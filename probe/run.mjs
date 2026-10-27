#!/usr/bin/env node
/**
 * probe/run.mjs — 阶段 1 探针运行器
 *
 * 一次调用 = 一个 (scenario, runtime) 组合。它负责：
 *   1. 在临时工作目录里生成该 runtime 的配置（不动用户的全局配置）
 *   2. 跑一次 headless 任务，记录 wall time / 退出码 / 输出
 *   3. 读回 MCP 服务器的 JSONL 日志，作为「服务器视角」的客观证据
 *   4. 把判决写进 probe/results/raw/<scenario>.<runtime>.json
 *
 * 用法：
 *   node probe/run.mjs --scenario p2 --runtime opencode
 *   node probe/run.mjs --scenario p3-block --runtime dsh --block 120 --mcp-timeout 600000
 *   node probe/run.mjs --list
 *
 * 设计原则：判决只看两件事——服务器日志里工具到底跑完没有、客户端有没有在超时点前后
 * 自行退出。输出文本只作旁证，不作为判决依据。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SERVER = join(HERE, 'mcp', 'server.mjs')
const RESULTS = join(HERE, 'results', 'raw')
const NODE = process.execPath

// ---------------------------------------------------------------- CLI 解析
const argv = process.argv.slice(2)
function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const SCENARIO = flag('scenario')
const RUNTIME = flag('runtime')
const BLOCK_SECONDS = Number(flag('block', '120'))
const MCP_TIMEOUT_MS = Number(flag('mcp-timeout', '30000'))
const PROGRESS_INTERVAL_MS = Number(flag('progress-interval', '15000'))
const HARNESS_TIMEOUT_MS = Number(flag('harness-timeout', String((BLOCK_SECONDS + 240) * 1000)))
const LABEL = flag('label', '')

if (has('list') || !SCENARIO || !RUNTIME) {
  console.log(`scenarios: p1 | p2 | p3-block | p3-progress | p3-bash
runtimes:  opencode | dsh
flags:     --block <s> (default 120) --mcp-timeout <ms> (default 30000)
           --progress-interval <ms> (default 15000) --harness-timeout <ms> --label <text>`)
  process.exit(has('list') ? 0 : 2)
}

// ---------------------------------------------------------------- runtime 定义
const OPENCODE_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'

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

const RUNTIMES = {
  opencode: {
    // opencode 的 MCP 工具名：<server>_<tool>（见其 MCP 层 ny(v)+"_"+ny(name)）
    toolName: (t) => `probe_${t}`,
    needsMcp: true,
    writeConfig(dir, logPath) {
      const cfg = {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          probe: {
            type: 'local',
            command: [NODE, SERVER, '--log', logPath],
            enabled: true,
            // 对应 opencode 的 per-server 工具调用超时（其默认 30000）
            timeout: MCP_TIMEOUT_MS,
          },
        },
      }
      writeFileSync(join(dir, 'opencode.json'), JSON.stringify(cfg, null, 2))
    },
    command(dir, prompt) {
      return {
        cmd: 'opencode',
        args: ['run', '--pure', '-m', OPENCODE_MODEL, '--dir', dir, prompt],
        env: {},
      }
    },
  },
  dsh: {
    toolName: (t) => `mcp__probe__${t}`,
    needsMcp: true,
    writeConfig(dir, logPath) {
      const patch = [
        {
          insert: [
            {
              id: 'mcp-probe',
              name: '@deepseek-ai/dsh-mcp-client',
              config: {
                serverName: 'probe',
                transport: 'stdio',
                command: NODE,
                args: [SERVER, '--log', logPath],
                toolCallTimeoutMs: MCP_TIMEOUT_MS,
              },
            },
          ],
        },
      ]
      // 手写 YAML，避免为了一个探针引入序列化依赖
      const lines = ['- insert:']
      for (const entry of patch[0].insert) {
        lines.push(`    - id: ${entry.id}`)
        lines.push(`      name: '${entry.name}'`)
        lines.push('      config:')
        lines.push(`        serverName: ${entry.config.serverName}`)
        lines.push(`        transport: ${entry.config.transport}`)
        lines.push(`        command: ${entry.config.command}`)
        lines.push('        args:')
        for (const a of entry.config.args) lines.push(`          - ${a}`)
        lines.push(`        toolCallTimeoutMs: ${entry.config.toolCallTimeoutMs}`)
      }
      writeFileSync(join(dir, 'patch.yml'), lines.join('\n') + '\n')
    },
    command(dir, prompt) {
      const patch = join(dir, 'patch.yml')
      const args = ['--profile', 'headless']
      // 只有写了 patch 的场景才传 --patch（p1 / p3-bash 不挂 MCP）
      if (existsSync(patch)) args.push('--patch', patch)
      args.push(prompt)
      return {
        cmd: 'dsh',
        args,
        env: { DEEPSEEK_API_KEY: dshApiKey() ?? '' },
      }
    },
  },
}

// ---------------------------------------------------------------- scenario 定义
const SCENARIOS = {
  p1: {
    needsMcp: false,
    prompt: () => 'Reply with exactly: P1_OK',
  },
  p2: {
    needsMcp: true,
    prompt: (rt) =>
      `Call the tool named "${rt.toolName('probe_ping')}" with no arguments, then reply with exactly its raw text output and nothing else.`,
  },
  'p3-block': {
    needsMcp: true,
    prompt: (rt) =>
      `Call the tool named "${rt.toolName('probe_block')}" exactly once with {"seconds": ${BLOCK_SECONDS}}. Wait for it to return, then reply with exactly its raw text output and nothing else. Do not call it again.`,
  },
  'p3-progress': {
    needsMcp: true,
    prompt: (rt) =>
      `Call the tool named "${rt.toolName('probe_block_progress')}" exactly once with {"seconds": ${BLOCK_SECONDS}, "intervalMs": ${PROGRESS_INTERVAL_MS}}. Wait for it to return, then reply with exactly its raw text output and nothing else. Do not call it again.`,
  },
  'p3-bash': {
    needsMcp: false,
    prompt: () =>
      `Run exactly this shell command and wait for it to finish: sleep ${BLOCK_SECONDS}. Then reply with exactly: BASH_DONE`,
  },
}

const scenario = SCENARIOS[SCENARIO]
const runtime = RUNTIMES[RUNTIME]
if (!scenario) throw new Error(`unknown scenario: ${SCENARIO}`)
if (!runtime) throw new Error(`unknown runtime: ${RUNTIME}`)

// ---------------------------------------------------------------- 执行
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const tag = [SCENARIO, RUNTIME, LABEL].filter(Boolean).join('.')
const scratch = join(HERE, 'work', `${tag}.${stamp}`)
mkdirSync(scratch, { recursive: true })
mkdirSync(RESULTS, { recursive: true })
const serverLog = join(scratch, 'mcp-server.jsonl')

if (scenario.needsMcp && runtime.needsMcp) runtime.writeConfig(scratch, serverLog)

const prompt = scenario.prompt(runtime)
const { cmd, args, env } = runtime.command(scratch, prompt)

const startedAt = Date.now()
let stdout = ''
let stderr = ''
let exitCode = null
let timedOut = false

const child = spawn(cmd, args, {
  cwd: scratch,
  env: { ...process.env, ...env, PATH: `/Users/krisyu/.nvm/versions/node/v26.1.0/bin:${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => (stdout += d))
child.stderr.on('data', (d) => (stderr += d))

const killer = setTimeout(() => {
  timedOut = true
  child.kill('SIGKILL')
}, HARNESS_TIMEOUT_MS)

await new Promise((res) => child.on('close', (code) => {
  clearTimeout(killer)
  exitCode = code
  res()
}))

const wallMs = Date.now() - startedAt

// ---------------------------------------------------------------- 读服务器日志
function readEvents(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const events = readEvents(serverLog)
const callStarts = events.filter((e) => e.event === 'tools/call:start')
const callEnds = events.filter((e) => e.event === 'tools/call:end' && e.ok)
const progressSent = events.filter((e) => e.event === 'progress:sent')

// 判决：只看服务器侧事实
const toolCalled = callStarts.length > 0
const toolCompleted = callEnds.length > 0
const serverBlockMs = callEnds[0]?.blockedMs ?? null

const record = {
  scenario: SCENARIO,
  runtime: RUNTIME,
  label: LABEL || null,
  startedAt: new Date(startedAt).toISOString(),
  params: { blockSeconds: BLOCK_SECONDS, mcpTimeoutMs: MCP_TIMEOUT_MS, progressIntervalMs: PROGRESS_INTERVAL_MS },
  prompt,
  exitCode,
  timedOut,
  wallMs,
  verdict: {
    toolCalled,
    toolCompleted,
    serverBlockMs,
    progressNotifications: progressSent.length,
    // 客户端是否在服务器干完活之前就退出了
    clientGaveUpEarly: toolCalled && !toolCompleted && exitCode !== null,
  },
  serverEvents: events.length,
  stdoutTail: stdout.slice(-1500),
  stderrTail: stderr.slice(-1500),
  scratch,
  serverLog,
}

writeFileSync(join(RESULTS, `${tag}.json`), JSON.stringify(record, null, 2) + '\n')

// 服务器日志是判决的原始证据，随记录一起入库（work/ 是可丢弃的临时目录）
if (existsSync(serverLog)) copyFileSync(serverLog, join(RESULTS, `${tag}.server.jsonl`))

const v = record.verdict
console.log(
  `${v.toolCalled ? (v.toolCompleted ? 'PASS' : 'FAIL') : scenario.needsMcp ? 'FAIL' : 'N/A'}  ${tag}  ` +
    `wall=${(wallMs / 1000).toFixed(1)}s exit=${exitCode}${timedOut ? ' (harness timeout)' : ''} ` +
    `called=${v.toolCalled} completed=${v.toolCompleted} block=${((v.serverBlockMs ?? 0) / 1000).toFixed(1)}s progress=${v.progressNotifications}`,
)
console.log(`  result → probe/results/raw/${tag}.json`)
if (!v.toolCalled && scenario.needsMcp) {
  console.log('  stdout tail:\n' + stdout.slice(-600))
  console.log('  stderr tail:\n' + stderr.slice(-600))
}
if (has('clean')) rmSync(scratch, { recursive: true, force: true })
