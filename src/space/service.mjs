/**
 * src/space/service.mjs — 空间领域操作
 *
 * 每个操作 = 一次事务（事件 + 投影同生共死）+ 服务端不变式校验。
 * 这里是「机制优于自然语言」的落点：越权、越界、漏 handoff 全部返回错误码，
 * 不依赖 agent 记得规矩。
 */

import { metaGet, newId, txn } from './db.mjs'
import { appendEvent, safeJson, verifyProjection } from './events.mjs'
import {
  SLOT_BY_CP,
  SLOT_LIMITS,
  SpaceError,
  TASK_TYPES,
  TERMINAL_STATES,
  assertCanRequestRevision,
  assertCanRelaxHardGate,
  assertClaimable,
  assertFailureEvidence,
  assertHandoff,
  assertLeaseHolder,
  assertNotTerminal,
  assertTransition,
  bumpSlot,
  slotRounds,
} from './invariants.mjs'

const DEFAULT_BLOCK_SEC = 20
const DEFAULT_LEASE_SEC = 300
const MAX_ATTEMPTS = 3
/** 单次 wait 的硬上限：再大也只会让 agent 白等（ADR 0005） */
const MAX_BLOCK_SEC = 300
/** 租约上限：不设限时 `lease_sec: 1e9` 能让任务 31 年不可回收（实测过） */
const LEASE_MAX_SEC = 3600
/** 单条消息的长度上限：不设限时一次 wait 能返回 200MB */
const MSG_MAX_CHARS = 1000

const clampLease = (v, fallback = DEFAULT_LEASE_SEC) => Math.max(1, Math.min(toInt(v, fallback), LEASE_MAX_SEC))

/**
 * 数字入参收口。LLM 常见失手是把数字写成字符串（"20" 甚至 "abc"），
 * 而 NaN 会让 deadline 变成 NaN → wait 永不返回 → 会话挂死。
 */
function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ 工具函数

function taskRow(db, id) {
  const row = db.prepare('select * from tasks where id = ?').get(id)
  if (!row) throw new SpaceError('TASK_NOT_FOUND', `task ${id} not found`)
  return row
}

function hydrateTask(row) {
  return {
    task_id: row.id,
    op: row.op,
    step: row.step,
    type: row.type,
    slot: row.slot,
    to: row.to_member,
    role: row.role,
    state: row.state,
    attempts: row.attempts,
    claims: `${row.claims_count}/${row.claims_max}`,
    inputs: safeJson(row.inputs, []),
    expected: safeJson(row.expected, {}),
    refs: safeJson(row.refs, []),
    owner: row.owner,
    lease_until: row.lease_until,
    handoff: row.handoff_uri ? { uri: row.handoff_uri, sha256: row.handoff_sha } : null,
    reason: row.reason ?? null,
    created_by: row.created_by,
    updated_at: row.updated_at,
  }
}

/**
 * 任务可见性（读侧也必须有边界）。
 * 与 wait 的事件可见性同一套谓词：自己发的 / 派给自己的 / 自己持有的 / 自己角色的广播 / human 全见。
 */
function canSeeTask(task, member) {
  if (!task) return false
  if (member.kind === 'human') return true
  if (task.to_member === member.id) return true
  if (task.created_by === member.id) return true
  if (task.owner === member.id) return true
  if (task.to_member == null && task.role === member.role) return true
  return false
}

/** 谁看得见这个事件：自己发的 / 派给自己的 / 派给自己角色的 / 广播消息 */
function visibleTo(row, task, member) {
  if (row.member_id === member.id) return true
  if (task) {
    if (task.to_member === member.id) return true
    if (task.to_member == null && task.role != null && task.role === member.role) return true
    if (task.created_by === member.id) return true
  }
  const p = safeJson(row.payload, {})
  if (row.kind === 'message.sent') {
    return p.to === member.id || p.topic != null
  }
  return false
}

/**
 * 租约回收（协议 §4.2）：CLAIMED/WORKING 超时 → attempts+1 → 回 PENDING；
 * 超过上限转 FAILED。惰性扫描，在每个会读写任务的操作前跑一次。
 */
