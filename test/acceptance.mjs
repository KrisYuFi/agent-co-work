#!/usr/bin/env node
/**
 * test/acceptance.mjs — ROADMAP 阶段 2 验收
 *
 * 设计原则：**每条断言都必须在实现坏掉时失败**。
 * 上一版的教训（见 ADR 0009）：`check(name, true)` 这类占位断言、以及只比较
 * `state` 字符串而不试「回收之后还能不能再认领」，会让 25/25 变成假信号。
 *
 * 五个假成员直接说 MCP over stdio（不起模型）：验的是空间骨架，不是 agent 的智能。
 * 关键事实一律回 sqlite 直接核对，不采信任何一方自述。
 *
 * 用法：node test/acceptance.mjs [--keep]
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

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
  const got = err?.code
  check(name, got === code, `expected ${code}, got ${got ?? err?.message}`)
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spaceCli = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

class Member {
  constructor(name) {
    this.name = name
    this.nextId = 1
    this.pending = new Map()
    this.stderr = []
  }

  async start(spaceDir) {
    const tokenFile = join(spaceDir, 'tokens', `${this.name}.token`)
    this.proc = spawn(process.execPath, [CLI, 'serve', '--dir', spaceDir, '--token-file', tokenFile], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d) => this.stderr.push(...String(d).split('\n').filter(Boolean)))
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
          p(msg)
        }
      }
    })
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '0.1.0' } })
    this.notify('notifications/initialized')
    return this
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  request(method, params, { timeoutMs = 60000 } = {}) {
    const id = this.nextId++
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectP(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolveP(msg)
      })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /** 只发不等：返回 requestId，供精确取消 / 稍后取响应 */
  sendTool(name, args = {}) {
    const id = this.nextId++
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    return id
  }

  cancelRequest(id, reason = 'human interrupted') {
    this.notify('notifications/cancelled', { requestId: id, reason })
  }

  awaitResponse(id, ms) {
    return new Promise((resolveP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolveP(null)
      }, ms)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolveP(msg)
      })
    })
  }

  async tool(name, args = {}) {
    return this.unwrap(await this.request('tools/call', { name, arguments: args }), name)
  }

  unwrap(msg, name) {
    if (msg?.error) throw Object.assign(new Error(msg.error.message), { code: `RPC_${msg.error.code}` })
    const text = msg?.result?.content?.[0]?.text ?? '{}'
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
    if (msg?.result?.isError) {
      const err = new Error(payload.message ?? `${name} failed`)
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

// ---------------------------------------------------------------- 准备
const spaceDir = mkdtempSync(join(tmpdir(), 'space-acc-'))
console.log(`space: ${spaceDir}\n`)
spaceCli(['init', '--dir', spaceDir])
mkdirSync(join(spaceDir, 'tokens'), { recursive: true })
mkdirSync(join(spaceDir, 'artifacts'), { recursive: true })

for (const [member, kind, role] of [
  ['dev-code', 'role', 'developer'],
  ['pm', 'role', 'pm'],
  ['qa', 'role', 'qa'],
  ['intruder', 'role', 'developer'],
  ['boss', 'human', 'human'],
]) {
  writeFileSync(join(spaceDir, 'tokens', `${member}.token`), spaceCli(['token', 'issue', '--dir', spaceDir, '--member', member, '--role', role, '--kind', kind]))
}

const rawDb = new DatabaseSync(join(spaceDir, 'space.sqlite'))
const rowOf = (id) => rawDb.prepare('select * from tasks where id = ?').get(id)
const kindsOf = (id) => rawDb.prepare('select kind from events where task_id = ?').all(id).map((r) => r.kind)

const A = await new Member('dev-code').start(spaceDir)
const B = await new Member('pm').start(spaceDir)
const QA = await new Member('qa').start(spaceDir)
const C = await new Member('intruder').start(spaceDir)
const H = await new Member('boss').start(spaceDir)

try {
  // ── 1. 入场 ────────────────────────────────────────────────
  const aAttach = await A.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  check('A attach（身份 + 宪法版本 + 游标）', aAttach.member?.id === 'dev-code' && aAttach.constitution_version === 1 && typeof aAttach.cursor === 'number', `cursor=${aAttach.cursor}`)
  const bAttach = await B.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  await QA.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  await C.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  await H.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
  let curA = aAttach.cursor
  let curB = bAttach.cursor

  try {
    await C.tool('space_attach', { constitution_version: 0, capabilities: {} })
    check('宪法过旧被拒', false, 'no error raised')
  } catch (err) {
    expectError('宪法过旧被拒（CONSTITUTION_OUTDATED）', err, 'CONSTITUTION_OUTDATED')
  }

  // ── 2. 主链路 ──────────────────────────────────────────────
  const waitP = A.tool('space_wait', { since_cursor: curA, timeout_sec: 20 })
  const created = await B.tool('space_task_create', { type: 'assign', to: 'dev-code', op: 'add', step: '3.1', expected: { language: 'cuda' } })
  const taskId = created.task_id

  const woke = await waitP
  curA = woke.cursor
  check('A 的 wait 被任务唤醒（reason=events）', woke.reason === 'events' && woke.tasks.length === 1, `reason=${woke.reason} tasks=${woke.tasks.length}`)

  const claim = await A.tool('space_task_claim', { task_id: taskId, lease_sec: 120 })
  check('A claim 拿到租约', Boolean(claim.lease_id) && rowOf(taskId).owner === 'dev-code')
  const working = await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'WORKING' })
  check('CLAIMED → WORKING（核对库内状态）', working.state === 'WORKING' && rowOf(taskId).state === 'WORKING')

  try {
    await B.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'DONE', payload: {} })
    check('非持有者改任务被拒', false, 'no error raised')
  } catch (err) {
    expectError('B 改 A 的任务被拒（LEASE_MISMATCH）', err, 'LEASE_MISMATCH')
  }

  const taskForA = await B.tool('space_task_create', { type: 'assign', to: 'dev-code', op: 'add', step: '3.2' })
  try {
    await C.tool('space_task_claim', { task_id: taskForA.task_id })
    check('跨成员认领被拒', false, 'no error raised')
  } catch (err) {
    expectError('C 认领派给 A 的任务被拒（FORBIDDEN_ROLE）', err, 'FORBIDDEN_ROLE')
  }
  // 收尾这条任务：否则它会让后面「排空 wait 直到 timeout」永远排不空
  const cForA = await A.tool('space_task_claim', { task_id: taskForA.task_id })
  await A.tool('space_task_transition', { task_id: taskForA.task_id, lease_id: cForA.lease_id, to: 'WORKING' })
  await A.tool('space_task_transition', { task_id: taskForA.task_id, lease_id: cForA.lease_id, to: 'CANCELED', payload: { reason: '验收用，取消' } })

  // ── 3. handoff 硬门槛 + 交链 ───────────────────────────────
  try {
    await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'DONE', payload: {} })
    check('缺 handoff 不能 DONE', false, 'no error raised')
  } catch (err) {
    expectError('缺 handoff 不能 DONE（HANDOFF_MISSING）', err, 'HANDOFF_MISSING')
  }

  const body = Buffer.from('kernel v1')
  const kernelSha = sha(body)
  const art = await A.tool('space_publish', { uri: 'artifacts/add_kernel.cu', sha256: kernelSha, size: body.length, media_type: 'text/x-cuda', task_id: taskId })
  check('A 登记产物引用（只存引用）', Boolean(art.artifact_id))

  await C.tool('space_publish', { uri: 'artifacts/intruder.cu', sha256: sha('x'), size: 1 })
  try {
    await A.tool('space_task_transition', {
      task_id: taskId,
      lease_id: claim.lease_id,
      to: 'DONE',
      payload: { handoff: { uri: 'artifacts/intruder.cu', sha256: sha('x') } },
    })
    check('拿别人的产物当 handoff 被拒', false, 'no error raised')
  } catch (err) {
    expectError('拿别人的产物当 handoff 被拒（ARTIFACT_MISSING）', err, 'ARTIFACT_MISSING')
  }

  try {
    await A.tool('space_task_transition', {
      task_id: taskId,
      lease_id: claim.lease_id,
      to: 'DONE',
      payload: { handoff: { uri: 'artifacts/never-published.bin', sha256: '0'.repeat(64) } },
    })
    check('handoff 指向未登记制品被拒', false, 'no error raised')
  } catch (err) {
    expectError('handoff 指向未登记制品被拒（ARTIFACT_MISSING）', err, 'ARTIFACT_MISSING')
  }

  const done = await A.tool('space_task_transition', {
    task_id: taskId,
    lease_id: claim.lease_id,
    to: 'DONE',
    payload: { handoff: { uri: 'artifacts/add_kernel.cu', sha256: kernelSha, size: body.length }, reason: 'kernel 完成' },
  })
  check('A DONE + handoff（核对库内交链）', done.state === 'DONE' && rowOf(taskId).handoff_sha === kernelSha)
  check('事件流记下 handoff.written', kindsOf(taskId).includes('handoff.written'))

  // 幂等：wait 超时 / 工具调用被超时或插话打断后 agent 会重试，重试不该报错
  const again = await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'DONE', payload: {} })
  check('重复 DONE 幂等返回（不报错）', again.state === 'DONE' && again.idempotent === true, JSON.stringify(again))

  // ── 4. 下游收到完成 + 解析引用 ─────────────────────────────
  const bWoke = await B.tool('space_wait', { since_cursor: curB, timeout_sec: 10 })
  curB = bWoke.cursor
  const doneEvent = bWoke.events.find((e) => e.kind === 'task.transitioned' && e.payload?.to === 'DONE')
  check('B 收到 task DONE 事件', Boolean(doneEvent), doneEvent ? `event#${doneEvent.id}` : 'missing')
  const resolved = await B.tool('space_artifact_resolve', { artifact_id: art.artifact_id })
  check('B 解析 handoff 引用（uri + sha256 + size）', resolved.uri === 'artifacts/add_kernel.cu' && resolved.sha256 === kernelSha && resolved.size === body.length)

  // ── 5. R1 终态不可变 ──────────────────────────────────────
  try {
    await A.tool('space_task_transition', { task_id: taskId, lease_id: claim.lease_id, to: 'WORKING' })
    check('R1 终态不可变', false, 'no error raised')
  } catch (err) {
    expectError('R1 终态不可变（TASK_STATE_INVALID）', err, 'TASK_STATE_INVALID')
  }

  // ── 6. R3 硬门槛归人（独立动作，不再看客户端自报字段）────
  const t3 = await B.tool('space_task_create', { type: 'assign', to: 'dev-code', op: 'add', step: '3.3' })
  await A.tool('space_task_claim', { task_id: t3.task_id })
  const evidence = { quantified_gap: 'TFLOPS 差 18%', exhausted_optimizations: 'tiling/vector/双缓冲 均负结果', design_contradiction: '设计假设 128 对齐与实测带宽矛盾' }
  try {
    await A.tool('space_task_accept', { task_id: t3.task_id, verdict: 'relax', evidence })
    check('agent 放宽硬门槛被拒', false, 'no error raised')
  } catch (err) {
    expectError('R3 agent 放宽硬门槛被拒（FORBIDDEN_ROLE）', err, 'FORBIDDEN_ROLE')
  }
  try {
    await H.tool('space_task_accept', { task_id: t3.task_id, verdict: 'relax', evidence: { quantified_gap: 'x' } })
    check('human 放宽但证据不全被拒', false, 'no error raised')
  } catch (err) {
    expectError('human 放宽但证据不全被拒（EVIDENCE_INSUFFICIENT）', err, 'EVIDENCE_INSUFFICIENT')
  }
  try {
    await QA.tool('space_task_accept', { task_id: t3.task_id, verdict: 'pass', cp: 'CP3', gaps: [{ id: 'G1', issue: '需求与文档冲突', blocking: true }] })
    check('pass 带阻断级 gap 被拒', false, 'no error raised')
  } catch (err) {
    expectError('pass 不能带阻断级 gap（EVIDENCE_INSUFFICIENT）', err, 'EVIDENCE_INSUFFICIENT')
  }

  const relaxed = await H.tool('space_task_accept', { task_id: t3.task_id, verdict: 'relax', cp: 'CP3', evidence })
  check('human 带齐证据可放宽（记 cp.judged）', relaxed.relaxed === true && rawDb.prepare("select count(*) c from events where kind='cp.judged'").get().c >= 1)

  // ── 7. R2 轮次槽位由服务端确定 ────────────────────────────
  try {
    await B.tool('space_task_create', { type: 'revision', refs: [t3.task_id], op: 'add' })
    check('revision 缺 cp 被拒（不能自己选 slot）', false, 'no error raised')
  } catch (err) {
    expectError('revision 缺 cp 被拒（TASK_STATE_INVALID）', err, 'TASK_STATE_INVALID')
  }
  try {
    await B.tool('space_task_create', { type: 'revision', refs: [], cp: 'CP1' })
    check('revision 缺原任务被拒', false, 'no error raised')
  } catch (err) {
    expectError('revision 必须 refs 指向原任务（TASK_STATE_INVALID）', err, 'TASK_STATE_INVALID')
  }

  const rev = []
  for (let i = 0; i < 3; i++) {
    rev.push(await B.tool('space_task_create', { type: 'revision', refs: [t3.task_id], cp: 'CP1', op: `hacked-op-${i}` }))
  }
  const slotRow = rawDb.prepare("select round from slots where op = 'add' and slot = 'design'").get()
  check('R2 轮次按服务端归属计数（改 op 字符串无效）', rev[2].slot_round === 3 && slotRow?.round === 3, `round=${slotRow?.round}`)

  try {
    await B.tool('space_task_create', { type: 'revision', refs: [t3.task_id], cp: 'CP1' })
    check('R2 第 4 次回退被拒', false, 'no error raised')
  } catch (err) {
    expectError('R2 超轮次上限（LOOP_EXHAUSTED）', err, 'LOOP_EXHAUSTED')
  }
  check('轮次耗尽证据已落库', rawDb.prepare("select count(*) c from events where kind='loop.exhausted'").get().c >= 1)

  // ── 8. 人插话：服务端必须真的停手 ─────────────────────────
  let sawTimeout = false
  for (let i = 0; i < 12 && !sawTimeout; i++) {
    const r = await A.tool('space_wait', { since_cursor: curA, timeout_sec: 1 })
    curA = r.cursor
    if (r.reason === 'timeout') sawTimeout = true
  }
  check('wait 超时返回是正常返回（reason=timeout）', sawTimeout)

  const hangId = A.sendTool('space_wait', { since_cursor: curA, timeout_sec: 15 })
  await sleep(300)
  A.cancelRequest(hangId)
  const afterCancel = await A.awaitResponse(hangId, 1000)
  check('被取消的 wait 不再返回响应', afterCancel === null)
  await sleep(200)
  check('服务端 handler 真的中止（不是跑满 deadline）', A.stderr.some((l) => /aborted/.test(l)), A.stderr.filter((l) => /abort|cancel/i.test(l)).join(' | ').slice(0, 140))

  const resume = A.tool('space_wait', { since_cursor: curA, timeout_sec: 20 })
  await sleep(150)
  await H.tool('space_msg_send', { to: 'dev-code', text: '3.3 先别收，我看一下产物' })
  const resumed = await resume
  curA = resumed.cursor
  check('打断后恢复 wait 并收到人的消息', resumed.events.some((e) => e.kind === 'message.sent'), resumed.events.map((e) => e.kind).join(','))

  // ── 9. 租约回收：能回收、能重认、预算会走到 FAILED ────────
  const leaseTask = await B.tool('space_task_create', { type: 'assign', to: 'intruder', op: 'lease-test' })
  await C.tool('space_task_claim', { task_id: leaseTask.task_id, lease_sec: 1 })
  await sleep(1300)
  // 关键：由**别的成员**触发扫描。持有者自己调用会顺延自己的租约（ADR 0010 的活跃续期）
  await B.tool('space_task_list', {})
  const afterSweep = rowOf(leaseTask.task_id)
  check(
    '租约过期被回收（PENDING + attempts=1 + 认领数清零）',
    afterSweep.state === 'PENDING' && afterSweep.attempts === 1 && afterSweep.claims_count === 0,
    JSON.stringify({ state: afterSweep.state, attempts: afterSweep.attempts, claims: afterSweep.claims_count }),
  )
  const recounted = await C.tool('space_task_claim', { task_id: leaseTask.task_id, lease_sec: 1 })
  check('回收后**能再次认领**（旧实现此处永久死锁）', Boolean(recounted.lease_id))

  for (let i = 0; i < 5; i++) {
    await sleep(1300)
    await B.tool('space_task_list', {})
    const r = rowOf(leaseTask.task_id)
    if (r.state === 'FAILED') break
    if (r.state === 'PENDING') {
      try {
        await C.tool('space_task_claim', { task_id: leaseTask.task_id, lease_sec: 1 })
      } catch {
        break
      }
    }
  }
  const finalRow = rowOf(leaseTask.task_id)
  check('重试预算耗尽转 FAILED（attempts ≥ 3）', finalRow.state === 'FAILED' && finalRow.attempts >= 3, JSON.stringify({ state: finalRow.state, attempts: finalRow.attempts }))

  // ── 9b. 活跃即心跳：持有者只要还在调工具，租约就顺延（ADR 0010）
  const alive = await B.tool('space_task_create', { type: 'assign', to: 'intruder', op: 'alive-test' })
  const aliveClaim = await C.tool('space_task_claim', { task_id: alive.task_id, lease_sec: 2 })
  await sleep(1500)
  await C.tool('space_task_transition', { task_id: alive.task_id, lease_id: aliveClaim.lease_id, to: 'WORKING' }) // 这次调用顺延租约
  await sleep(1500) // 距最初认领已 3s > 2s 租约
  const aliveRow = rowOf(alive.task_id)
  check('持有者活跃时租约被顺延（不会因为"干活不心跳"被判过期）', aliveRow.state === 'WORKING' && aliveRow.owner === 'intruder', `state=${aliveRow.state} owner=${aliveRow.owner}`)
  // 收尾
  await C.tool('space_task_transition', { task_id: alive.task_id, lease_id: aliveClaim.lease_id, to: 'CANCELED', payload: { reason: '验收用' } })

  // ── 10. 广播的竞争消费：v0.2 只有一个租约，必须显式拒绝而不是假装支持 ──
  try {
    await B.tool('space_task_create', { type: 'broadcast', role: 'developer', op: 'bcast', claims: 2 })
    check('claims > 1 被显式拒绝（未实现的边界要说清）', false, 'no error raised')
  } catch (err) {
    expectError('claims > 1 显式拒绝（TASK_STATE_INVALID）', err, 'TASK_STATE_INVALID')
  }

  const bcast = await B.tool('space_task_create', { type: 'broadcast', role: 'developer', op: 'bcast' })
  const cl1 = await A.tool('space_task_claim', { task_id: bcast.task_id })
  check('广播任务可被第一个匹配成员认领', Boolean(cl1.lease_id))
  try {
    await C.tool('space_task_claim', { task_id: bcast.task_id })
    check('广播任务已被认领后第二人不能重复认领', false, 'no error raised')
  } catch (err) {
    expectError('已被认领的任务拒绝重复认领（TASK_ALREADY_CLAIMED）', err, 'TASK_ALREADY_CLAIMED')
  }

  // ── 11. 资源互斥 ──────────────────────────────────────────
  const fpga = await A.tool('space_resource_acquire', { name: 'fpga:0', lease_sec: 60 })
  check('A 拿到 fpga:0', Boolean(fpga.lease_id))
  try {
    await C.tool('space_resource_acquire', { name: 'fpga:0', lease_sec: 60 })
    check('资源互斥', false, 'no error raised')
  } catch (err) {
    expectError('C 抢 fpga:0 被拒（RESOURCE_BUSY）', err, 'RESOURCE_BUSY')
  }
  await A.tool('space_resource_release', { lease_id: fpga.lease_id })

  // ── 12. 吊销：即时失效 + 回收后别人能接 ───────────────────
  const busy = await B.tool('space_task_create', { type: 'assign', to: 'dev-code', op: 'revoke-test' })
  await A.tool('space_task_claim', { task_id: busy.task_id, lease_sec: 300 })
  spaceCli(['token', 'revoke', '--dir', spaceDir, '--member', 'dev-code'])
  try {
    await A.tool('space_state_get', { op: 'add' })
    check('吊销后旧会话被拒', false, 'no error raised')
  } catch (err) {
    expectError('吊销后该 token 被拒（TOKEN_REVOKED）', err, 'TOKEN_REVOKED')
  }
  const busyRow = rowOf(busy.task_id)
  check('吊销后名下任务回 PENDING 并释放归属', busyRow.state === 'PENDING' && busyRow.owner === null)

  const backupToken = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', 'dev-backup', '--role', 'developer'])
  writeFileSync(join(spaceDir, 'tokens', 'dev-backup.token'), backupToken)
  const D = await new Member('dev-backup').start(spaceDir)
  try {
    await D.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
    try {
      await D.tool('space_task_claim', { task_id: busy.task_id })
      check('吊销回收后**其他成员能接手**（旧实现死锁）', rowOf(busy.task_id).owner === 'dev-backup')
    } catch (err) {
      check('吊销回收后其他成员能接手（旧实现死锁）', false, `${err.code}: ${err.message}`)
    }
  } finally {
    await D.close()
  }

  // ── 12b. 安全边界回归（对 4 个 review 的 P0/P1 逐条设防）──
  // 未 attach 不得使用其它工具：宪法版本门不能靠自觉
  const peekToken = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', 'peeker', '--role', 'developer'])
  writeFileSync(join(spaceDir, 'tokens', 'peeker.token'), peekToken)
  const P = await new Member('peeker').start(spaceDir)
  try {
    try {
      await P.tool('space_task_list', {})
      check('未 attach 就调用工具被拒', false, 'no error raised')
    } catch (err) {
      expectError('未 attach 就调用工具被拒（NOT_ATTACHED）', err, 'NOT_ATTACHED')
    }
  } finally {
    await P.close()
  }

  // 读侧可见性：不能随便看别人的任务
  const cList = await C.tool('space_task_list', {})
  check('读侧可见性：看不到无关成员的任务', !cList.tasks.some((t) => t.task_id === taskId), `visible=${cList.tasks.length}`)

  // 消息：to 与 topic 不能同时给（否则 topic 让它变成全员可见 = 私聊泄漏）
  try {
    await H.tool('space_msg_send', { to: 'dev-backup', topic: 'standup', text: '私下说' })
    check('消息同时给 to 与 topic 被拒', false, 'no error raised')
  } catch (err) {
    expectError('消息同时给 to 与 topic 被拒（防私聊泄漏）', err, 'EVIDENCE_INSUFFICIENT')
  }
  try {
    await H.tool('space_msg_send', { to: 'dev-code', text: 'x'.repeat(2000) })
    check('超长消息被拒', false, 'no error raised')
  } catch (err) {
    expectError('超长消息被拒（控制面信号不做内容载体）', err, 'EVIDENCE_INSUFFICIENT')
  }

  // revision 不能拿别人的任务烧轮次预算（跨 op 投毒）
  try {
    await C.tool('space_task_create', { type: 'revision', refs: [taskId], cp: 'CP1' })
    check('对别人任务开 revision 被拒', false, 'no error raised')
  } catch (err) {
    expectError('对别人任务开 revision 被拒（FORBIDDEN_ROLE）', err, 'FORBIDDEN_ROLE')
  }

  // 租约上限：1e9 秒不能让任务 31 年不可回收
  const bigLease = await B.tool('space_task_create', { type: 'assign', to: 'intruder', op: 'lease-cap' })
  const capped = await C.tool('space_task_claim', { task_id: bigLease.task_id, lease_sec: 1e9 })
  const leaseSpanSec = (capped.lease_until - Date.now()) / 1000
  check('过长的租约被 clamp（不会 31 年不可回收）', leaseSpanSec <= 3600 + 5, `lease=${Math.round(leaseSpanSec)}s`)

  // 心跳不能续别人的租约
  try {
    await B.tool('space_task_heartbeat', { lease_id: capped.lease_id })
    check('心跳不能续别人的租约', false, 'no error raised')
  } catch (err) {
    check('心跳不能续别人的租约（LEASE_MISMATCH）', ['LEASE_MISMATCH', 'LEASE_EXPIRED'].includes(err.code), `got ${err.code}`)
  }

  // max_block_sec 必须真的生效（阶段 1 花整阶段换来的约束，不能没有回归）
  const slowToken = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', 'slowpoke', '--role', 'polite'])
  writeFileSync(join(spaceDir, 'tokens', 'slowpoke.token'), slowToken)
  const S = await new Member('slowpoke').start(spaceDir)
  try {
    const sAttach = await S.tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 2 } })
    const t0 = Date.now()
    const slowWait = await S.tool('space_wait', { since_cursor: sAttach.cursor, timeout_sec: 20 })
    const elapsedSec = (Date.now() - t0) / 1000
    check(
      'max_block_sec 生效（自报上限压过请求值）',
      slowWait.effective_timeout_sec === 2 && elapsedSec < 6 && slowWait.reason === 'timeout',
      `effective=${slowWait.effective_timeout_sec} elapsed=${elapsedSec.toFixed(1)}s`,
    )
  } finally {
    await S.close()
  }

  // scope 必须真的生效（scope 表化后，这里是最容易悄悄失效的地方）
  const roToken = spaceCli(['token', 'issue', '--dir', spaceDir, '--member', 'reader', '--role', 'reader', '--scopes', 'read'])
  writeFileSync(join(spaceDir, 'tokens', 'reader.token'), roToken)
  const R = await new Member('reader').start(spaceDir)
  try {
    await R.tool('space_attach', { constitution_version: 1, capabilities: {} })
    await R.tool('space_task_list', {})
    check('read scope 可读', true)
    try {
      await R.tool('space_publish', { uri: 'artifacts/nope.cu', sha256: sha('nope'), size: 4 })
      check('read scope 不能发布产物', false, 'no error raised')
    } catch (err) {
      expectError('read scope 不能发布产物（FORBIDDEN_ROLE）', err, 'FORBIDDEN_ROLE')
    }
  } finally {
    await R.close()
  }

  // 吊销可解封（否则一次误操作就是永久死刑）
  const unrev = spaceCli(['token', 'unrevoke', '--dir', spaceDir, '--member', 'dev-code'])
  check('吊销可解封（token unrevoke）', /unrevoked dev-code/.test(unrev), unrev.trim())
  try {
    await A.tool('space_task_list', {})
    check('解封后旧会话恢复可用', true)
  } catch (err) {
    check('解封后旧会话恢复可用', false, `${err.code}: ${err.message}`)
  }

  // ── 13. 对账器本身可信（负向测试）─────────────────────────
  const before = rowOf(taskId).state
  rawDb.prepare("update tasks set state = 'WORKING' where id = ?").run(taskId)
  const badVerify = await B.tool('space_verify', {})
  rawDb.prepare('update tasks set state = ? where id = ?').run(before, taskId)
  check('投影被篡改时 verify 报错（对账器不是恒真）', badVerify.ok === false && badVerify.drift.length > 0, JSON.stringify(badVerify.drift).slice(0, 140))

  const goodVerify = await B.tool('space_verify', {})
  check('正常状态下投影 == 事件归约', goodVerify.ok === true, JSON.stringify(goodVerify.drift))

  // ── 14. trace ────────────────────────────────────────────
  const trace = spaceCli(['trace', '--dir', spaceDir, '--limit', '400']).trim().split('\n')
  const kinds = new Set(trace.map((l) => l.trim().split(/\s+/)[2]).filter(Boolean))
  check(
    '事件流覆盖关键环节（可作 trace）',
    ['member.attached', 'task.created', 'task.claimed', 'task.transitioned', 'artifact.published', 'handoff.written', 'task.expired', 'token.revoked'].every((k) => kinds.has(k)),
    `${trace.length} lines`,
  )
} catch (err) {
  // 断言之外的异常也要落成一条 FAIL，而不是让脚本崩掉、丢掉前面的汇总
  check('验收脚本完整跑完（无未捕获异常）', false, `${err.code ?? ''} ${err.message}`.trim())
} finally {
  rawDb.close()
  await Promise.all([A.close(), B.close(), QA.close(), C.close(), H.close()])
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
}
console.log(`\nspace 目录：${spaceDir}${KEEP ? '（已保留）' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
