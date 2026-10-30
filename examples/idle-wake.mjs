#!/usr/bin/env node
/**
 * examples/idle-wake.mjs — 「空闲被唤醒」的最小验证（真实 opencode 会话）
 *
 * 场景（对应 plugins/opencode-space.js）：
 *   1. space up 起空间；opencode 会话空闲着（只回答过一句 OK，**没有**任何接管空间的提示词）
 *   2. 脚本以 pm 身份派一个任务给 dev
 *   3. 插件轮询到 PENDING（0 token），把会话叫醒，注入 join+claim 指令
 *   4. agent 自己 join → attach → claim → WORKING
 *   5. 以库内事实核对，不用看模型怎么说
 *
 * 用法：node examples/idle-wake.mjs [--keep]
 * 成本：两次模型 turn 左右（首轮 + 唤醒轮）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const PLUGIN = join(REPO, 'plugins', 'opencode-space.js')
const KEEP = process.argv.includes('--keep')
const PORT = 7463
const URL_ = `http://127.0.0.1:${PORT}/mcp`

function realNode() {
  const bad = (p) => /DSH Desktop|\.desktop-bin/.test(p)
  if (!bad(process.execPath) && !process.versions.electron) return process.execPath
  for (const d of (process.env.PATH ?? '').split(':')) {
    const p = join(d, 'node')
    if (d && !bad(p) && existsSync(p)) return p
  }
  return 'node'
}
const NODE = realNode()

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const work = mkdtempSync(join(tmpdir(), 'space-idlewake-'))
// 兜底：任何一步卡住都不该让脚本无声挂着
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: 240s 未完成，退出')
  process.exit(2)
}, 240_000)
const spaceDir = join(work, 'space')
const sessDir = join(work, 'dev-session')
mkdirSync(sessDir, { recursive: true })

// ── 空间 + hub
const hub = spawn(NODE, [CLI, 'up', '--dir', spaceDir, '--listen', `127.0.0.1:${PORT}`, '--members', 'pm:pm,dev:developer'], { stdio: ['ignore', 'pipe', 'pipe'] })
hub.stdout.resume()
hub.stderr.resume()
await sleep(1500)
const devToken = readFileSync(join(spaceDir, 'tokens', 'dev.token'), 'utf8').trim()
const pmToken = readFileSync(join(spaceDir, 'tokens', 'pm.token'), 'utf8').trim()

// ── 会话目录：opencode.json（网关）+ 插件
writeFileSync(
  join(sessDir, 'opencode.json'),
  JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      permission: { edit: 'allow', bash: 'allow', external_directory: 'allow' },
      mcp: { space: { type: 'local', command: [NODE, CLI, 'connect'], enabled: true, timeout: 120000 } },
    },
    null,
    2,
  ),
)
mkdirSync(join(sessDir, '.opencode', 'plugins'), { recursive: true })
cpSync(PLUGIN, join(sessDir, '.opencode', 'plugins', 'opencode-space.js'))
const pluginLog = join(work, 'plugin.log')

// ── 起 opencode serve（插件带环境变量启动）
const env = {
  ...process.env,
  PATH: `${dirname(NODE)}:${process.env.PATH}`,
  SPACE_URL: URL_,
  SPACE_TOKEN: devToken,
  SPACE_ALIAS: 'work',
  SPACE_POLL_MS: '3000',
  SPACE_COOLDOWN_MS: '3000',
  SPACE_LOG: pluginLog,
}
const serve = spawn('opencode', ['serve', '--port', '7464'], { cwd: sessDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
serve.stderr.pipe(process.stderr)
const base = 'http://127.0.0.1:7464'
const q = `directory=${encodeURIComponent(sessDir)}`

async function httpRpc(token, method, params, id = 1) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return res.json()
}
async function pmCall(name, args, id = Math.floor(Math.random() * 1e6)) {
  const msg = await httpRpc(pmToken, 'tools/call', { name, arguments: args }, id)
  return JSON.parse(msg.result.content[0].text)
}

try {
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`${base}/session/status?${q}`)).ok
    } catch {}
    if (!up) await sleep(250)
  }
  check('opencode serve 就绪', up)

  // pm 先 attach，用于稍后派活
  await httpRpc(pmToken, 'tools/call', { name: 'space_attach', arguments: {} }, 9001)

  const s = await (await fetch(`${base}/session?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
  await fetch(`${base}/session/${s.id}/prompt_async?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '只回复 OK 两个字，不要调用任何工具，也不要提到协作空间。' }], model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' } }),
  })

  // 等它空闲（插件日志出现 session.idle）
  let idle = false
  for (let i = 0; i < 240 && !idle; i++) {
    if (existsSync(pluginLog) && readFileSync(pluginLog, 'utf8').includes('session.idle')) idle = true
    else await sleep(250)
  }
  check('会话进入空闲（没有任何空间提示词）', idle)

  // pm 派活
  const task = await pmCall('space_task_create', { type: 'assign', to: 'dev', op: 'idle-wake', step: '1', expected: { note: '插件唤醒你的测试' } })
  check('pm 派活成功', Boolean(task.task_id), task.task_id)

  // 等插件唤醒 + agent 认领
  const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
  const events0 = () => db.prepare('select kind, member_id from events order by id').all()
  let state = null
  for (let i = 0; i < 160; i++) {
    const row = db.prepare('select state, owner from tasks where id = ?').get(task.task_id)
    state = row?.state ?? null
    if (state === 'WORKING') break
    if (i % 10 === 0) console.log(`  …${(i * 0.5).toFixed(0)}s 任务态：${state ?? '?'}`)
    await sleep(500)
  }
  check('agent 被唤醒并认领到 WORKING', state === 'WORKING', `state=${state}`)
  check(
    '插件确实注入过唤醒（日志有 wake 记录）',
    existsSync(pluginLog) && /"msg":"wake"/.test(readFileSync(pluginLog, 'utf8')),
  )
  const devAttached = events0().some((e) => e.kind === 'member.attached' && e.member_id === 'dev')
  check('agent 自己 join 并报到了空间（member.attached=dev）', devAttached)

  const events = events0()
  console.log('\n事件流：')
  for (const e of events.slice(-8)) console.log(`  ${e.kind.padEnd(20)} ${e.member_id ?? ''}`)
} finally {
  serve.kill('SIGKILL')
  hub.kill('SIGKILL')
  await sleep(300)
  clearTimeout(watchdog)
  console.log(`\n工作目录：${work}${KEEP ? '（--keep）' : ''}`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
