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
  SLOT_LIMITS,
  SpaceError,
  TERMINAL_STATES,
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
    created_by: row.created_by,
    updated_at: row.updated_at,
  }
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
function sweepExpired(db) {
  const now = Date.now()
  const rows = db
    .prepare("select * from tasks where state in ('CLAIMED','WORKING') and lease_until is not null and lease_until < ?")
    .all(now)
  if (rows.length === 0) return 0
  txn(db, () => {
    for (const t of rows) {
      const attempts = t.attempts + 1
      const to = attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING'
      db.prepare(
        'update tasks set state = ?, attempts = ?, lease_id = null, lease_until = null, owner = null, updated_at = ? where id = ?',
      ).run(to, attempts, now, t.id)
      appendEvent(db, {
        kind: 'task.expired',
        taskId: t.id,
        memberId: t.owner,
        payload: { attempts, from: t.state, to },
      })
    }
  })
  return rows.length
}

function assertAttached(member) {
  if (!member) throw new SpaceError('TOKEN_INVALID', 'not attached')
}

function assertScope(member, need) {
  if (!member.scopes || member.scopes.length === 0) return // 未限定 = 全权
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
  const capabilities = args.capabilities ?? {}
  txn(db, () => {
    db.prepare('update members set last_seen_at = ?, capabilities = ? where id = ?').run(
      Date.now(),
      JSON.stringify(capabilities),
      member.id,
    )
    appendEvent(db, { kind: 'member.attached', memberId: member.id, payload: { capabilities } })
  })
  member.capabilities = capabilities
  ctx.maxBlockSec = Number(capabilities.max_block_sec ?? DEFAULT_BLOCK_SEC)

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
  assertAttached(member)
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
  assertAttached(member)

  const maxBlock = Number(ctx.maxBlockSec ?? member.capabilities?.max_block_sec ?? DEFAULT_BLOCK_SEC)
  const requested = Number(args.timeout_sec ?? DEFAULT_BLOCK_SEC)
  const effective = Math.max(1, Math.min(requested, maxBlock))
  let cursor = Number(args.since_cursor ?? 0)
  const deadline = Date.now() + effective * 1000

  for (;;) {
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
  assertAttached(member)
  assertScope(member, 'task')

  const type = args.type ?? 'assign'
  const op = args.op
  const to = args.to ?? null
  const role = args.role ?? null
  if (!op) throw new SpaceError('TASK_NOT_FOUND', 'op is required (算子名)')
  if (type === 'assign' && !to) throw new SpaceError('TASK_NOT_FOUND', 'type=assign requires `to`')
  if (type === 'broadcast' && !role) throw new SpaceError('TASK_NOT_FOUND', 'type=broadcast requires `role`')

  const now = Date.now()
  const id = newId('t')

  const outcome = txn(db, () => {
    let round = null
    if (type === 'revision') {
      const slot = args.slot
      if (!slot || !SLOT_LIMITS[slot]) {
        throw new SpaceError('TASK_STATE_INVALID', `revision requires slot ∈ {${Object.keys(SLOT_LIMITS).join('|')}}`)
      }
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
      args.step ?? null,
      type,
      args.slot ?? null,
      to,
      role,
      Math.max(1, Number(args.claims ?? 1)),
      JSON.stringify(args.inputs ?? []),
      JSON.stringify(args.expected ?? {}),
      JSON.stringify(args.refs ?? []),
      member.id,
      now,
      now,
    )
    appendEvent(db, {
      kind: 'task.created',
      taskId: id,
      memberId: member.id,
      payload: { type, to, role, op, step: args.step ?? null, slot: args.slot ?? null, round },
    })
    return { task_id: id, slot_round: round }
  })

  if (outcome.error) throw outcome.error
  return { ...outcome, state: 'PENDING' }
}

export async function taskClaim(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  assertScope(member, 'task')
  sweepExpired(db)
  const task = taskRow(db, args.task_id)
  assertClaimable(task)

  // 只能认领派给自己的、自己角色的、或广播
  const forMe = task.to_member === member.id || (task.to_member == null && task.role === member.role)
  if (!forMe) {
    throw new SpaceError('FORBIDDEN_ROLE', `task ${task.id} is not addressed to ${member.id} (to=${task.to_member ?? '—'}, role=${task.role ?? '—'})`)
  }

  const leaseSec = Number(args.lease_sec ?? DEFAULT_LEASE_SEC)
  const leaseId = newId('lease')
  const until = Date.now() + leaseSec * 1000

  return txn(db, () => {
    const cur = taskRow(db, task.id)
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
  assertAttached(member)
  const task = db.prepare('select * from tasks where lease_id = ?').get(args.lease_id)
  if (!task) throw new SpaceError('LEASE_EXPIRED', `lease ${args.lease_id} not found`)
  assertLeaseHolder(task, args.lease_id, member)
  const until = Date.now() + (task.lease_sec ?? DEFAULT_LEASE_SEC) * 1000
  db.prepare('update tasks set lease_until = ?, updated_at = ? where id = ?').run(until, Date.now(), task.id)
  return { lease_until: until }
}

export async function taskTransition(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  sweepExpired(db)
  const to = args.to
  const payload = args.payload ?? {}
  const task = taskRow(db, args.task_id)

  assertNotTerminal(task) // R1 终态不可变
  assertTransition(task.state, to)

  const isHolder = task.owner === member.id && task.lease_id === args.lease_id
  if (!isHolder) {
    // 唯一例外：非持有者的 QA 打回（WORKING → REVISION_REQUESTED）
    if (to === 'REVISION_REQUESTED' && task.owner !== member.id) {
      // 允许
    } else if (to === 'CANCELED' && member.kind === 'human') {
      // 人可作废（协议 §2.1）
    } else {
      throw new SpaceError('LEASE_MISMATCH', `task ${task.id} is held by ${task.owner ?? 'nobody'}; caller ${member.id} cannot transition it`)
    }
  }

  // 各分支的附加约束（协议 §4.2 / §5）
  let handoff = null
  if (to === 'DONE') {
    handoff = assertHandoff(payload)
    const art = db.prepare('select id from artifacts where uri = ? and sha256 = ?').get(handoff.uri, handoff.sha256)
    if (!art) {
      throw new SpaceError('ARTIFACT_MISSING', `handoff references unknown artifact ${handoff.uri} (${handoff.sha256}); 先 space_publish`)
    }
  }
  if (to === 'FAILED') assertFailureEvidence(payload)
  if (to === 'WAITING_INPUT') {
    const qid = payload.question_task_id
    if (!qid) throw new SpaceError('EVIDENCE_INSUFFICIENT', 'transition to WAITING_INPUT requires payload.question_task_id (先 task_create type=question)')
    const q = db.prepare('select * from tasks where id = ? and type = ?').get(qid, 'question')
    if (!q) throw new SpaceError('TASK_NOT_FOUND', `question task ${qid} not found`)
  }
  if (payload.relax_hard_gate === true) assertCanRelaxHardGate(member) // R3

  return txn(db, () => {
    const cur = taskRow(db, task.id)
    assertNotTerminal(cur)
    assertTransition(cur.state, to)
    const terminal = TERMINAL_STATES.has(to)
    db.prepare(
      `update tasks set state = ?, handoff_uri = ?, handoff_sha = ?, reason = ?,
         lease_id = case when ? then null else lease_id end,
         lease_until = case when ? then null else lease_until end,
         updated_at = ?
       where id = ?`,
    ).run(
      to,
      handoff?.uri ?? cur.handoff_uri,
      handoff?.sha256 ?? cur.handoff_sha,
      payload.reason ?? cur.reason,
      terminal ? 1 : 0,
      terminal ? 1 : 0,
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
        payload: { uri: handoff.uri, sha256: handoff.sha256 },
      })
    }
    return { task_id: cur.id, state: to }
  })
}

export async function taskList(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  sweepExpired(db)
  const f = args.filter ?? {}
  const where = []
  const params = []
  if (f.op) (where.push('op = ?'), params.push(f.op))
  if (f.state) (where.push('state = ?'), params.push(f.state))
  if (f.to) (where.push('to_member = ?'), params.push(f.to))
  if (f.role) (where.push('role = ?'), params.push(f.role))
  const sql = `select * from tasks ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at asc limit 200`
  return { tasks: db.prepare(sql).all(...params).map(hydrateTask) }
}

export async function publish(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  assertScope(member, 'publish')
  if (!args.uri || !args.sha256) throw new SpaceError('ARTIFACT_MISSING', 'publish requires uri + sha256（只登记引用，不传字节）')
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
  const { db } = ctx
  const row = db.prepare('select * from artifacts where id = ? or uri = ?').get(args.artifact_id ?? '', args.artifact_id ?? '')
  if (!row) throw new SpaceError('ARTIFACT_MISSING', `artifact ${args.artifact_id} not found`)
  return { uri: row.uri, sha256: row.sha256, size: row.size, media_type: row.media_type, by: row.by_member }
}

export async function msgSend(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  assertScope(member, 'msg')
  if (!args.text) throw new SpaceError('EVIDENCE_INSUFFICIENT', 'msg requires text')
  if (!args.to && !args.topic) throw new SpaceError('EVIDENCE_INSUFFICIENT', 'msg requires to or topic')
  const id = newId('msg')
  txn(db, () => {
    db.prepare('insert into messages(id, to_member, topic, text, refs, by_member, at) values(?, ?, ?, ?, ?, ?, ?)').run(
      id,
      args.to ?? null,
      args.topic ?? null,
      args.text,
      JSON.stringify(args.refs ?? []),
      member.id,
      Date.now(),
    )
    appendEvent(db, {
      kind: 'message.sent',
      memberId: member.id,
      payload: { msg_id: id, to: args.to ?? null, topic: args.topic ?? null, text: args.text, refs: args.refs ?? [] },
    })
  })
  return { msg_id: id }
}

/** 状态面：server 归约出的只读状态（agent 不能写） */
export async function stateGet(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  sweepExpired(db)
  const op = args.op
  const tasks = op
    ? db.prepare('select * from tasks where op = ? order by created_at asc').all(op)
    : db.prepare('select * from tasks order by created_at asc limit 500').all()
  return {
    op: op ?? null,
    slots: op ? slotRounds(db, op) : {},
    tasks: tasks.map(hydrateTask),
    artifacts: db
      .prepare('select id, uri, sha256, size, by_member from artifacts where (? is null or task_id in (select id from tasks where op = ?))')
      .all(op ?? null, op ?? null),
  }
}

export async function resourceAcquire(ctx, args = {}) {
  const { db, member } = ctx
  assertAttached(member)
  const name = args.name
  if (!name) throw new SpaceError('RESOURCE_BUSY', 'resource name required')
  const leaseSec = Number(args.lease_sec ?? DEFAULT_LEASE_SEC)
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
  assertAttached(member)
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
  const drift = verifyProjection(ctx.db)
  return { ok: drift.length === 0, drift }
}