/**
 * 租约回收（协议 §4.2 / ADR 0008）。
 *
 * 三条纪律，缺一条就会出已实测到的严重缺陷：
 *   1. select 必须在写事务**内部**——事务外的快照会让「刚提交 DONE 的任务」被复活成 PENDING（破坏 R1）
 *   2. update 必须带 state + 过期时间守卫，只认自己刚读到的那个状态
 *   3. attempts 用 SQL 自增，不用 JS 快照值算
 *
 * 覆盖范围包含中断态：agent 最可能崩的时刻正是「挂着等人回答」。
 */
const SWEEPABLE = "('CLAIMED','WORKING','WAITING_INPUT','WAITING_AUTH','BLOCKED')"

function sweepExpired(db) {
  const now = Date.now()
  // 只读快速探测：没有过期任务就不去抢写锁（否则纯读接口会被写锁拖住）
  const probe = db
    .prepare(`select count(*) as c from tasks where state in ${SWEEPABLE} and lease_until is not null and lease_until < ?`)
    .get(now)
  if (!probe?.c) return 0

  return txn(db, () => {
    const rows = db
      .prepare(`select id, state from tasks where state in ${SWEEPABLE} and lease_until is not null and lease_until < ?`)
      .all(now)
    let swept = 0
    for (const row of rows) {
      const info = db
        .prepare(
          `update tasks set
             attempts = attempts + 1,
             state = case when attempts + 1 >= ? then 'FAILED' else 'PENDING' end,
             claims_count = 0,
             lease_id = null, lease_until = null, owner = null, updated_at = ?
           where id = ? and state in ${SWEEPABLE} and lease_until is not null and lease_until < ?`,
        )
        .run(MAX_ATTEMPTS, now, row.id, now)
      if (Number(info.changes) !== 1) continue // 守卫住的那一份：别人已经处理或任务已终态
      const after = db.prepare('select attempts, state from tasks where id = ?').get(row.id)
      appendEvent(db, {
        kind: 'task.expired',
        taskId: row.id,
        memberId: null,
        payload: { attempts: after.attempts, from: row.state, to: after.state },
      })
      swept += 1
    }
    return swept
  })
}

function assertAttached(member) {
  if (!member) throw new SpaceError('TOKEN_INVALID', 'not attached')
}

/**
 * 宪法版本门必须是机制，不是自愿动作（AGENTS.md 原则 3）。
 * 不 attach 就能用其它工具 = 版本闸门形同不存在，实测确实如此。
 */
function assertReady(ctx) {
  assertAttached(ctx.member)
  if (ctx.session && !ctx.session.attached) {
    throw new SpaceError('NOT_ATTACHED', 'call space_attach first（宪法版本与 capabilities 要在这一步上报）')
  }
}

function assertScope(member, need) {
  // 阶段 2 的简化：未列 scope = 全权（fail-open）。这是已知的弱默认值，
  // 协议 §2.2 已标注；阶段 3 上 HTTP 时必须改成 fail-closed。
  if (!member.scopes || member.scopes.length === 0) return
  if (!member.scopes.includes(need)) {
    throw new SpaceError('FORBIDDEN_ROLE', `missing scope "${need}" (have: ${member.scopes.join(',')})`)
  }
}

// ------------------------------------------------------------------ 操作

export async function attach(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  const serverVersion = Number(metaGet(db, 'constitution_version') ?? 1)
  const clientVersion = Number(args.constitution_version ?? serverVersion)
  if (clientVersion < serverVersion) {
    throw new SpaceError(
      'CONSTITUTION_OUTDATED',
      `constitution v${clientVersion} is older than server v${serverVersion}: 请先升级空间宪法`,
    )
  }
  const rawCaps = args.capabilities ?? {}
  const capabilities = {
    ...rawCaps,
    // max_block_sec 由客户端自报，必须收口：NaN 会让 wait 永不返回，1e9 会挂死一个 handler
    max_block_sec: Math.max(1, Math.min(toInt(rawCaps.max_block_sec, DEFAULT_BLOCK_SEC), MAX_BLOCK_SEC)),
  }
  if (ctx.session) ctx.session.attached = true
  txn(db, () => {
    db.prepare('update members set last_seen_at = ?, capabilities = ? where id = ?').run(
      Date.now(),
      JSON.stringify(capabilities),
      member.id,
    )
    appendEvent(db, { kind: 'member.attached', memberId: member.id, payload: { capabilities } })
  })
  member.capabilities = capabilities
  ctx.maxBlockSec = capabilities.max_block_sec
  if (ctx.session) ctx.session.maxBlockSec = capabilities.max_block_sec

  const mine = db
    .prepare("select * from tasks where state = 'PENDING' and (to_member = ? or (to_member is null and role = ?))")
    .all(member.id, member.role)
    .map(hydrateTask)

  // attach 必须回一个游标：否则 agent 只能从 0 开始 wait，第一条就是自己的 member.attached
  const cursor = Number(db.prepare('select coalesce(max(id), 0) as c from events').get().c)

  return {
    member: { id: member.id, role: member.role, kind: member.kind, scopes: member.scopes },
    constitution_version: serverVersion,
    cursor,
    unread_tasks: mine,
    hint: 'attach 完成。下一步：循环调用 space_wait({since_cursor}) 等活，或直接 claim 未读任务。',
  }
}

