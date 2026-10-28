/**
 * src/space/events.mjs — 事件流与状态归约
 *
 * 铁律（协议 §3）：agent 不写状态，只发事件。state 是 events 的归约结果。
 *
 * 实现取「物化投影 + 可重放校验」：
 *   - 写路径：同一事务里 append 事件，并更新 tasks 投影（省去每次读都折叠）
 *   - 校验路径：reduceTask() 从事件重新折叠，verifyProjection() 比对投影是否漂移
 *   - trace：events 表本身就是 trace，不需要额外日志
 */

import { txn } from './db.mjs'

/** 追加一条事件，返回自增 id（同时充当游标） */
export function appendEvent(db, { kind, taskId = null, memberId = null, payload = {} }) {
  const info = db
    .prepare('insert into events(kind, task_id, member_id, payload, at) values(?, ?, ?, ?, ?)')
    .run(kind, taskId, memberId, JSON.stringify(payload ?? {}), Date.now())
  return Number(info.lastInsertRowid)
}

export function eventsSince(db, cursor, limit = 200) {
  return db
    .prepare('select id, kind, task_id, member_id, payload, at from events where id > ? order by id asc limit ?')
    .all(cursor, limit)
    .map(hydrate)
}

function hydrate(row) {
  return {
    id: row.id,
    kind: row.kind,
    task_id: row.task_id,
    member_id: row.member_id,
    payload: safeJson(row.payload),
    at: row.at,
  }
}

export function safeJson(text, fallback = {}) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 某个任务的全部事件，按时间正序 */
export function taskEvents(db, taskId) {
  return db
    .prepare('select id, kind, task_id, member_id, payload, at from events where task_id = ? order by id asc')
    .all(taskId)
    .map(hydrate)
}

/**
 * 从事件重新归约出一个任务的状态。用于校验物化投影有没有漂移（verifyProjection）。
 * 返回 { state, attempts }。
 */
export function reduceTask(events) {
  let state = null
  let attempts = 0
  let handoff = null
  let terminalAt = null
  let terminalMutated = false
  const TERMINAL = new Set(['DONE', 'FAILED', 'REJECTED', 'CANCELED'])

  for (const e of events) {
    if (terminalAt !== null && ['task.claimed', 'task.transitioned', 'task.expired', 'task.requeued'].includes(e.kind)) {
      terminalMutated = true // 终态之后还有状态类事件 —— R1 被破坏
    }
    switch (e.kind) {
      case 'task.created':
        state = 'PENDING'
        break
      case 'task.claimed':
        state = 'CLAIMED'
        break
      case 'task.transitioned':
        state = e.payload?.to ?? state
        if (e.payload?.handoff) handoff = e.payload.handoff
        break
      case 'task.expired':
        attempts += 1
        state = e.payload?.to ?? 'PENDING'
        break
      case 'task.requeued':
        state = 'PENDING'
        break
      default:
        break
    }
    if (TERMINAL.has(state)) terminalAt ??= e.id
  }
  return { state, attempts, handoff, terminalMutated }
}

/**
 * 校验所有任务投影与事件归约一致。返回漂移列表（空数组 = 一致）。
 * 这是「可重放」这条设计承诺的可执行形式，不是口号。
 */
export function verifyProjection(db) {
  const tasks = db.prepare('select id, type, state, attempts, handoff_uri, handoff_sha from tasks').all()
  const drift = []
  for (const t of tasks) {
    const reduced = reduceTask(taskEvents(db, t.id))

    if (reduced.state !== t.state || reduced.attempts !== t.attempts) {
      drift.push({
        task_id: t.id,
        kind: 'state_or_attempts',
        projected: { state: t.state, attempts: t.attempts },
        reduced: { state: reduced.state, attempts: reduced.attempts },
      })
    }

    // 终态之后仍有状态事件 —— 服务器自己的回收逻辑曾打破过 R1（ADR 0008 的修复点）
    if (reduced.terminalMutated) {
      drift.push({ task_id: t.id, kind: 'terminal_mutated', projected: t.state, reduced: reduced.state })
    }

    // handoff 交链：投影行 == 事件里的 handoff == 制品登记。
    // 只对「产出交付件」的任务要求 handoff；question/answer/notice 是人机问答，本来就没有文件
    const needsHandoff = ['assign', 'revision', 'broadcast'].includes(t.type)
    if (t.state === 'DONE' && needsHandoff) {
      const h = reduced.handoff
      if (!h) {
        drift.push({ task_id: t.id, kind: 'handoff_missing_in_events' })
      } else if (h.uri !== t.handoff_uri || h.sha256 !== t.handoff_sha) {
        drift.push({
          task_id: t.id,
          kind: 'handoff_mismatch',
          projected: { uri: t.handoff_uri, sha256: t.handoff_sha },
          reduced: h,
        })
      } else {
        const art = db.prepare('select uri, sha256 from artifacts where uri = ? and sha256 = ?').get(h.uri, h.sha256)
        if (!art) drift.push({ task_id: t.id, kind: 'handoff_artifact_missing', reduced: h })
      }
    }
  }
  return drift
}

/** 事件流 → 人可读 trace 行 */
export function formatEvent(e) {
  const p = e.payload ?? {}
  const bits = []
  if (p.to) bits.push(`→${p.to}`)
  if (p.from && p.to) bits[bits.length - 1] = `${p.from}→${p.to}`
  if (p.reason) bits.push(`reason=${p.reason}`)
  if (p.attempts !== undefined) bits.push(`attempts=${p.attempts}`)
  if (p.handoff) bits.push(`handoff=${p.handoff.uri}`)
  if (p.text) bits.push(`"${String(p.text).slice(0, 60)}"`)
  const who = e.member_id ? ` @${e.member_id}` : ''
  const task = e.task_id ? ` [${e.task_id}]` : ''
  return `${String(e.id).padStart(5)}  ${new Date(e.at).toISOString().slice(11, 23)}  ${e.kind}${task}${who}  ${bits.join(' ')}`.trimEnd()
}

/** 把一段操作包进事务：事件与投影必须同生共死 */
export function withEvent(db, fn) {
  return txn(db, fn)
}
