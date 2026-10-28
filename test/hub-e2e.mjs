#!/usr/bin/env node
/**
 * test/hub-e2e.mjs — 通过**中心化 hub（HTTP）**跑一次真实 agent 协作
 *
 * 与 e2e-real.mjs 的区别：那边的成员各自 spawn 一个 `space serve` 共享 sqlite 文件（同机变形），
 * 这里所有成员连**同一个 hub 进程**，走 MCP over Streamable HTTP —— 这是跨机器的实际形态。
 *
 *   dev-code（opencode）：attach → wait → claim → 写产物 → publish → DONE + handoff
 *   pm      （dsh）     ：attach → task_create(assign → dev-code) → wait 到 DONE → 解析 handoff
 *
 * 用法：node test/hub-e2e.mjs [--port 7396] [--keep]
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7396
const KEEP = process.argv.includes('--keep')
const OC_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'
const PATH = `${dirname(NODE)}:${process.env.PATH}`

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const spaceDir = mkdtempSync(join(tmpdir(), 'space-hub-'))
spaceCli(['init', '--dir', spaceDir])
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })
const tokens = {}
for (const [m, role] of [['dev-code', 'developer'], ['pm', 'pm'], ['human', 'human']]) {
  tokens[m] = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', m, '--role', role, ...(m === 'human' ? ['--kind', 'human'] : [])]).trim()
  writeFileSync(join(spaceDir, 'tokens', `${m}.token`), tokens[m])
}
const ART = 'artifacts/hub-kernel.cu'
const BODY = Buffer.from('// hub e2e kernel\n')
writeFileSync(join(spaceDir, ART), BODY)

// ── hub
const hub = spawn(NODE, [CLI, 'serve', '--dir', spaceDir, '--listen', `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
const hubLog = []
hub.stderr.setEncoding('utf8')
hub.stderr.on('data', (d) => hubLog.push(...String(d).split('\n').filter(Boolean)))
await sleep(1200)
console.log(`hub: http://127.0.0.1:${PORT}/mcp · space: ${spaceDir}\n`)

const URL_ = `http://127.0.0.1:${PORT}/mcp`

// ── 成员配置（remote）
const devDir = join(spaceDir, 'member-dev')
const pmDir = join(spaceDir, 'member-pm')
mkdirSync(devDir, { recursive: true })
mkdirSync(pmDir, { recursive: true })
writeFileSync(
  join(devDir, 'opencode.json'),
  JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      permission: { external_directory: 'allow', edit: 'allow', bash: 'allow' },
      mcp: { space: { type: 'remote', url: URL_, enabled: true, oauth: false, headers: { Authorization: `Bearer ${tokens['dev-code']}` } } },
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
    '        transport: streamable-http',
    `        url: ${URL_}`,
    '        headers:',
    `          Authorization: Bearer ${tokens.pm}`,
  ].join('\n'),
)

function spawnAgent(member, kind, dir, prompt) {
  const env = { ...process.env, PATH }
  let cmd
  let args
  if (kind === 'opencode') {
    cmd = 'opencode'
    args = ['run', '--pure', '-m', OC_MODEL, '--dir', dir, prompt]
  } else {
    env.DEEPSEEK_API_KEY =
      process.env.DEEPSEEK_API_KEY || readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1]
    cmd = 'dsh'
    args = ['--profile', 'headless', '--patch', join(dir, 'patch.yml'), prompt]
  }
  const child = spawn(cmd, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (out.stdout += d))
  child.stderr.on('data', (d) => (out.stderr += d))
  return { child, out, done: new Promise((r) => child.on('close', (code) => r({ code, ...out }))) }
}

const devPrompt = `你在协作空间里当开发成员 dev-code。严格按步骤执行，不要解释、不要提问。

1. 调用空间工具 space_space_attach，参数 {"constitution_version":1,"capabilities":{"max_block_sec":20}}，记下返回的 cursor。
2. 最多循环 6 次：
   调用 space_space_wait {"since_cursor": <上一轮的 cursor，第一次用 attach 返回的>,"timeout_sec":20}
   - reason 是 "timeout" 就继续下一轮
   - tasks 里有 state=PENDING 的任务时，对第一个任务：
     a. space_space_task_claim {"task_id":<id>,"lease_sec":120}
     b. space_space_task_transition {"task_id":<id>,"lease_id":<lease_id>,"to":"WORKING"}
     c. 用 shell 确认文件存在：ls -l ${join(spaceDir, ART)}
     d. space_space_publish {"uri":"${ART}","sha256":"${sha256(BODY)}","size":${BODY.length},"media_type":"text/x-cuda","task_id":<id>}
     e. space_space_task_transition {"task_id":<id>,"lease_id":<lease_id>,"to":"DONE","payload":{"handoff":{"uri":"${ART}","sha256":"${sha256(BODY)}","size":${BODY.length}},"reason":"done"}}
     f. 结束循环，最后一行只输出：DEV_DONE <task_id>
3. 六轮都是 timeout，最后一行只输出：NO_TASK`

const pmPrompt = `你在协作空间里当 PM。严格按步骤执行，不要解释。

1. 调用空间工具 mcp__space__space_attach，参数 {"constitution_version":1,"capabilities":{"max_block_sec":20}}，记下 cursor。
2. 调用 mcp__space__space_task_create {"type":"assign","to":"dev-code","op":"hub-op","step":"3.1","expected":{"filename":"hub-kernel.cu"}}，记下 task_id。
3. 最多循环 6 次：mcp__space__space_wait {"since_cursor":<上一轮 cursor>,"timeout_sec":20}，直到 events 里出现 kind="task.transitioned" 且 payload.to="DONE"。
4. 调用 mcp__space__space_artifact_resolve {"artifact_id":"${ART}"} 确认能解析。
最后一行只输出：PM_DONE <handoff uri>`

const dev = spawnAgent('dev-code', 'opencode', devDir, devPrompt)
// 等 dev-code 先 attach，再让 PM 派活
const dbProbe = new DatabaseSync(join(spaceDir, 'space.sqlite'))
for (let i = 0; i < 300; i++) {
  if (dbProbe.prepare("select 1 from events where kind='member.attached' and member_id='dev-code'").get()) break
  await sleep(200)
}
const pm = spawnAgent('pm', 'dsh', pmDir, pmPrompt)

const timeout = sleep(300_000).then(() => 'timeout')
const done = await Promise.race([Promise.all([dev.done, pm.done]).then((r) => r), timeout])
if (done === 'timeout') {
  dev.child.kill('SIGKILL')
  pm.child.kill('SIGKILL')
}

// ── 验收（只看库与磁盘）
const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const tasks = db.prepare('select * from tasks').all()
const doneTask = tasks.find((t) => t.state === 'DONE')
const claims = db.prepare("select count(*) c from events where kind='task.claimed'").get().c

console.log(`\ndev exit=${dev.out.code ?? '?'}, pm exit=${pm.out.code ?? '?'}\n`)
check('dev-code 通过 HTTP hub 拿到任务并完成', /DEV_DONE/.test(dev.out.stdout))
check('pm 通过 HTTP hub 收到完成事件', /PM_DONE/.test(pm.out.stdout))
check('库里存在带 handoff 的 DONE 任务', Boolean(doneTask?.handoff_uri), doneTask ? `${doneTask.id} → ${doneTask.handoff_uri}` : 'none')
check('任务确实经过 cl/via hub（有 claimed 事件）', claims >= 1, `${claims} 次认领`)
check(
  '产物登记 sha 与磁盘一致',
  (() => {
    const a = db.prepare('select sha256 from artifacts where uri = ?').get(ART)
    return Boolean(a) && a.sha256 === sha256(BODY)
  })(),
)
const verifyOut = spaceCli(['verify', '--dir', spaceDir])
check('投影 == 事件归约', /projection OK/.test(verifyOut), verifyOut.trim())

console.log('\n--- trace ---')
console.log(spaceCli(['trace', '--dir', spaceDir, '--limit', '100']).trim().split('\n').slice(-12).join('\n'))
if (!KEEP) console.log(`\nspace：${spaceDir}（加 --keep 保留）`)

hub.kill('SIGKILL')
db.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
