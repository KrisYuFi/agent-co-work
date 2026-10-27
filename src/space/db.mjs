/**
 * src/space/db.mjs — 空间库：打开、迁移、事务
 *
 * 决策见 ADR 0006：Node 内置 node:sqlite，WAL，N 个无状态进程共享单库。
 * 所有写操作都在 BEGIN IMMEDIATE 事务里完成——认领互斥、资源互斥、租约回收
 * 因此退化为单库事务，而不是分布式协调。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const SCHEMA_VERSION = 1
export const DEFAULT_SPACE_DIR = '.space'

export function resolveSpaceDir(explicit) {
  return resolve(explicit || process.env.SPACE_DIR || DEFAULT_SPACE_DIR)
}

const SCHEMA = `
create table if not exists meta (
  key   text primary key,
  value text not null
);

-- 成员：由 token 签发时创建，attach 只更新 last_seen / capabilities
create table if not exists members (
  id            text primary key,
  role          text not null,
  kind          text not null default 'role',   -- role | human | supervisor
  capabilities  text not null default '{}',     -- { max_block_sec, ... }
  status        text not null default 'active', -- active | revoked
  created_at    integer not null,
  last_seen_at  integer
);

-- 身份：只存哈希（ADR 0007）
create table if not exists tokens (
  token_hash  text primary key,
  prefix      text not null,
  member_id   text not null references members(id),
  role        text not null,
  scopes      text not null default '[]',
  issued_at   integer not null,
  expires_at  integer,
  revoked_at  integer
);
create index if not exists idx_tokens_member on tokens(member_id);

-- 任务：从 events 归约出的投影（只存最新值）
create table if not exists tasks (
  id           text primary key,
  op           text not null,
  step         text,
  type         text not null,             -- assign | broadcast | revision | question | answer | notice
  slot         text,                      -- design | joint_debug | acceptance
  to_member    text,
  role         text,
  state        text not null,
  attempts     integer not null default 0,
  claims_max   integer not null default 1,
  claims_count integer not null default 0,
  inputs       text not null default '[]',
  expected     text not null default '{}',
  refs         text not null default '[]',
  lease_id     text,
  lease_until  integer,
  lease_sec    integer not null default 300,
  owner        text,                      -- 当前租约持有者
  handoff_uri  text,
  handoff_sha  text,
  reason       text,
  created_by   text,
  created_at   integer not null,
  updated_at   integer not null
);
create index if not exists idx_tasks_state on tasks(state);
create index if not exists idx_tasks_to on tasks(to_member);

-- 事件：append-only，唯一真相来源，也是 trace
create table if not exists events (
  id        integer primary key autoincrement,
  kind      text not null,
  task_id   text,
  member_id text,
  payload   text not null default '{}',
  at        integer not null
);
create index if not exists idx_events_task on events(task_id);

-- 制品：只存引用，不存字节（铁律：消息只传引用）
create table if not exists artifacts (
  id         text primary key,
  uri        text not null,
  sha256     text not null,
  size       integer,
  media_type text,
  by_member  text not null,
  task_id    text,
  meta       text not null default '{}',
  created_at integer not null
);

-- 消息：控制面瞬时信号，不归档
create table if not exists messages (
  id        text primary key,
  to_member text,
  topic     text,
  text      text not null,
  refs      text not null default '[]',
  by_member text not null,
  at        integer not null
);

-- 资源：一等公民（fpga:0 等），认领即持租约
create table if not exists resources (
  name       text primary key,
  lease_id   text,
  member_id  text,
  until      integer
);

-- 轮次槽位：R2 的载体
create table if not exists slots (
  op    text not null,
  slot  text not null,
  round integer not null default 0,
  primary key (op, slot)
);
`

export function openDb(spaceDir, { create = false } = {}) {
  const dir = resolveSpaceDir(spaceDir)
  const file = join(dir, 'space.sqlite')
  if (!create && !existsSync(file)) {
    throw new Error(`space not found at ${dir} (run: space init --dir ${dir})`)
  }
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  if (!metaGet(db, 'schema_version')) {
    metaSet(db, 'schema_version', String(SCHEMA_VERSION))
    metaSet(db, 'constitution_version', '1')
    metaSet(db, 'created_at', String(Date.now()))
  }
  db.spaceDir = dir
  return db
}

export function metaGet(db, key) {
  const row = db.prepare('select value from meta where key = ?').get(key)
  return row?.value ?? null
}

export function metaSet(db, key, value) {
  db.prepare('insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(
    key,
    String(value),
  )
}

/** 事务包装：默认 IMMEDIATE，确保写锁先拿到，避免升级死锁 */
export function txn(db, fn, mode = 'IMMEDIATE') {
  db.exec(`BEGIN ${mode}`)
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
