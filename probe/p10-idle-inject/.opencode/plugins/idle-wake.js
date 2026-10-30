import { appendFileSync } from 'node:fs'
const LOG = process.env.P10_LOG || './plugin.log'
let injected = 0
function findSessionID(x, depth = 0) {
  if (depth > 6 || x === null || typeof x !== 'object') return undefined
  for (const [k, v] of Object.entries(x)) {
    if (k.toLowerCase().includes('session') && typeof v === 'string' && v.startsWith('ses')) return v
    const r = findSessionID(v, depth + 1)
    if (r) return r
  }
}
export const IdleWake = async ({ client }) => ({
  event: async ({ event }) => {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), type: event.type, properties: event.properties }) + '\n')
    if (event.type !== 'session.idle' || injected > 0) return
    const id = findSessionID(event.properties)
    if (!id) return
    injected += 1
    await client.session.prompt({
      path: { id },
      body: { parts: [{ type: 'text', text: 'P10_IDLE_WAKE：现在调用 probe_ping 工具一次，然后回复 WAKE_OK。' }] },
    })
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), injected: id }) + '\n')
  },
})