export async function detach(ctx) {
  const { db, member } = ctx
  assertReady(ctx)
  if (ctx.session) ctx.session.attached = false
  txn(db, () => appendEvent(db, { kind: 'member.detached', memberId: member.id, payload: {} }))
  return { ok: true }
}

/**
 * B 档主路径（协议 §6.2 + ADR 0005）：
 * 挂住等活，最多 effective_timeout_sec 秒；返回时顺带续租 + 心跳。
 * 超时返回是**正常返回**（reason=timeout），不是错误——agent 必须继续循环。
 */
export async function wait(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)

  const maxBlock = toInt(
    ctx.session?.maxBlockSec ?? ctx.maxBlockSec ?? member.capabilities?.max_block_sec,
    DEFAULT_BLOCK_SEC,
  )
  const requested = toInt(args.timeout_sec, DEFAULT_BLOCK_SEC)
  const effective = Math.max(1, Math.min(requested, maxBlock, MAX_BLOCK_SEC))
  let cursor = toInt(args.since_cursor, 0)
  const deadline = Date.now() + effective * 1000

  for (;;) {
    // 人插话（MCP notifications/cancelled）时立刻收手：不再占着 handler 跑满 deadline
    if (ctx.signal?.aborted) {
      throw new SpaceError('CANCELLED', 'wait cancelled by client (人可能插话了)')
    }
    sweepExpired(db)
    const rows = db
      .prepare('select id, kind, task_id, member_id, payload, at from events where id > ? order by id asc limit 200')
      .all(cursor)
    const fresh = []
    for (const row of rows) {
      const task = row.task_id ? db.prepare('select * from tasks where id = ?').get(row.task_id) : null
      if (visibleTo(row, task, member)) fresh.push(row)
    }
    const pending = db
      .prepare("select * from tasks where state = 'PENDING' and (to_member = ? or (to_member is null and role = ?))")
      .all(member.id, member.role)

    if (rows.length > 0) cursor = Math.max(cursor, rows[rows.length - 1].id)

    if (fresh.length > 0 || pending.length > 0) {
      renewLeases(db, member)
      return {
        reason: 'events',
        cursor,
        events: fresh.map((r) => ({ id: r.id, kind: r.kind, task_id: r.task_id, member_id: r.member_id, payload: safeJson(r.payload, {}), at: r.at })),
        tasks: pending.map(hydrateTask),
        effective_timeout_sec: effective,
      }
    }

    if (Date.now() >= deadline) {
      renewLeases(db, member)
      return { reason: 'timeout', cursor, events: [], tasks: [], effective_timeout_sec: effective }
    }
    await sleep(250)
  }
}

/** wait 返回即续租：一次调用做三件事，不会漏续租（协议 §6.2） */
function renewLeases(db, member) {
  const now = Date.now()
  txn(db, () => {
    const held = db
      .prepare("select id, lease_sec from tasks where owner = ? and state in ('CLAIMED','WORKING')")
      .all(member.id)
    for (const t of held) {
      db.prepare('update tasks set lease_until = ? where id = ?').run(now + (t.lease_sec ?? DEFAULT_LEASE_SEC) * 1000, t.id)
    }
    db.prepare('update members set last_seen_at = ? where id = ?').run(now, member.id)
  })
}

