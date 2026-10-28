#!/usr/bin/env node
/**
 * examples/ops-direct-invoke/run-design.mjs
 *
 * 跑 ops-direct-invoke 的**编码之前**那一段：需求 → 设计 → 设计 review。
 *   1.1 需求分析 → CP1(QA+人) → 2.1 测试方案 → CP2.1(QA) → 2.2 开发方案 → CP2.2(QA+人)
 * 其中 CP1 故意被打回一次，用来验证 revision 任务 + R2 轮次槽位。
 *
 * 参与者：
 *   - pm        脚本（本进程），用与 agent 完全相同的 MCP 工具派活/收活
 *   - architect **真实 agent**（dsh）
 *   - qa        **真实 agent**（opencode）
 *   - human     脚本（扮演人，回答 CP 问卷）
 *
 * 用法：node examples/ops-direct-invoke/run-design.mjs [--keep] [--architect dsh|opencode] [--qa dsh|opencode]
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const KEEP = process.argv.includes('--keep')
const arg = (name, dflt) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : dflt)
const RUNTIME_ARCH = arg('architect', 'dsh')
const RUNTIME_QA = arg('qa', 'opencode')
const OC_MODEL = process.env.PROBE_OPENCODE_MODEL || 'deepseek/deepseek-v4-pro'
const OP = 'add'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ───────────────────────────────────────────── 空间准备
const spaceDir = mkdtempSync(join(tmpdir(), 'space-ops-'))
const artifactsDir = join(spaceDir, 'artifacts', OP)
mkdirSync(artifactsDir, { recursive: true })
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
writeFileSync(join(spaceDir, 'artifacts', `${OP}-需求输入.md`), `# 算子需求（用户原始输入）\n\n实现 add 算子：逐元素相加，输入两个 float32 tensor，输出一个。\n目标：先跑通功能，性能不是本次重点。\n`)

const { execFileSync } = await import('node:child_process')
const spaceCli = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

spaceCli(['init', '--dir', spaceDir])
for (const [member, kind, role] of [
  ['pm', 'role', 'pm'],
  ['architect', 'role', 'architect'],
  ['qa', 'role', 'qa'],
  ['human', 'human', 'human'],
]) {
  writeFileSync(join(spaceDir, 'tokens', `${member}.token`), spaceCli(['token', 'issue', '--dir', spaceDir, '--member', member, '--role', role, '--kind', kind]))
}
console.log(`space: ${spaceDir}\n协议：ops-direct-invoke 设计段（1.1 → CP1 → 2.1 → CP2.1 → 2.2 → CP2.2）\n`)

// ───────────────────────────────────────────── 两个真实 agent 的配置
function writeRuntimeConfig(runtime, member, dir) {
  const tokenFile = join(spaceDir, 'tokens', `${member}.token`)
  if (runtime === 'opencode') {
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          // 产物目录在 agent 的 project 目录之外，opencode 默认会对跨目录读写"请求权限"，
          // 非交互模式下直接 auto-reject（实测：QA 读需求文档被拒，任务卡在 WORKING）。
          // 这正是 ADR 0001 说的「文件系统当协作空间会撞上的墙」的一个具体形态。
          permission: { external_directory: 'allow', edit: 'allow', bash: 'allow' },
          mcp: { space: { type: 'local', command: [process.execPath, CLI, 'serve', '--dir', spaceDir, '--token-file', tokenFile], enabled: true, timeout: 60000 } },
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
        `        command: ${process.execPath}`,
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

function spawnAgent(runtime, member, dir, prompt) {
  const env = { ...process.env, PATH: `/Users/krisyu/.nvm/versions/node/v26.1.0/bin:${process.env.PATH}` }
  let cmd
  let args
  if (runtime === 'opencode') {
    cmd = 'opencode'
    args = ['run', '--pure', '-m', OC_MODEL, '--dir', dir, prompt]
  } else {
    const key = process.env.DEEPSEEK_API_KEY || readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1]
    env.DEEPSEEK_API_KEY = key
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
  child.on('close', (code) => {
    try {
      writeFileSync(logPath, `# ${member} (${runtime}) exit=${code}\n--- stdout ---\n${out.stdout}\n--- stderr ---\n${out.stderr}`)
    } catch {}
  })
  return { child, out, logPath, done: new Promise((r) => child.on('close', (code) => r({ code, ...out }))) }
}

/** 给真实 agent 的提示词：角色职责 + 空间协议（工具名按 runtime 前缀） */
function buildPrompt(member, runtime, role) {
  const t = runtime === 'opencode' ? (n) => `space_space_${n}` : (n) => `mcp__space__space_${n}`
  const roleDoc = readFileSync(join(HERE, 'roles', `${member}.md`), 'utf8')
  return `${roleDoc}

---
# 你在协作空间里的工作方式

你是一个**独立会话**，通过 MCP 工具和中心空间交互。工具名以 ${runtime === 'opencode' ? 'space_space_' : 'mcp__space__space_'} 开头。
空间根目录：${spaceDir}
产物请写到：${artifactsDir}/  （发布时 uri 用相对路径 artifacts/${OP}/<文件名>，不带反引号）

## 启动
调用 \`${t('attach')}\`，参数 {"constitution_version":1,"capabilities":{"max_block_sec":60}}。
记下返回的 cursor。

## 主循环（最多 30 轮；每轮 wait 60 秒，覆盖整个流程约 30 分钟）
1. \`${t('wait')}\` 参数 {"since_cursor": <上次的 cursor>, "timeout_sec": 60}
   - reason="timeout" → 继续下一轮
   - 返回的 tasks 里有 state=PENDING 的任务 → 取第一个，进入「干活」
2. 干活（对每个任务）：
   a. \`${t('task_claim')}\` {"task_id": <id>, "lease_sec": 300} → 拿到 lease_id
   b. \`${t('task_transition')}\` {"task_id": <id>, "lease_id": <lease_id>, "to": "WORKING"}
   c. 用任务里的 inputs（uri + sha256）读上游交付件：文件在 ${spaceDir}/<uri>
   d. 按角色职责写交付件到 ${artifactsDir}/<任务 expected.filename>
   e. 用 shell 算哈希：shasum -a 256 <文件>
   f. \`${t('publish')}\` {"uri":"artifacts/${OP}/<文件名>","sha256":<哈希>,"size":<字节数>,"media_type":"text/markdown","task_id":<id>}
   g. 若是验收类任务（step 以 CP 开头）：\`${t('task_accept')}\` {"task_id": <id>, "cp": "<step>", "verdict": "pass" 或 "hold", "gaps": [...], "evidence": {...}}
   h. \`${t('task_transition')}\` {"task_id": <id>, "lease_id": <lease_id>, "to": "DONE", "payload": {"handoff": {"uri":"artifacts/${OP}/<文件名>", "sha256":<哈希>, "size":<字节数>}, "reason": "<一句话结论>"}}
3. 回到循环

## 底线
- 只能认领派给你（to 是你或 role 是你）的任务；不是你的别碰。
- 交付件要像真的：有章节、有具体数值/接口签名，不要写占位提纲。
- 做不了就 \`${t('task_transition')}\` 到 FAILED 并写 reason，不要静默卡住。
- 循环 30 轮没有任务就正常结束，最后输出一行：AGENT_DONE <你完成了几个任务>
`
}

