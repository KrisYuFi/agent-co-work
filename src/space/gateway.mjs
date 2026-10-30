/**
 * src/space/gateway.mjs — 成员侧网关：运行时加入空间（ADR 0011 / 0012）
 *
 * 为什么需要它：MCP 工具集在会话启动时就固定了，会话中途无法动态挂一个新的 MCP server。
 * 所以「在提示词里说一句就连上某个空间」的前提，是启动时先挂一个**能收参数的连接器**。
 *
 * 这个网关启动时不连任何空间，只提供：
 *   space_join({space, url, token})   加入一个空间，给它起个别名
 *   space_leave({space})              离开
 *   space_spaces()                    当前加入了哪些
 * 加入之后，hub 的全部工具可用；网关把调用透传给对应的 hub，并注入 Authorization。
 *
 * 多空间（ADR 0012）：空间用别名区分。调用 hub 工具时可带 `space`：
 *   - 只加入了一个空间 → 省略即可
 *   - 加入了多个 → 必须指定，省略则拒绝（AMBIGUOUS_SPACE），**不猜**
 */

import { TOOLS as HUB_TOOLS } from './mcp.mjs'

const PROTOCOL_FALLBACK = '2025-06-18'

const GATEWAY_TOOLS = [
  {
    name: 'space_join',
    description:
      'Join a collaboration space over MCP HTTP. Give it a local alias. After joining, all space_* tools work (pass `space` when joined to more than one). Token is the identity: whoever holds it is that member.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'local alias for this space, e.g. "work"' },
        url: { type: 'string', description: 'hub MCP endpoint, e.g. http://127.0.0.1:7321/mcp' },
        token: { type: 'string', description: 'bearer token issued by the space (spt_...)' },
      },
      required: ['space', 'url', 'token'],
      additionalProperties: false,
    },
  },
  {
    name: 'space_leave',
    description: 'Leave a joined space.',
    inputSchema: { type: 'object', properties: { space: { type: 'string' } }, required: ['space'], additionalProperties: false },
  },
  {
    name: 'space_spaces',
    description: 'List spaces this session has joined.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** hub 工具在网关层多一个可选的 space 别名参数 */
const withSpaceParam = (tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      space: { type: 'string', description: 'which joined space (omit when only one is joined)' },
      ...(tool.inputSchema?.properties ?? {}),
    },
  },
})

export const GATEWAY_TOOL_LIST = [...GATEWAY_TOOLS, ...HUB_TOOLS.map(withSpaceParam)]

