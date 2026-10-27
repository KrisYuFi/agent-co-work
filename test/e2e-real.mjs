#!/usr/bin/env node
/**
 * test/e2e-real.mjs — 真实 runtime 端到端（不是假成员）
 *
 * 两个**真实 agent 会话**各当一个成员：
 *   dev-code → opencode（headless run）
 *   pm       → DSH（dsh headless）
 *
 * 验证的是 ROADMAP 阶段 2 的那句话：「全链路无人手动干预即可推进」，
 * 而且推进它的是模型，不是脚本里的 if。
 *
 * 用法：node test/e2e-real.mjs [--keep] [--timeout-sec N]
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const KEEP = process.argv.includes('--keep')
function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isFinite(v) ? v : fallback
}
const TIMEOUT_SEC = argValue('--timeout-sec', 300)
const OC_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'

const HASH = 'a3f1c9d27b4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708'

const sha = () => HASH
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function spaceCli(args) {
  return execFileSync(NODE, [CLI, ...args], { encoding: 'utf8' })
}

function dshApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  return raw.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1] ?? ''
}

const spaceDir = mkdtempSync(join(tmpdir(), 'space-e2e-'))
console.log(`space: ${spaceDir}`)
spaceCli(['init', '--dir', spaceDir])
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })
writeFileSync(join(spaceDir, 'artifacts', 'design.md'), '# add 算子设计\n\nTiling: 128\n')

const devToken = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', 'dev-code', '--role', 'developer'])
const pmToken = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', 'pm', '--role', 'pm'])
writeFileSync(join(spaceDir, 'tokens', 'dev-code.token'), devToken)
writeFileSync(join(spaceDir, 'tokens', 'pm.token'), pmToken)

// ---------------------------------------------------------------- 两个成员的工作目录 / 配置
const devDir = join(spaceDir, 'member-dev-code')
const pmDir = join(spaceDir, 'member-pm')
mkdirSync(devDir, { recursive: true })
mkdirSync(pmDir, { recursive: true })

writeFileSync(
  join(devDir, 'opencode.json'),
  JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        space: {
          type: 'local',
          command: [NODE, CLI, 'serve', '--dir', spaceDir, '--token-file', join(spaceDir, 'tokens', 'dev-code.token')],
          enabled: true,
          timeout: 60000,
        },
      },
    },
    null,
    2,
  ),
)

writeFileSync(
  join(pmDir, 'patch.yml'),
  [
    '- insert:',
    '    - id: space',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: space',
    '        transport: stdio',
    `        command: ${NODE}`,
    '        args:',
    `          - ${CLI}`,
    '          - serve',
    '          - --dir',
    `          - ${spaceDir}`,
    '          - --token-file',
    `          - ${join(spaceDir, 'tokens', 'pm.token')}`,
    '        toolCallTimeoutMs: 60000',
  ].join('\n'),
)

// ---------------------------------------------------------------- 两个真实 agent 的提示词
const devPrompt = `你是一个协作空间里的开发成员 dev-code。严格按步骤执行，不要解释、不要提问、不要做别的事。

第 1 步，调用工具 space_space_attach，参数：{"constitution_version":1,"capabilities":{"max_block_sec":20}}

第 2 步，最多循环 6 次（keep calling until told to stop）：
  调用工具 space_space_wait，参数 {"since_cursor": <第一次用 0，之后用上一次返回的 cursor>, "timeout_sec": 20}
  - 如果返回里 reason 是 "timeout"：继续下一轮循环
  - 如果返回里 tasks 中有 state 为 "PENDING" 的任务，记下 task_id，然后依次：
      a) space_space_task_claim {"task_id": <task_id>, "lease_sec": 120}
      b) space_space_task_transition {"task_id": <task_id>, "lease_id": <lease_id>, "to": "WORKING"}
      c) space_space_publish {"uri":"artifacts/add_kernel.cu","sha256":"${sha()}","size":1234,"media_type":"text/x-cuda","task_id":<task_id>}
      d) space_space_task_transition {"task_id": <task_id>, "lease_id": <lease_id>, "to": "DONE", "payload": {"handoff": {"uri":"artifacts/add_kernel.cu","sha256":"${sha()}"}, "reason": "kernel implemented"}}
      e) 结束循环，最后一行只输出：TASK_DONE <task_id>

如果 6 次全是 timeout，最后一行只输出：NO_TASK`

const pmPrompt = `你是一个协作空间里的 PM 成员 pm。严格按步骤执行，不要解释、不要提问。

第 1 步，调用工具 mcp__space__space_attach，参数 {"constitution_version":1,"capabilities":{"max_block_sec":20}}

第 2 步，调用 mcp__space__space_task_create，参数 {"type":"assign","to":"dev-code","op":"add-x","step":"3.1","expected":{"language":"cuda"}}，记住返回的 task_id。

第 3 步，最多循环 6 次：
  调用 mcp__space__space_wait，参数 {"since_cursor": <第一次用第1步返回的 cursor，之后用上一次返回的 cursor>, "timeout_sec": 20}
  直到 events 里出现 kind="task.transitioned" 且 payload.to="DONE" 为止。

第 4 步，拿到 handoff 后调用 mcp__space__space_artifact_resolve，参数 {"artifact_id": <handoff 的 uri>}，确认能解析出 uri 和 sha256。

最后一行只输出：HANDOFF <uri> <sha256>`

// ---------------------------------------------------------------- 起 dev-code（先让它挂上）
function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const out = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (out.stdout += d))
  child.stderr.on('data', (d) => (out.stderr += d))
  const done = new Promise((res) => child.on('close', (code) => res({ code, ...out })))
  return { child, done, out }
}

const PATH = `/Users/krisyu/.nvm/versions/node/v26.1.0/bin:${process.env.PATH}`
const t0 = Date.now()

console.log('\n启动 dev-code（opencode headless）…')
const dev = run('opencode', ['run', '--pure', '-m', OC_MODEL, '--dir', devDir, devPrompt], {
  env: { ...process.env, PATH },
  cwd: devDir,
})

// 等 dev-code attach（轮询事件表，最多 120s）
const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
function waitForAttach(memberId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = db
      .prepare("select id from events where kind = 'member.attached' and member_id = ? limit 1")
      .get(memberId)
    if (row) return true
    execFileSync('sleep', ['0.2'])
  }
  return false
}
const devAttached = waitForAttach('dev-code', 120000)
check('dev-code 通过 opencode 会话 attach 上空间', devAttached, `${((Date.now() - t0) / 1000).toFixed(1)}s`)

console.log('\n启动 pm（dsh headless）…')
const pm = run('dsh', ['--profile', 'headless', '--patch', join(pmDir, 'patch.yml'), pmPrompt], {
  env: { ...process.env, PATH, DEEPSEEK_API_KEY: dshApiKey() },
  cwd: pmDir,
})

const remaining = Math.max(30, TIMEOUT_SEC - (Date.now() - t0) / 1000)
const killer = setTimeout(() => {
  dev.child.kill('SIGKILL')
  pm.child.kill('SIGKILL')
}, remaining * 1000 + 20000)

const [devRes, pmRes] = await Promise.all([dev.done, pm.done])
clearTimeout(killer)
db.close()

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n两个会话都结束，用时 ${elapsed}s（dev exit=${devRes.code}, pm exit=${pmRes.code}）\n`)

check('dev-code 会话正常退出', devRes.code === 0)
check('pm 会话正常退出', pmRes.code === 0)

const devLine = devRes.stdout.split('\n').reverse().find((l) => l.includes('TASK_DONE') || l.includes('NO_TASK')) ?? ''
check('dev-code 报告拿到并完成了任务', /TASK_DONE t_/.test(devLine), devLine.trim().slice(0, 80))

const pmLine = pmRes.stdout.split('\n').reverse().find((l) => l.includes('HANDOFF')) ?? ''
check('pm 报告收到 handoff 并解析成功', pmLine.includes('artifacts/add_kernel.cu') && pmLine.includes(HASH), pmLine.trim().slice(0, 100))

// 空间侧客观核对：不采信 agent 的自述
const dbv = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const doneTask = dbv.prepare("select id, state, handoff_uri, handoff_sha from tasks where state = 'DONE'").get()
check('库里存在 DONE 且带 handoff 的任务', Boolean(doneTask?.handoff_uri), doneTask ? `${doneTask.id} → ${doneTask.handoff_uri}` : 'none')
const events = dbv.prepare('select kind from events').all().map((r) => r.kind)
check('事件流覆盖完整链路', ['member.attached', 'task.created', 'task.claimed', 'task.transitioned', 'artifact.published', 'handoff.written'].every((k) => events.includes(k)), `${events.length} events`)
dbv.close()

const verified = { ok: spaceCli(['verify', '--dir', spaceDir]).includes('projection OK') }
check('投影 == 事件归约', verified.ok === true)

console.log('\n--- dev-code 最后 15 行 ---')
console.log(devRes.stdout.split('\n').slice(-15).join('\n'))
console.log('\n--- pm 最后 15 行 ---')
console.log(pmRes.stdout.split('\n').slice(-15).join('\n'))
console.log('\n--- trace（最后 25 条）---')
const trace = spaceCli(['trace', '--dir', spaceDir, '--limit', '200']).split('\n')
console.log(trace.slice(-25).join('\n'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
  if (!KEEP) console.log(`\n（space 目录未保留；重跑加 --keep 可留档）`)
}
process.exit(failed.length === 0 ? 0 : 1)
