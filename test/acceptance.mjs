#!/usr/bin/env node
/**
 * test/acceptance.mjs — ROADMAP 阶段 2 验收剧本
 *
 * 三个「假成员」直接说 MCP over stdio，不起任何模型：验证的是**空间骨架**，不是 agent 的智能。
 * 剧本（对应 ROADMAP.md 阶段 2）：
 *   成员 A: attach → wait
 *   成员 B: attach → task_create(assign → A)
 *   成员 A: 收到 → claim → publish 产物 → transition(DONE + handoff)
 *   成员 B: wait 收到 task.done 事件 → 读 handoff → 继续
 *   人:     中途插话打断 A 的 wait → A 响应 → 恢复 wait
 *   人:     拿另一个 token attach，验证越权操作被拒绝
 *
 * 用法：node test/acceptance.mjs [--keep]
 * 退出码：0 全通 / 1 有失败
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const KEEP = process.argv.includes('--keep')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
function expectError(name, err, code) {
  const got = err?.code ?? err?.payload?.error
  check(name, got === code, `expected ${code}, got ${got ?? err?.message}`)
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function spaceCli(args, { quiet = true } = {}) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
}

// ---------------------------------------------------------------- 一个成员 = 一个 serve 进程
class Member {
  constructor(name, kind, role) {
    this.name = name
    this.kind = kind
    this.role = role
    this.nextId = 1
    this.pending = new Map()
    this.log = []
  }

  async start(spaceDir) {
    const tokenFile = join(spaceDir, 'tokens', `${this.name}.token`)
    this.proc = spawn(process.execPath, [CLI, 'serve', '--dir', spaceDir, '--token-file', tokenFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d) => this.log.push(...String(d).split('\n').filter(Boolean)))

    let buf = ''
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk
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
          p.resolve(msg)
        }
      }
    })

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.name, version: '0.1.0' },
    })
    this.notify('notifications/initialized')
    return this
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** 发请求；返回原始消息。可被 cancel 放弃（模拟人插话） */
  request(method, params, { timeoutMs = 120000 } = {}) {
    const id = this.nextId++
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectP(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolveP(msg)
        },
      })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /** 模拟「人在这条会话里说了句话」：放弃当前工具调用 */
  cancelPending() {
    for (const id of [...this.pending.keys()]) {
      this.notify('notifications/cancelled', { requestId: id, reason: 'human interrupted' })
      this.pending.delete(id)
    }
  }

  /** 调工具，返回解析后的 JSON；isError 时抛带 code 的错 */
  async tool(name, args = {}) {
    const msg = await this.request('tools/call', { name, arguments: args })
    if (msg.error) throw Object.assign(new Error(msg.error.message), { code: `RPC_${msg.error.code}` })
    const text = msg.result?.content?.[0]?.text ?? '{}'
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
    if (msg.result?.isError) {
      const err = new Error(payload.message ?? 'tool error')
      err.code = payload.error
      err.payload = payload
      throw err
    }
    return payload
  }

  async close() {
    try {
      this.proc.stdin.end()
    } catch {}
  }
}

// ---------------------------------------------------------------- 剧本
const spaceDir = mkdtempSync(join(tmpdir(), 'space-acc-'))
console.log(`space: ${spaceDir}\n`)

spaceCli(['init', '--dir', spaceDir])
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })
for (const [member, kind, role] of [
  ['dev-code', 'role', 'developer'],
  ['pm', 'role', 'pm'],
  ['intruder', 'role', 'developer'],
  ['boss', 'human', 'human'],
]) {
  const token = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', member, '--role', role, '--kind', kind])
  writeFileSync(join(spaceDir, 'tokens', `${member}.token`), token)
}
const artifactDir = join(spaceDir, 'artifacts')
const artifactBody = Buffer.from('# add 算子设计\n\nTiling: 128\n')
writeFileSync(join(artifactDir, 'design.md'), artifactBody)

const A = await new Member('dev-code', 'role', 'developer').start(spaceDir)
const B = await new Member('pm', 'role', 'pm').start(spaceDir)
const C = await new Member('intruder', 'role', 'developer').start(spaceDir)
const HUMAN = await new Member('boss', 'human', 'human').start(spaceDir)

