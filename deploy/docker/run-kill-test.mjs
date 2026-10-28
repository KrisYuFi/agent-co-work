#!/usr/bin/env node
/**
 * deploy/docker/run-kill-test.mjs — 跨机器 + 掉线回收
 *
 * 拓扑（「一台服务器 + 多台机器」的形态）：
 *
 *   宿主机 = 服务器：`space serve --listen 0.0.0.0:7321`（单进程 + 单 sqlite）
 *   容器   = 机器：只挂 tokens/ 与 artifacts/，**看不到 space.sqlite**
 *
 * 场景：
 *   pm      派 broadcast 任务给 developer 角色
 *   dev-a   认领 → WORKING → 挂住
 *   dev-b   在旁边等
 *   ── docker kill dev-a（= 一台机器掉线）──
 *   dev-b   租约过期后接手 → 写产物 → DONE
 *
 * 这是 ROADMAP 阶段 4「杀掉任意成员，任务自动回队并被重新认领」的验证，
 * 也是同机共享 sqlite 时**根本做不出来**的实验。
 *
 * 为什么成员用 Python：本机没有 node 镜像可拉（Docker Hub 不通），
 * 而 `ascendai/cann` 镜像自带 Python 3.11 —— 那正是真实的编码环境。
 *
 * 用法：node deploy/docker/run-kill-test.mjs [--keep] [--image <img>]
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const RUNTIME = join(HERE, 'runtime')
const PORT = 7321
const KEEP = process.argv.includes('--keep')
const imgArg = process.argv.indexOf('--image')
const IMAGE = imgArg >= 0 ? process.argv[imgArg + 1] : 'ascendai/cann:9.1.0-beta.1-910-ubuntu22.04-py3.11'

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spaceCli = (a) => execFileSync(process.execPath, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.join(' ')} 失败：${(r.stderr || '').slice(-500)}`)
  return r
}

function startMember(name, role, tokenFile) {
  docker(['rm', '-f', `space-${name}`], { allowFail: true })
  docker([
    'run', '-d', '--name', `space-${name}`,
    '-v', `${RUNTIME}/tokens:/tokens:ro`,
    '-v', `${RUNTIME}/artifacts:/artifacts`,
    '-v', `${join(HERE, 'member.py')}:/app/member.py:ro`,
    '--entrypoint', 'python3',
    IMAGE,
    '/app/member.py', '--role', role, '--url', `http://host.docker.internal:${PORT}/mcp`,
    '--token-file', `/tokens/${tokenFile}`, '--artifacts', '/artifacts',
  ])
  return `space-${name}`
}

const logs = (name) => spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout ?? ''

// ───────────────────────────────────────────── 准备
rmSync(RUNTIME, { recursive: true, force: true })
mkdirSync(join(RUNTIME, 'tokens'), { recursive: true })
mkdirSync(join(RUNTIME, 'artifacts'), { recursive: true })
spaceCli(['init', '--dir', RUNTIME])
for (const [m, role] of [['pm', 'pm'], ['dev-a', 'developer'], ['dev-b', 'developer']]) {
  const token = spaceCli(['token', 'issue', '--dir', RUNTIME, '--member', m, '--role', role]).trim()
  writeFileSync(join(RUNTIME, 'tokens', `${m}.token`), token)
}
console.log(`space（宿主）：${RUNTIME}`)
console.log(`成员镜像：${IMAGE.slice(0, 60)}…\n`)

// ───────────────────────────────────────────── 起 hub（宿主 = 服务器）
const hub = spawn(process.execPath, [CLI, 'serve', '--dir', RUNTIME, '--listen', `0.0.0.0:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
const hubLog = []
hub.stderr.setEncoding('utf8')
hub.stderr.on('data', (d) => hubLog.push(...String(d).split('\n').filter(Boolean)))
await sleep(1200)

// 预检：容器能不能连到宿主 hub
const pre = docker(
  [
    'run', '--rm', '--entrypoint', 'python3', IMAGE,
    '-c',
    `import urllib.request,urllib.error\n` +
      `try:\n` +
      `  urllib.request.urlopen('http://host.docker.internal:${PORT}/mcp',timeout=5)\n` +
      `  print('reachable')\n` +
      `except urllib.error.HTTPError as e:\n` +
      `  print('reachable', e.code)\n` +
      `except Exception as e:\n` +
      `  print('UNREACHABLE', e)\n`,
  ],
  { allowFail: true },
)
const preOut = `${pre.stdout}${pre.stderr}`
check('容器能通过网络到达宿主 hub（跨机器连通）', /reachable/.test(preOut), preOut.trim().split('\n').slice(-1)[0])

// ───────────────────────────────────────────── 跑场景
const t0 = Date.now()
console.log('起 pm（派活）…')
startMember('pm', 'pm', 'pm.token')

const db = new DatabaseSync(join(RUNTIME, 'space.sqlite'))
let taskId = null
for (let i = 0; i < 120; i++) {
  const row = db.prepare('select * from tasks limit 1').get()
  if (row) {
    taskId = row.id
    break
  }
  await sleep(250)
}
check('pm 容器创建了任务', Boolean(taskId), taskId ?? 'no task')

console.log('起 dev-a（认领后会被杀）…')
startMember('dev-a', 'crash', 'dev-a.token')
let working = null
for (let i = 0; i < 160; i++) {
  const row = taskId ? db.prepare('select * from tasks where id = ?').get(taskId) : null
  if (row?.state === 'WORKING') {
    working = row
    break
  }
  await sleep(250)
}
check('dev-a 认领并进入 WORKING', Boolean(working), working ? `owner=${working.owner}` : 'not working')

console.log('起 dev-b（旁边等）…')
startMember('dev-b', 'finish', 'dev-b.token')
await sleep(800)

console.log('docker kill dev-a（模拟一台机器掉线）…')
docker(['kill', 'space-dev-a'])
const killAt = Date.now()

let finalRow = null
for (let i = 0; i < 240; i++) {
  const row = taskId ? db.prepare('select * from tasks where id = ?').get(taskId) : null
  if (row?.state === 'DONE') {
    finalRow = row
    break
  }
  await sleep(250)
}
const recoverSec = ((Date.now() - killAt) / 1000).toFixed(1)

check('掉线后任务被另一个容器里的成员接手完成', finalRow?.state === 'DONE', finalRow ? `${recoverSec}s 内完成，owner=${finalRow.owner}` : 'not done')
// 终态会释放租约、清空 owner（设计如此），所以这里核对事件流里的认领换手
const claimsAfter = db.prepare("select member_id from events where kind = 'task.claimed' order by id").all().map((r) => r.member_id)
check(
  '回收记账正确（认领从 dev-a 换到 dev-b，attempts ≥ 1）',
  claimsAfter.includes('dev-a') && claimsAfter.includes('dev-b') && (finalRow?.attempts ?? 0) >= 1,
  `claimed=${claimsAfter.join(',')} attempts=${finalRow?.attempts}`,
)
check('完成时带 handoff', Boolean(finalRow?.handoff_uri), finalRow?.handoff_uri ?? 'none')

await sleep(1500)
check('pm 容器在另一个网络里收到完成事件', /PM_DONE/.test(logs('space-pm')), logs('space-pm').trim().split('\n').slice(-1)[0])

const events = db.prepare('select kind, member_id, payload from events order by id').all()
const claimedBy = events.filter((e) => e.kind === 'task.claimed').map((e) => e.member_id)
const expired = events.filter((e) => e.kind === 'task.expired').length
check('事件流记录了「认领 → 过期回收 → 再认领」', new Set(claimedBy).size >= 2 && expired >= 1, `claimed=${claimedBy.join(',')} expired=${expired}`)

const verifyOut = spaceCli(['verify', '--dir', RUNTIME])
check('投影 == 事件归约', /projection OK/.test(verifyOut), verifyOut.trim())

const mounts = spawnSync('docker', ['inspect', '--format', '{{json .Mounts}}', 'space-dev-b'], { encoding: 'utf8' }).stdout ?? ''
check('成员容器只挂 tokens/ 与 artifacts/，没有 space.sqlite', !mounts.includes('space.sqlite') && mounts.includes('/tokens'), mounts.replace(/"/g, '').slice(0, 120))

console.log(`\n从 kill 到恢复完成：${recoverSec}s`)
console.log('\n--- 事件流（后 10 条）---')
for (const e of events.slice(-10)) console.log(` ${e.kind} ${e.member_id ?? ''} ${String(e.payload).slice(0, 88)}`)

db.close()
hub.kill('SIGKILL')
if (!KEEP) {
  for (const n of ['pm', 'dev-a', 'dev-b']) docker(['rm', '-f', `space-${n}`], { allowFail: true })
  console.log('\n已清理容器（--keep 保留现场）')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
