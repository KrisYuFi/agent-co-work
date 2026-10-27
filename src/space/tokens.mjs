/**
 * src/space/tokens.mjs — 身份签发与校验（ADR 0007）
 *
 * 库里只存 sha256(token) + prefix；明文只在签发那一刻出现。
 * 签发走 CLI（能读库 = 管理员），不走 MCP —— 避免「管 token 的 token」这层自举。
 */

import { createHash, randomBytes } from 'node:crypto'
import { SpaceError } from './invariants.mjs'
import { txn } from './db.mjs'

export const TOKEN_PREFIX = 'spt_'

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function newToken() {
  return TOKEN_PREFIX + randomBytes(16).toString('hex')
}

/**
 * 签发 token。返回 { token, member_id, role, expires_at }，token 只此一次可见。
 */
export function issueToken(db, { memberId, role, kind = 'role', scopes = [], ttlMs = null }) {
  const token = newToken()
  const now = Date.now()
  const expiresAt = ttlMs == null ? null : now + ttlMs
  return txn(db, () => {
    const existing = db.prepare('select id, role, kind from members where id = ?').get(memberId)
    if (!existing) {
      db.prepare(
        'insert into members(id, role, kind, capabilities, status, created_at) values(?, ?, ?, ?, ?, ?)',
      ).run(memberId, role, kind, '{}', 'active', now)
    } else if (existing.role !== role || existing.kind !== kind) {
      throw new SpaceError(
        'FORBIDDEN_ROLE',
        `member ${memberId} already exists as ${existing.kind}/${existing.role}; refusing silent re-role to ${kind}/${role}`,
      )
    }
    db.prepare(
      'insert into tokens(token_hash, prefix, member_id, role, scopes, issued_at, expires_at) values(?, ?, ?, ?, ?, ?, ?)',
    ).run(hashToken(token), token.slice(0, 12), memberId, role, JSON.stringify(scopes), now, expiresAt)
    return { token, member_id: memberId, role, kind, scopes, expires_at: expiresAt }
  })
}

/** 校验 token → 成员；失败抛 TOKEN_INVALID / TOKEN_REVOKED */
export function authenticate(db, token) {
  if (!token) throw new SpaceError('TOKEN_INVALID', 'missing token')
  const row = db.prepare('select * from tokens where token_hash = ?').get(hashToken(token))
  if (!row) throw new SpaceError('TOKEN_INVALID', 'token not recognised')
  if (row.revoked_at) throw new SpaceError('TOKEN_REVOKED', `token revoked at ${new Date(row.revoked_at).toISOString()}`)
  if (row.expires_at && row.expires_at < Date.now()) {
    throw new SpaceError('TOKEN_REVOKED', `token expired at ${new Date(row.expires_at).toISOString()}`)
  }
  const member = db.prepare('select * from members where id = ?').get(row.member_id)
  if (!member || member.status === 'revoked') throw new SpaceError('TOKEN_REVOKED', `member ${row.member_id} is revoked`)
  return {
    id: member.id,
    role: member.role,
    kind: member.kind,
    scopes: JSON.parse(row.scopes || '[]'),
    token_prefix: row.prefix,
    capabilities: JSON.parse(member.capabilities || '{}'),
  }
}

/**
 * 吊销：token 作废 + 名下任务回收（协议 §2.2「吊销后已发出的 task 自动回 PENDING」）。
 * 失效与过期走同一条路径，不写第二套逻辑。
 */
export function revokeMember(db, memberId, { appendEvent, reason = 'revoked' } = {}) {
  return txn(db, () => {
    const now = Date.now()
    const res = db
      .prepare('update tokens set revoked_at = ? where member_id = ? and revoked_at is null')
      .run(now, memberId)
    db.prepare('update members set status = ? where id = ?').run('revoked', memberId)

    // 收回租约：CLAIMED / WORKING 回 PENDING
    const held = db
      .prepare("select id, state from tasks where owner = ? and state in ('CLAIMED','WORKING','WAITING_INPUT','WAITING_AUTH','BLOCKED')")
      .all(memberId)
    for (const t of held) {
      db.prepare(
        'update tasks set state = ?, lease_id = null, lease_until = null, owner = null, updated_at = ? where id = ?',
      ).run('PENDING', now, t.id)
      appendEvent?.(db, {
        kind: 'task.requeued',
        taskId: t.id,
        memberId,
        payload: { reason, from: t.state, to: 'PENDING' },
      })
    }
    db.prepare('update resources set lease_id = null, member_id = null, until = null where member_id = ?').run(memberId)
    appendEvent?.(db, { kind: 'token.revoked', memberId, payload: { reason, tokens_revoked: res.changes, tasks_requeued: held.length } })
    return { tokens_revoked: Number(res.changes), tasks_requeued: held.length }
  })
}

export function listTokens(db) {
  return db
    .prepare(
      `select t.prefix, t.member_id, t.role, t.issued_at, t.expires_at, t.revoked_at, m.kind, m.status
       from tokens t join members m on m.id = t.member_id order by t.issued_at desc`,
    )
    .all()
}