export async function taskCreate(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  assertScope(member, 'task')

  const type = String(args.type ?? 'assign').trim()
  if (!TASK_TYPES.has(type)) {
    throw new SpaceError('TASK_STATE_INVALID', `unknown task type "${type}"（允许：${[...TASK_TYPES].join('|')}）`)
  }

  let op = String(args.op ?? '').trim()
  const to = args.to ? String(args.to).trim() : null
  const role = args.role ? String(args.role).trim() : null
  const refs = Array.isArray(args.refs) ? args.refs : []

  // ── R2 的关键修复（ADR 0008）：revision 的 op 与 slot 都由**服务端**确定
  //    原来 op/slot/type 全是客户端入参，等于让被约束方自己选循环边界：换个字符串就重置轮次。
  let slot = null
  if (type === 'revision') {
    const originId = typeof refs[0] === 'string' ? refs[0] : null
    if (!originId) throw new SpaceError('TASK_STATE_INVALID', 'revision requires refs[0] to be the original task_id')
    const origin = db.prepare('select * from tasks where id = ?').get(originId)
    if (!origin) throw new SpaceError('TASK_NOT_FOUND', `revision refs[0] ${originId} does not exist`)
    // 轮次预算是任务属主的，不是路人的。否则任何成员对别人的任务连发 3 次就能封死它（实测可复现）
    if (!canSeeTask(origin, member)) {
      throw new SpaceError('FORBIDDEN_ROLE', `revision on task ${originId} (op=${origin.op}) is not yours to open`)
    }
    op = origin.op // op 从原任务取，不信任入参
    slot = SLOT_BY_CP[String(args.cp ?? '').trim()]
    if (!slot) {
      throw new SpaceError(
        'TASK_STATE_INVALID',
        `revision requires cp ∈ {${Object.keys(SLOT_BY_CP).join('|')}}；slot 由服务端按 §5.2 查出，不接受客户端指定`,
      )
    }
  } else if (!op) {
    throw new SpaceError('TASK_STATE_INVALID', 'op is required (算子名)')
  }

  if (type === 'assign' && !to) throw new SpaceError('TASK_STATE_INVALID', 'type=assign requires `to`')
  if (type === 'broadcast' && !role) throw new SpaceError('TASK_STATE_INVALID', 'type=broadcast requires `role`')

  // 诚实边界：一行任务只有一个租约，多成员同时认领需要 task_claims 表（阶段 4）。
  // 与其接受 claims=2 却让第二个人永远失败，不如当场说清。
  const claimsWanted = Math.max(1, toInt(args.claims, 1))
  if (claimsWanted > 1) {
    throw new SpaceError(
      'TASK_STATE_INVALID',
      'claims > 1 未实现（v0.2）：一行任务只持一个租约。广播竞争消费留到阶段 4 引入 task_claims 表',
    )
  }

  const now = Date.now()
  const id = newId('t')

  const outcome = txn(db, () => {
    let round = null
    if (type === 'revision') {
      try {
        round = bumpSlot(db, op, slot)
      } catch (err) {
        if (err.code !== 'LOOP_EXHAUSTED') throw err
        // 落盘证据后拒绝创建：轮次耗尽必须留痕，不能静默
        appendEvent(db, {
          kind: 'loop.exhausted',
          memberId: member.id,
          payload: { op, slot, round: err.detail?.round, limit: err.detail?.limit, evidence: args.refs ?? [] },
        })
        return { error: err }
      }
    }
    db.prepare(
      `insert into tasks(id, op, step, type, slot, to_member, role, state, attempts, claims_max, claims_count,
        inputs, expected, refs, created_by, created_at, updated_at)
       values(?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      op,
      args.step ? String(args.step) : null,
      type,
      slot,
      to,
      role,
      claimsWanted,
      JSON.stringify(args.inputs ?? []),
      JSON.stringify(args.expected ?? {}),
      JSON.stringify(refs),
      member.id,
      now,
      now,
    )
    appendEvent(db, {
      kind: 'task.created',
      taskId: id,
      memberId: member.id,
      payload: { type, to, role, op, step: args.step ?? null, slot, round, refs },
    })
    return { task_id: id, slot_round: round }
  })

  if (outcome.error) throw outcome.error
  return { ...outcome, state: 'PENDING' }
}

export async function taskClaim(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  assertScope(member, 'task')
  sweepExpired(db)
  const task = taskRow(db, args.task_id)
  assertClaimable(task)

  // 只能认领派给自己的、自己角色的、或广播
  const forMe = task.to_member === member.id || (task.to_member == null && task.role === member.role)
  if (!forMe) {
    throw new SpaceError('FORBIDDEN_ROLE', `task ${task.id} is not addressed to ${member.id} (to=${task.to_member ?? '—'}, role=${task.role ?? '—'})`)
  }

  const leaseSec = clampLease(args.lease_sec)
  const leaseId = newId('lease')
  const until = Date.now() + leaseSec * 1000

  return txn(db, () => {
    const cur = taskRow(db, task.id)
    // 幂等（协议 §8.1）：wait 超时 / 工具调用被打断后 agent 会重试，重试不该报错
    if (cur.state === 'CLAIMED' && cur.owner === member.id && cur.lease_id) {
      return { lease_id: cur.lease_id, lease_until: cur.lease_until, state: 'CLAIMED', idempotent: true }
    }
    assertClaimable(cur) // 事务内二次校验：并发竞争在这里被挡掉
    db.prepare(
      'update tasks set state = ?, owner = ?, lease_id = ?, lease_until = ?, lease_sec = ?, claims_count = claims_count + 1, updated_at = ? where id = ?',
    ).run('CLAIMED', member.id, leaseId, until, leaseSec, Date.now(), cur.id)
    appendEvent(db, {
      kind: 'task.claimed',
      taskId: cur.id,
      memberId: member.id,
      payload: { lease_id: leaseId, lease_until: until, claims: cur.claims_count + 1 },
    })
    return { lease_id: leaseId, lease_until: until, state: 'CLAIMED' }
  })
}

export async function taskHeartbeat(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  const leaseId = args.lease_id
  if (!leaseId) throw new SpaceError('LEASE_EXPIRED', 'lease_id required')

  return txn(db, () => {
    const task = db.prepare('select * from tasks where lease_id = ?').get(leaseId)
    if (!task) throw new SpaceError('LEASE_EXPIRED', `lease ${leaseId} not found`)
    assertLeaseHolder(task, leaseId, member)
    const until = Date.now() + clampLease(task.lease_sec) * 1000
    // 谓词必须有：否则另一进程刚认领的租约会被这条迟到的 UPDATE 覆盖回旧时间（实测过）
    const info = db
      .prepare('update tasks set lease_until = ?, updated_at = ? where id = ? and lease_id = ? and owner = ?')
      .run(until, Date.now(), task.id, leaseId, member.id)
    if (Number(info.changes) !== 1) throw new SpaceError('LEASE_EXPIRED', `lease ${leaseId} was taken over`)
    return { lease_until: until }
  })
}

export async function taskTransition(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  assertScope(member, 'task')
  sweepExpired(db)

  const to = String(args.to ?? '').trim()
  const payload = args.payload ?? {}
  const task = taskRow(db, args.task_id)

  // 幂等（协议 §8.1）：wait 超时 / 工具调用被超时或插话打断后 agent 会重试。
  // 重试必须返回当前态，而不是一个错误码——否则 agent 会把它当失败处理。
  if (task.state === to) {
    return { task_id: task.id, state: to, idempotent: true }
  }

  assertNotTerminal(task) // R1 终态不可变
  assertTransition(task.state, to)

  const isHolder = task.owner === member.id && task.lease_id === args.lease_id
  if (!isHolder) {
    if (to === 'REVISION_REQUESTED' && task.owner !== member.id) {
      // 协议 §4.2 写的是「QA（非本人）」——必须真的校验角色，否则任何同 role 成员
      // 都能把别人手上的任务打回并冻住（无需租约的 DoS）
      assertCanRequestRevision(member)
    } else if (to === 'CANCELED' && member.kind === 'human') {
      // 人可作废（协议 §2.1）
    } else {
      throw new SpaceError('LEASE_MISMATCH', `task ${task.id} is held by ${task.owner ?? 'nobody'}; caller ${member.id} cannot transition it`)
    }
  }

  // 各分支的附加约束（协议 §4.2 / §5）
  let handoff = null
  // handoff 是「交付件」的要求；question / answer / notice 是人机问答，不产出文件
  const needsHandoff = ['assign', 'revision', 'broadcast'].includes(task.type)
  if (to === 'DONE' && needsHandoff) {
    handoff = assertHandoff(payload)
    const art = db
      .prepare('select id, by_member, task_id, size from artifacts where uri = ? and sha256 = ?')
      .get(handoff.uri, handoff.sha256)
    if (!art) {
      throw new SpaceError('ARTIFACT_MISSING', `handoff references unknown artifact ${handoff.uri} (${handoff.sha256}); 先 space_publish`)
    }
    // handoff 必须指向**自己**为**这条任务**登记的制品，不能拿别人的产物充数
    if (art.by_member !== member.id || (art.task_id && art.task_id !== task.id)) {
      throw new SpaceError(
        'ARTIFACT_MISSING',
        `artifact ${handoff.uri} was published by ${art.by_member}${art.task_id ? ` for task ${art.task_id}` : ''}, not by ${member.id} for ${task.id}`,
      )
    }
    if (handoff.size != null && art.size != null && toInt(handoff.size, -1) !== Number(art.size)) {
      throw new SpaceError('ARTIFACT_MISSING', `handoff size ${handoff.size} does not match registry size ${art.size}`)
    }
  }
  if (to === 'FAILED') assertFailureEvidence(payload)
  if (to === 'WAITING_INPUT') {
    const qid = payload.question_task_id
    if (!qid) throw new SpaceError('EVIDENCE_INSUFFICIENT', 'transition to WAITING_INPUT requires payload.question_task_id (先 task_create type=question)')
    const q = db.prepare('select * from tasks where id = ? and type = ? and op = ?').get(qid, 'question', task.op)
    if (!q) throw new SpaceError('TASK_NOT_FOUND', `question task ${qid} for op ${task.op} not found`)
  }
  // 注意：这里**不再**接受 payload.relax_hard_gate（ADR 0008）。
  // 放宽硬门槛从「客户端自报一个布尔量」改成独立的 space_task_accept，只有 human 能签。

  return txn(db, () => {
    const cur = taskRow(db, task.id)
    if (cur.state === to) return { task_id: cur.id, state: to, idempotent: true }
    assertNotTerminal(cur)
    assertTransition(cur.state, to)

    const terminal = TERMINAL_STATES.has(to)
    const releasing = terminal || to === 'PENDING' // 回 PENDING 必须释放租约并清空认领名额
    db.prepare(
      `update tasks set state = ?, handoff_uri = ?, handoff_sha = ?, reason = ?,
         lease_id = case when ? then null else lease_id end,
         lease_until = case when ? then null else lease_until end,
         owner = case when ? then null else owner end,
         claims_count = case when ? then 0 else claims_count end,
         updated_at = ?
       where id = ?`,
    ).run(
      to,
      handoff?.uri ?? cur.handoff_uri,
      handoff?.sha256 ?? cur.handoff_sha,
      payload.reason ?? cur.reason,
      releasing ? 1 : 0,
      releasing ? 1 : 0,
      releasing ? 1 : 0,
      releasing ? 1 : 0,
      Date.now(),
      cur.id,
    )
    appendEvent(db, {
      kind: 'task.transitioned',
      taskId: cur.id,
      memberId: member.id,
      payload: { from: cur.state, to, reason: payload.reason ?? null, handoff: handoff ?? null },
    })
    if (handoff) {
      appendEvent(db, {
        kind: 'handoff.written',
        taskId: cur.id,
        memberId: member.id,
        payload: { uri: handoff.uri, sha256: handoff.sha256, size: handoff.size ?? null },
      })
    }
    return { task_id: cur.id, state: to }
  })
}

/**
 * R3（协议 §5.3）：硬门槛不得由验收方自行放宽。
 *
 * 修复（ADR 0008）：原来只看 `payload.relax_hard_gate === true`——约束条件由被约束方自己填，
 * 等于不存在。现在改成独立动作：只有 human 能签，且必须带齐三类证据。
 */
export async function taskAccept(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  const task = taskRow(db, args.task_id)
  const verdict = String(args.verdict ?? '').trim() // pass | hold | relax
  if (!['pass', 'hold', 'relax'].includes(verdict)) {
    throw new SpaceError('EVIDENCE_INSUFFICIENT', 'verdict must be one of pass | hold | relax')
  }

  // pass 与 blocking gap 是矛盾的判定。实跑里 QA 判 pass 却写下「需求基线与文档冲突」这种
  // 阻断级问题，靠 PM 读 gaps 才补救回来——不该让编排方的细心承担正确性。
  if (verdict === 'pass') {
    const blocking = (args.gaps ?? []).filter((g) => g && (g.blocking === true || g.severity === 'blocker' || g.severity === 'blocking'))
    if (blocking.length > 0) {
      throw new SpaceError(
        'EVIDENCE_INSUFFICIENT',
        `verdict=pass 不能带阻断级 gap（${blocking.map((g) => g.id ?? '?').join(',')}）：要么判 hold 并打回，要么把它降级为「可带下的细化项」`,
      )
    }
  }

  if (verdict === 'relax') {
    assertCanRelaxHardGate(member) // 只有 human
    const ev = args.evidence ?? {}
    const missing = ['quantified_gap', 'exhausted_optimizations', 'design_contradiction'].filter((k) => !ev[k])
    if (missing.length > 0) {
      throw new SpaceError(
        'EVIDENCE_INSUFFICIENT',
        `放宽硬门槛必须给齐证据（协议 §5.3）：缺 ${missing.join(', ')}`,
      )
    }
  }

  return txn(db, () => {
    db.prepare('update tasks set reason = ?, updated_at = ? where id = ?').run(`verdict:${verdict}`, Date.now(), task.id)
    appendEvent(db, {
      kind: 'cp.judged',
      taskId: task.id,
      memberId: member.id,
      payload: { cp: args.cp ?? null, verdict, gaps: args.gaps ?? [], evidence: args.evidence ?? {} },
    })
    return {
      task_id: task.id,
      verdict,
      by: member.id,
      relaxed: verdict === 'relax',
      pending_user_review: verdict === 'relax' ? false : undefined,
    }
  })
}

export async function taskList(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  sweepExpired(db)
  const f = args.filter ?? {}
  const where = []
  const params = []
  if (f.op) (where.push('op = ?'), params.push(f.op))
  if (f.step) (where.push('step = ?'), params.push(f.step))
  if (f.state) (where.push('state = ?'), params.push(f.state))
  if (f.to) (where.push('to_member = ?'), params.push(f.to))
  if (f.role) (where.push('role = ?'), params.push(f.role))
  const sql = `select * from tasks ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at asc limit 200`
  return { tasks: db.prepare(sql).all(...params).filter((t) => canSeeTask(t, member)).map(hydrateTask) }
}

export async function publish(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  assertScope(member, 'publish')
  if (!args.uri || !args.sha256) throw new SpaceError('ARTIFACT_MISSING', 'publish requires uri + sha256（只登记引用，不传字节）')
  if (args.task_id) {
    const t = db.prepare('select * from tasks where id = ?').get(args.task_id)
    if (!t) throw new SpaceError('TASK_NOT_FOUND', `task ${args.task_id} not found`)
    if (!canSeeTask(t, member)) throw new SpaceError('FORBIDDEN_ROLE', `cannot publish for task ${args.task_id}`)
  }
  const id = newId('a')
  txn(db, () => {
    db.prepare(
      'insert into artifacts(id, uri, sha256, size, media_type, by_member, task_id, meta, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      args.uri,
      args.sha256,
      args.size ?? null,
      args.media_type ?? null,
      member.id,
      args.task_id ?? null,
      JSON.stringify(args.meta ?? {}),
      Date.now(),
    )
    appendEvent(db, {
      kind: 'artifact.published',
      taskId: args.task_id ?? null,
      memberId: member.id,
      payload: { artifact_id: id, uri: args.uri, sha256: args.sha256, size: args.size ?? null },
    })
  })
  return { artifact_id: id }
}

export async function artifactResolve(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  const row = db.prepare('select * from artifacts where id = ? or uri = ?').get(args.artifact_id ?? '', args.artifact_id ?? '')
  if (!row) throw new SpaceError('ARTIFACT_MISSING', `artifact ${args.artifact_id} not found`)
  const ownerTask = row.task_id ? db.prepare('select * from tasks where id = ?').get(row.task_id) : null
  if (row.by_member !== member.id && !canSeeTask(ownerTask, member)) {
    throw new SpaceError('FORBIDDEN_ROLE', `artifact ${row.uri} belongs to ${row.by_member}`)
  }
  return { uri: row.uri, sha256: row.sha256, size: row.size, media_type: row.media_type, by: row.by_member }
}

export async function msgSend(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  assertScope(member, 'msg')
  const text = String(args.text ?? '')
  if (!text) throw new SpaceError('EVIDENCE_INSUFFICIENT', 'msg requires text')
  if (text.length > MSG_MAX_CHARS) {
    throw new SpaceError('EVIDENCE_INSUFFICIENT', `msg too long (${text.length} > ${MSG_MAX_CHARS} chars)：消息是控制面瞬时信号，不是内容载体`)
  }
  if (Boolean(args.to) === Boolean(args.topic)) {
    // 同时给 to 和 topic 时，原来 topic 会让它变成全员可见 —— 私聊泄漏
    throw new SpaceError('EVIDENCE_INSUFFICIENT', 'msg requires exactly one of `to` (direct) or `topic` (broadcast)')
  }
  if (args.to) {
    const target = db.prepare("select id, status from members where id = ?").get(args.to)
    if (!target || target.status === 'revoked') throw new SpaceError('NOT_MEMBER', `recipient ${args.to} is not a member`)
  }
  const id = newId('msg')
  txn(db, () => {
    db.prepare('insert into messages(id, to_member, topic, text, refs, by_member, at) values(?, ?, ?, ?, ?, ?, ?)').run(
      id,
      args.to ?? null,
      args.topic ?? null,
      text,
      JSON.stringify(args.refs ?? []),
      member.id,
      Date.now(),
    )
    appendEvent(db, {
      kind: 'message.sent',
      memberId: member.id,
      payload: { msg_id: id, to: args.to ?? null, topic: args.topic ?? null, text, refs: args.refs ?? [] },
    })
  })
  return { msg_id: id }
}

/** 状态面：server 归约出的只读状态（agent 不能写） */
export async function stateGet(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  sweepExpired(db)
  const op = args.op
  const tasks = op
    ? db.prepare('select * from tasks where op = ? order by created_at asc').all(op)
    : db.prepare('select * from tasks order by created_at asc limit 500').all()
  const visible = tasks.filter((t) => canSeeTask(t, member))
  const visibleIds = new Set(visible.map((t) => t.id))
  const artifacts = db
    .prepare('select id, uri, sha256, size, by_member, task_id from artifacts where (? is null or task_id in (select id from tasks where op = ?))')
    .all(op ?? null, op ?? null)
    .filter((a) => a.by_member === member.id || visibleIds.has(a.task_id) || member.kind === 'human')
  return {
    op: op ?? null,
    slots: op ? slotRounds(db, op) : {},
    tasks: visible.map(hydrateTask),
    artifacts: artifacts.map(({ task_id, ...rest }) => rest),
  }
}

export async function resourceAcquire(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  const name = args.name
  if (!name) throw new SpaceError('RESOURCE_BUSY', 'resource name required')
  const leaseSec = clampLease(args.lease_sec)
  const now = Date.now()
  return txn(db, () => {
    const row = db.prepare('select * from resources where name = ?').get(name)
    if (row?.lease_id && row.until > now && row.member_id !== member.id) {
      throw new SpaceError('RESOURCE_BUSY', `${name} is held by ${row.member_id} until ${new Date(row.until).toISOString()}`)
    }
    const leaseId = newId('res')
    const until = now + leaseSec * 1000
    db.prepare(
      'insert into resources(name, lease_id, member_id, until) values(?, ?, ?, ?) on conflict(name) do update set lease_id = excluded.lease_id, member_id = excluded.member_id, until = excluded.until',
    ).run(name, leaseId, member.id, until)
    appendEvent(db, { kind: 'resource.acquired', memberId: member.id, payload: { name, lease_id: leaseId, until } })
    return { lease_id: leaseId, lease_until: until }
  })
}

export async function resourceRelease(ctx, args = {}) {
  const { db, member } = ctx
  assertReady(ctx)
  return txn(db, () => {
    const row = db.prepare('select * from resources where lease_id = ?').get(args.lease_id)
    if (!row) throw new SpaceError('LEASE_EXPIRED', `resource lease ${args.lease_id} not found`)
    if (row.member_id !== member.id) throw new SpaceError('LEASE_MISMATCH', `resource held by ${row.member_id}`)
    db.prepare('update resources set lease_id = null, member_id = null, until = null where name = ?').run(row.name)
    appendEvent(db, { kind: 'resource.released', memberId: member.id, payload: { name: row.name, lease_id: args.lease_id } })
    return { ok: true }
  })
}

/** 调试用：投影 vs 事件归约 */
export async function verify(ctx) {
  // 对账器既给成员用（MCP），也给管理员用（CLI）——后者没有 attach 会话
  if (!ctx.admin) assertReady(ctx)
  const drift = verifyProjection(ctx.db)
  return { ok: drift.length === 0, drift }
}
