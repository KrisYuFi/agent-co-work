# 阶段 1 实测结论

> 实测时间：2026-10-28 · 探针版本：`probe/run.mjs` + `probe/mcp/server.mjs`
> 复现方式见 [README.md](README.md)。原始记录与服务器日志在 `results/raw/`（`<tag>.json` + `<tag>.server.jsonl`），**判决只认服务器日志**。

---

## 一句话结论

**B 档（`wait` 长轮询）成立，但有一个必须写进协议的约束**：单次 `wait` 的阻塞时长受**客户端 MCP 工具调用超时**限制，而这个超时的默认值只有 **opencode 30s / DSH 60s**，且**只有 opencode 能用进度通知续期**。
→ 可直接进阶段 2；协议须补一条：`wait` 默认时长 ≤ 20s + 客户端超时必须显式配置。详见 [ADR 0005](../docs/decisions/0005-wait-bounded-by-client-tool-timeout.md)。

| 假设 | opencode 1.18.23 | dsh (headless) |
|---|---|---|
| **P1** headless 非交互执行 | ✅ 通过（`opencode run`，exit 0） | ✅ 通过（`dsh --profile headless`，exit 0） |
| **P2** MCP over stdio | ✅ 通过（协商 `2025-11-25`） | ✅ 通过（有 `server/discover` 兼容性代价） |
| **P3** 单 turn 内阻塞工具 | ✅ **通过**（调高超时后可阻塞 150s） | ✅ **通过**（调高超时后可阻塞 150s） |
| P3 默认配置下 | ❌ 30s 处 `MCP error -32001` | ❌ 60s 处 `Request timed out` |
| P3 进度通知续期 | ✅ 30s 超时下靠 15s 进度通知撑住 150s | ❌ 不发 progress token，无此机制 |

ROADMAP 的阶段 1 通过标准是「P3 在**至少一个** runtime 上成立」。**两个都成立**，且其中一个（opencode）连默认配置都能靠进度通知救回来。

---

## 逐 runtime 结论表

| runtime | P1 headless | P2 MCP stdio | P3 阻塞下限（默认配置） | P3 阻塞（调高超时） | 进度续期 | 首字延迟 |
|---|---|---|---|---|---|---|
| **opencode** 1.18.23 | ✅ `opencode run` | ✅ 工具名 `probe_<tool>` | ❌ 30s | ✅ 150s（实测） | ✅ `resetTimeoutOnProgress` | ~40s |
| **dsh** 0.1.2-rc.1 | ✅ `dsh headless` | ✅ 工具名 `mcp__probe__<tool>` | ❌ 60s | ✅ 150s（实测） | ❌ 不请求 progress | ~5s |
| claude / codex | 未安装，**未实测** | — | — | — | — | — |

> **首字延迟**：opencode 每次 headless 启动约 40s 开销（会话语料初始化），DSH 约 5s。这是 D 档（`supervisor` 拉起）的**实际成本**，不是缺陷但要计入预算。

---

## 关键证据

### P3 失败的确切形状

默认超时下，**服务器还在干活，客户端先放弃了**——这正是「阻塞工具被打断」：

| runtime | 参数 | wall | 服务器 | 客户端报错 |
|---|---|---|---|---|
| opencode | `block=90s`, `timeout=30000` | 70.7s | `tools/call:start` 有，`end` 无 | `MCP error -32001: Request timed out` |
| dsh | `block=90s`, `timeout=60000` | 64.8s | `tools/call:start` 有，`end` 无 | `Request timed out` |

两边都在**配置值附近**断开（30s / 60s），说明打断来源是**工具调用超时，不是 turn 超时**。

### 调高超时后完全恢复

| runtime | 参数 | wall | 服务器实际阻塞 | 判决 |
|---|---|---|---|---|
| opencode | `block=150s`, `timeout=600000` | 195.6s | **150.0s** | ✅ 工具跑完，agent 拿到真实返回值 |
| dsh | `block=150s`, `timeout=600000` | 156.9s | **150.0s** | ✅ 同上 |

