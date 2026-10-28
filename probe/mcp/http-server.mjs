#!/usr/bin/env node
/**
 * probe/mcp/http-server.mjs — 最小 MCP over HTTP（Streamable HTTP）探针服务器
 *
 * 目的只有一个：回答「opencode 的 remote MCP 与 DSH 的 streamable-http 到底连不连得上」。
 * 阶段 1 只实测过 stdio，跨机器（中心化 hub）全靠这条路径，所以先探。
 *
 * 实现策略（按 MCP 2025-06-18 的 Streamable HTTP）：
 *   POST /mcp  —— 收 JSON-RPC；有 id 就以 application/json 回单条响应，通知回 202
 *   GET  /mcp  —— 回 405（本探针不支持服务端主动推送，规范允许这样声明）
 * 零依赖。
 *
 * 用法：
 *   node probe/mcp/http-server.mjs [--port 7391] [--token <bearer>] [--log <path>]
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const PORT = Number(flag('port', '7391'))
const TOKEN = flag('token', process.env.PROBE_HTTP_TOKEN || null)
const LOG = flag('log', null)
const STARTED = Date.now()

const log = (event, extra = {}) => {
  const line = JSON.stringify({ ts: Date.now(), sinceStartMs: Date.now() - STARTED, event, ...extra })
  process.stderr.write(line + '\n')
  if (LOG) appendFileSync(LOG, line + '\n')
}

const PROTOCOL_FALLBACK = '2025-06-18'

const TOOLS = [
  { name: 'probe_ping', description: 'Returns PONG immediately.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'probe_block',
    description: 'Block N seconds then return.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'], additionalProperties: false },
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function handleRpc(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'probe-http', version: '0.1.0' },
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (name === 'probe_ping') {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `PONG ${new Date().toISOString()}` }] } }
      }
      if (name === 'probe_block') {
        const secs = Number(args.seconds ?? 0)
        await sleep(Math.max(0, secs) * 1000)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `BLOCKED ${secs}s over HTTP` }] } }
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } }
    }
    default:
      // 含 DSH 的私有 server/discover：不猜坏 schema
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  log('request', { method: req.method, path: url.pathname, accept: req.headers.accept ?? null, auth: req.headers.authorization ? 'present' : 'none' })

  if (url.pathname !== '/mcp') {
    res.writeHead(404).end('not found')
    return
  }

  if (TOKEN) {
    const got = req.headers.authorization ?? ''
    if (got !== `Bearer ${TOKEN}`) {
      log('auth:rejected', { got })
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
  }

  if (req.method === 'GET') {
    // 声明不支持服务端主动推送（规范允许）
    res.writeHead(405, { allow: 'POST' }).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end()
    return
  }

  let msg
  try {
    msg = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
    return
  }

  // 通知（无 id）：202 Accepted，无响应体
  if (msg.id === undefined || msg.id === null) {
    log('notification', { method: msg.method })
    res.writeHead(202).end()
    return
  }

  log('rpc', { method: msg.method, id: msg.id })
  const out = await handleRpc(msg)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
})

server.listen(PORT, '127.0.0.1', () => {
  log('listening', { port: PORT, auth: Boolean(TOKEN) })
  console.log(`probe MCP over HTTP listening on http://127.0.0.1:${PORT}/mcp${TOKEN ? ' (bearer required)' : ''}`)
})
