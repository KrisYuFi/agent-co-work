#!/usr/bin/env node
/**
 * test/multimachine-design.mjs — 设计段在多机形态下跑一遍
 *
 * 拓扑：
 *   宿主机（服务器）：hub（单进程 + 单 sqlite + HTTP）
 *   宿主机上的三个**真实 agent 会话**：pm / architect / qa（各自连 hub）
 *   一个 CANN 容器：作为**没有 agent 的机器**，承担阶段 0「环境检查」
 *
 * 流程（ops-direct-invoke 编码之前那一段）：
 *   0 环境准备(容器) → 1.1 需求分析(architect) → CP1(qa + 人) → 2.1 测试方案 → CP2.1
 *   → 2.2 开发方案 → CP2.2(qa + 人)
 *
 * 验的是：**不同机器上的成员，通过中心 hub 协同完成一条真实流程**。
 *
 * 用法：node test/multimachine-design.mjs [--keep] [--timeout-min 25]
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const KEEP = process.argv.includes('--keep')
const opt = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const TIMEOUT_MIN = Number(opt('timeout-min', '25'))
const PORT = Number(opt('port', '7321'))
const IMAGE = 'ascendai/cann:9.1.0-beta.1-910-ubuntu22.04-py3.11'
const OC_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'
const OP = 'add'
const URL_ = `http://127.0.0.1:${PORT}/mcp`
const PATH = `${dirname(NODE)}:/usr/local/bin:${process.env.PATH}`

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// ───────────────────────────────────────────── 空间 + hub
const spaceDir = mkdtempSync(join(tmpdir(), 'space-mm-'))
const ART = join(spaceDir, 'artifacts')
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
mkdirSync(ART, { recursive: true })
spaceCli(['init', '--dir', spaceDir])
const tokens = {}
for (const [m, kind, role] of [
  ['pm', 'role', 'pm'],
  ['architect', 'role', 'architect'],
  ['qa', 'role', 'qa'],
  ['runner', 'role', 'runner'],
  ['human', 'human', 'human'],
]) {
  tokens[m] = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', m, '--role', role, '--kind', kind]).trim()
  writeFileSync(join(spaceDir, 'tokens', `${m}.token`), tokens[m])
}
writeFileSync(join(ART, `${OP}-需求输入.md`), '# 算子需求（用户原始输入）\n\n实现 add 算子：逐元素相加，输入两个 float32 tensor（同形状、无广播）。\n目标：先跑通功能，性能不是重点。\n')

const hub = spawn(NODE, [CLI, 'serve', '--dir', spaceDir, '--listen', `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
hub.stderr.resume()
await sleep(1200)
console.log(`hub: ${URL_}\nspace: ${spaceDir}\n`)

// ───────────────────────────────────────────── 容器成员（无 agent，只做环境检查）
function startRunner() {
  spawnSync('docker', ['rm', '-f', 'space-runner'], { encoding: 'utf8' })
  const r = spawnSync(
    'docker',
    [
      'run', '-d', '--name', 'space-runner',
      '-v', `${spaceDir}/tokens:/tokens:ro`,
      '-v', `${ART}:/artifacts`,
      '-v', `${join(REPO, 'deploy', 'docker', 'member.py')}:/app/member.py:ro`,
      '--entrypoint', 'python3',
      IMAGE,
      '/app/member.py', '--role', 'runner',
      '--url', `http://host.docker.internal:${PORT}/mcp`,
      '--token-file', '/tokens/runner.token', '--artifacts', '/artifacts',
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`启动 runner 容器失败：${r.stderr.slice(-400)}`)
}
startRunner()
console.log(`runner 容器已起（${IMAGE.slice(0, 40)}…）——它没有 agent，只跑环境检查\n`)

// ───────────────────────────────────────────── 三个真实 agent（remote 接入）
function writeConfig(member, runtime, dir) {
  if (runtime === 'opencode') {
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission: { external_directory: 'allow', edit: 'allow', bash: 'allow' },
          mcp: { space: { type: 'remote', url: URL_, enabled: true, oauth: false, headers: { Authorization: `Bearer ${tokens[member]}` } } },
        },
        null,
        2,
      ),
    )
  } else {
    writeFileSync(
      join(dir, 'patch.yml'),
      [
        '- insert:',
        '    - id: space',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: space',
        '        transport: streamable-http',
        `        url: ${URL_}`,
        '        headers:',
        `          Authorization: Bearer ${tokens[member]}`,
      ].join('\n'),
    )
  }
}

function buildPrompt(member, runtime) {
  const t = (n) => (runtime === 'opencode' ? `space_space_${n}` : `mcp__space__space_${n}`)
  const roleDoc = readFileSync(join(REPO, 'examples', 'ops-direct-invoke', 'roles', `${member}.md`), 'utf8')
  return `${roleDoc}

---
# 你在协作空间里的工作方式

你通过 MCP over HTTP 连到中心 hub。工具名以 ${runtime === 'opencode' ? 'space_space_' : 'mcp__space__space_'} 开头。
空间根目录（别人能读到的产物都在这里）：${spaceDir}
产物目录：${ART}/

## 启动
调用 \`${t('attach')}\`，参数 {"constitution_version":1,"capabilities":{"max_block_sec":60}}，记下 cursor。

## 主循环（最多 40 轮）
1. \`${t('wait')}\` {"since_cursor":<上次 cursor>,"timeout_sec":60}；reason="timeout" 就继续
   tasks 里有 state=PENDING 且 to 是你的 → 干活
2. a \`${t('task_claim')}\` {"task_id":<id>,"lease_sec":300}
   b \`${t('task_transition')}\` {...,"to":"WORKING"}
   c 读 inputs（文件在 ${spaceDir}/<uri>）
   d 写 ${ART}/<expected.filename>
   e shasum -a 256 <文件>
   f \`${t('publish')}\` {"uri":"artifacts/${OP}/<文件名>","sha256":<哈希>,"size":<字节>,"media_type":"text/markdown","task_id":<id>}
   g 若 step 以 CP 开头：\`${t('task_accept')}\` {"task_id":<id>,"cp":"<step>","verdict":"pass|hold","gaps":[...]}
   h \`${t('task_transition')}\` {...,"to":"DONE","payload":{"handoff":{"uri":"artifacts/${OP}/<文件名>","sha256":<哈希>,"size":<字节>},"reason":"<一句话>"}}
3. 回到循环；40 轮后输出 AGENT_DONE

## 这条流程里你要知道的
- **阶段 0（step="0"）由另一台机器上的成员 runner 负责**（它在 docker 容器里，没有 agent，只跑环境检查）。
  你不做这一步，也**不要**替它做。
${member === 'pm' ? `
## PM 额外说明：流程从阶段 0 开始

1. 先派 **阶段 0**：space_task_create {"type":"assign","to":"runner","op":"${OP}","step":"0","op_note":"环境检查","expected":{"filename":"env-info.md"}}
   → 等它 DONE（它会把 ${ART}/env-info.md 交回来）
2. 再按流程表继续 1.1 → CP1 → … → CP2.2（与角色文档一致）
3. 全部完成后最后一行输出 PM_DONE <总结>
` : ''}
- 你只处理派给你的任务。
- 交付件要像真的：有章节、有具体数值/接口签名。
- 做不了就 transition 到 FAILED 写 reason。
`
}

function spawnAgent(member, runtime, dir, prompt) {
  const env = { ...process.env, PATH }
  let cmd
  let args
  if (runtime === 'opencode') {
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

const RT = { pm: 'dsh', architect: 'dsh', qa: 'opencode' }
const dirs = {}
for (const m of Object.keys(RT)) {
  dirs[m] = join(spaceDir, `member-${m}`)
  mkdirSync(dirs[m], { recursive: true })
  writeConfig(m, RT[m], dirs[m])
}

// ───────────────────────────────────────────── 脚本扮演的人
class Human {
  constructor() {
    this.nextId = 1
    this.pending = new Map()
  }
  async start() {
    this.proc = spawn(NODE, [CLI, 'serve', '--dir', spaceDir, '--token-file', join(spaceDir, 'tokens', 'human.token')], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (c) => {
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
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p(msg)
        }
      }
    })
    this.proc.stderr.resume()
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'human', version: '0' } })
    this.notify('notifications/initialized')
    return this
  }
  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  request(method, params) {
    const id = this.nextId++
    return new Promise((res) => {
      this.pending.set(id, res)
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async tool(name, args = {}) {
    const msg = await this.request('tools/call', { name, arguments: args })
    const payload = JSON.parse(msg?.result?.content?.[0]?.text ?? '{}')
    if (msg?.result?.isError) {
      const e = new Error(payload.message)
      e.code = payload.error
      throw e
    }
    return payload
  }
  async run(deadline) {
    await this.tool('space_attach', { constitution_version: 1, capabilities: {} })
    let cursor = 0
    let rejected = false
    while (Date.now() < deadline) {
      let r
      try {
        r = await this.tool('space_wait', { since_cursor: cursor, timeout_sec: 10 })
      } catch {
        break
      }
      cursor = r.cursor
      for (const t of r.tasks ?? []) {
        const claim = await this.tool('space_task_claim', { task_id: t.task_id, lease_sec: 120 })
        const first = /CP1/.test(String(t.step)) && !rejected
        const answer = first ? 'reject：目标芯片对该架构的支持情况没写清，无法拍板' : 'approve：可以进入下一步'
        if (first) rejected = true
        await this.tool('space_task_transition', { task_id: t.task_id, lease_id: claim.lease_id, to: 'WORKING' })
        await this.tool('space_task_transition', { task_id: t.task_id, lease_id: claim.lease_id, to: 'DONE', payload: { reason: answer, answer } })
        console.log(`  [human] ${t.step} → ${answer.slice(0, 16)}…`)
      }
    }
  }
  close() {
    try {
      this.proc.stdin.end()
    } catch {}
  }
}

const human = await new Human().start()
const humanLoop = human.run(Date.now() + TIMEOUT_MIN * 60_000).catch(() => {})

// ───────────────────────────────────────────── 起 agent
const t0 = Date.now()
const agents = {}
for (const m of Object.keys(RT)) {
  agents[m] = spawnAgent(m, RT[m], dirs[m], buildPrompt(m, RT[m]))
}

const pmResult = await Promise.race([agents.pm.done, sleep(TIMEOUT_MIN * 60_000).then(() => ({ code: 'TIMEOUT', stdout: agents.pm.out.stdout }))])
const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
human.close()
for (const m of ['architect', 'qa']) agents[m].child.kill('SIGKILL')
await Promise.race([humanLoop, sleep(2000)])

// ───────────────────────────────────────────── 验收
const db = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const tasks = db.prepare('select * from tasks order by created_at').all()
const files = existsSync(ART) ? readdirSync(ART).filter((f) => f.endsWith('.md')) : []
const substantive = files.filter((f) => statSync(join(ART, f)).size > 1024)

console.log(`\npm 会话结束（exit=${pmResult.code}），总用时 ${elapsed}s\n`)

check('pm 是真实会话并跑完编排', pmResult.code === 0 && /PM_DONE/.test(pmResult.stdout), String(pmResult.code))
check('容器里的 runner 完成了阶段 0 环境检查', tasks.some((t) => t.step === '0' && t.state === 'DONE'), tasks.filter((t) => t.step === '0').map((t) => t.state).join(',') || 'no step0')
const envFile = join(ART, 'env-info.md')
check('环境信息文档由容器产出（跨机器产物）', existsSync(envFile), existsSync(envFile) ? `${statSync(envFile).size}B` : 'missing')
check('交付件数量足够（≥5 份 1KB 以上的文档）', substantive.length >= 5, `${substantive.length} 份`)
check('流程覆盖 0/1.1/CP1/2.1/CP2.1/2.2/CP2.2', ['0', '1.1', 'CP1', '2.1', 'CP2.1', '2.2', 'CP2.2'].every((s) => tasks.some((t) => String(t.step).startsWith(s))), tasks.map((t) => t.step).join(','))
check('出现 revision 任务（打回→返工）', tasks.some((t) => t.type === 'revision'))
const unfinished = tasks.filter((t) => t.state !== 'DONE')
check('所有任务到达 DONE', unfinished.length === 0, unfinished.map((t) => `${t.step}:${t.state}`).join(',') || 'ok')
const slot = db.prepare("select round from slots where op = ? and slot = 'design'").get(OP)
check('R2 打回计入 design 槽', (slot?.round ?? 0) >= 1, `round=${slot?.round}`)
const verifyOut = spaceCli(['verify', '--dir', spaceDir])
check('投影 == 事件归约', /projection OK/.test(verifyOut), verifyOut.trim())
const byMember = {}
for (const e of db.prepare('select member_id, count(*) c from events where kind = ? group by member_id').all('artifact.published')) byMember[e.member_id] = e.c
check('产物来自多个成员（跨机器分布）', Object.keys(byMember).length >= 2, JSON.stringify(byMember))

const trace = spaceCli(['trace', '--dir', spaceDir, '--limit', '400']).trim().split('\n')
console.log('\n--- trace（末 12 条）---')
console.log(trace.slice(-12).join('\n'))
console.log(`\nenv-info.md 片段：`)
if (existsSync(envFile)) console.log(readFileSync(envFile, 'utf8').split('\n').slice(0, 8).join('\n'))

db.close()
hub.kill('SIGKILL')
spawnSync('docker', ['rm', '-f', 'space-runner'], { encoding: 'utf8' })
if (!KEEP) console.log(`\nspace：${spaceDir}（加 --keep 保留）`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log(`  - ${f.n}${f.d ? `: ${f.d}` : ''}`)
process.exit(failed.length ? 1 : 0)
