#!/usr/bin/env node
/**
 * src/cli.mjs — `space` 命令行
 *
 *   space init   [--dir <path>] [--force]
 *   space token  issue|list|revoke
 *   space serve  --token-file <p> | --token <t> | SPACE_TOKEN   （MCP stdio 服务器）
 *   space attach --runtime opencode|dsh --token-file <p>        （打印可直接粘贴的接入配置）
 *   space trace  [--limit N] [--follow]
 *   space verify （投影 vs 事件归约）
 *   space tasks  [--op X] / space members
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, resolveSpaceDir, metaGet } from './space/db.mjs'
import { authenticate, issueToken, listTokens, revokeMember, unrevokeMember } from './space/tokens.mjs'
import { appendEvent, formatEvent } from './space/events.mjs'
import { serveStdio } from './space/mcp.mjs'
import * as httpModule from './space/http.mjs'
import * as gatewayModule from './space/gateway.mjs'
import { verify } from './space/service.mjs'

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}

function die(msg, code = 1) {
  console.error(`space: ${msg}`)
  process.exit(code)
}

function parseTtl(text) {
  if (!text || text === true) return null
  const m = String(text).match(/^(\d+)([smhd])$/)
  if (!m) die(`bad --ttl "${text}" (use e.g. 30m / 12h / 7d)`)
  const n = Number(m[1])
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]
  return n * unit
}

function readToken(args) {
  const fromArg = args.token && args.token !== true ? args.token : null
  const fromFile = args['token-file'] && args['token-file'] !== true ? args['token-file'] : null
  const fromEnv = process.env.SPACE_TOKEN || null

  // 显式参数 > 环境变量。原来环境变量会静默盖掉 --token-file，多 agent 共用 shell 时
  // 会让 agent 以别人的身份干活（实测过）。
  if (fromArg) {
    if (fromEnv) console.error('space: 警告：同时给了 --token 与 SPACE_TOKEN，采用 --token')
    return fromArg
  }
  if (fromFile) {
    if (fromEnv) console.error('space: 警告：同时给了 --token-file 与 SPACE_TOKEN，采用 --token-file')
    if (!existsSync(fromFile)) die(`token file not found: ${fromFile}`)
    return readFileSync(fromFile, 'utf8').trim()
  }
  return fromEnv
}

const CONSTITUTION = `# 空间宪法 (constitution: {VERSION})

> 本文件由 \`space init\` 生成。它是**空间里跑什么流程**的约定，不是空间实现的约定。
> 铁律：能用接口约束的，不写在这里（协议 §9）。

## 入场

1. 先 \`space_attach\`，上报你遵守的宪法版本与 \`capabilities.max_block_sec\`。
2. 然后循环：\`space_wait\` → 有活就 \`space_task_claim\` → 干活 → \`space_publish\` → \`space_task_transition(DONE + handoff)\`。

## 不可协商

- \`wait\` 返回 \`reason="timeout"\` 是**正常返回**，继续循环，不要放弃等待。
- 消息只传引用（uri + sha256 + size），不传内容。
- 转到 \`DONE\` 必须带 handoff，server 会拒绝没有 handoff 的完成。
- 终态任务不可重开；要改就新建 \`revision\` 任务并 \`refs\` 原任务。
- 硬门槛只能由 human 放宽，agent 无权自行放行。
`

// ---------------------------------------------------------------- 命令

function cmdInit(args) {
  const dir = resolveSpaceDir(args.dir)
  if (existsSync(join(dir, 'space.sqlite')) && !args.force) die(`space already initialised at ${dir} (use --force to keep existing data)`)
  const db = openDb(dir, { create: true })
  const version = Number(args['constitution-version'] ?? metaGet(db, 'constitution_version') ?? 1)
  db.prepare('update meta set value = ? where key = ?').run(String(version), 'constitution_version')
  const constitutionPath = join(dir, 'AGENTS.md')
  if (!existsSync(constitutionPath)) writeFileSync(constitutionPath, CONSTITUTION.replace('{VERSION}', String(version)))
  console.log(`space initialised at ${db.spaceDir}`)
  console.log(`  db           ${join(db.spaceDir, 'space.sqlite')}`)
  console.log(`  constitution ${constitutionPath} (v${version})`)
  const members = args.members && args.members !== true ? String(args.members) : null
  if (members) {
    const tokensDir = join(db.spaceDir, 'tokens')
    mkdirSync(tokensDir, { recursive: true })
    const issued = []
    for (const spec of members.split(',').map((x) => x.trim()).filter(Boolean)) {
      // 格式：名字:角色[:kind]，例如 pm:pm、me:human:human
      const [name, role, kind = 'role'] = spec.split(':')
      if (!name || !role) die(`bad --members entry "${spec}" (expect 名字:角色[:kind])`)
      const out = issueToken(db, { memberId: name, role, kind })
      const file = join(tokensDir, `${name}.token`)
      writeFileSync(file, out.token + '\n', { mode: 0o600 })
      issued.push({ name, role, kind, file, token: out.token })
    }
    console.log(`\n已签发 ${issued.length} 个具名身份（token 只显示这一次）：`)
    for (const m of issued) console.log(`  ${m.name.padEnd(12)} ${(m.kind === 'human' ? 'human' : m.role).padEnd(12)} ${m.token}  → ${m.file}`)
    console.log(`\n用法示例（在 agent 会话里说）：`)
    console.log(`  「space_join 到空间 http://127.0.0.1:7321/mcp，space 别名 work，token 用上面 ${issued[0].name} 那串，然后 space_attach，再循环 space_wait 等活」`)
  } else {
    console.log(`\n下一步：space token issue --member dev-code --role developer`)
  }
  db.close()
}

function cmdToken(args) {
  const db = openDb(args.dir)
  const sub = args._[1]
  if (sub === 'issue') {
    const memberId = args.member
    const role = args.role
    if (!memberId || !role) die('usage: space token issue --member <id> --role <role> [--kind role|human|supervisor] [--scopes a,b] [--ttl 7d]')
    const out = issueToken(db, {
      memberId,
      role,
      kind: args.kind && args.kind !== true ? args.kind : 'role',
      scopes: args.scopes && args.scopes !== true ? String(args.scopes).split(',').map((s) => s.trim()) : [],
      ttlMs: parseTtl(args.ttl),
    })
    console.log(out.token)
    console.error(`issued for ${out.member_id} (${out.kind}/${out.role})${out.expires_at ? `, expires ${new Date(out.expires_at).toISOString()}` : ', no expiry'}`)
    console.error('token 只显示这一次。用 --token-file 或 SPACE_TOKEN 使用，别写进命令行历史。')
  } else if (sub === 'list') {
    const rows = listTokens(db)
    if (rows.length === 0) console.log('(no tokens)')
    for (const r of rows) {
      const state = r.revoked_at ? 'REVOKED' : r.expires_at && r.expires_at < Date.now() ? 'EXPIRED' : 'active'
      console.log(`${r.prefix}…  ${r.member_id}  ${r.kind}/${r.role}  ${state}  issued=${new Date(r.issued_at).toISOString()}`)
    }
  } else if (sub === 'revoke') {
    const memberId = args.member
    if (!memberId) die('usage: space token revoke --member <id>')
    const res = revokeMember(db, memberId, { appendEvent, reason: args.reason ?? 'revoked' })
    console.log(`revoked ${res.tokens_revoked} token(s) for ${memberId}; requeued ${res.tasks_requeued} task(s)`)
  } else if (sub === 'unrevoke') {
    const memberId = args.member
    if (!memberId) die('usage: space token unrevoke --member <id>')
    const res = unrevokeMember(db, memberId)
    console.log(`unrevoked ${memberId}; reactivated ${res.tokens_reactivated} token(s)`)
  } else die('usage: space token issue|list|revoke|unrevoke ...')
  db.close()
}

function cmdConnect(args) {
  const { serveGateway } = gatewayModule
  const log = (msg) => console.error(`[gateway ${new Date().toISOString().slice(11, 19)}] ${msg}`)
  serveGateway({ onLog: log })
}

function cmdServe(args) {
  const db = openDb(args.dir)

  // hub 模式：单进程 + 单 sqlite + MCP over Streamable HTTP，成员从各处接入（跨机器的前提）
  if (args.listen && args.listen !== true) {
    const [host, port] = String(args.listen).split(':')
    const { serveHttp } = httpModule
    serveHttp({
      db,
      host: host || '0.0.0.0',
      port: Number(port || 7321),
      authenticate,
      onLog: (msg) => console.error(`[hub ${new Date().toISOString().slice(11, 19)}] ${msg}`),
    })
    return
  }

  const token = readToken(args)
  if (!token) die('serve needs a token: --token-file <p>, --token <t>, or SPACE_TOKEN')
  let member
  try {
    member = authenticate(db, token)
  } catch (err) {
    die(`attach refused: ${err.code ?? 'ERROR'} — ${err.message}`)
  }
  const ctx = {
    db,
    member,
    // 未 attach 前除 attach 外的工具一律拒绝：宪法版本门不能靠自觉（协议 §2.3）。
    // max_block_sec 也放这里：attach 时由服务端收口后写入，供后续 wait 读取。
    session: { attached: false },
    // 身份每次调用重查：吊销/过期即时生效（ADR 0007）
    reauth: () => authenticate(db, token),
  }
  const log = (msg) => console.error(`[space ${new Date().toISOString().slice(11, 19)}] ${msg}`)
  serveStdio(ctx, { name: 'space', version: '0.1.0', onLog: log })
}

function cmdAttach(args) {
  const db = openDb(args.dir)
  const token = readToken(args)
  if (!token) die('attach needs a token: --token-file <p>, --token <t>, or SPACE_TOKEN')
  const member = authenticate(db, token)
  const runtime = args.runtime
  const cli = join(import.meta.dirname, 'cli.mjs')
  const spaceDir = db.spaceDir
  const tokenFile = args['token-file'] && args['token-file'] !== true ? args['token-file'] : null

  const remoteUrl = args.url && args.url !== true ? String(args.url) : null
  const bearer = token

  if (remoteUrl) {
    if (runtime === 'opencode') {
      console.log(
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              space: {
                type: 'remote',
                url: remoteUrl,
                enabled: true,
                oauth: false,
                headers: { Authorization: `Bearer ${bearer}` },
              },
            },
          },
          null,
          2,
        ),
      )
    } else if (runtime === 'dsh') {
      console.log(
        [
          '- insert:',
          '    - id: space',
          "      name: '@deepseek-ai/dsh-mcp-client'",
          '      config:',
          '        serverName: space',
          '        transport: streamable-http',
          `        url: ${remoteUrl}`,
          '        headers:',
          `          Authorization: Bearer ${bearer}`,
        ].join('\n'),
      )
    } else if (runtime === 'claude') {
      console.log(JSON.stringify({ mcpServers: { space: { type: 'http', url: remoteUrl, headers: { Authorization: `Bearer ${bearer}` } } } }, null, 2))
    } else {
      die('--runtime required: opencode | dsh | claude')
    }
    console.error(`# member ${member.id} (${member.kind}/${member.role}) · hub ${remoteUrl}`)
    console.error('# 注意：token 是内联的，别把生成的配置文件提交进 git')
    db.close()
    return
  }

  if (runtime === 'opencode') {
    const cfg = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        space: {
          type: 'local',
          command: [process.execPath, cli, 'serve', '--dir', spaceDir, ...(tokenFile ? ['--token-file', tokenFile] : [])],
          enabled: true,
          timeout: 60000,
        },
      },
    }
    console.log(JSON.stringify(cfg, null, 2))
  } else if (runtime === 'dsh') {
    console.log(
      [
        '- insert:',
        '    - id: space',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: space',
        '        transport: stdio',
        `        command: ${process.execPath}`,
        '        args:',
        `          - ${cli}`,
        '          - serve',
        '          - --dir',
        `          - ${spaceDir}`,
        ...(tokenFile ? ['          - --token-file', `          - ${tokenFile}`] : []),
        '        toolCallTimeoutMs: 60000',
      ].join('\n'),
    )
  } else if (runtime === 'claude') {
    console.log(
      JSON.stringify(
        { mcpServers: { space: { command: process.execPath, args: [cli, 'serve', '--dir', spaceDir, ...(tokenFile ? ['--token-file', tokenFile] : [])] } } },
        null,
        2,
      ),
    )
  } else {
    die(`--runtime required: opencode | dsh | claude`)
  }
  console.error(`# member ${member.id} (${member.kind}/${member.role}) · space ${spaceDir}`)
  console.error(`# 记得在 space_attach 里上报 capabilities.max_block_sec = 20（或客户端超时/2）`)
  db.close()
}

function cmdTrace(args) {
  const db = openDb(args.dir)
  const limit = Number(args.limit ?? 200)
  const rows = db
    .prepare('select id, kind, task_id, member_id, payload, at from events order by id asc limit ?')
    .all(limit)
  for (const r of rows) console.log(formatEvent({ ...r, payload: JSON.parse(r.payload) }))
  if (args.follow) {
    let cursor = rows.at(-1)?.id ?? 0
    console.error(`# following from event ${cursor} (Ctrl-C to stop)`)
    setInterval(() => {
      const fresh = db.prepare('select * from events where id > ? order by id asc').all(cursor)
      for (const r of fresh) {
        cursor = r.id
        console.log(formatEvent({ ...r, payload: JSON.parse(r.payload) }))
      }
    }, 400)
  } else db.close()
}

async function cmdVerify(args) {
  const db = openDb(args.dir)
  const res = await verify({ db, member: null, admin: true })
  console.log(res.ok ? 'projection OK (state == event reduction)' : `DRIFT: ${JSON.stringify(res.drift, null, 2)}`)
  db.close()
  process.exit(res.ok ? 0 : 1)
}

function cmdTasks(args) {
  const db = openDb(args.dir)
  const op = args.op && args.op !== true ? args.op : null
  const rows = op
    ? db.prepare('select * from tasks where op = ? order by created_at').all(op)
    : db.prepare('select * from tasks order by created_at').all()
  for (const t of rows) {
    console.log(`${t.id}  ${t.state.padEnd(14)} ${t.type.padEnd(9)} to=${(t.to_member ?? t.role ?? '—').padEnd(12)} owner=${t.owner ?? '—'}`)
  }
  db.close()
}

function cmdMembers(args) {
  const db = openDb(args.dir)
  for (const m of db.prepare('select * from members order by created_at').all()) {
    console.log(`${m.id.padEnd(14)} ${m.kind.padEnd(11)} ${m.role.padEnd(12)} ${m.status}`)
  }
  db.close()
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2)
const args = parseArgs(argv)
const cmd = args._[0]

try {
  switch (cmd) {
    case 'init':
      cmdInit(args)
      break
    case 'token':
      cmdToken(args)
      break
    case 'serve':
      cmdServe(args)
      break
    case 'connect':
      cmdConnect(args)
      break
    case 'attach':
      cmdAttach(args)
      break
    case 'trace':
      cmdTrace(args)
      break
    case 'verify':
      await cmdVerify(args)
      break
    case 'tasks':
      cmdTasks(args)
      break
    case 'members':
      cmdMembers(args)
      break
    default:
      console.log(`space — agent 协作空间（阶段 2 原型）

  space init    [--dir <path>] [--constitution-version N] [--members pm:pm,architect:architect,me:human:human]
  space token   issue --member <id> --role <r> [--kind role|human] [--scopes a,b] [--ttl 7d]
                list | revoke --member <id>
  space serve   --token-file <p> | --token <t>   （stdio：一个成员一个进程，本机开发用）
                --listen 0.0.0.0:7321           （hub：单进程 + HTTP，跨机器接入用）
  space connect                                          （网关：启动不连空间，用 space_join 运行时加入）
  space attach  --runtime opencode|dsh|claude --token-file <p> [--url http://hub:7321/mcp]
  space trace   [--limit N] [--follow]
  space verify  （投影 vs 事件归约）
  space tasks   [--op <name>]
  space members
`)
  }
} catch (err) {
  if (err?.code && err?.message) die(`${err.code}: ${err.message}`)
  die(err?.stack ?? String(err))
}