**没有观察到 turn 级硬超时**：两个 runtime 的 turn 都能撑过 150s 的单个工具调用。

### 进度通知：只有 opencode 认

| runtime | 参数 | 结果 |
|---|---|---|
| opencode | `block=150s`, `timeout=30000`, 每 15s 一条 progress | ✅ 撑满 150s，服务器共发 **10** 条进度通知 |
| dsh | `block=150s`, `timeout=60000`, 同样发进度 | ❌ 60s 处仍断；**服务器发出 0 条**——DSH 的 MCP 桥**根本不在请求里带 `progressToken`** |

读码印证：`dsh-mcp-client` 走 `client.request({method:'tools/call'}, {signal, timeout})`，而 opencode 走 `callTool(..., {resetTimeoutOnProgress: true, timeout})`。**不能把「靠进度通知续期」当跨 runtime 通用机制。**

### 对照：内置 shell 工具不受这个限制

`p3-bash`（`sleep 150`，不走 MCP）：

| runtime | wall | 结果 |
|---|---|---|
| opencode | 195.3s | ✅ 正常跑完，返回 `BASH_DONE` |
| dsh | 156.9s | ✅ 正常跑完，返回 `BASH_DONE` |

所以「30s 限制」是 **MCP 工具调用层**的，不是 agent 的 turn，也不是 shell 工具。**阻塞能力本身没问题，卡的是 MCP 客户端的单次调用超时。**

### P2 的一个兼容性代价：DSH 先问 `server/discover`

DSH 的 MCP 桥在标准 `initialize` 之前先发一个 `server/discover`（id 形如 `server-discover-probe-1`）。探针服务器回了 `-32601 Method not found`，DSH 于是**杀掉进程、重启一个、再走标准 `initialize`**：

```jsonl
{"event":"server:start","pid":31307}
{"event":"request","method":"server/discover","id":"server-discover-probe-1"}
{"event":"server:start","pid":31308}          ← 重启
{"event":"request","method":"initialize","id":0}
{"event":"initialize","protocolVersion":"2025-11-25","clientInfo":{"name":"dsh-mcp-client"}}
```

代价是每次 attach 多一次进程启动（~130ms）。**对空间服务端的要求**：要么实现 `server/discover`，要么接受「每个成员 attach 时被拉起两次」——若 `attach` 有副作用（注册、租约、审计），这条会变成正确性问题，不只是性能问题。

---

## 对协议的推论

1. **`wait` 的默认阻塞时长必须小**：取 **20s**（低于 opencode 的 30s 默认值，留余量）。`wait` 本来就带 `since_cursor`，超时返回后循环再调即可，语义不变。
2. **空间不能假设客户端能挂任意久**：客户端超时是**客户端侧配置**，服务端强制不了。所以这条必须同时体现在两处——协议里写清默认值（机制），空间宪法里给出 attach 前的配置指引（约定）。仅靠后者就是「写进文档当约定」，本仓明确反对。
3. **进度通知只能做优化项，不能做正确性依赖**：opencode 支持、DSH 不支持，且这是各 CLI 私有实现细节，随时可变。
4. **`wait` 返回即续租**这条设计经受住了考验：超时返回是无害的，重连再 attach 即可，与 §6.2 的描述一致，不需要改。

---

## 追加探针：跨机器所需的 remote MCP（2026-10-28）

中心化 hub 要求成员**通过网络**接入，而阶段 1 只测过 stdio。补测：

| # | 假设 | opencode 1.18.23 | dsh 0.1.2-rc.1 |
|---|---|---|---|
| P4 | 支持 **MCP over Streamable HTTP**（remote 接入） | ✅ `type:"remote"` + `url` + `headers` | ✅ `transport: streamable-http` + `url` + `headers` |
| P5 | 带 **Bearer 鉴权**可用 | ✅ `headers.Authorization` | ✅ `headers.Authorization` |
| P6 | 服务端只回 JSON、不开 SSE 流也能用 | ✅ 会用 `GET` 开推送流，但 405 也能忍 | ✅ 不依赖推送流 |

