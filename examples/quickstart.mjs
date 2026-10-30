#!/usr/bin/env node
/**
 * examples/quickstart.mjs — 两个真实 agent 用 `space up` 打印的提示词跑一条最短链路
 *
 * 验证的是「照抄能不能用」，不是「模型聪不聪明」：
 *   1. `space up` 起空间，**原样抓取**它打印的 pm / dev 两行提示词
 *   2. 两个 opencode 会话的配置里只有网关（不含 url、不含 token）
 *   3. pm 派活 → dev 认领 → 发布产物 → DONE + handoff → pm 看到 DONE
 *   4. 用库内事实核对：状态链、handoff 的 sha256 与产物文件一致
 *
 * 用法：node examples/quickstart.mjs [--keep] [--model opencode/deepseek-v4-pro]
 * 成本：两个模型会话，约 2–3 分钟。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const KEEP = process.argv.includes('--keep')
const MODEL = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'deepseek/deepseek-v4-pro'
const PORT = 7451
const URL_ = `http://127.0.0.1:${PORT}/mcp`

// 在 Electron 壳里跑时 execPath 是桌面壳，挑一个真 node
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
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

const work = mkdtempSync(join(tmpdir(), 'space-quickstart-'))
const spaceDir = join(work, 'space')
const ART_REL = 'artifacts/hello.txt'
const BODY = Buffer.from('hello from quickstart\n')

// ───────────────────────────────────────────── 1. space up，抓它打印的提示词
const hub = spawn(NODE, [CLI, 'up', '--dir', spaceDir, '--listen', `127.0.0.1:${PORT}`, '--members', 'pm:pm,dev:developer'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let upOut = ''
hub.stdout.setEncoding('utf8')
hub.stdout.on('data', (d) => (upOut += d))
hub.stderr.resume()
await sleep(1500)

const promptFor = (name) => {
  const m = upOut.match(new RegExp(`\\[${name} · [^\\]]+\\]\\n\\s*(.+)$`, 'm'))
  return m ? m[1].trim() : null
}
const pmLine = promptFor('pm')
const devLine = promptFor('dev')
check('space up 打印出 pm 的可粘贴提示词', Boolean(pmLine), (pmLine ?? '').slice(0, 60))
check('space up 打印出 dev 的可粘贴提示词', Boolean(devLine), (devLine ?? '').slice(0, 60))

const hubUp = await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'q', version: '0' }, capabilities: {} } }),
      })
      if (r.status > 0) return true // 401 也算「在听」：这一步只验端口可达
    } catch {}
    await sleep(250)
  }
  return false
})()
check('up 起的 hub 可用', hubUp)

// ───────────────────────────────────────────── 2. 产物 + 两个会话目录（配置里只有网关）
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })
writeFileSync(join(spaceDir, ART_REL), BODY)
const ART_ABS = join(spaceDir, ART_REL)
const HASH = sha256(BODY)

for (const name of ['pm', 'dev']) {
  const dir = join(work, `${name}-session`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        permission: { external_directory: 'allow', edit: 'allow', bash: 'allow' },
        mcp: { space: { type: 'local', command: [NODE, CLI, 'connect'], enabled: true, timeout: 120000 } },
      },
      null,
      2,
    ),
  )
}

const pmPrompt = `${pmLine}

具体这件事：先把活派给 dev —— 调用 space_task_create，参数 {"type":"assign","to":"dev","op":"quickstart","step":"1","expected":{"note":"hello"}}。
然后循环 space_wait（每次 timeout_sec=15）。看到 message 或任务状态里 dev 到了 DONE，就停止循环，最后一行只输出：PM_SAW_DONE`

const devPrompt = `${devLine}

具体这件事：任务里 expected.note 对应的就是文件 ${ART_ABS}，内容 sha256=${HASH}，size=${BODY.length}，media_type=text/plain。
publish 的 uri 写 "${ART_REL}"。做完最后一行只输出：DEV_DONE`

// ───────────────────────────────────────────── 3. 两个真实会话并发
const env = { ...process.env, PATH: `${dirname(NODE)}:${process.env.PATH}` }
function runAgent(name, dir, prompt) {
  const child = spawn('opencode', ['run', '--pure', '-m', MODEL, '--dir', dir, prompt], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '', log: join(work, `${name}.log`) }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (out.stdout += d))
  child.stderr.on('data', (d) => (out.stderr += d))
  console.log(`\n[${name}] 会话已启动（${MODEL}），日志 ${out.log}`)
  return { name, child, out, done: new Promise((r) => child.on('close', (code) => r({ code, ...out }))) }
}

const dev = runAgent('dev', join(work, 'dev-session'), devPrompt)
const pm = runAgent('pm', join(work, 'pm-session'), pmPrompt)

// ───────────────────────────────────────────── 4. 以库内事实为准
const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const taskRow = () => db.prepare("select * from tasks where type='assign' order by created_at desc limit 1").get()
let done = false
for (let i = 0; i < 240; i++) {
  const t = taskRow()
  if (t?.state === 'DONE') {
    done = true
    break
  }
  if (i % 20 === 0 && i > 0) console.log(`  …${i * 0.5}s 任务态：${t?.state ?? '还没创建'}`)
  await sleep(500)
}
check('dev 把任务做到了 DONE（库内事实）', done, taskRow()?.state)

const events = db.prepare('select kind, member_id, task_id, payload, at from events order by id').all()
const kinds = events.map((e) => e.kind)
const transitions = db
  .prepare("select payload from events where kind = 'task.transitioned'")
  .all()
  .map((r) => JSON.parse(r.payload ?? '{}'))
check(
  '状态链完整：created → claimed → WORKING → DONE（+ handoff.written）',
  kinds.includes('task.created') &&
    kinds.includes('task.claimed') &&
    transitions.some((t) => t.to === 'WORKING') &&
    transitions.some((t) => t.to === 'DONE') &&
    kinds.includes('handoff.written'),
  kinds.filter((k) => k.startsWith('task.') || k === 'handoff.written').join(' → '),
)

const art = db.prepare('select uri, sha256, size, by_member from artifacts order by created_at desc limit 1').get()
check('产物已登记且 sha256 与磁盘文件一致', art?.sha256 === HASH && art?.size === BODY.length, art ? `${art.uri} by ${art.by_member}` : '没有制品')

const handoffEvent = events.find((e) => e.kind === 'handoff.written')
const handoff = handoffEvent ? JSON.parse(handoffEvent.payload ?? '{}') : null
check('handoff 指向同一个产物（sha256 对得上）', handoff?.sha256 === HASH, handoff ? handoff.uri : '没有 handoff')

for (const a of [dev, pm]) writeFileSync(a.out.log, a.out.stdout + '\n--- stderr ---\n' + a.out.stderr)
await Promise.race([Promise.all([dev.done, pm.done]), sleep(30_000)])
const pmSaw = /PM_SAW_DONE/.test(pm.out.stdout + pm.out.stderr)
check('pm 会话看到 DONE（模型侧闭环）', pmSaw, pmSaw ? '' : '（未在 30s 内输出 PM_SAW_DONE，见日志）')

// ───────────────────────────────────────────── 5. 收尾
console.log('\n事件流（trace）：')
for (const e of events) console.log(`  ${String(e.at % 100000).padStart(6)}  ${e.kind.padEnd(20)} ${e.member_id ?? ''} ${e.task_id ?? ''}`)

for (const a of [dev, pm]) {
  if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL')
  const tail = (a.out.stdout + a.out.stderr).trim().split('\n').slice(-6).join('\n')
  console.log(`\n[${a.name}] 最后几行：\n${tail}`)
}
hub.kill('SIGKILL')
await sleep(300)
console.log(`\n空间与会话目录：${work}${KEEP ? '（--keep）' : ''}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
