#!/usr/bin/env node
/**
 * deploy/docker/member.mjs — 容器里的「成员」：一个最小的 MCP over HTTP 客户端
 *
 * 它不调模型（这是传输与回收机制的测试，不是智能测试）。三种行为：
 *   pm      派一个广播任务给 developer 角色，然后等它 DONE
 *   crash   认领任务 → WORKING → 挂住不动（用来被杀掉）
 *   finish  认领任务 → WORKING → 写产物 → publish → DONE + handoff
 *
 * 用法：node member.mjs --role pm|crash|finish --url http://hub:7321/mcp --token-file /space/tokens/x.token
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : d
}
const ROLE = arg('role', 'finish')
const URL_ = arg('url', 'http://127.0.0.1:7321/mcp')
const TOKEN = readFileSync(arg('token-file'), 'utf8').trim()
const SPACE = arg('space', '/space')
const ART_URI = `artifacts/kernel-${ROLE}.cu`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let nextId = 1
async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const msg = await res.json()
  if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code })
  return msg.result
}

async function tool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result?.content?.[0]?.text ?? '{}'
  const payload = JSON.parse(text)
  if (result.isError) {
    const e = new Error(payload.message)
    e.code = payload.error
    throw e
  }
  return payload
}

const log = (m) => console.error(`[${ROLE}] ${m}`)

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: ROLE, version: '0' } })
const attached = await tool('space_attach', { constitution_version: 1, capabilities: { max_block_sec: 20 } })
let cursor = attached.cursor
log(`attached, cursor=${cursor}`)

if (ROLE === 'pm') {
  // 广播：任何 developer 角色成员都可以认领（正好用来测「一个挂了另一个接手」）
  const created = await tool('space_task_create', {
    type: 'broadcast',
    role: 'developer',
    op: 'kill-test',
    step: '3.1',
    expected: { filename: 'kernel.cu' },
  })
  log(`created task ${created.task_id}`)
  for (let i = 0; i < 40; i++) {
    const r = await tool('space_wait', { since_cursor: cursor, timeout_sec: 10 })
    cursor = r.cursor
    const done = r.events.find((e) => e.kind === 'task.transitioned' && e.payload?.to === 'DONE')
    if (done) {
      log(`saw DONE for ${done.task_id}`)
      console.log(`PM_DONE ${done.task_id}`)
      process.exit(0)
    }
  }
  console.log('PM_TIMEOUT')
  process.exit(2)
}

// 工作者：等任务 → 认领 → WORKING
for (let i = 0; i < 60; i++) {
  const r = await tool('space_wait', { since_cursor: cursor, timeout_sec: 10 })
  cursor = r.cursor
  const pending = (r.tasks ?? []).find((t) => t.state === 'PENDING')
  if (!pending) continue

  let claim
  try {
    claim = await tool('space_task_claim', { task_id: pending.task_id, lease_sec: 5 })
  } catch (err) {
    log(`claim lost: ${err.code}`)
    continue
  }
  await tool('space_task_transition', { task_id: pending.task_id, lease_id: claim.lease_id, to: 'WORKING' })
  log(`claimed ${pending.task_id}, WORKING`)

  if (ROLE === 'crash') {
    log('holding (this container is about to be killed)')
    await sleep(600_000) // 被杀掉
    continue
  }

  // finish：写产物 → 登记 → DONE
  const body = Buffer.from(`// produced by ${ROLE} at ${new Date().toISOString()}\n`)
  writeFileSync(`${SPACE}/${ART_URI}`, body)
  const sha = createHash('sha256').update(body).digest('hex')
  const size = statSync(`${SPACE}/${ART_URI}`).size
  await tool('space_publish', { uri: ART_URI, sha256: sha, size, media_type: 'text/x-cuda', task_id: pending.task_id })
  await tool('space_task_transition', {
    task_id: pending.task_id,
    lease_id: claim.lease_id,
    to: 'DONE',
    payload: { handoff: { uri: ART_URI, sha256: sha, size }, reason: `finished by ${ROLE}` },
  })
  log(`DONE ${pending.task_id}`)
  console.log(`DEV_DONE ${pending.task_id}`)
  process.exit(0)
}
console.log('NO_TASK')
process.exit(3)