实测细节（对 `probe/mcp/http-server.mjs`，一个 150 行的零依赖服务器）：

- **没有触发 OAuth**：只要服务器回 200（不是 401），opencode 不会走它的 OAuth 客户端注册流程。101 时才会。
- **opencode 会额外开一条 SSE**：`initialize` → `notifications/initialized` → `GET /mcp (accept: text/event-stream)`。
  探针回 405（规范允许声明「不支持服务端推送」），它照常工作——**但生产 hub 若要用进度通知/服务端事件，就得实现这条流**。
- **DSH 走 HTTP 时同样先发 `server/discover`**（`-32601` 后回落到标准 `initialize`）。与 stdio 的差别：**这次没有重启进程**（本来就没有进程）。
- 两边都发了 `notifications/cancelled`，说明取消语义在 HTTP 传输下也是通的。

**结论**：中心化 hub 的接入路径可用，不需要 stdio 桥。`wait` 用「POST 长轮询」即可，SSE 只在要服务端主动通知时才需要。

## 未测 / 下一步

| # | 项 | 何时 |
|---|---|---|
| 1 | `claude -p` / `codex exec` 的同三项实测 | 有环境时；**结论可能不同，不能外推** |
| 2 | 阻塞上限的真实天花板（300s / 600s / 更长） | 阶段 2 实测前，按需推一次即可 |
| 3 | 工具调用超时后 session 的可用性（能否继续调工具、上下文是否被污染） | 阶段 2（影响 `wait` 超时返回后的行为） |
| 4 | 人中途插话打断 `wait`（§6.2 的核心卖点） | 阶段 2 验收剧本已含此项 |

---

## 追加探针 P7–P9：人「会话内打断」（2026-10-30，阶段 3 前置）

> 背景：[background.md §3.1](../docs/background.md) 把 R7「人能中途干预」澄清成**会话内**主通道——
> 人打开 agent 自己的会话盯着看、直接输入，而不是往空间里发消息。
> 这要求 runtime 在「人停止当前 turn」时，把 MCP 的取消通知传到**正在阻塞的工具调用**上。
> 脚本：[`p7-interrupt.mjs`](p7-interrupt.mjs)。判决只看 `probe/mcp/server.mjs` 的 JSONL。

| # | 假设 | opencode 1.18.23 | dsh 0.2.1-rc.2 |
|---|---|---|---|
| **P7** | 人**停止**当前 turn → 在飞的 MCP 工具调用收到 `notifications/cancelled` | ✅ `/abort` → 41ms 后 cancelled | ✅ SIGINT → ~230ms 后 cancelled，随后 `stdin:end` |
| **P8** | 人**直接输入新消息**（不按停止）会打断在飞工具调用 | ❌ 20s 内无 cancelled（HTTP 204，消息排队到 turn 之后） | 未测（GUI，需人工） |
| **P9** | 同一会话能被**第二个前端**挂上看并输入 | ✅ `opencode attach <url> -s <session>`；`opencode web` 也是同一 server 的客户端 | ⚠️ Desktop GUI 的会话本人可打开；`dsh headless` 是一次性执行，不行 |

证据（`results/raw/`）：

- `p7.opencode.stop.json` + `.server.jsonl`：`tools/call:start` 后 41ms 出现
  `cancelled {"requestId":2,"reason":"AbortError: The operation was aborted."}`
- `p7.opencode.type.json` + `.server.jsonl`：发出第二条消息后 20s 内**没有** cancelled
- `p7.dsh.stop.json` + `.server.jsonl`：SIGINT 后 ~230ms 收到 cancelled，之后 `stdin:end`

**结论**

1. **通道①成立**，但口径是「**先停再输入**」：直接打字不会打断在飞的工具调用（opencode 会把它排队到 turn 之后）。
   用法上必须写清，否则人会觉得「我说了它没反应」。
