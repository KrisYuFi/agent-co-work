#!/usr/bin/env node
/**
 * test/up.mjs — `space up` 一条命令起空间（离线，不起模型）
 *
 * 验的是「人少一步」这件事本身：
 *   1. up --print-only 幂等：第一次建空间并签发，第二次复用同一批 token（旧会话不失联）
 *   2. 打印出来的东西够用：hub 地址、每个成员的整行提示词（含 url + token）
 *   3. up 起的 hub 真的能用：浏览器之外，用打印出来的 token 直接 attach 成功
 *
 * 用法：node test/up.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'src', 'cli.mjs')
const NODE = process.execPath
const PORT = 7441

const results = []
const check = (n, ok, d = '') => {
  results.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spaceCli = (a) => execFileSync(NODE, [CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const dir = mkdtempSync(join(tmpdir(), 'space-up-'))
const members = 'pm:pm,dev:developer,me:human:human'

// ───────────────────────────────────────────── 1. print-only 幂等
const first = spaceCli(['up', '--dir', dir, '--members', members, '--print-only'])
const second = spaceCli(['up', '--dir', dir, '--members', members, '--print-only'])
check('up --print-only 建空间并打印 hub 地址', /hub\s+http:\/\/127\.0\.0\.1:\d+\/mcp/.test(first), first.split('\n')[0])
check('第二次 up 显示复用（不新建）', !second.includes('(新建)') && existsSync(join(dir, 'space.sqlite')))
check(
  '每个成员都有一行可粘贴提示词（含 space_join + url + token）',
  ['pm', 'dev', 'me'].every((n) => new RegExp(`\\[${n} ·`).test(first)) &&
    (first.match(/space_join，参数 \{"space":/g) ?? []).length === 3,
)

const tokens = ['pm', 'dev', 'me'].map((n) => readFileSync(join(dir, 'tokens', `${n}.token`), 'utf8').trim())
check('token 文件 0600 且前缀正确', tokens.every((t) => t.startsWith('spt_')) && (statSync(join(dir, 'tokens', 'pm.token')).mode & 0o777) === 0o600)
check('重跑 up 复用同一批 token（打印值 == 文件值）', tokens.every((t) => first.includes(t) && second.includes(t)))

// ───────────────────────────────────────────── 2. up 起的 hub 真能用
const hub = spawn(NODE, [CLI, 'up', '--dir', dir, '--listen', `127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
hub.stderr.resume()
await sleep(1200)

async function rpc(token, method, params, id = 1) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const init = await rpc(tokens[0], 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'up-smoke', version: '0' }, capabilities: {} })
check('up 起的 hub 能 initialize（打印的地址真的可达）', init.status === 200 && init.json?.result?.serverInfo?.name === 'space')

const attach = await rpc(tokens[0], 'tools/call', { name: 'space_attach', arguments: {} }, 2)
const member = JSON.parse(attach.json?.result?.content?.[0]?.text ?? '{}').member
check('打印的 token 能 attach 并拿到自己的名字（身份由 token 决定）', member?.id === 'pm', JSON.stringify(member))

const bad = await rpc('spt_deadbeef', 'tools/call', { name: 'space_state_get', arguments: {} }, 3)
check('坏 token 被 hub 拒绝（TOKEN_INVALID）', bad.status >= 400 || bad.json?.error != null, JSON.stringify(bad.json ?? bad.status).slice(0, 80))

hub.kill('SIGTERM')
await sleep(400)
hub.kill('SIGKILL')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
