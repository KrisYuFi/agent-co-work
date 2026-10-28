/**
 * src/space/invariants.mjs — 服务端不变式（协议 §4.2 / §5）
 *
 * 这是本项目「机制优于自然语言」的落地点：凡是原来写在 error-handling.md 里
 * 靠 agent 记住的规则，在这里变成**返回错误码**。
 *
 * 已实现：R1 终态不可变、迁移表、handoff 必填、认领互斥、R2 轮次不清零、R3 硬门槛归人
 * 明确未实现（阶段 4）：R4 杠杆评估门、R5 修改不越权 —— 二者需要现有工作流的语义，
 *   在阶段 4 与 ops-direct-invoke 全量映射时一起落。
 */

export class SpaceError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export const TERMINAL_STATES = new Set(['DONE', 'FAILED', 'REJECTED', 'CANCELED'])
export const ACTIVE_STATES = new Set(['PENDING', 'CLAIMED', 'WORKING'])
export const INTERRUPTED_STATES = new Set(['WAITING_INPUT', 'WAITING_AUTH', 'BLOCKED'])

/** 任务类型（协议 §7.1）。必须在 server 侧校验——schema 只是提示，不是边界。 */
export const TASK_TYPES = new Set(['assign', 'broadcast', 'revision', 'question', 'answer', 'notice'])

/** 只有 QA 或人可打回他人任务（协议 §4.2「QA（非本人）」） */
export function assertCanRequestRevision(member) {
  if (member.kind === 'human' || member.role === 'qa') return
  throw new SpaceError(
    'FORBIDDEN_ROLE',
    `只有 qa 或 human 可以打回他人任务；${member.id} is ${member.kind}/${member.role}`,
  )
}

/** 迁移表（协议 §4.2）。只列允许的边，表外的一律非法。 */
export const TRANSITIONS = {
  PENDING: ['CLAIMED', 'CANCELED'],
  CLAIMED: ['WORKING', 'PENDING', 'CANCELED'], // → PENDING 由吊销/释放触发
  WORKING: [
    'DONE',
    'FAILED',
    'WAITING_INPUT',
    'WAITING_AUTH',
    'BLOCKED',
    'REVISION_REQUESTED',
    'CANCELED',
    'PENDING',
  ],
  WAITING_INPUT: ['WORKING', 'FAILED', 'CANCELED'],
  WAITING_AUTH: ['WORKING', 'FAILED', 'CANCELED'],
  BLOCKED: ['WORKING', 'FAILED', 'CANCELED'],
  // 终态没有出边
  DONE: [],
  FAILED: [],
  REJECTED: [],
  CANCELED: [],
  // EXPIRED / REVISION_REQUESTED 是投影态：EXPIRED 立即回落 PENDING，不单独停留
  EXPIRED: ['PENDING'],
  REVISION_REQUESTED: ['PENDING', 'CANCELED'],
}

/** R1：终态不可变 */
export function assertNotTerminal(task) {
  if (TERMINAL_STATES.has(task.state)) {
    throw new SpaceError('TASK_STATE_INVALID', `task ${task.id} is in terminal state ${task.state}: 终态不可变（R1）`)
  }
}

/** 迁移表校验 */
export function assertTransition(from, to) {
  const allowed = TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) {
    throw new SpaceError('TASK_STATE_INVALID', `illegal transition ${from} → ${to}`)
  }
}

/** 租约持有者校验 */
export function assertLeaseHolder(task, leaseId, member) {
  if (!leaseId || task.lease_id !== leaseId) {
    throw new SpaceError('LEASE_MISMATCH', `lease mismatch on task ${task.id}`)
  }
  if (task.owner !== member.id) {
    throw new SpaceError('LEASE_MISMATCH', `task ${task.id} is held by ${task.owner}, not ${member.id}`)
  }
}