// ───────────────────────────────────────────── 脚本扮演的 MCP 成员（pm / human）
class ScriptedMember {
  constructor(name) {
    this.name = name
    this.nextId = 1
    this.pending = new Map()
  }
  async start() {
    this.proc = spawn(process.execPath, [CLI, 'serve', '--dir', spaceDir, '--token-file', join(spaceDir, 'tokens', `${this.name}.token`)], { stdio: ['pipe', 'pipe', 'pipe'] })
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
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '0' } })
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
  close() {
    try {
      this.proc.stdin.end()
    } catch {}
  }
}

const pm = await new ScriptedMember('pm').start()
const human = await new ScriptedMember('human').start()
const rawDb = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const taskRow = (id) => rawDb.prepare('select * from tasks where id = ?').get(id)

await pm.tool('space_attach', { constitution_version: 1, capabilities: {} })
await human.tool('space_attach', { constitution_version: 1, capabilities: {} })

// ───────────────────────────────────────────── 起两个真实 agent
const archDir = join(spaceDir, 'member-architect')
const qaDir = join(spaceDir, 'member-qa')
mkdirSync(archDir, { recursive: true })
mkdirSync(qaDir, { recursive: true })
writeRuntimeConfig(RUNTIME_ARCH, 'architect', archDir)
writeRuntimeConfig(RUNTIME_QA, 'qa', qaDir)

