#!/usr/bin/env node
/**
 * test/agent-join.mjs — 「开一个会话，说一句就连上空间」
 *
 * 这是 ADR 0011 想要验证的日常形态：
 *   · opencode 的配置里**永远只有一行**（网关），不含 URL、不含 token
 *   · 空间与身份由**提示词**决定：space_join 到哪个 hub、用哪个 token
 *   · 连上之后 attach → wait，干活
 *
 * 对照：以前要「每个角色一份配置 + token 写在配置里」，改一次配置才能换一个身份/空间。
 *
 * 用法：node test/agent-join.mjs [--keep]
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const PORT = 7411
const KEEP = process.argv.includes('--keep')
const OC_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const spaceDir = mkdtempSync(join(tmpdir(), 'space-join-'))
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })
const initOut = spaceCli(['init', '--dir', spaceDir, '--members', 'worker:developer,boss:pm'])
const workerToken = readFileSync(join(spaceDir, 'tokens', 'worker.token'), 'utf8').trim()
check('space init --members 一次签发全部具名 token', existsSync(join(spaceDir, 'tokens', 'worker.token')) && workerToken.startsWith('spt_'), initOut.split('\n').find((l) => l.includes('worker'))?.slice(0, 60))

const hub = spawn(NODE, [CLI, 'serve', '--dir', spaceDir, '--listen', `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
hub.stderr.resume()
await sleep(1200)
const URL_ = `http://127.0.0.1:${PORT}/mcp`

// ── 会话的工作目录：配置里只有网关，没有 URL、没有 token
const dir = join(spaceDir, 'member-worker')
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
console.log(`\n会话配置（全部内容就这些，不含空间地址与身份）：`)
console.log(readFileSync(join(dir, 'opencode.json'), 'utf8'))

const ART = 'artifacts/join-demo.cu'
const BODY = Buffer.from('// produced after prompt-driven join\n')
writeFileSync(join(spaceDir, ART), BODY)

const prompt = `你现在在一个会话里，还没有连任何协作空间。请严格按步骤做，不要解释、不要提问。

1. 调用工具 space_join，参数：{"space":"work","url":"${URL_}","token":"${workerToken}"}
   —— 这一步是把你自己挂到协作空间上；token 就是你的身份（worker）。
2. 调用工具 space_attach（不需要传 space，因为只连了一个空间），参数 {"constitution_version":1,"capabilities":{"max_block_sec":20}}，
   记下返回里 member 的 id（那是你的名字）和 cursor。
3. 最多循环 6 次：调用工具 space_wait，参数 {"since_cursor":<上一轮 cursor>,"timeout_sec":20}
   - reason 是 "timeout" 就继续下一轮
   - tasks 里有 state=PENDING 的任务时，对第一个：
     a. space_task_claim {"task_id":<id>,"lease_sec":120}
     b. space_task_transition {"task_id":<id>,"lease_id":<lease_id>,"to":"WORKING"}
     c. （跳过）
     d. space_publish {"uri":"${ART}","sha256":"${sha256(BODY)}","size":${BODY.length},"media_type":"text/x-cuda","task_id":<id>}
     e. space_task_transition {"task_id":<id>,"lease_id":<lease_id>,"to":"DONE","payload":{"handoff":{"uri":"${ART}","sha256":"${sha256(BODY)}","size":${BODY.length}},"reason":"done"}}
     f. 结束循环，最后一行只输出：WORKER_DONE <task_id> <你的 member id>
4. 六轮都没有任务，最后一行只输出：NO_TASK`

const child = spawn('opencode', ['run', '--pure', '-m', OC_MODEL, '--dir', dir, prompt], {
  cwd: dir,
  env: { ...process.env, PATH: `${dirname(NODE)}:${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const out = { stdout: '', stderr: '' }
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => (out.stdout += d))
child.stderr.on('data', (d) => (out.stderr += d))
const done = new Promise((r) => child.on('close', (code) => r({ code, ...out })))

// ── 等 agent join 上来；然后由「另一个成员」派活
const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
let joined = false
for (let i = 0; i < 300; i++) {
  if (db.prepare("select 1 from events where kind='member.attached' and member_id='worker'").get()) {
    joined = true
    break
  }
  await sleep(200)
}
check('agent 只凭提示词把自己挂上了空间（配置里没有地址和 token）', joined)

// 用 curl 式的直连当「另一个成员 boss」
async function bossRpc(method, params) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readFileSync(join(spaceDir, 'tokens', 'boss.token'), 'utf8').trim()}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
  })
  const msg = await res.json()
  return msg.result
}
async function bossTool(name, args) {
  const r = await bossRpc('tools/call', { name, arguments: args })
  return JSON.parse(r.content[0].text)
}
await bossTool('space_attach', { constitution_version: 1, capabilities: {} })
const created = await bossTool('space_task_create', { type: 'assign', to: 'worker', op: 'join-demo', step: '3.1' })
console.log(`\n[boss] 派了任务 ${created.task_id}，等 agent 醒来处理…\n`)

const res = await Promise.race([done, sleep(240000).then(() => ({ code: 'TIMEOUT', stdout: out.stdout }))])
if (res.code === 'TIMEOUT') child.kill('SIGKILL')

const row = db.prepare('select * from tasks where id = ?').get(created.task_id)
console.log(`\n--- agent 最后 6 行 ---`)
console.log(res.stdout.split('\n').slice(-6).join('\n'))

check('agent 被任务唤醒并完成了它', row?.state === 'DONE' && /WORKER_DONE/.test(res.stdout), `${row?.state}`)
check('身份来自 token（agent 报回自己的名字是 worker）', /worker/.test(res.stdout))
check('产物登记与磁盘一致', (() => {
  const a = db.prepare('select sha256 from artifacts where uri = ?').get(ART)
  return Boolean(a) && a.sha256 === sha256(BODY)
})())
const verifyOut = spaceCli(['verify', '--dir', spaceDir])
check('投影 == 事件归约', /projection OK/.test(verifyOut), verifyOut.trim())

db.close()
hub.kill('SIGKILL')
if (!KEEP) console.log(`\nspace：${spaceDir}（加 --keep 保留）`)
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log(`  - ${f.n}${f.d ? `: ${f.d}` : ''}`)
process.exit(failed.length ? 1 : 0)
