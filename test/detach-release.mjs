#!/usr/bin/env node
/**
 * test/detach-release.mjs — 「成员下线 = 交还手上的活」（离线，不起模型）
 *
 * 背景：会话关掉后任务要等租约过期（默认 900s）才回队——这是多机实跑踩出来的坑。
 * 关会话是**明确信号**，不该按崩溃处理。本测试验证两条下线路径都立刻回队：
 *
 *   A. 直接 space_detach —— hub 立刻把该成员持有的任务收回 PENDING，并改派到角色
 *   B. 网关进程退出（会话结束）—— 网关在 shutdown 时自动 detach，效果同上
 *
 * 同时验证「收回不等于失败」：attempts 不增加，同角色的另一个成员能立刻接着干。
 *
 * 用法：node test/detach-release.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const PORT = 7447
const URL_ = `http://127.0.0.1:${PORT}/mcp`

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const dir = mkdtempSync(join(tmpdir(), 'space-detach-'))
spaceCli(['init', '--dir', dir, '--members', 'pm:pm,dev:developer,dev2:developer'])
const token = (name) => readFileSync(join(dir, 'tokens', `${name}.token`), 'utf8').trim()

const hub = spawn(NODE, [CLI, 'serve', '--dir', dir, '--listen', `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
hub.stderr.resume()
await sleep(1200)

async function rpc(who, method, params, id = 1) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token(who)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}
const call = async (who, name, args, extra = {}) => {
  const r = await rpc(who, 'tools/call', { name, arguments: args, ...extra }, Math.floor(Math.random() * 1e6))
  const text = r?.content?.[0]?.text ?? ''
  const parsed = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })()
  if (r?.isError) throw Object.assign(new Error(parsed?.message ?? text), { code: parsed?.error })
  return parsed
}

const db = new DatabaseSync(join(dir, 'space.sqlite'))
const taskById = (id) => db.prepare('select * from tasks where id = ?').get(id)

// ───────────────────────────────────────────── A. 直接 detach
await call('pm', 'space_attach', {})
const created = await call('pm', 'space_task_create', { type: 'assign', to: 'dev', op: 'detach-demo', step: '1' })
const claimed = await call('dev', 'space_attach', {})
const lease = await call('dev', 'space_task_claim', { task_id: created.task_id })
await call('dev', 'space_task_transition', { task_id: created.task_id, lease_id: lease.lease_id, to: 'WORKING' })
check('dev 认领并进入 WORKING', taskById(created.task_id).state === 'WORKING')

const detached = await call('dev', 'space_detach', {})
const after = taskById(created.task_id)
check('detach 立刻收回任务（不等租约过期）', after.state === 'PENDING' && after.owner === null, `state=${after.state}`)
check('收回不算失败（attempts 不增加）', Number(after.attempts) === 0, `attempts=${after.attempts}`)
check('任务改派到角色（别人能接）', after.to_member === null && after.role === 'developer', `to=${after.to_member} role=${after.role}`)
check('detach 返回收回数量', detached.tasks_requeued === 1, JSON.stringify(detached))
check('成员已下线（attached_at 清空）', db.prepare("select attached_at from members where id='dev'").get().attached_at == null)

const dev2 = await call('dev2', 'space_attach', {})
const takeover = await call('dev2', 'space_task_claim', { task_id: created.task_id })
check('同角色成员可以立刻接手', Boolean(takeover.lease_id) && taskById(created.task_id).owner === 'dev2')

// ───────────────────────────────────────────── B. 网关退出 = 自动 detach
const gw = spawn(NODE, [CLI, 'connect'], { stdio: ['pipe', 'pipe', 'pipe'] })
gw.stderr.resume()
let gwBuf = ''
const gwPending = new Map()
gw.stdout.setEncoding('utf8')
gw.stdout.on('data', (d) => {
  gwBuf += d
  let nl
  while ((nl = gwBuf.indexOf('\n')) >= 0) {
    const line = gwBuf.slice(0, nl).trim()
    gwBuf = gwBuf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    gwPending.get(msg.id)?.(msg)
    gwPending.delete(msg.id)
  }
})
let gwId = 1
function gwCall(method, params) {
  const id = gwId++
  return new Promise((resolve, reject) => {
    gwPending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
    gw.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => reject(new Error(`gateway ${method} timeout`)), 15_000)
  })
}
await gwCall('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'detach-test', version: '0' }, capabilities: {} })
await gwCall('tools/call', { name: 'space_join', arguments: { space: 'work', url: URL_, token: token('dev2') } })
await gwCall('tools/call', { name: 'space_attach', arguments: {} })
// 用 pm 通过 HTTP 派活给 dev2，再让网关（dev2 身份）认领——网关自己不能派活给别人
const pmTask = await call('pm', 'space_task_create', { type: 'assign', to: 'dev2', op: 'detach-demo-2', step: '1' })
const gwClaim = await gwCall('tools/call', { name: 'space_task_claim', arguments: { task_id: pmTask.task_id } })
const gwClaimBody = JSON.parse(gwClaim.content[0].text)
check('网关侧认领成功（拿到 lease）', Boolean(gwClaimBody.lease_id), JSON.stringify(gwClaimBody).slice(0, 80))
await gwCall('tools/call', { name: 'space_task_transition', arguments: { task_id: pmTask.task_id, lease_id: gwClaimBody.lease_id, to: 'WORKING' } })

// 模拟会话结束：关掉网关的标准输入（opencode 关闭子进程时就是这样）
gw.stdin.end()
await new Promise((r) => gw.on('close', r))
await sleep(800)
const secondTask = taskById(pmTask.task_id)
check('网关退出后任务立刻回队（不需要等 900s）', secondTask?.state === 'PENDING', `state=${secondTask?.state}`)
check('网关退出后 failed 数不变（收回不是失败）', Number(secondTask?.attempts) === 0, `attempts=${secondTask?.attempts}`)

hub.kill('SIGTERM')
await sleep(300)
hub.kill('SIGKILL')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
