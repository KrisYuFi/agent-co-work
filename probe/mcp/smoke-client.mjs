#!/usr/bin/env node
/**
 * probe/mcp/smoke-client.mjs — 探针服务器的本地自检客户端（零依赖）
 *
 * 作用：在把服务器交给 opencode / dsh 之前，先自己确认它能正常握手、列工具、调用工具。
 * 没有这一步，runtime 上任何失败都可能是「我的服务器坏了」，而不是「runtime 不支持」。
 *
 * 用法：node smoke-client.mjs [--block <seconds>]
 * 退出码：0 全通，1 有失败项。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const blockIdx = process.argv.indexOf('--block')
const blockSeconds = blockIdx >= 0 ? Number(process.argv[blockIdx + 1] ?? 5) : null

const child = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })

let buf = ''
const waiting = new Map()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { resolve } = waiting.get(msg.id)
      waiting.delete(msg.id)
      resolve(msg)
    }
  }
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, { resolve })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-client', version: '0.1.0' },
})
check('initialize', init.result?.protocolVersion === '2025-06-18', `serverVersion=${init.result?.protocolVersion}`)
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const list = await request('tools/list', {})
const names = (list.result?.tools ?? []).map((t) => t.name)
check('tools/list', names.includes('probe_ping') && names.includes('probe_block'), names.join(','))

const ping = await request('tools/call', { name: 'probe_ping', arguments: {} })
check('tools/call probe_ping', String(ping.result?.content?.[0]?.text ?? '').startsWith('PONG'))

if (blockSeconds !== null) {
  const t0 = Date.now()
  const blocked = await request('tools/call', { name: 'probe_block', arguments: { seconds: blockSeconds } })
  const elapsed = (Date.now() - t0) / 1000
  const ok = blocked.result?.content?.[0]?.text?.startsWith('BLOCKED') && elapsed >= blockSeconds - 0.5
  check(`tools/call probe_block(${blockSeconds})`, ok, `elapsed=${elapsed.toFixed(1)}s`)
}

child.stdin.end()
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
