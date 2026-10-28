# 0011. 入场方式：网关 `space connect` + 运行时 join

- **状态**：已接受（待实现）
- **日期**：2026-10-28
- **影响面**：入场的 UX / 成员侧进程 / 接口表（不是 hub 的 16 个工具，而是成员侧新增两个） / 身份交付方式

## 背景

现在的入场方式是**进程启动时绑定**：

```bash
space serve --dir ./space --token-file space/tokens/architect.token
```

一个进程 = 一个空间 + 一个身份，所以每个角色一份 MCP 配置、每个空间一份配置。从使用者角度看这是**运维脚手架**，不是日常操作：

> 开一个会话，说「加入 work 空间，你是 architect」，这件事做不到。

原因不是模型不行，是一条硬约束：

> **MCP 工具集在会话启动时就固定了。** 会话中途没有"动态连上一个新的 MCP server"这种通用能力。
> 个别 runtime 有热加载，但那是各家私有行为——正是本仓明确不绑定的东西（AGENTS.md 原则 5）。

所以「说一句就连上」不等价于「提示词里让 agent 去连」，而等价于：

> **启动时挂一个什么都不做的连接器，把「连哪个空间、用什么身份」变成运行时参数。**

## 决策

**一、成员侧新增一个网关进程 `space connect`**

- 启动时**不连任何空间**，只暴露两个工具：
  - `space_join({url, token})` → 连接到该 hub，此后所有 `space_*` 工具可用
  - `space_leave()` → 断开，回到未加入状态
- 实现上是**透传**：把 `space_*` 的 JSON-RPC 转发给 hub 的 `/mcp`，并注入 `Authorization: Bearer <token>`
- 一个会话可以 `join` → `leave` → 再 `join` 另一个空间

配置里永远只有一行，一次配好不用再改：

```json
{ "mcp": { "space": { "type": "local", "command": ["node", "<repo>/src/cli.mjs", "connect"] } } }
```

**二、身份 = token，名字 = `member_id`（沿用现有模型，不新造概念）**

- 签发时确定：`space token issue --member <名字> --role <角色>` → token ↔ (名字, 角色, scopes, kind)
- agent 连上后用 `space_attach` 拿回自己的身份（`{id, role, kind}`）；可另加 `space_whoami`，但 attach 已够
- **agent 不能自封身份**：它只能提交人给它的 token。谁能拿到 token，谁就是这个身份（bearer 语义）

**三、空间初始化时批量签发具名 token**

```bash
space init --dir ./space --members pm:pm,architect:architect,qa:qa,me:human:human
```

一条命令建库 + 签发全部具名 token + 写入 `space/tokens/<名字>.token`（**0600**）+ 只打印一次。
之后随时可加：`space token issue --member dev-2 --role developer`。

**四、入场示例（这就是日常形态）**

```
你（在 architect 的会话里）：先用 space_join 连到 http://127.0.0.1:7321/mcp，token 是 spt_xxx，
                             然后 space_attach，再循环 space_wait 等活。
agent：→ space_join → space_attach（拿回身份 architect）→ space_wait …
```

## 后果

**正面**

- 日常操作从「四条命令 + 改配置」降为「开 session + 说一句话」
- 一个会话能换空间（项目间切换），不必重启
- hub 的 16 个工具完全不变；网关只是成员侧的接入层，符合「接入层与核心解耦」
- 身份仍由人授予：agent 只持有凭据，不能声明身份（`background.md` §5.2 的「attach 是门」原则不破）

**负面 / 代价**

- **token 进提示词 = 进会话历史与日志**。能翻到该会话的人就能复用这个身份。缓解：短 TTL（`--ttl 12h`）+ `space token revoke` 即时生效。这是这条路线的固有代价，不是实现缺陷
- **上下文压缩 / 会话重启后 token 丢失**，agent 无法自行重新入场，需要人再给一次
- 多了一个成员侧进程与一层透传，排障时要分「网关没连上」还是「hub 拒绝」
- `space/tokens/` 里的文件就是身份，必须 0600 且不进 git（`.gitignore` 已覆盖）

## 备选方案

| 方案 | 放弃理由 |
|---|---|
| 保持现状（每角色一份配置） | 一个角色一个配置 + 一个空间一份配置，日常不可用；这正是本次变更要解决的 |
| **本地凭证库**（`space login work --role qa`，agent 只报角色名，网关查库取 token） | 更安全（token 不进会话历史）、会话重启后仍可自动加入。**作为可选增强保留**，但多一步「人先配」，与「开 session 说一句」的诉求冲突 |
| 让 agent 走 bash 调 CLI（`space wait` / `space claim`） | 不依赖 MCP，任何 runtime 都能用；但每次等待都是一次 shell 调用 + 解析 JSON，agent 容易用错。留作 A 档兜底 |
| 依赖 runtime 的 MCP 热加载 | 各家私有行为、跨 runtime 不通用，且随时可变；违反「借鉴不绑定」 |

## 未定 / 后续

- `space_join` 是否顺带完成 `attach`（省一次调用）——倾向**不合并**：join 是连接，attach 是报到（要上报宪法版本与 capabilities），语义不同
- 一个会话同时连多个空间（多 hub 并存）是否需要 —— 目前留白
- 凭证库增强何时做 —— 等有人真的被「token 丢失需重给」咬到