console.log(`architect → ${RUNTIME_ARCH}，qa → ${RUNTIME_QA}（两个真实会话并发）\n`)
const t0 = Date.now()
const architect = spawnAgent(RUNTIME_ARCH, 'architect', archDir, buildPrompt('architect', RUNTIME_ARCH, 'architect'))
const qa = spawnAgent(RUNTIME_QA, 'qa', qaDir, buildPrompt('qa', RUNTIME_QA, 'qa'))

// 人：脚本循环回答 question 任务（第一次 CP1 打回，其余通过）
let cp1Seen = false
let humanStop = false
const humanLoop = (async () => {
  let cursor = 0
  const humanDeadline = Date.now() + 45 * 60_000
  while (!humanStop && Date.now() < humanDeadline) {
    const r = await human.tool('space_wait', { since_cursor: cursor, timeout_sec: 10 })
    cursor = r.cursor
    const pending = r.tasks?.filter((t) => t.state === 'PENDING') ?? []
    for (const t of pending) {
      const claim = await human.tool('space_task_claim', { task_id: t.task_id, lease_sec: 120 })
      const isCP1 = /CP1/.test(t.step ?? '') && !cp1Seen
      const answer = isCP1
        ? 'reject：架构选型只给了推荐，目标芯片对该架构的支持情况没写清，无法拍板'
        : 'approve：可以进入下一步'
      if (isCP1) cp1Seen = true
      // 状态机是 CLAIMED → WORKING → DONE，人也不能跳步
      await human.tool('space_task_transition', { task_id: t.task_id, lease_id: claim.lease_id, to: 'WORKING' })
      await human.tool('space_task_transition', {
        task_id: t.task_id,
        lease_id: claim.lease_id,
        to: 'DONE',
        payload: { reason: answer, answer },
      })
      console.log(`  [human] 回答 ${t.step}：${answer.slice(0, 20)}…`)
    }
  }
})()

// ───────────────────────────────────────────── PM：派活 + 收活
async function createTask(args) {
  const r = await pm.tool('space_task_create', { op: OP, ...args })
  return r.task_id
}
async function waitDone(taskId, { timeoutMs = 420000, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = taskRow(taskId)
    if (row?.state === 'DONE') return row
    if (row?.state === 'FAILED') throw new Error(`${label || taskId} FAILED: ${row.reason}`)
    await sleep(500)
  }
  throw new Error(`${label || taskId} 超时未完成（state=${taskRow(taskId)?.state}）`)
}
async function question(step, text) {
  const id = await createTask({ type: 'question', to: 'human', step, expected: { question: text } })
  return waitDone(id, { label: `question ${step}` })
}

