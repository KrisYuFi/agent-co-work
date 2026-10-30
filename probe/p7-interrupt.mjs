#!/usr/bin/env node
/**
 * probe/p7-interrupt.mjs — P7/P8 探针：人「会话内打断」能不能传到在飞的 MCP 工具调用
 *
 * 对应 docs/background.md §3.1「待验：P7/P8 探针」与 R7 通道①：
 *   人在 agent 自己的会话里停止/纠正时，runtime 会不会对**正在阻塞的 MCP 工具请求**
 *   发 `notifications/cancelled`？会 → 通道①成立；不会 → 人只能等下一次工具边界。
 *
 * 判决只看服务器侧 JSONL（probe/mcp/server.mjs 的日志），不看客户端说法。
 *
 * 用法：
 *   node probe/p7-interrupt.mjs --scenario p7 --runtime opencode --label stop   # 按停止（P7）
 *   node probe/p7-interrupt.mjs --scenario p7 --runtime dsh      --label stop   # Ctrl+C 代理（P7）
 *   node probe/p7-interrupt.mjs --scenario p7 --runtime opencode --action message --label type  # 直接输入（P8）
 *   可选：--block 120  --keep
 *
 * P9（同一会话能否被第二个前端挂上看）是结构性能力，见 probe/RESULTS.md；本脚本不测。
 *
 * 代理关系（必须写清，不能替 runtime 圆）：
 *   · opencode 的「停止」用 POST /session/{id}/abort —— TUI 里按 Esc / 点停止走的就是这个接口。
 *     测的不是「新消息排队」，而是「停止当前 turn」，因为人看到错了第一步就是停。
 *   · dsh 的「停止」用 SIGINT 代理：headless 没有按钮，Ctrl+C 是它唯一的停止方式。
 *     若 SIGINT 直接杀进程、没走 abort → cancellation，结论要如实写成「headless 的
 *     停止不经过 abort 路径」。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'mcp', 'server.mjs')
const RESULTS = join(HERE, 'results', 'raw')

// 在 DSH Desktop 的沙箱里跑本探针时，process.execPath 可能是 Electron helper
// （Electron 的 node 能跑 .mjs，但 `#!/usr/bin/env node` 的 dsh 会被它接管而报
// Unsupported/no-context）。所以显式挑一个「非桌面壳」的 node 给 MCP 服务器与 dsh 用。
function realNode() {
  const isDesktopShell = (p) => /DSH Desktop|\.desktop-bin/.test(p)
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, 'node')
    if (!dir || isDesktopShell(p) || !existsSync(p)) continue
    return p
  }
  return isDesktopShell(process.execPath) ? '/usr/bin/env' : process.execPath
}
const NODE = realNode()
const NODE_DIR = dirname(NODE)

const argv = process.argv.slice(2)
const flag = (n, d) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : d)
const has = (n) => argv.includes(`--${n}`)

const SCENARIO = flag('scenario', 'p7')
const RUNTIME = flag('runtime', 'opencode')
const BLOCK_SEC = Number(flag('block', '120'))
const ACTION = flag('action', 'abort') // abort = 按停止；message = 直接输入新消息
const LABEL = flag('label', '')
const KEEP = has('keep')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const WORK = join(HERE, 'work', `${SCENARIO}.${RUNTIME}.${STAMP}`)
const LOG = join(WORK, 'mcp-server.jsonl')
const READY_TIMEOUT_MS = 120_000
const CANCEL_TIMEOUT_MS = 20_000

mkdirSync(WORK, { recursive: true })
mkdirSync(RESULTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const marks = []
const mark = (label, extra = {}) => {
  marks.push({ label, atMs: Date.now() - t0, ...extra })
  console.log(`  [${String(Date.now() - t0).padStart(6)}ms] ${label}${extra.reason ? ` — ${extra.reason}` : ''}`)
}

function readLog() {
  try {
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const hasEvent = (name) => readLog().some((e) => e.event === name)
const firstEvent = (name) => readLog().find((e) => e.event === name)

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return Boolean(await predicate())
}

function dshApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = raw.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

const PROMPT_OPENCODE = `只做一件事：调用工具 probe_probe_block，参数 {"seconds": ${BLOCK_SEC}}。不要解释、不要调用别的工具。`
const PROMPT_DSH = `只做一件事：调用工具 mcp__probe__probe_block，参数 {"seconds": ${BLOCK_SEC}}。不要解释、不要调用别的工具。`

function writeOpencodeConfig() {
  writeFileSync(
    join(WORK, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'deepseek/deepseek-v4-pro',
        permission: { external_directory: 'allow', edit: 'allow', bash: 'allow' },
        mcp: {
          probe: {
            type: 'local',
            command: [NODE, SERVER, '--log', LOG],
            enabled: true,
            // 刻意调大：先于它发生的是我们的 abort，否则分不清是超时还是打断
            timeout: 600_000,
          },
        },
      },
      null,
      2,
    ),
  )
}

function writeDshPatch() {
  writeFileSync(
    join(WORK, 'patch.yml'),
    [
      '- insert:',
      '    - id: probe',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: probe',
      '        transport: stdio',
      `        command: ${NODE}`,
      '        args:',
      `          - ${SERVER}`,
      '          - --log',
      `          - ${LOG}`,
      '        toolCallTimeoutMs: 600000',
    ].join('\n') + '\n',
  )
}

// ─────────────────────────────────────────────── P7/P8 · opencode（abort = TUI 停止；message = 直接输入）
async function runOpencode() {
  writeOpencodeConfig()
  const port = Number(flag('port', '7421'))
  const base = `http://127.0.0.1:${port}`
  const q = `directory=${encodeURIComponent(WORK)}`
  const serveLog = join(WORK, 'opencode-serve.log')
  const serve = spawn('opencode', ['serve', '--port', String(port)], { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] })
  serve.stdout.setEncoding('utf8')
  serve.stderr.setEncoding('utf8')
  serve.stdout.on('data', (d) => appendFileSync(serveLog, d))
  serve.stderr.on('data', (d) => appendFileSync(serveLog, d))

  try {
    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${base}/session/status?${q}`)).ok
      } catch {
        return false
      }
    }, 60_000)
    if (!ready) throw new Error('opencode serve 未就绪（60s）')
    mark('opencode serve ready', { port })

    const created = await fetch(`${base}/session?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!created.ok) throw new Error(`POST /session → HTTP ${created.status}`)
    const { id: sessionID } = await created.json()
    mark('session created', { reason: sessionID })

    const sent = await fetch(`${base}/session/${sessionID}/prompt_async?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: PROMPT_OPENCODE }],
        model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' },
      }),
    })
    if (!sent.ok) throw new Error(`prompt_async → HTTP ${sent.status}: ${(await sent.text()).slice(0, 200)}`)
    mark('prompt_async sent')

    if (!(await waitFor(() => hasEvent('tools/call:start'), READY_TIMEOUT_MS))) {
      throw new Error(`模型在 ${READY_TIMEOUT_MS / 1000}s 内没有发起工具调用`)
    }
    mark('MCP tools/call:start', { reason: firstEvent('tools/call:start')?.tool })

    let cancelled = false
    let cancelLatencyMs = null
    if (ACTION === 'message') {
      const at = Date.now()
      const second = await fetch(`${base}/session/${sessionID}/prompt_async?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: '停，先别继续。用一句话说明你刚才在做什么。' }],
          model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' },
        }),
      })
      mark('第二个人消息已发（人直接输入）', { reason: `HTTP ${second.status}` })
      cancelled = await waitFor(() => hasEvent('cancelled'), CANCEL_TIMEOUT_MS)
      if (cancelled) cancelLatencyMs = Date.now() - at
    } else {
      const abortAt = Date.now()
      const aborted = await fetch(`${base}/session/${sessionID}/abort?${q}`, { method: 'POST' })
      mark('POST /abort（TUI 停止）', { reason: `HTTP ${aborted.status}` })
      cancelled = await waitFor(() => hasEvent('cancelled'), CANCEL_TIMEOUT_MS)
      if (cancelled) cancelLatencyMs = Date.now() - abortAt
    }
    const cancelEvent = firstEvent('cancelled')
    mark(cancelled ? 'MCP notifications/cancelled 收到' : `等 cancelled 超时（${CANCEL_TIMEOUT_MS}ms）`)

    let statusAfter = null
    try {
      const st = await fetch(`${base}/session/status?${q}`)
      statusAfter = st.ok ? (await st.text()).slice(0, 400) : null
    } catch {}

    return {
      verdict: cancelled ? 'PASS' : 'FAIL',
      assert: '在 agent 会话里停止 → 在飞的 MCP 工具请求收到 notifications/cancelled',
      cancelled,
      action: ACTION,
      cancelLatencyMs,
      detail: cancelled
        ? `人在会话里${ACTION === 'message' ? '直接输入' : '按停止'} → 在飞请求收到 cancelled（服务器侧时间戳 ${cancelEvent.ts}）`
        : ACTION === 'message'
          ? '直接输入不会打断在飞工具调用（消息应是排队到 turn 之后）；人必须先「停止」'
          : '服务器没有收到该请求的 cancelled；通道①在 turn 中间不成立',
      statusAfter,
      toolArgs: firstEvent('tools/call:start')?.args ?? null,
    }
  } finally {
    if (serve.exitCode === null && serve.signalCode === null) {
      serve.kill('SIGTERM')
      await sleep(500)
      if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL')
    }
  }
}

// ─────────────────────────────────────────────── P7 · dsh（SIGINT = Ctrl+C 代理）
async function runDsh() {
  writeDshPatch()
  const apiKey = dshApiKey()
  const out = join(WORK, 'dsh.log')
  const child = spawn('dsh', ['--profile', 'headless', '--patch', join(WORK, 'patch.yml'), PROMPT_DSH], {
    cwd: WORK,
    stdio: ['ignore', 'pipe', 'pipe'],
    // PATH 前置真实 node 目录：dsh 是 `#!/usr/bin/env node`，否则会被桌面壳的 node 接管
    env: { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH}`, ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}) },
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => appendFileSync(out, d))
  child.stderr.on('data', (d) => appendFileSync(out, d))
  const exited = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })))

  try {
    if (!(await waitFor(() => hasEvent('tools/call:start'), READY_TIMEOUT_MS))) {
      throw new Error(`模型在 ${READY_TIMEOUT_MS / 1000}s 内没有发起工具调用`)
    }
    mark('MCP tools/call:start', { reason: firstEvent('tools/call:start')?.tool })

    child.kill('SIGINT')
    mark('SIGINT 已发（headless 的 Ctrl+C）')

    const cancelled = await waitFor(() => hasEvent('cancelled'), CANCEL_TIMEOUT_MS)
    mark(cancelled ? 'MCP notifications/cancelled 收到' : `等 cancelled 超时（${CANCEL_TIMEOUT_MS}ms）`)

    const outcome = await Promise.race([exited, sleep(5000).then(() => ({ stillRunning: true }))])
    return {
      verdict: cancelled ? 'PASS' : 'FAIL',
      assert: '停止（SIGINT 代理）→ 在飞的 MCP 工具请求收到 notifications/cancelled',
      cancelled,
      detail: cancelled
        ? 'SIGINT 走了 abort 路径，cancellation 到达服务器'
        : '服务器没有收到 cancelled：SIGINT 可能是直接杀进程，没经过 agent-loop 的 abort',
      processExit: outcome,
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

// ─────────────────────────────────────────────── main
let result
try {
  console.log(`\n== ${SCENARIO} / ${RUNTIME} ==  工作目录：${WORK}`)
  result = RUNTIME === 'dsh' ? await runDsh() : await runOpencode()
} catch (err) {
  result = { verdict: 'ERROR', assert: '探针未跑完', error: String(err?.message ?? err) }
}
result = { scenario: SCENARIO, runtime: RUNTIME, action: ACTION, at: new Date().toISOString(), blockSec: BLOCK_SEC, marks, ...result }

const tag = `${SCENARIO}.${RUNTIME}${LABEL ? `.${LABEL}` : ''}`
writeFileSync(join(RESULTS, `${tag}.json`), JSON.stringify(result, null, 2) + '\n')
if (existsSync(LOG)) writeFileSync(join(RESULTS, `${tag}.server.jsonl`), readFileSync(LOG))

console.log(`\n${result.verdict}  ${result.assert}`)
if (result.detail) console.log(`  ${result.detail}`)
if (result.error) console.log(`  ERROR: ${result.error}`)
console.log(`  证据：probe/results/raw/${tag}.json + ${tag}.server.jsonl`)

if (!KEEP) rmSync(WORK, { recursive: true, force: true })
process.exit(result.verdict === 'PASS' ? 0 : 1)
