/**
 * src/space/mcp.mjs — MCP over stdio 传输 + 工具注册
 *
 * 刻意不引 SDK（ADR 0006）：阶段 1 的探针服务器就是这个形态，opencode 与 DSH 都已实测通过。
 * 传输：newline-delimited JSON-RPC 2.0 over stdio。
 *
 * 关于 DSH：它在标准 initialize 之前会先发一个私有方法 `server/discover`，
 * 失败（-32601）后杀掉进程重启、再走标准握手（见 probe/RESULTS.md）。
 * 这里选择返回 -32601 而不是猜它的私有 schema —— 协议层不猜，代价只是多一次进程启动，
 * 而 `space serve` 的启动无副作用，所以是安全的。
 */

import * as service from './service.mjs'
import { SpaceError } from './invariants.mjs'

const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: true })
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const arr = (description) => ({ type: 'array', description, items: {} })

export const TOOLS = [
  {
    name: 'space_attach',
    description:
      'Attach this session to the space. Call once at session start. Reports capabilities (including max_block_sec: how long this client can block in one tool call) and the constitution version it obeys.',
    inputSchema: obj({
      capabilities: obj({ max_block_sec: num('single tool-call block budget in seconds') }),
      constitution_version: num('constitution version this agent obeys'),
    }),
  },
  { name: 'space_detach', description: 'Detach this session from the space.', inputSchema: obj() },
  {
    name: 'space_wait',
    description:
      'Long-poll for work. Blocks up to effective_timeout_sec (server clamps to your declared max_block_sec, default 20s). Returns reason="events" with new events/pending tasks, or reason="timeout" which is a NORMAL return — keep looping. Renews your leases.',
    inputSchema: obj({ since_cursor: num('cursor from the previous call'), timeout_sec: num('requested block seconds (default 20)') }),
  },
  {
    name: 'space_task_create',
    description:
      'Create a task. type=assign needs `to`; broadcast needs `role` (broadcast does NOT trigger work — the receiver must claim); revision needs `slot` + refs to the original task.',
    inputSchema: obj(
      {
        type: { type: 'string', enum: ['assign', 'broadcast', 'revision', 'question', 'answer', 'notice'] },
        to: str('target member id'),
        role: str('target role'),
        op: str('operator name (算子)'),
        step: str('workflow step label'),
        slot: { type: 'string', enum: ['design', 'joint_debug', 'acceptance'] },
        inputs: arr('input refs'),
        expected: obj(),
        refs: arr('referenced task/artifact ids'),
        claims: num('max concurrent claims (default 1)'),
      },
      ['op'],
    ),
  },
  {
    name: 'space_task_claim',
    description: 'Claim a task atomically. Returns lease_id or TASK_ALREADY_CLAIMED (a normal race outcome).',
    inputSchema: obj({ task_id: str('task id'), lease_sec: num('lease seconds (default 300)') }, ['task_id']),
  },
  { name: 'space_task_heartbeat', description: 'Renew a lease.', inputSchema: obj({ lease_id: str('lease id') }, ['lease_id']) },
  {
    name: 'space_task_transition',
    description:
      'Transition a task state. to=DONE REQUIRES payload.handoff {uri, sha256} referencing a published artifact. Terminal states are immutable (R1).',
    inputSchema: obj(
      {
        task_id: str('task id'),
        lease_id: str('your lease id'),
        to: {
          type: 'string',
          enum: ['CLAIMED', 'WORKING', 'WAITING_INPUT', 'WAITING_AUTH', 'BLOCKED', 'DONE', 'FAILED', 'REVISION_REQUESTED', 'CANCELED', 'PENDING'],
        },
        payload: obj(),
      },
      ['task_id', 'to'],
    ),
  },
  {
    name: 'space_task_list',
    description: 'List tasks (read-only projection).',
    inputSchema: obj({ filter: obj({ op: str(''), state: str(''), to: str(''), role: str('') }) }),
  },
  {
    name: 'space_publish',
    description: 'Register an artifact REFERENCE (uri + sha256 + size). Never sends bytes.',
    inputSchema: obj({ uri: str('artifact uri / path'), sha256: str('content hash'), size: num(''), media_type: str(''), task_id: str('owning task'), meta: obj() }, ['uri', 'sha256']),
  },
  { name: 'space_artifact_resolve', description: 'Resolve an artifact reference to its uri/sha256.', inputSchema: obj({ artifact_id: str('artifact id or uri') }, ['artifact_id']) },
  {
    name: 'space_msg_send',
    description: 'Send a short message to a member or topic. References only, no payloads.',
    inputSchema: obj({ to: str('member id'), topic: str('topic'), text: str('message text'), refs: arr('') }),
  },
  { name: 'space_state_get', description: 'Read the server-reduced state (read-only; agents never write state).', inputSchema: obj({ op: str('operator name') }) },
  { name: 'space_resource_acquire', description: 'Acquire an exclusive resource lease (e.g. fpga:0). Returns RESOURCE_BUSY if held.', inputSchema: obj({ name: str('resource name'), lease_sec: num('') }, ['name']) },
  { name: 'space_resource_release', description: 'Release a resource lease.', inputSchema: obj({ lease_id: str('') }, ['lease_id']) },
  { name: 'space_verify', description: 'Debug: check the state projection against the event log.', inputSchema: obj() },
]