/**
 * 认领互斥（协议 §8.1）：单条事务内判断。
 *
 * 语义（修复见 ADR 0008）：`claims_count` 是**当前并发认领数**，不是终身计数。
 * 任务回到 PENDING 时它必须归零，否则一次租约过期就把任务变成「PENDING 但谁也不能认领」的僵尸。
 * 重试预算由 `attempts` 单独承担（sweep 时 +1，超 MAX_ATTEMPTS 转 FAILED）。
 */
export function assertClaimable(task) {
  if (task.state !== 'PENDING') {
    throw new SpaceError('TASK_ALREADY_CLAIMED', `task ${task.id} is ${task.state}, not claimable`)
  }
  if (Number(task.claims_count ?? 0) >= Number(task.claims_max ?? 1)) {
    throw new SpaceError('TASK_ALREADY_CLAIMED', `task ${task.id} already has ${task.claims_count} active claim(s)`)
  }
}

/** WORKING → DONE 必须同时提交 handoff 引用（协议 §4.2） */
export function assertHandoff(payload) {
  const h = payload?.handoff
  if (!h || !h.uri || !h.sha256) {
    throw new SpaceError('HANDOFF_MISSING', 'transition to DONE requires payload.handoff {uri, sha256}')
  }
  return h
}

/** 必须有 reason 与证据（FAILED 分支） */
export function assertFailureEvidence(payload) {
  if (!payload?.reason) {
    throw new SpaceError('EVIDENCE_INSUFFICIENT', 'transition to FAILED requires payload.reason')
  }
}

/**
 * R3：硬门槛不得由验收方自行放宽。
 * 权威结论只认 human——这是「机制」，不是提示词里的劝阻。
 */
export function assertCanRelaxHardGate(member) {
  if (member.kind !== 'human') {
    throw new SpaceError(
      'FORBIDDEN_ROLE',
      `硬门槛只能由 human 放宽；${member.id} is ${member.kind}（R3）。请提交建议按已知限制收口 + 完整依据`,
    )
  }
}

/** 轮次槽位上限（协议 §5.1） */
export const SLOT_LIMITS = { design: 3, joint_debug: 3, acceptance: 3 }

/**
 * CP → slot 的服务端映射（协议 §5.2）。
 *
 * 修复（ADR 0008）：原来 slot 直接取客户端入参，等于让被约束方自己选边界——
 * 换个字符串就重置轮次。现在客户端只能报 CP 名，slot 由服务端查表得出。
 */
export const SLOT_BY_CP = {
  CP1: 'design',
  'CP2.1': 'design',
  'CP2.2': 'design',
  CP3: 'acceptance',
  CP4: 'acceptance',
  CP5: 'acceptance',
  '3.4': 'joint_debug',
}

/**
 * R2：revision 任务创建时按语义归属确定 slot，round += 1，超限拒绝。
 * 跨环节回退**不清零**发起方槽位——这条靠忘就会失去循环边界，所以在这里硬来。
 */
export function bumpSlot(db, op, slot) {
  const limit = SLOT_LIMITS[slot]
  if (limit === undefined) {
    throw new SpaceError('TASK_STATE_INVALID', `unknown revision slot: ${slot}`)
  }
  const row = db.prepare('select round from slots where op = ? and slot = ?').get(op, slot)
  const round = (row?.round ?? 0) + 1
  if (round > limit) {
    db.prepare('insert into slots(op, slot, round) values(?, ?, ?) on conflict(op, slot) do update set round = excluded.round').run(
      op,
      slot,
      round,
    )
    throw new SpaceError('LOOP_EXHAUSTED', `slot ${slot} of ${op} exhausted (${round}/${limit})：暂停待人工决策`, {
      slot,
      round,
      limit,
    })
  }
  db.prepare('insert into slots(op, slot, round) values(?, ?, ?) on conflict(op, slot) do update set round = excluded.round').run(
    op,
    slot,
    round,
  )
  return round
}

export function slotRounds(db, op) {
  const rows = db.prepare('select slot, round from slots where op = ?').all(op)
  const out = {}
  for (const r of rows) out[r.slot] = r.round
  return out
}
