/**
 * plugins/opencode-space.js — opencode 侧「空闲即被唤醒」插件（可选，P10 实测可行）
 *
 * 目的：让 agent **真正空闲**（turn 结束），由插件在空间有活时把它叫醒；
 * 而不是让 agent 一直卡在 `space_wait` 里循环（那样人打字要等它 wait 返回）。
 *
 * 做法：
 *   - 每 SPACE_POLL_MS 调一次 `space_task_list`（**0 token**，只读）
 *   - 只有「会话处于 idle」且「有 PENDING 任务」时，才用 client.session.prompt 注入一条消息
 *     → 注入 = 一次完整模型 turn（有成本，所以有冷却与上限）
 *   - 第一次唤醒会把 space_join 所需的 url/token 一并给出（之后不再重复，减少泄露面）
 *
 * 安装：
 *   cp plugins/opencode-space.js <你的会话目录>/.opencode/plugins/
 * 启动时给环境变量：
 *   SPACE_URL=http://127.0.0.1:7321/mcp SPACE_TOKEN=spt_xxx SPACE_ALIAS=work opencode
 * 可选：SPACE_POLL_MS=20000 SPACE_COOLDOWN_MS=60000 SPACE_MAX_WAKES=3 SPACE_LOG=/tmp/space-plugin.log
 *
 * 边界：token 来自环境变量（不进提示词）；但第一次唤醒的注入文本里会带它一次——
 * 这是「自动唤醒」与「不把 token 写进对话」之间的取舍，见 docs/background.md §3.1。
 */

import { appendFileSync } from 'node:fs'

const URL_ = process.env.SPACE_URL
const TOKEN = process.env.SPACE_TOKEN
const ALIAS = process.env.SPACE_ALIAS || 'work'
const POLL_MS = Number(process.env.SPACE_POLL_MS || 20000)
const COOLDOWN_MS = Number(process.env.SPACE_COOLDOWN_MS || 60000)
const MAX_WAKES = Number(process.env.SPACE_MAX_WAKES || 3)
const LOG = process.env.SPACE_LOG || null

function log(msg, extra = {}) {
  const line = JSON.stringify({ t: Date.now(), msg, ...extra })
  if (LOG) {
    try {
      appendFileSync(LOG, line + '\n')
    } catch {}
  }
  return line
}

function findSessionID(x, depth = 0) {
  if (depth > 6 || x === null || typeof x !== 'object') return undefined
  for (const [k, v] of Object.entries(x)) {
    if (k.toLowerCase().includes('session') && typeof v === 'string' && v.startsWith('ses')) return v
    const r = findSessionID(v, depth + 1)
    if (r) return r
  }
}

export const SpaceWake = async ({ client }) => {
  if (!URL_ || !TOKEN) {
    log('space-wake disabled: SPACE_URL / SPACE_TOKEN not set')
    return {}
  }

  const state = { idle: new Set(), nextId: 1, initialized: false, lastSignature: null, lastWakeAt: 0, wakes: 0, joinHinted: false }
  log('space-wake started', { url: URL_, alias: ALIAS, pollMs: POLL_MS })

  async function rpc(method, params) {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: state.nextId++, method, params }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`hub HTTP ${res.status}`)
    const msg = await res.json()
    if (msg.error) throw new Error(msg.error.message)
    return msg.result
  }

  async function ensureInit() {
    if (state.initialized) return
    await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'space-wake', version: '0.1.0' }, capabilities: {} })
    // 插件自己也要 attach：hub 的读操作同样要求「已报到」（协议 §2.3 的硬前置）。
    // 这和 agent 后来通过网关 attach 不冲突（幂等，只更新 capabilities）。
    const r = await rpc('tools/call', { name: 'space_attach', arguments: {} })
    const text = r?.content?.[0]?.text ?? ''
    try {
      state.member = JSON.parse(text).member ?? null
      log('attached', { member: state.member })
    } catch {
      log('attach returned', { text: String(text).slice(0, 120) })
    }
    state.initialized = true
  }

  async function pollPending() {
    await ensureInit()
    const r = await rpc('tools/call', { name: 'space_task_list', arguments: {} })
    const text = r?.content?.[0]?.text ?? ''
    const parsed = (() => {
      try {
        return JSON.parse(text)
      } catch {
        return {}
      }
    })()
    if (parsed.error) throw new Error(`${parsed.error}: ${parsed.message ?? ''}`)
    return (parsed.tasks ?? []).filter((t) => t.state === 'PENDING')
  }

  function wakeText(tasks) {
    const ids = tasks.map((t) => t.id).join(', ')
    const act = `对任务 ${ids}：space_task_claim {"task_id":"<id>"} 拿到 lease，然后 space_task_transition {"task_id":"<id>","lease_id":"<lease>","to":"WORKING"}，最后用一句话说明你在做什么`
    if (state.joinHinted) return `[协作空间] 还有 ${tasks.length} 个待办任务：${ids}。${act}。`
    state.joinHinted = true
    const join = JSON.stringify({ space: ALIAS, url: URL_, token: TOKEN })
    return `[协作空间] 有 ${tasks.length} 个待办任务：${ids}。你还没连空间：先调用 space_join，参数 ${join}；然后 space_attach；再${act}。`
  }

  async function wake(sessionID, tasks) {
    state.idle.delete(sessionID)
    log('wake', { sessionID, tasks: tasks.length })
    await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: wakeText(tasks) }] } })
  }

  const timer = setInterval(async () => {
    if (state.idle.size === 0) return
    try {
      const tasks = await pollPending()
      if (tasks.length === 0) {
        state.wakes = 0
        state.lastSignature = null
        return
      }
      const sig = tasks.map((t) => t.id).sort().join(',')
      const now = Date.now()
      if (sig === state.lastSignature && now - state.lastWakeAt < COOLDOWN_MS) return // 同一批活，别催
      if (sig !== state.lastSignature) state.wakes = 0
      if (state.wakes >= MAX_WAKES) return // 叫了三次还不干，交给 wait/人
      for (const sid of [...state.idle]) await wake(sid, tasks)
      state.lastSignature = sig
      state.lastWakeAt = now
      state.wakes += 1
    } catch (err) {
      log('poll failed', { error: String(err?.message ?? err) })
    }
  }, POLL_MS)
  timer.unref?.()

  return {
    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        const sid = findSessionID(event.properties)
        if (sid) {
          state.idle.add(sid)
          log('session.idle', { sessionID: sid })
        }
      } else if (event.type === 'session.deleted') {
        const sid = findSessionID(event.properties)
        if (sid) state.idle.delete(sid)
      } else if (event.type === 'session.error') {
        const sid = findSessionID(event.properties)
        if (sid) state.idle.delete(sid)
      }
    },
  }
}
