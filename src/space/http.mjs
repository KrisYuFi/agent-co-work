/**
 * src/space/http.mjs — MCP over Streamable HTTP（中心化 hub 的传输层）
 *
 * 探针已实测（probe/RESULTS.md P4–P6）：
 *   - opencode `type:"remote"` 与 DSH `transport: streamable-http` 都能连「只回 JSON」的服务器
 *   - 服务器回 200（而非 401）时不会触发 opencode 的 OAuth 流程
 *   - opencode 会额外开一条 GET SSE 推送流；回 405 它也照常工作
 *
 * 因此本实现只做最小可用集合：
 *   POST /mcp  收 JSON-RPC，回 application/json
 *   GET  /mcp  405（声明不支持服务端主动推送）
 *
 * 与 stdio 的差别：
 *   - 身份在**每个请求**的 Authorization 头上，无连接态 → 吊销天然即时生效
 *   - `attach` 的会话状态（是否已 attach、max_block_sec）存在 hub 进程内存里，
 *     hub 重启后成员需重新 attach（原型阶段的已知取舍）
 *   - 取消：客户端断开连接 = 取消，服务端据此中止在飞的 handler（人插话打断 wait）
 */

import { createServer } from 'node:http'
import { createDispatcher } from './mcp.mjs'
import { SpaceError } from './invariants.mjs'

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

export function serveHttp({ db, host = '0.0.0.0', port = 7321, authenticate, onLog = () => {} }) {
  /** memberId → { attached, maxBlockSec }：hub 内存态，重启即失效（需重新 attach） */
  const sessions = new Map()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // 规范允许服务端声明不支持推送流；opencode 会开这条流，405 实测可被容忍
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }

    // ── 身份：每个请求独立校验（吊销即时生效）
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
    let member
    try {
      member = authenticate(db, token)
    } catch (err) {
      onLog(`http auth rejected: ${err.code ?? 'TOKEN_INVALID'} (${req.socket.remoteAddress})`)
      // 401 会让 opencode 走 OAuth 流程，但那是**没带/带错 token** 的正确语义
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.code ?? 'TOKEN_INVALID', message: err.message }))
      return
    }

    let msg
    try {
      msg = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }

    const session = sessions.get(member.id) ?? { attached: false }
    sessions.set(member.id, session)
    const ctx = {
      db,
      member,
      session,
      reauth: () => authenticate(db, token),
    }

    let replied = false
    const send = (payload) => {
      if (replied) return
      replied = true
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    }

    const dispatcher = createDispatcher(ctx, { name: 'space', version: '0.1.0', onLog, send })

    // 客户端断开 = 取消（HTTP 下没有 notifications/cancelled 通道）
    req.on('close', () => {
      if (!replied && msg?.id != null) {
        const ctl = dispatcher.inflight.get(msg.id)
        if (ctl) {
          ctl.abort()
          onLog(`http client closed request ${msg.id} — handler aborted`)
        }
      }
    })

    // 通知：没有 id，处理完回 202
    if (msg.id === undefined || msg.id === null) {
      await dispatcher.handle(msg).catch((err) => onLog(`notification error: ${err?.message ?? err}`))
      if (!replied) {
        replied = true
        res.writeHead(202).end()
      }
      return
    }

    await dispatcher.handle(msg).catch((err) => {
      onLog(`http handler crash: ${err?.message ?? err}`)
      if (!replied) {
        replied = true
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'INTERNAL', message: String(err?.message ?? err) }) }], isError: true } }),
        )
      }
    })
    // 被取消的请求：连接多半已断；若还在，就别再回一条
    if (!replied) {
      replied = true
      res.writeHead(202).end()
    }
  })

  server.requestTimeout = 0 // wait 长轮询最长 300s，不让 HTTP 层先掐断
  server.headersTimeout = 65_000

  server.listen(port, host, () => {
    onLog(`hub listening on http://${host}:${port}/mcp（MCP over Streamable HTTP）`)
  })

  return {
    server,
    sessions,
    close: () => new Promise((r) => server.close(r)),
  }
}
