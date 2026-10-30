/**
 * src/space/requeue.mjs — 释放成员持有的任务租约
 *
 * 两个调用点共用一个实现：token 吊销（ADR 0007）与成员主动下线（space_detach）。
 * 规则相同，理由也相同（ADR 0008）：
 *   - claims_count 必须归零：它是「当前并发认领数」，不清零任务就再也认领不了
 *   - to_member 必须改派到角色：否则回收后仍写着已下线的成员，别人照样接不了
 *   - 不算 attempts：这是**主动交还**，不是失败；记成失败会因为三次尝试把任务打死
 */

import { appendEvent } from './events.mjs'

export const HELD_STATES = ['CLAIMED', 'WORKING', 'WAITING_INPUT', 'WAITING_AUTH', 'BLOCKED']

/**
 * @param db 已打开的空间库；调用方负责事务边界
 * @param opts.emit 事件写入函数（默认本模块的 appendEvent；吊销路径会显式传）
 * @returns {{held:number, addressed:number}} 被收回 / 改派的任务数
 */
export function requeueHeldTasks(db, memberId, { reason = 'released', emit = appendEvent } = {}) {
  const held = db
    .prepare(`select id, state, to_member from tasks where owner = ? and state in (${HELD_STATES.map(() => '?').join(',')})`)
    .all(memberId, ...HELD_STATES)

  const member = db.prepare('select role from members where id = ?').get(memberId)
  const now = Date.now()
  for (const t of held) {
    const reassign = t.to_member === memberId
    db.prepare(
      `update tasks set state = 'PENDING', lease_id = null, lease_until = null, owner = null, claims_count = 0,
         to_member = case when ? then null else to_member end,
         role = case when ? then ? else role end,
         updated_at = ?
       where id = ?`,
    ).run(reassign ? 1 : 0, reassign ? 1 : 0, member?.role ?? null, now, t.id)
    emit(db, {
      kind: 'task.requeued',
      taskId: t.id,
      memberId,
      payload: { reason, from: t.state, to: 'PENDING', reassigned_to_role: reassign ? member?.role ?? null : null },
    })
  }

  // 还没开工但派给该成员的任务，同样要改派，否则会永远没人能领
  const addressed = db.prepare("select id from tasks where state = 'PENDING' and to_member = ?").all(memberId)
  for (const t of addressed) {
    db.prepare('update tasks set to_member = null, role = ?, updated_at = ? where id = ?').run(member?.role ?? null, now, t.id)
    emit(db, {
      kind: 'task.requeued',
      taskId: t.id,
      memberId,
      payload: { reason: `${reason}:reassigned`, from: 'PENDING', to: 'PENDING', reassigned_to_role: member?.role ?? null },
    })
  }

  return { held: held.length, addressed: addressed.length }
}
