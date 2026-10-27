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
  for (const e of events) {
    switch (e.kind) {
      case 'task.created':
        state = 'PENDING'
        break
      case 'task.claimed':
        state = 'CLAIMED'
        break
      case 'task.transitioned':
        state = e.payload?.to ?? state
        break
      case 'task.expired':
        attempts += 1
        state = e.payload?.to ?? 'PENDING'
        break
      case 'task.requeued': // 吊销 / token 失效导致的任务回收
        state = 'PENDING'
        break
      default:
        break
    }
  }
  return { state, attempts }
}

/**
 * 校验所有任务投影与事件归约一致。返回漂移列表（空数组 = 一致）。
 * 这是「可重放」这条设计承诺的可执行形式，不是口号。
 */
export function verifyProjection(db) {
  const tasks = db.prepare('select id, state, attempts from tasks').all()
  const drift = []
  for (const t of tasks) {
    const reduced = reduceTask(taskEvents(db, t.id))
    if (reduced.state !== t.state || reduced.attempts !== t.attempts) {
      drift.push({ task_id: t.id, projected: { state: t.state, attempts: t.attempts }, reduced })
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
