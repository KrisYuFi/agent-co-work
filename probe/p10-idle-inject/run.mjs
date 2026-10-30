#!/usr/bin/env node
/**
 * P10 运行器：验证 opencode 插件在 session.idle 注入消息能否开新 turn。
 * 用法：node run.mjs --dir <含 .opencode/plugins 与 opencode.json 的目录> [--port 7461]
 * 判定：plugin.log 有 session.idle 与注入记录，且 mcp.jsonl 出现 probe_ping。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : d)
const dir = resolve(flag('dir', '.'))
const port = Number(flag('port', '7461'))
const base = `http://127.0.0.1:${port}`
const q = `directory=${encodeURIComponent(dir)}`
const pluginLog = join(dir, 'plugin.log')
const mcpLog = join(dir, 'mcp.jsonl')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const serve = spawn('opencode', ['serve', '--port', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
serve.stderr.pipe(process.stderr)
try {
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${base}/session/status?${q}`)).ok } catch {}
    if (!up) await sleep(250)
  }
  if (!up) throw new Error('opencode serve 未就绪')
  const s = await (await fetch(`${base}/session?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
  await fetch(`${base}/session/${s.id}/prompt_async?${q}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '只回复 OK 两个字，不要调用任何工具。' }], model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' } }),
  })
  let idle = false
  for (let i = 0; i < 240 && !idle; i++) {
    if (existsSync(pluginLog) && readFileSync(pluginLog, 'utf8').includes('"session.idle"')) idle = true
    else await sleep(250)
  }
  let probe = false
  for (let i = 0; i < 240 && !probe; i++) {
    if (existsSync(mcpLog) && readFileSync(mcpLog, 'utf8').includes('probe_ping')) probe = true
    else await sleep(250)
  }
  console.log(`session.idle: ${idle} | probe_ping after idle: ${probe}`)
  console.log(probe ? 'PASS' : 'FAIL')
} finally {
  serve.kill('SIGKILL')
}
