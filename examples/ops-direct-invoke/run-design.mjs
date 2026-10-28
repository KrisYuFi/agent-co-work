#!/usr/bin/env node
/**
 * examples/ops-direct-invoke/run-design.mjs
 *
 * 跑 ops-direct-invoke 的「需求 → 设计 → 设计 review」段：
 *   1.1 需求分析 → CP1(QA+人) → 2.1 测试方案 → CP2.1(QA) → 2.2 开发方案 → CP2.2(QA+人)
 *
 * 四个成员**都是成员**：pm / architect / qa 是真实 LLM 会话，human 是脚本扮演的人。
 * PM 不再由本脚本代劳——它自己用 space_* 工具派活、等活、判定、打回。
 *
 * 用法：node examples/ops-direct-invoke/run-design.mjs [--keep]
 *       [--pm dsh|opencode] [--architect dsh|opencode] [--qa dsh|opencode] [--timeout-min 30]
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const KEEP = process.argv.includes('--keep')
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const RT = {
  pm: opt('pm', 'dsh'),
  architect: opt('architect', 'dsh'),
  qa: opt('qa', 'opencode'),
}
const TIMEOUT_MIN = Number(opt('timeout-min', '30'))
const OC_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'
const OP = 'add'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const spaceCli = (args) => execFileSync(NODE, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const PATH = `${dirname(NODE)}:${process.env.PATH}`

// ───────────────────────────────────────────── 空间准备
const spaceDir = mkdtempSync(join(tmpdir(), 'space-ops-'))
const artifactsDir = join(spaceDir, 'artifacts', OP)
mkdirSync(artifactsDir, { recursive: true })
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
const requirementInput = `# 算子需求（用户原始输入）

实现 add 算子：逐元素相加，输入两个 float32 tensor（同形状、无广播），输出一个。
目标：先跑通功能，性能不是本次重点。目标芯片按 910B 假设，若不确定就记为待决项。
`
writeFileSync(join(spaceDir, 'artifacts', `${OP}-需求输入.md`), requirementInput)

spaceCli(['init', '--dir', spaceDir])
for (const [member, kind, role] of [
  ['pm', 'role', 'pm'],
  ['architect', 'role', 'architect'],
  ['qa', 'role', 'qa'],
  ['human', 'human', 'human'],
]) {
  writeFileSync(join(spaceDir, 'tokens', `${member}.token`), spaceCli(['token', 'issue', '--dir', spaceDir, '--member', member, '--role', role, '--kind', kind]))
}

console.log(`space: ${spaceDir}`)
console.log(`pm → ${RT.pm}，architect → ${RT.architect}，qa → ${RT.qa}（三个真实会话 + 脚本扮演的人）\n`)

// ───────────────────────────────────────────── 运行时配置 / 启动
function writeRuntimeConfig(runtime, member, dir) {
  const tokenFile = join(spaceDir, 'tokens', `${member}.token`)
  if (runtime === 'opencode') {
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          // 产物目录在 agent 的 project 目录之外；opencode 默认会对跨目录读写请求权限，
          // 非交互模式下 auto-reject（实测：QA 卡在 WORKING 五分钟）
          permission: { external_directory: 'allow', edit: 'allow', bash: 'allow' },
          mcp: { space: { type: 'local', command: [NODE, CLI, 'serve', '--dir', spaceDir, '--token-file', tokenFile], enabled: true, timeout: 60000 } },
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
        '        transport: stdio',
        `        command: ${NODE}`,
        '        args:',
        `          - ${CLI}`,
        '          - serve',
        '          - --dir',
        `          - ${spaceDir}`,
        '          - --token-file',
        `          - ${tokenFile}`,
        '        toolCallTimeoutMs: 60000',
      ].join('\n'),
    )
  }
}

function buildPrompt(member, runtime) {
  const t = (n) => (runtime === 'opencode' ? `space_space_${n}` : `mcp__space__space_${n}`)
  const roleDoc = readFileSync(join(HERE, 'roles', `${member}.md`), 'utf8')
  const isPm = member === 'pm'
  return `${roleDoc}

---
# 你在协作空间里的工作方式

你是一个**独立会话**，通过 MCP 工具和中心空间交互。工具名以 ${runtime === 'opencode' ? 'space_space_' : 'mcp__space__space_'} 开头。
空间根目录：${spaceDir}
产物目录（你自己不写产物，仅用于读）：${artifactsDir}/

## 启动
调用 \`${t('attach')}\`，参数 {"constitution_version":1,"capabilities":{"max_block_sec":60}}。
记下返回的 cursor。

## 主循环（最多 40 轮）
1. \`${t('wait')}\` {"since_cursor": <上次的 cursor>, "timeout_sec": 60}
   - reason="timeout" → 继续下一轮
   - tasks 里有 state=PENDING 的任务 → 取第一个，进入「干活」
2. 干活（每个任务）：
   a. \`${t('task_claim')}\` {"task_id": <id>, "lease_sec": 300}
   b. \`${t('task_transition')}\` {"task_id": <id>, "lease_id": <lease_id>, "to": "WORKING"}
   c. 读任务 inputs（文件在 ${spaceDir}/<uri>）
   d. 写交付件到 ${artifactsDir}/<任务 expected.filename>
   e. 算哈希：shasum -a 256 <文件>
   f. \`${t('publish')}\` {"uri":"artifacts/${OP}/<文件名>","sha256":<哈希>,"size":<字节>,"media_type":"text/markdown","task_id":<id>}
   g. 验收类任务（step 以 CP 开头）：\`${t('task_accept')}\` {"task_id": <id>, "cp": "<step>", "verdict": "pass" 或 "hold", "gaps": [...]}
   h. \`${t('task_transition')}\` {"task_id": <id>, "lease_id": <lease_id>, "to": "DONE", "payload": {"handoff": {"uri":"artifacts/${OP}/<文件名>","sha256":<哈希>,"size":<字节>}, "reason": "<一句话结论>"}}
3. 回到循环

## 底线
- 只能认领派给你的任务（to 是你，或 role 是你）；不是你的别碰。
- 交付件要像真的：有章节、有具体数值/接口签名。
- 做不了就 transition 到 FAILED 并写 reason。
- 循环 40 轮没有任务就结束，最后输出一行：AGENT_DONE <完成几个任务>${isPm ? '（PM 请输出 PM_DONE <总结>）' : ''}
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
  const logPath = join(spaceDir, `agent-${member}.log`)
  const done = new Promise((r) =>
    child.on('close', (code) => {
      try {
        writeFileSync(logPath, `# ${member} (${runtime}) exit=${code}\n--- stdout ---\n${out.stdout}\n--- stderr ---\n${out.stderr}`)
      } catch {}
      r({ code, ...out })
    }),
  )
  return { child, out, done, logPath }
}

/** 脚本扮演的人：等 question 任务，第一次 CP1 打回，其余通过 */
class Human {
  constructor() {
    this.nextId = 1
    this.pending = new Map()
    this.stop = false
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
  async run() {
    await this.tool('space_attach', { constitution_version: 1, capabilities: {} })
    let cursor = 0
    let rejected = false
    const deadline = Date.now() + TIMEOUT_MIN * 60_000
    while (!this.stop && Date.now() < deadline) {
      let r
      try {
        r = await this.tool('space_wait', { since_cursor: cursor, timeout_sec: 10 })
      } catch {
        break
      }
      cursor = r.cursor
      for (const t of r.tasks ?? []) {
        const claim = await this.tool('space_task_claim', { task_id: t.task_id, lease_sec: 120 })
        // PM 可能把问卷叫 CP1-question / CP1 · 问卷…，只要不是复核轮（CP1-r*）就算首次
        const stepText = String(t.step ?? '')
        const isFirstCP1 = /CP1/.test(stepText) && !/CP1-r\d/i.test(stepText) && !rejected
        const answer = isFirstCP1 ? 'reject：架构选型只给了推荐，目标芯片对该架构的支持情况没写清，无法拍板' : 'approve：可以进入下一步'
        if (isFirstCP1) rejected = true
        await this.tool('space_task_transition', { task_id: t.task_id, lease_id: claim.lease_id, to: 'WORKING' })
        await this.tool('space_task_transition', { task_id: t.task_id, lease_id: claim.lease_id, to: 'DONE', payload: { reason: answer, answer } })
        console.log(`  [human] 回答 ${t.step}：${answer.slice(0, 18)}…`)
      }
    }
  }
  close() {
    this.stop = true
    try {
      this.proc.stdin.end()
    } catch {}
  }
}

// ───────────────────────────────────────────── 起三个真实会话 + 人
const dirs = {}
for (const member of ['pm', 'architect', 'qa']) {
  dirs[member] = join(spaceDir, `member-${member}`)
  mkdirSync(dirs[member], { recursive: true })
  writeRuntimeConfig(RT[member], member, dirs[member])
}

const human = await new Human().start()
const humanLoop = human.run().catch((e) => console.error(`[human] 退出：${e.message}`))

const t0 = Date.now()
const agents = {}
for (const member of ['pm', 'architect', 'qa']) {
  agents[member] = spawnAgent(member, RT[member], dirs[member], buildPrompt(member, RT[member]))
}

// PM 是总控：它结束（或超时）就收尾
const pmResult = await Promise.race([
  agents.pm.done,
  sleep(TIMEOUT_MIN * 60_000).then(() => ({ code: 'TIMEOUT', stdout: agents.pm.out.stdout })),
])
const elapsed = ((Date.now() - t0) / 1000).toFixed(0)

human.close()
for (const m of ['architect', 'qa']) agents[m].child.kill('SIGKILL')
// 人的循环是「一直等」，关掉 stdin 后 in-flight 的 wait 不会返回，所以只等一小会儿
await Promise.race([humanLoop, sleep(2000)])

// ───────────────────────────────────────────── 验收（只看库与磁盘）
const rawDb = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const tasks = rawDb.prepare('select * from tasks order by created_at').all()
const files = existsSync(artifactsDir) ? readdirSync(artifactsDir).filter((f) => f.endsWith('.md')) : []
const substantive = files.filter((f) => statSync(join(artifactsDir, f)).size > 1024)
const sizes = substantive.map((f) => `${f}=${(statSync(join(artifactsDir, f)).size / 1024).toFixed(0)}KB`)

console.log(`\nPM 会话结束（exit=${pmResult.code}），总用时 ${elapsed}s\n`)

check('PM 是真实会话并自行完成编排（未超时）', pmResult.code === 0 && /PM_DONE/.test(pmResult.stdout), String(pmResult.code))
check('交付件数量足够（≥6 份 1KB 以上的文档）', substantive.length >= 6, `${substantive.length} 份: ${sizes.join(' ')}`)

const steps = tasks.map((t) => t.step)
check(
  'PM 派出了完整流程（1.1/CP1/2.1/CP2.1/2.2/CP2.2）',
  ['1.1', 'CP1', '2.1', 'CP2.1', '2.2', 'CP2.2'].every((s) => steps.some((x) => x && x.startsWith(s))),
  steps.join(','),
)
check('PM 建了 revision 任务（人打回 → 返工）', tasks.some((t) => t.type === 'revision'))
check('PM 建了人工确认任务（question ≥2）', tasks.filter((t) => t.type === 'question').length >= 2, `${tasks.filter((t) => t.type === 'question').length} 个`)

const unfinished = tasks.filter((t) => t.state !== 'DONE')
check('所有任务到达 DONE', unfinished.length === 0, unfinished.map((t) => `${t.step}:${t.state}`).join(',') || 'ok')

const slot = rawDb.prepare("select round from slots where op = ? and slot = 'design'").get(OP)
check('R2 打回计入 design 槽且没清零', (slot?.round ?? 0) >= 1, `round=${slot?.round}`)

const artifacts = rawDb.prepare('select uri, sha256 from artifacts').all()
const chainOk =
  artifacts.length > 0 && artifacts.every((a) => existsSync(join(spaceDir, a.uri)) && sha256(readFileSync(join(spaceDir, a.uri))) === a.sha256)
check('产物登记与磁盘一致（sha256 全对）', chainOk, `${artifacts.length} 个产物`)

const verifyOut = spaceCli(['verify', '--dir', spaceDir])
check('投影 == 事件归约', /projection OK/.test(verifyOut), verifyOut.trim())

const trace = spaceCli(['trace', '--dir', spaceDir, '--limit', '500']).trim().split('\n')
check('事件流可作 trace', trace.length >= 30, `${trace.length} 条事件`)

console.log('\n--- PM 最后 20 行 ---')
console.log(pmResult.stdout.split('\n').slice(-20).join('\n'))
console.log('\n--- trace 尾部 ---')
console.log(trace.slice(-10).join('\n'))
console.log(`\n日志：${spaceDir}/agent-*.log`)
if (!KEEP) console.log(`space：${spaceDir}（加 --keep 保留）`)

rawDb.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
process.exit(failed.length ? 1 : 0)