const HANDLERS = {
  space_attach: service.attach,
  space_detach: service.detach,
  space_wait: service.wait,
  space_task_create: service.taskCreate,
  space_task_claim: service.taskClaim,
  space_task_heartbeat: service.taskHeartbeat,
  space_task_transition: service.taskTransition,
  space_task_list: service.taskList,
  space_publish: service.publish,
  space_artifact_resolve: service.artifactResolve,
  space_msg_send: service.msgSend,
  space_state_get: service.stateGet,
  space_resource_acquire: service.resourceAcquire,
  space_resource_release: service.resourceRelease,
  space_verify: service.verify,
}

const PROTOCOL_FALLBACK = '2025-06-18'

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function textResult(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError }
}

/** 启动一个成员会话的 MCP 服务器（stdio） */
export function serveStdio(ctx, { name = 'space', version = '0.1.0', onLog = () => {} } = {}) {
  const { db, member } = ctx

  async function handle(msg) {
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null

    if (isNotification) {
      if (method === 'notifications/initialized') onLog('initialized')
      else if (method === 'notifications/cancelled') onLog('cancelled (人可能插话打断了工具调用)')
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
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
        return
      case 'tools/call': {
        const toolName = params?.name
        // 每次调用都重新校验身份：吊销必须**立刻**生效，而不是等会话重启
        if (ctx.reauth) {
          try {
            ctx.member = ctx.reauth()
          } catch (err) {
            onLog(`${toolName} REJECTED ${err.code ?? 'TOKEN_INVALID'}: ${err.message}`)
            send({ jsonrpc: '2.0', id, result: textResult({ error: err.code ?? 'TOKEN_INVALID', message: err.message }, true) })
            return
          }
        }
        const fn = HANDLERS[toolName]
        if (!fn) {
          send({ jsonrpc: '2.0', id, result: textResult({ error: 'TASK_NOT_FOUND', message: `unknown tool ${toolName}` }, true) })
          return
        }
        try {
          const result = await fn(ctx, params?.arguments ?? {})
          onLog(`${toolName} ok`)
          send({ jsonrpc: '2.0', id, result: textResult(result) })
        } catch (err) {
          if (err instanceof SpaceError) {
            onLog(`${toolName} REJECTED ${err.code}: ${err.message}`)
            send({ jsonrpc: '2.0', id, result: textResult({ error: err.code, message: err.message, detail: err.detail ?? null }, true) })
          } else {
            onLog(`${toolName} ERROR ${err?.message ?? err}`)
            send({ jsonrpc: '2.0', id, result: textResult({ error: 'INTERNAL', message: String(err?.message ?? err) }, true) })
          }
        }
        return
      }
      default:
        // 包括 DSH 的私有 `server/discover`：协议层不猜私有 schema
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
      handle(msg).catch((err) => onLog(`handler crash: ${err?.message ?? err}`))
    }
  })
  process.stdin.on('end', () => {
    onLog('stdin closed')
    process.exit(0)
  })

  onLog(`space serve ready as ${member.id} (${member.kind}/${member.role}), space=${db.spaceDir}`)
  return { close: () => process.exit(0) }
}