export function createGateway({ onLog = () => {} } = {}) {
  /** alias → { url, token } */
  const joined = new Map()

  function resolveSpace(args) {
    const alias = args?.space
    if (alias) {
      const target = joined.get(alias)
      if (!target) throw Object.assign(new Error(`space "${alias}" not joined（已加入：${[...joined.keys()].join(',') || '无'}）`), { code: 'UNKNOWN_SPACE' })
      return { alias, ...target }
    }
    if (joined.size === 0) throw Object.assign(new Error('not joined to any space；先调用 space_join'), { code: 'NOT_JOINED' })
    if (joined.size > 1) {
      throw Object.assign(
        new Error(`connected to ${joined.size} spaces (${[...joined.keys()].join(',')}); 必须用 space 参数指定，不猜`),
        { code: 'AMBIGUOUS_SPACE' },
      )
    }
    const [onlyAlias, onlyTarget] = [...joined.entries()][0]
    return { alias: onlyAlias, ...onlyTarget }
  }

  async function forward({ url, token }, payload, timeoutMs) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (res.status === 401) throw Object.assign(new Error(`hub rejected the token (401)`), { code: 'TOKEN_INVALID' })
    if (res.status !== 200) throw Object.assign(new Error(`hub returned HTTP ${res.status}: ${text.slice(0, 200)}`), { code: 'HUB_ERROR' })
    return JSON.parse(text)
  }

  let nextId = 1
  /** 调用某个 hub 的工具（不带 space 参数） */
  async function callHubTool({ url, token }, name, args, { timeoutMs = 120_000 } = {}) {
    const { space, ...rest } = args ?? {}
    void space
    const payload = { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: rest } }
    const msg = await forward({ url, token }, payload, timeoutMs)
    if (msg.error) throw Object.assign(new Error(msg.error.message), { code: `RPC_${msg.error.code}` })
    return msg.result
  }

  async function callTool(name, args = {}, opts = {}) {
    // ── 网关自己的三个工具
    if (name === 'space_join') {
      if (!args.space || !args.url || !args.token) throw Object.assign(new Error('space_join requires {space, url, token}'), { code: 'EVIDENCE_INSUFFICIENT' })
      joined.set(args.space, { url: args.url, token: args.token })
      onLog(`joined space "${args.space}" → ${args.url}`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, space: args.space, hub: args.url }) }] }
    }
    if (name === 'space_leave') {
      const existed = joined.delete(args.space)
      onLog(`left space "${args.space}" (${existed ? 'ok' : 'was not joined'})`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: existed, space: args.space }) }] }
    }
    if (name === 'space_spaces') {
      const list = [...joined.entries()].map(([space, v]) => ({ space, hub: v.url }))
      return { content: [{ type: 'text', text: JSON.stringify({ spaces: list }) }] }
    }

    // ── 其余全部转发给目标 hub
    const target = resolveSpace(args)
    const timeoutMs = args?.timeout_sec ? (Number(args.timeout_sec) + 30) * 1000 : 120_000
    return callHubTool(target, name, args, { ...opts, timeoutMs })
  }

  /** 下线前把每个空间都 detach 一次：让 hub 立刻收回租约，而不是等 900s 过期 */
  async function detachAll() {
    const aliases = [...joined.keys()]
    if (aliases.length === 0) return
    onLog(`shutting down — detaching from ${aliases.length} space(s): ${aliases.join(', ')}`)
    await Promise.allSettled(
      aliases.map(async (alias) => {
        try {
          await callTool('space_detach', { space: alias }, { timeoutMs: 3000 })
          onLog(`detached "${alias}"`)
        } catch (err) {
          onLog(`detach "${alias}" failed (ignored): ${err?.message ?? err}`)
        }
      }),
    )
  }

  return { joined, callTool, resolveSpace, detachAll }
}

/** stdio 传输：一个会话一个网关进程 */
export function serveGateway({ name = 'space-gateway', version = '0.1.0', onLog = () => {} } = {}) {
  const gw = createGateway({ onLog })
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const inflight = new Map()

  async function handle(msg) {
    const { id, method, params } = msg
    if (id === undefined || id === null) {
      if (method === 'notifications/cancelled') {
        const ctl = inflight.get(params?.requestId)
        if (ctl) ctl.abort()
      }
      return
    }
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          },
        })
        return
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: GATEWAY_TOOL_LIST } })
        return
      case 'tools/call': {
        const toolName = params?.name
        const args = params?.arguments ?? {}
        try {
          const result = await gw.callTool(toolName, args)
          send({ jsonrpc: '2.0', id, result })
        } catch (err) {
          onLog(`${toolName} failed: ${err.code ?? ''} ${err.message}`)
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify({ error: err.code ?? 'GATEWAY_ERROR', message: err.message }) }], isError: true },
          })
        }
        return
      }
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
        continue
      }
      handle(msg).catch((err) => onLog(`crashed: ${err?.message ?? err}`))
    }
  })
  // 会话结束 = 成员下线：先交出持有的任务，再退出。
  // 不这么做的话，任务要等默认 900s 租约过期才回队（多机实跑踩过，见 ADR 0010）。
  let closing = false
  const shutdown = async (why) => {
    if (closing) return
    closing = true
    try {
      await gw.detachAll()
    } finally {
      onLog(`exit (${why})`)
      process.exit(0)
    }
  }
  process.stdin.on('end', () => shutdown('stdin closed'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))

  onLog('gateway ready（未加入任何空间；用 space_join 加入）')
}
