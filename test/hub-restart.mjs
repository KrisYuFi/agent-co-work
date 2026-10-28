#!/usr/bin/env node
/**
 * test/hub-restart.mjs — hub 重启 / 网络断开后的恢复
 *
 * 「agent 离线是常态」这句话，对**服务端**同样成立：hub 会重启、网络会断。
 * 这个测试验三件事：
 *   1. hub 挂掉时，成员在飞的 wait 会被打断（客户端要能扛住这个错误）
 *   2. hub 起来后，**同一个 token 不需要重新 attach**（attach 状态落在库里，不在进程内存里）
 *   3. 重启期间攒下的未读任务，成员重连后能拿到（attach 回 unread_tasks）
 *
 * 用法：node test/hub-restart.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const PORT = 7399

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const spaceDir = mkdtempSync(join(tmpdir(), 'space-restart-'))
spaceCli(['init', '--dir', spaceDir])
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })
const tokens = {}
for (const [m, role] of [['dev', 'developer'], ['pm', 'pm']]) {
  tokens[m] = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', m, '--role', role]).trim()
}
const URL_ = `http://127.0.0.1:${PORT}/mcp`

function startHub() {
  const p = spawn(NODE, [CLI, 'serve', '--dir', spaceDir, '--listen', `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.resume()
  return p
}
let hub = startHub()
await sleep(1000)

let rid = 0
async function rpc(token, method, params) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
  })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const msg = await res.json()
  if (msg.error) throw new Error(msg.error.message)
  return msg.result
}
async function tool(token, name, args = {}) {
  const result = await rpc(token, 'tools/call', { name, arguments: args })
  const payload = JSON.parse(result.content[0].text)
  if (result.isError) {
    const e = new Error(payload.message)
    e.code = payload.error
    throw e
  }
  return payload
}

// 1) 双方 attach
const devAttach = await tool(tokens.dev, 'space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
await tool(tokens.pm, 'space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
check('两个成员 attach 成功', Boolean(devAttach.member?.id))

// 2) dev 先挂一个长轮询（此时没有任务，它会真的挂住），然后我们把 hub 杀掉
const hanging = tool(tokens.dev, 'space_wait', { since_cursor: devAttach.cursor, timeout_sec: 60 }).then(
  (r) => ({ ok: true, r }),
  (e) => ({ ok: false, e }),
)
await sleep(400)
hub.kill('SIGKILL')
const hangResult = await hanging
check('hub 挂掉时，在飞的 wait 被打断（客户端必须能扛）', hangResult.ok === false, String(hangResult.e?.message ?? '').slice(0, 60))

// 4) 重启 hub，**不重新 attach**，直接用同一个 token 调用
hub = startHub()
await sleep(1000)

// 重启期间（此刻 hub 已恢复）pm 派一个任务给 dev：模拟「成员不在线时任务攒着」
const created = await tool(tokens.pm, 'space_task_create', { type: 'assign', to: 'dev', op: 'restart-op', step: '3.1' })
check('hub 恢复后任务创建成功', Boolean(created.task_id), created.task_id)

let afterRestart = null
try {
  afterRestart = await tool(tokens.dev, 'space_wait', { since_cursor: 0, timeout_sec: 2 })
  check('重启后同一 token 直接可用（不需要重新 attach）', true, `reason=${afterRestart.reason}`)
} catch (err) {
  check('重启后同一 token 直接可用（不需要重新 attach）', false, err.code ?? err.message)
}

// 5) 未读任务补投：attach 回来时应带上重启前派的那条
const reattach = await tool(tokens.dev, 'space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
const unread = reattach.unread_tasks ?? []
check('未读任务补投（attach 带回重启期间攒下的任务）', unread.some((t) => t.task_id === created.task_id), `${unread.length} 条未读`)

// 6) 接着把任务做完，证明恢复后链路是通的
const claim = await tool(tokens.dev, 'space_task_claim', { task_id: created.task_id })
await tool(tokens.dev, 'space_task_transition', { task_id: created.task_id, lease_id: claim.lease_id, to: 'WORKING' })
const body = Buffer.from('artifact after hub restart\n')
const sha = (await import('node:crypto')).createHash('sha256').update(body).digest('hex')
writeFileSync(join(spaceDir, 'artifacts', 'after-restart.txt'), body)
await tool(tokens.dev, 'space_publish', { uri: 'artifacts/after-restart.txt', sha256: sha, size: body.length, media_type: 'text/plain', task_id: created.task_id })
await tool(tokens.dev, 'space_task_transition', {
  task_id: created.task_id,
  lease_id: claim.lease_id,
  to: 'DONE',
  payload: { handoff: { uri: 'artifacts/after-restart.txt', sha256: sha, size: body.length }, reason: 'recovered' },
})
const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const row = db.prepare('select state, handoff_uri from tasks where id = ?').get(created.task_id)
check('重启后仍能完成整条链路（认领→发布→DONE+handoff）', row?.state === 'DONE' && Boolean(row?.handoff_uri), `${row?.state}`)

// 7) detach 会清掉 attached_at（否则「离线」语义就是假的）
await tool(tokens.dev, 'space_detach', {})
try {
  await tool(tokens.dev, 'space_task_list', {})
  check('detach 之后必须重新 attach 才能用工具', false, 'no error raised')
} catch (err) {
  check('detach 之后必须重新 attach 才能用工具', err.code === 'NOT_ATTACHED', err.code)
}

db.close()
hub.kill('SIGKILL')
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
