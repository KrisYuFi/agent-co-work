#!/usr/bin/env node
/**
 * probe/mcp/server.mjs — 零依赖 stdio MCP 探针服务器
 *
 * 目的：给 P2 / P3 提供一台「能阻塞、能报进度、能留下计时刻」的 MCP 服务器。
 * 刻意不依赖 @modelcontextprotocol/sdk：探针本身要能证明「一台裸 MCP stdio 服务器
 * 就能被目标 CLI 挂上」，引入 SDK 反而模糊了这段结论。
 *
 * 传输：newline-delimited JSON-RPC 2.0 over stdio（MCP 现行 stdio 传输）。
 *
 * 工具：
 *   probe_ping()                      立即返回，用于判断「挂上了没有」
 *   probe_block(seconds)              阻塞 N 秒后返回，用于 P3（不发进度通知）
 *   probe_block_progress(seconds)     阻塞 N 秒，期间按 interval 发 notifications/progress
 *
 * 日志：--log <path> 或 PROBE_LOG，JSONL，一行一个事件，带单调递增 ts（ms）。
 * 日志是探针的「客观证据」：客户端说自己等到了，日志说服务器到底跑完了没有。
 */

import { createWriteStream } from 'node:fs'

const argv = process.argv.slice(2)
function argOf(name, fallback = undefined) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const LOG_PATH = argOf('--log', process.env.PROBE_LOG || null)
const STARTED_AT = Date.now()
const logStream = LOG_PATH ? createWriteStream(LOG_PATH, { flags: 'a' }) : null

function log(event, fields = {}) {
  if (!logStream) return
  logStream.write(
    JSON.stringify({ ts: Date.now(), sinceStartMs: Date.now() - STARTED_AT, event, pid: process.pid, ...fields }) + '\n',
  )
}

const PROTOCOL_FALLBACK = '2025-06-18'

const TOOLS = [
  {
    name: 'probe_ping',
    description: 'Probe liveness. Returns a short string immediately.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'probe_block',
    description:
      'Block for the given number of seconds (no progress notifications), then return. Used to measure client-side tool-call timeouts.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Seconds to block, e.g. 120' } },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
  {
    name: 'probe_block_progress',
    description:
      'Block for the given number of seconds while emitting progress notifications every intervalMs. Used to test resetTimeoutOnProgress.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Total seconds to block' },
        intervalMs: { type: 'number', description: 'Progress notification interval in ms (default 10000)' },
      },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function callTool(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  const progressToken = params?._meta?.progressToken
  log('tools/call:start', { tool: name, args, progressToken: progressToken ?? null })

  if (name === 'probe_ping') {
    log('tools/call:end', { tool: name, ok: true })
    return { content: [{ type: 'text', text: `PONG ${new Date().toISOString()}` }] }
  }

  if (name === 'probe_block' || name === 'probe_block_progress') {
    const seconds = Number(args.seconds ?? 0)
    const intervalMs = Number(args.intervalMs ?? 10000)
    const totalMs = Math.max(0, seconds * 1000)
    const startedAt = Date.now()
    let progress = 0
    let elapsed = 0
    while (elapsed < totalMs) {
      const step = Math.min(name === 'probe_block_progress' ? intervalMs : totalMs - elapsed, totalMs - elapsed)
      await sleep(step)
      elapsed = Date.now() - startedAt
      if (name === 'probe_block_progress' && progressToken !== undefined) {
        progress += 1
        send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            total: Math.ceil(totalMs / intervalMs),
            message: `blocked ${Math.round(elapsed / 1000)}s`,
          },
        })
        log('progress:sent', { progress, elapsedMs: elapsed })
      }
    }
    log('tools/call:end', { tool: name, ok: true, blockedMs: Date.now() - startedAt })
    return {
      content: [
        { type: 'text', text: `BLOCKED ${seconds}s (actual ${Math.round((Date.now() - startedAt) / 1000)}s)` },
      ],
    }
  }

  log('tools/call:end', { tool: name, ok: false, reason: 'unknown tool' })
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
}

async function handle(msg) {
  const { id, method, params } = msg
  log('request', { method, id: id ?? null })

  if (msg.id === undefined || msg.id === null) {
    // 通知：无需响应
    if (method === 'notifications/initialized') log('initialized')
    else if (method === 'notifications/cancelled') log('cancelled', { params })
    return
  }

  switch (method) {
    case 'initialize': {
      // 回显客户端请求的协议版本：SDK 客户端会校验服务器版本是否在支持列表内
      const protocolVersion = params?.protocolVersion || PROTOCOL_FALLBACK
      log('initialize', { protocolVersion, clientInfo: params?.clientInfo ?? null })
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'probe-mcp', version: '0.1.0' },
        },
      })
      return
    }
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    case 'tools/call':
      try {
        const result = await callTool(id, params)
        send({ jsonrpc: '2.0', id, result })
      } catch (err) {
        send({ jsonrpc: '2.0', id, error: { code: err.code ?? -32000, message: String(err.message ?? err) } })
      }
      return
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
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
      log('parse:error', { line: line.slice(0, 200) })
      continue
    }
    handle(msg).catch((err) => log('handler:error', { error: String(err?.message ?? err) }))
  }
})
process.stdin.on('end', () => {
  log('stdin:end')
  process.exit(0)
})

log('server:start', { logPath: LOG_PATH })