2. DSH 的 SIGINT 能传播 cancellation，说明 abort 路径是通的；**GUI 停止按钮是否同一条路**仍需人工确认（P8 的 DSH 列）。
3. P9 让「盯着看」成立：opencode 是 server + 多前端（attach / web）结构，人挂上去看到的就是**同一个会话**；
   DSH 在 GUI 里打开自己的会话天然成立，headless 则明确放弃这个能力（与 background §3.1 的判断一致）。

---

## 追加探针 P10–P12：hook 能不能替代/补强「挂起等待」（2026-10-31）

> 背景：用户问「挂起等待能不能用 hook 解决」。结论先给：**不能替代，但能补一个洞**。
> 判定不看文档，看真实 runtime 行为。

### P10 opencode：插件在 `session.idle` 注入消息 → 新 turn ✅

- 插件 `.opencode/plugins/idle-wake.js` 监听 `event.type === "session.idle"`，调用
  `client.session.prompt({ path:{id}, body:{ parts:[{type:"text", text:"…probe_ping…"}] } })`
- 实测（`opencode serve` + API 驱动，配置里挂 `probe/mcp/server.mjs`）：
  1. 第一轮提示词「只回复 OK，不要调用任何工具」→ 模型回复 `OK` → `session.idle` 触发
  2. 插件注入「调用 probe_ping」→ **新的 assistant 消息出现**，MCP 服务器日志出现 `tools/call:start probe_ping`
  3. 最终消息序列：`只回复 OK… → OK → P10_IDLE_WAKE… → WAKE_OK`
- **结论**：opencode 上「推」是成立的——agent 可以真正 idle（turn 结束），由插件在事件到达时把它叫醒。
  代价是每次唤醒 = 一次完整模型 turn（上下文越长越贵），与 `wait` 的「0 token 轮询」是两种东西。

证据：`probe/work/p10.*`（工作目录，日志未入库；判决见本节与 runs）

### P11 DSH：Stop hook 拦截 ⚠️ 本机无法实测（版本不匹配）

- DSH 0.2.1-rc.2（nvm 全局）**不带** hooks bridge；app 自带的是 `dsh-hooks-claude-code@0.1.2-rc.1`，
  声明要求 `@deepseek-ai/dsh-*@^0.1.2-rc.1`，被 dsh 0.2.1 拒绝加载（提示用 `dsh plugin allow-version`）
- 执行 `dsh plugin --profile headless allow-version '@deepseek-ai/dsh-hooks-claude-code@0.1.2-rc.1' --dsh-version 0.2.1-rc.2 --accept-risk`
  之后插件能进入 composed config，但**实测 PreToolUse 与 Stop 都没有触发**（hook 脚本零调用，`space_*`/probe 工具仍正常）
- 代码层面：bridge 监听 `agent/turn-stopping`，而 dsh 0.2.1 的 `dsh-agent-loop` 仍有该扩展点
  → **理论上 Stop 可拦，但需要 version-matched 的 bridge 才能验**
- 待验条件：用 Desktop 自带 runtime（0.1.2-rc.1）或等 0.2.x 的 bridge 发布

### P12 成本：结构性结论已足够

- `wait` 循环：每 20s 一次工具调用，**0 token**；只有真的有事才进入模型 turn
- hook 唤醒：每次 = **一次完整 turn**（输入 ≈ 当前上下文），session 越长越贵
- 因此 hook 只适合**低频兜底**（会话结束释放租约、漏等提醒），不适合当通知总线

### 对设计的推论

1. **主循环仍是 `wait`**（ADR 0004 不翻案）。
2. opencode 上可以做「idle 推」的可选路径：插件定时查空间状态（0 token），有新活才注入
   —— 这会让 agent 真正空闲、对人更可打断；但要处理「人正在打字时别注入」的冲突。
3. DSH 侧先解决版本配套问题，再谈 Stop/idle 兜底。