try {
  // 1. attach
  const aAttach = await A.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  check('A attach（身份 + 宪法版本）', aAttach.member.id === 'dev-code' && aAttach.constitution_version === 1)
  const bAttach = await B.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  check('B attach', bAttach.member.id === 'pm')
  await C.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  await HUMAN.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })

  // 宪法过旧必须被拒
  try {
    await C.tool('space_attach', { constitution_version: 0, capabilities: {} })
    check('宪法过旧被拒', false, 'no error raised')
  } catch (err) {
    expectError('宪法过旧被拒', err, 'CONSTITUTION_OUTDATED')
  }

  // 2. A 挂起等活（从 attach 给的游标开始，否则第一条事件就是自己的 member.attached）
  let cursorA = aAttach.cursor
  const waitP = A.tool('space_wait', { since_cursor: cursorA, timeout_sec: 20 })

  // 3. B 派活给 A
  const created = await B.tool('space_task_create', {
    type: 'assign',
    to: 'dev-code',
    op: 'add',
    step: '3.1',
    inputs: [{ uri: 'artifacts/design.md', sha256: sha(artifactBody) }],
    expected: { language: 'cuda' },
  })
  check('B task_create(assign → A)', Boolean(created.task_id), created.task_id)

  // 4. A 的 wait 立刻返回任务
  const woke = await waitP
  cursorA = woke.cursor
  check('A wait 被唤醒（reason=events）', woke.reason === 'events' && woke.tasks.length === 1, `reason=${woke.reason}`)
  const taskId = woke.tasks[0].task_id

  // 5. claim → WORKING
  const claim = await A.tool('space_task_claim', { task_id: taskId, lease_sec: 60 })
  check('A claim（拿到租约）', Boolean(claim.lease_id))
  await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'WORKING' })
  check('A CLAIMED → WORKING', true)

  // 6. 越权：B（非持有者）改 A 的任务
  try {
    await B.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'DONE', payload: {} })
    check('越权 transition 被拒', false, 'no error raised')
  } catch (err) {
    expectError('B 改 A 的任务被拒（LEASE_MISMATCH）', err, 'LEASE_MISMATCH')
  }

  // 7. 越权：C 认领派给 A 的任务
  const taskForA2 = await B.tool('space_task_create', { type: 'assign', to: 'dev-code', op: 'add', step: '3.2' })
  try {
    await C.tool('space_task_claim', { task_id: taskForA2.task_id })
    check('越权 claim 被拒', false, 'no error raised')
  } catch (err) {
    expectError('C 认领派给 A 的任务被拒（FORBIDDEN_ROLE）', err, 'FORBIDDEN_ROLE')
  }
  // 清掉这条遗留任务，否则它会让 A 的每次 wait 立刻返回（PENDING 派给 A）
  const claim2 = await A.tool('space_task_claim', { task_id: taskForA2.task_id })
  await A.tool('space_task_transition', { task_id: taskForA2.task_id, lease_id: claim2.lease_id, to: 'WORKING' })
  await A.tool('space_task_transition', { task_id: taskForA2.task_id, lease_id: claim2.lease_id, to: 'CANCELED', payload: { reason: '验收用，取消' } })

  // 8. 没有 handoff 不能 DONE
  try {
    await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'DONE', payload: {} })
    check('缺 handoff 被拒', false, 'no error raised')
  } catch (err) {
    expectError('缺 handoff 不能 DONE（HANDOFF_MISSING）', err, 'HANDOFF_MISSING')
  }

  // 9. publish → DONE + handoff
  const art = await A.tool('space_publish', {
    uri: 'artifacts/add_kernel.cu',
    sha256: sha('kernel'),
    size: 6,
    media_type: 'text/x-cuda',
    task_id: taskId,
  })
  check('A publish 产物（只登记引用）', Boolean(art.artifact_id))

  // handoff 指向未登记的 artifact 也要被拒
  try {
    await A.tool('space_task_transition', {
      task_id: taskId,
      lease_id: claim.lease_id,
      to: 'DONE',
      payload: { handoff: { uri: 'artifacts/nope.bin', sha256: 'deadbeef' } },
    })
    check('handoff 指向未登记制品被拒', false, 'no error raised')
  } catch (err) {
    expectError('handoff 指向未登记制品被拒（ARTIFACT_MISSING）', err, 'ARTIFACT_MISSING')
  }

  await A.tool('space_task_transition', {
    task_id: taskId,
    lease_id: claim.lease_id,
    to: 'DONE',
    payload: { handoff: { uri: 'artifacts/add_kernel.cu', sha256: sha('kernel') }, reason: 'kernel 实现完成' },
  })
  check('A DONE + handoff', true)

  // 10. B 收到完成事件并解析 handoff
  const bWoke = await B.tool('space_wait', { since_cursor: bAttach.cursor, timeout_sec: 10 })
  const doneEvent = bWoke.events.find((e) => e.kind === 'task.transitioned' && e.payload?.to === 'DONE')
  check('B wait 收到 task DONE 事件', Boolean(doneEvent), doneEvent ? `event#${doneEvent.id}` : 'missing')
  const resolved = await B.tool('space_artifact_resolve', { artifact_id: art.artifact_id })
  check('B 解析 handoff 引用（拿到 uri/sha256）', resolved.uri === 'artifacts/add_kernel.cu' && resolved.sha256 === sha('kernel'))

  // 11. R1：终态不可变
  try {
    await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'WORKING' })
    check('终态不可变被拒', false, 'no error raised')
  } catch (err) {
    expectError('R1 终态不可变被拒（TASK_STATE_INVALID）', err, 'TASK_STATE_INVALID')
  }

  // 12. R3：非 human 不能放宽硬门槛
  const task3 = await B.tool('space_task_create', { type: 'assign', to: 'dev-code', op: 'add', step: '3.3' })
  const claim3 = await A.tool('space_task_claim', { task_id: task3.task_id })
  await A.tool('space_task_transition', { task_id: task3.task_id, lease_id: claim3.lease_id, to: 'WORKING' })
  try {
    await A.tool('space_task_transition', {
      task_id: task3.task_id,
      lease_id: claim3.lease_id,
      to: 'DONE',
      payload: { relax_hard_gate: true, handoff: { uri: 'artifacts/add_kernel.cu', sha256: sha('kernel') } },
    })
    check('非 human 放宽硬门槛被拒', false, 'no error raised')
  } catch (err) {
    expectError('R3 非 human 放宽硬门槛被拒（FORBIDDEN_ROLE）', err, 'FORBIDDEN_ROLE')
  }

  // 13. 人中途插话：打断 A 的 wait，人发消息，A 恢复等待并收到
  // 先把已有事件排空，让这次 wait 真的挂住
  for (let i = 0; i < 8; i++) {
    const r = await A.tool('space_wait', { since_cursor: cursorA, timeout_sec: 1 })
    cursorA = r.cursor
    if (r.reason === 'timeout') break
  }
  const abandoned = A.tool('space_wait', { since_cursor: cursorA, timeout_sec: 15 }).then(
    (r) => ({ settled: true, r }),
    (e) => ({ settled: true, error: e }),
  )
  await new Promise((r) => setTimeout(r, 700))
  A.cancelPending() // 人在会话里说话 → 挂着的工具调用作废（runtime 丢弃它）
  const interruptedResult = await Promise.race([abandoned, new Promise((r) => setTimeout(() => r({ settled: false }), 1500))])
  check('人插话后挂着的 wait 被放弃（不再返回）', interruptedResult.settled === false, JSON.stringify(interruptedResult).slice(0, 120))

  const resumed = A.tool('space_wait', { since_cursor: cursorA, timeout_sec: 20 })
  await HUMAN.tool('space_msg_send', { to: 'dev-code', text: '3.3 先别收，我看一下产物' })
  const resumedResult = await resumed
  cursorA = resumedResult.cursor
  const msgEvent = resumedResult.events.find((e) => e.kind === 'message.sent')
  check('A 恢复 wait 并收到人的消息', Boolean(msgEvent), msgEvent?.payload?.text)

  // 14. 资源互斥（fpga:0）
  const r1 = await A.tool('space_resource_acquire', { name: 'fpga:0', lease_sec: 60 })
  check('A 拿到 fpga:0', Boolean(r1.lease_id))
  try {
    await C.tool('space_resource_acquire', { name: 'fpga:0', lease_sec: 60 })
    check('资源互斥被拒', false, 'no error raised')
  } catch (err) {
    expectError('C 抢 fpga:0 被拒（RESOURCE_BUSY）', err, 'RESOURCE_BUSY')
  }
  await A.tool('space_resource_release', { lease_id: r1.lease_id })

  // 15. 吊销：token 作废 + 名下任务回收
  spaceCli(['token', 'revoke', '--dir', spaceDir, '--member', 'dev-code'])
  try {
    await A.tool('space_state_get', { op: 'add' })
    check('吊销后旧会话被拒', false, 'no error raised')
  } catch (err) {
    expectError('吊销后该 token 被拒（TOKEN_REVOKED）', err, 'TOKEN_REVOKED')
  }
  const taskStateNow = await B.tool('space_task_list', { filter: { op: 'add' } })
  const t33 = taskStateNow.tasks.find((t) => t.task_id === task3.task_id)
  check('吊销后名下 WORKING 任务回 PENDING', t33?.state === 'PENDING', `state=${t33?.state}`)

  // 16. 投影与事件归约一致（可重放校验）
  const verified = await B.tool('space_verify', {})
  check('投影 == 事件归约（可重放）', verified.ok === true, JSON.stringify(verified.drift))

  // 17. trace 可读
  const trace = spaceCli(['trace', '--dir', spaceDir, '--limit', '100'])
  check('事件流可作 trace（14+ 条可读行）', trace.split('\n').length >= 14, `${trace.split('\n').length} lines`)
} finally {
  await Promise.all([A.close(), B.close(), C.close(), HUMAN.close()])
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
}
if (KEEP) console.log(`\n保留的 space 目录：${spaceDir}`)
else console.log(`\nspace 目录：${spaceDir}（--keep 可保留）`)

process.exit(failed.length === 0 ? 0 : 1)