try {
  // 1.1 需求分析
  const t11 = await createTask({
    type: 'assign',
    to: 'architect',
    step: '1.1',
    inputs: [{ uri: `artifacts/${OP}-需求输入.md`, sha256: sha256(readFileSync(join(spaceDir, 'artifacts', `${OP}-需求输入.md`))) }],
    expected: { filename: '1.1-需求分析.md', deliverable: '需求文档（含代码架构推荐）' },
  })
  await waitDone(t11, { label: '1.1' })
  console.log('  [pm] 1.1 需求分析 完成')

  // CP1（QA 验收 → 人确认 → 打回 → revision）
  const cp1 = await createTask({ type: 'assign', to: 'qa', step: 'CP1', refs: [t11], inputs: [taskRow(t11).handoff_uri ? { uri: taskRow(t11).handoff_uri, sha256: taskRow(t11).handoff_sha } : {}], expected: { filename: 'CP1-需求验收报告.md' } })
  await waitDone(cp1, { label: 'CP1' })
  console.log('  [pm] CP1 QA 验收完成')
  const q1 = await question('CP1', '需求文档是否可拍板？架构选型是否已给出目标芯片支持情况？')
  check('CP1 问卷打到人（WAITING_INPUT 语义）', /reject/.test(q1.reason ?? ''), (q1.reason ?? '').slice(0, 40))

  // 打回 → revision（R2：slot 由服务端按 cp 查表）
  const rev = await createTask({ type: 'revision', refs: [t11], cp: 'CP1', to: 'architect', step: '1.1-r2', expected: { filename: '1.1-需求分析-v2.md', fix: q1.reason } })
  await waitDone(rev, { label: 'revision 1.1' })
  console.log('  [pm] revision 任务完成（architect 已按意见修订）')

  const cp1b = await createTask({ type: 'assign', to: 'qa', step: 'CP1-r2', refs: [rev], inputs: [{ uri: taskRow(rev).handoff_uri, sha256: taskRow(rev).handoff_sha }], expected: { filename: 'CP1-需求验收报告-r2.md' } })
  await waitDone(cp1b, { label: 'CP1-r2' })
  const q1b = await question('CP1-r2', '修订后的需求文档是否可拍板？')
  check('CP1 第二轮人工确认通过', /approve/.test(q1b.reason ?? ''), (q1b.reason ?? '').slice(0, 40))

  // 2.1 测试方案 → CP2.1
  const t21 = await createTask({ type: 'assign', to: 'architect', step: '2.1', inputs: [{ uri: taskRow(rev).handoff_uri, sha256: taskRow(rev).handoff_sha }], expected: { filename: '2.1-测试方案设计.md' } })
  await waitDone(t21, { label: '2.1' })
  console.log('  [pm] 2.1 测试方案 完成')
  const cp21 = await createTask({ type: 'assign', to: 'qa', step: 'CP2.1', refs: [t21], inputs: [{ uri: taskRow(t21).handoff_uri, sha256: taskRow(t21).handoff_sha }], expected: { filename: 'CP2.1-测试方案验收报告.md' } })
  await waitDone(cp21, { label: 'CP2.1' })
  console.log('  [pm] CP2.1 完成')

  // 2.2 开发方案 → CP2.2 → 人确认
  const t22 = await createTask({ type: 'assign', to: 'architect', step: '2.2', inputs: [{ uri: taskRow(rev).handoff_uri, sha256: taskRow(rev).handoff_sha }], expected: { filename: '2.2-开发方案设计.md' } })
  await waitDone(t22, { label: '2.2' })
  console.log('  [pm] 2.2 开发方案 完成')
  const cp22 = await createTask({ type: 'assign', to: 'qa', step: 'CP2.2', refs: [t22], inputs: [{ uri: taskRow(t22).handoff_uri, sha256: taskRow(t22).handoff_sha }], expected: { filename: 'CP2.2-方案验收报告.md' } })
  await waitDone(cp22, { label: 'CP2.2' })
  const q22 = await question('CP2.2', '开发方案是否可进入编码？')
  check('CP2.2 问卷打到人并获批', /approve/.test(q22.reason ?? ''), (q22.reason ?? '').slice(0, 40))

  console.log('\n设计段（1.1 → CP2.2）全流程跑完，等待两个 agent 收尾…\n')
} catch (err) {
  check('工作流推进无异常', false, err.message)
} finally {
  // 让 agent 自然结束（它们的循环会在无任务时退出）
  const waited = await Promise.race([Promise.all([architect.done, qa.done]), sleep(120000).then(() => 'timeout')])
  if (waited === 'timeout') {
    architect.child.kill('SIGKILL')
    qa.child.kill('SIGKILL')
  }
  humanStop = true
  human.close()
  await humanLoop.catch(() => {})

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const archOut = architect.out
  const qaOut = qa.out

  const tasks = rawDb.prepare('select * from tasks order by created_at').all()
  const docs = ['1.1-需求分析.md', '1.1-需求分析-v2.md', '2.1-测试方案设计.md', '2.2-开发方案设计.md']
  const present = docs.filter((f) => existsSync(join(artifactsDir, f)))
  const sizes = present.map((f) => `${f}:${statSync(join(artifactsDir, f)).size}B`)

  console.log(`\n两个真实会话用时 ${secs}s（architect exit=${architect.out.code ?? '?'}, qa exit=${qa.out.code ?? '?'}）\n`)

  check('architect 交付了需求文档（真实文件）', present.includes('1.1-需求分析.md'), sizes.join(' '))
  check('architect 按打回意见产出了修订版', present.includes('1.1-需求分析-v2.md'))
  check('architect 交付了测试方案', present.includes('2.1-测试方案设计.md'))
  check('architect 交付了开发方案', present.includes('2.2-开发方案设计.md'))

  const doneCount = tasks.filter((t) => t.state === 'DONE').length
  check('任务全部到达 DONE', doneCount === tasks.length && tasks.length >= 10, `${doneCount}/${tasks.length}`)

  const revision = tasks.find((t) => t.type === 'revision')
  const slot = rawDb.prepare("select round from slots where op = ? and slot = 'design'").get(OP)
  check('R2 轮次按服务端归属计数（CP1 打回记进 design 槽）', Boolean(revision) && slot?.round === 1, `round=${slot?.round}`)

  const handoffs = tasks.filter((t) => t.handoff_uri).length
  check('每个交付类任务都带 handoff', handoffs >= 6, `${handoffs} 个`)

  // handoff 交链：登记 sha 必须等于文件真值
  const artifacts = rawDb.prepare('select uri, sha256 from artifacts').all()
  const chainOk = artifacts.every((a) => {
    const f = join(spaceDir, a.uri)
    if (!existsSync(f)) return false
    return sha256(readFileSync(f)) === a.sha256
  })
  check('产物登记与磁盘内容一致（sha256 全对）', chainOk, `${artifacts.length} 个产物`)

  const verifyOut = spaceCli(['verify', '--dir', spaceDir])
  check('投影 == 事件归约（可重放）', /projection OK/.test(verifyOut), verifyOut.trim())

  const trace = spaceCli(['trace', '--dir', spaceDir, '--limit', '400']).trim().split('\n')
  const kinds = new Set(trace.map((l) => l.trim().split(/\s+/)[2]).filter(Boolean))
  check('事件流覆盖 创建/认领/迁移/发布/人答', ['task.created', 'task.claimed', 'task.transitioned', 'artifact.published', 'handoff.written'].every((k) => kinds.has(k)), `${trace.length} 条事件`)

  console.log('\n--- qa 最后 25 行（诊断卡点）---')
  console.log(qa.out.stdout.split('\n').slice(-25).join('\n'))
  console.log('\n--- architect 最后 12 行 ---')
  console.log(architect.out.stdout.split('\n').slice(-12).join('\n'))
  console.log(`\n日志：${architect.logPath}\n      ${qa.logPath}`)

  console.log('\n--- trace 尾部 ---')
  console.log(trace.slice(-12).join('\n'))
  if (!KEEP) console.log(`\nspace 目录：${spaceDir}（加 --keep 保留）`)

  rawDb.close()
  pm.close()
  human.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(failed.length ? 1 : 0)
}
