#!/usr/bin/env node
/**
 * test/gateway.mjs — 成员侧网关：运行时加入 + 多空间隔离（ADR 0011 / 0012）
 *
 * 场景（**不起模型**，只验接入层）：
 *   两个独立的 hub（两个空间）：
 *     work  → 身份 pm
 *     team  → 身份 dev
 *   一个网关进程同时加入两个空间，然后：
 *     - 各自 attach，拿到各自的身份
 *     - work 里派的任务，在 team 侧看不见（隔离）
 *     - 调用不带 space 且连了两个 → 拒绝（AMBIGUOUS_SPACE），不猜
 *     - leave 掉一个之后，省略 space 又能用了
 *
 * 用法：node test/gateway.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// ───────────────────────────────────────────── 两个空间 + 两个 hub
function makeSpace(members) {
  const dir = mkdtempSync(join(tmpdir(), 'space-gw-'))
  const out = spaceCli(['init', '--dir', dir, '--members', members])
  return { dir, out }
}

const work = makeSpace('pm:pm')
const team = makeSpace('dev:developer')

function issue(space, member, role) {
  return spaceCli(['token', 'issue', '--dir', space.dir, '--member', member, '--role', role]).trim()
}
const workToken = issue(work, 'pm', 'pm')
const teamToken = issue(team, 'dev', 'developer')

function startHub(dir, port) {
  const p = spawn(NODE, [CLI, 'serve', '--dir', dir, '--listen', `127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.resume()
  return p
}
const hubA = startHub(work.dir, 7401)
const hubB = startHub(team.dir, 7402)
await sleep(1200)

// ───────────────────────────────────────────── 网关（stdio MCP client）
const gw = spawn(NODE, [CLI, 'connect'], { stdio: ['pipe', 'pipe', 'pipe'] })
const gwLog = []
gw.stderr.setEncoding('utf8')
gw.stderr.on('data', (d) => gwLog.push(...String(d).split('\n').filter(Boolean)))

let nextId = 1
const pending = new Map()
let buf = ''
gw.stdout.setEncoding('utf8')
gw.stdout.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout ${method}`)), 30000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      res(msg)
    })
    gw.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function tool(name, args = {}) {
  const msg = await rpc('tools/call', { name, arguments: args })
  const payload = JSON.parse(msg?.result?.content?.[0]?.text ?? '{}')
  if (msg?.result?.isError) {
    const e = new Error(payload.message)
    e.code = payload.error
    throw e
  }
  return payload
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gw-test', version: '0' } })
gw.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const toolList = await rpc('tools/list', {})
const names = toolList.result.tools.map((t) => t.name)
check('网关启动时就暴露完整工具集（含 3 个网关工具）', ['space_join', 'space_leave', 'space_spaces', 'space_attach', 'space_wait'].every((n) => names.includes(n)), `${names.length} 个工具`)
check('hub 工具在网关层多一个可选 space 参数', Boolean(toolList.result.tools.find((t) => t.name === 'space_wait')?.inputSchema?.properties?.space))

// 未加入任何空间时
try {
  await tool('space_task_list', {})
  check('未加入空间时调用 hub 工具被拒', false, 'no error raised')
} catch (err) {
  check('未加入空间时调用 hub 工具被拒（NOT_JOINED）', err.code === 'NOT_JOINED', err.code)
}

// 加入两个空间
await tool('space_join', { space: 'work', url: 'http://127.0.0.1:7401/mcp', token: workToken })
await tool('space_join', { space: 'team', url: 'http://127.0.0.1:7402/mcp', token: teamToken })
const spaces = await tool('space_spaces', {})
check('一个会话同时加入两个空间', spaces.spaces.length === 2, JSON.stringify(spaces.spaces.map((s) => s.space)))

// 各自 attach，拿各自的身份
const aWork = await tool('space_attach', { space: 'work', constitution_version: 1, capabilities: { max_block_sec: 20 } })
const aTeam = await tool('space_attach', { space: 'team', constitution_version: 1, capabilities: { max_block_sec: 20 } })
check('两个空间的 attach 各自独立（work=pm / team=dev）', aWork.member.id === 'pm' && aTeam.member.id === 'dev', `${aWork.member.id} / ${aTeam.member.id}`)

// 多空间时省略 space 必须拒绝
try {
  await tool('space_task_list', {})
  check('多空间时省略 space 被拒', false, 'no error raised')
} catch (err) {
  check('多空间时省略 space 被拒（AMBIGUOUS_SPACE，不猜）', err.code === 'AMBIGUOUS_SPACE', err.code)
}

// work 里派活，team 里看不见
const created = await tool('space_task_create', { space: 'work', type: 'assign', to: 'pm', op: 'gw-op', step: '1.1' })
const workTasks = await tool('space_task_list', { space: 'work' })
const teamTasks = await tool('space_task_list', { space: 'team' })
check('任务只在派发的空间可见（隔离）', workTasks.tasks.some((t) => t.task_id === created.task_id) && !teamTasks.tasks.some((t) => t.task_id === created.task_id), `work=${workTasks.tasks.length} team=${teamTasks.tasks.length}`)

// wait 也按空间隔离
const workWait = await tool('space_wait', { space: 'work', since_cursor: 0, timeout_sec: 2 })
check('wait 能拿到本空间的任务', workWait.tasks.some((t) => t.task_id === created.task_id), `reason=${workWait.reason}`)

// leave 掉 team 之后，省略 space 又能用
await tool('space_leave', { space: 'team' })
const afterLeave = await tool('space_task_list', {})
check('离开一个空间后，省略 space 自动落到剩下的那个', afterLeave.tasks.some((t) => t.task_id === created.task_id), `${afterLeave.tasks.length} 条`)

// 未知别名
try {
  await tool('space_task_list', { space: 'nope' })
  check('未知别名被拒', false, 'no error raised')
} catch (err) {
  check('未知别名被拒（UNKNOWN_SPACE）', err.code === 'UNKNOWN_SPACE', err.code)
}

// token 无效时 hub 会 401，网关要把它透出来
await tool('space_join', { space: 'bad', url: 'http://127.0.0.1:7401/mcp', token: 'spt_deadbeef' })
try {
  await tool('space_attach', { space: 'bad', constitution_version: 1 })
  check('坏 token 被 hub 拒绝并透出', false, 'no error raised')
} catch (err) {
  check('坏 token 被 hub 拒绝并透出（TOKEN_INVALID）', err.code === 'TOKEN_INVALID', err.code)
}

gw.kill('SIGKILL')
hubA.kill('SIGKILL')
hubB.kill('SIGKILL')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log(`  - ${f.n}${f.d ? `: ${f.d}` : ''}`)
process.exit(failed.length ? 1 : 0)
