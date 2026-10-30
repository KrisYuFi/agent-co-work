# probe/ — 阶段 1 技术探针

> **本目录不实现协作空间。** 它只回答一个问题：`wait` 长轮询这个主唤醒方案，在真实 runtime 上到底成不成立。
> 结论见 **[RESULTS.md](RESULTS.md)**。

对应 [ROADMAP 阶段 1](../ROADMAP.md)。三条假设：

| # | 假设 | 不成立的后果 |
|---|---|---|
| P1 | 目标 CLI 支持 headless 非交互执行 | 唤醒 D 档（无人值守）不存在 |
| P2 | 目标 CLI 能挂 MCP over stdio | 接入层要重选 |
| P3 | 单 turn 内调用阻塞工具不会被硬超时打断 | **B 档不成立 → 架构退回纯拉取** |

## 文件

| 文件 | 作用 |
|---|---|
| `mcp/server.mjs` | **零依赖** stdio MCP 服务器。工具：`probe_ping` / `probe_block(seconds)` / `probe_block_progress(seconds, intervalMs)`。把每个请求、每次调用起止、每条 progress 通知写进 JSONL 日志——**这是判决的客观依据**，不是客户端的一面之词 |
| `mcp/smoke-client.mjs` | 本地自检客户端。先证明服务器本身是对的，否则 runtime 上的失败分不清是「服务器坏了」还是「runtime 不支持」 |
| `run.mjs` | 一个 `(scenario, runtime)` = 一次运行。生成临时配置（**不碰用户全局配置**）、计时、读回服务器日志、写 `results/raw/*.json` |
| `mcp/http-server.mjs` | **最小 MCP over Streamable HTTP** 服务器（零依赖）。用于验证 opencode remote / DSH streamable-http 能否接入——中心化 hub 的前提 |
| `p7-interrupt.mjs` | **P7/P8 探针**：人在会话里「停止 / 直接输入」时，在飞的 MCP 工具调用会不会收到 `notifications/cancelled`。opencode 走 `/session/{id}/abort`（TUI 停止同一路径），dsh 走 SIGINT 代理 |
| `results/raw/<tag>.json` | 每次运行的原始记录，含判决、wall time、工具是否真的跑完、服务器侧阻塞时长 |
| `results/raw/<tag>.server.jsonl` | 对应的**服务器侧原始日志**（判决证据），随记录入库 |
| `work/` | 每次运行的工作目录（配置 + 服务器日志），可随时删 |

## 复现

前提：`node`（本机 v26.1.0）、`opencode` 1.18.23、`dsh`（DeepSeek Harness）。

```bash
# 0. 先自检探针服务器（5 秒阻塞）
node probe/mcp/smoke-client.mjs --block 5

# 1. P1 headless
node probe/run.mjs --scenario p1 --runtime opencode
node probe/run.mjs --scenario p1 --runtime dsh

# 2. P2 MCP over stdio
node probe/run.mjs --scenario p2 --runtime opencode
node probe/run.mjs --scenario p2 --runtime dsh

# 3. P3 阻塞（默认超时：opencode 30s / DSH 60s）
node probe/run.mjs --scenario p3-block --runtime opencode --block 90 --mcp-timeout 30000 --label default-30s
node probe/run.mjs --scenario p3-block --runtime dsh      --block 90 --mcp-timeout 60000 --label default-60s

# 4. P3 阻塞（调高客户端超时）
node probe/run.mjs --scenario p3-block --runtime opencode --block 150 --mcp-timeout 600000 --label raised-600s
node probe/run.mjs --scenario p3-block --runtime dsh      --block 150 --mcp-timeout 600000 --label raised-600s

# 5. P3 progress 续期（默认超时 + 每 15s 一条进度通知）
node probe/run.mjs --scenario p3-progress --runtime opencode --block 150 --mcp-timeout 30000 --progress-interval 15000
node probe/run.mjs --scenario p3-progress --runtime dsh      --block 150 --mcp-timeout 60000 --progress-interval 15000

# 6. 对照：内置 shell 工具阻塞（不走 MCP）
node probe/run.mjs --scenario p3-bash --runtime opencode --block 150
node probe/run.mjs --scenario p3-bash --runtime dsh      --block 150

# 7. P7/P8：人会话内「停止 / 直接输入」能否打断在飞工具调用（阶段 3 前置）
node probe/p7-interrupt.mjs --scenario p7 --runtime opencode --label stop
node probe/p7-interrupt.mjs --scenario p7 --runtime dsh      --label stop
node probe/p7-interrupt.mjs --scenario p7 --runtime opencode --action message --label type
```

## 判决口径

**只认服务器日志。** 客户端说「我调用了工具」不算数，必须服务器侧出现 `tools/call:start` **和** `tools/call:end{ok:true}`。理由：客户端可能在超时后编一个看似成功的回答，而日志不会。

三个字段：

- `called` — 服务器收到了 `tools/call`
- `completed` — 服务器把活干完了（`blockedMs` 就是它真实阻塞时长）
- `progress` — 服务器发了几条进度通知

`called && !completed` 就是 P3 失败的确切形状：**客户端在服务器干完之前自己放弃了**。

## 运行器为什么这样设计

- **不改全局配置**：opencode 用临时目录里的项目级 `opencode.json`；DSH 用 `--patch` 覆盖层。探针不能污染用户环境，否则结论不可复现。
- **每个 runtime 的超时旋钮是显式参数**：`--mcp-timeout` 直接写进该 runtime 的 MCP 配置字段，探的就是「这个值能不能救回阻塞」。
- **两次失败 + 一次成功才算测出边界**：先按默认值撞墙，再调高看是否恢复，两者缺一不可。

## 已知限制

- 只覆盖本机可用的两个 runtime（`opencode`、`dsh`）。`claude -p` / `codex exec` 本机未安装，**未实测**——ROADMAP 要求的「逐 CLI 填表」目前是两行。
- 模型固定为 `deepseek/deepseek-v4-pro`（opencode）与 DSH 默认 `deepseek-flash`，结论可能随模型行为（是否乖乖只调一次工具）波动。
- `block=150s` 是本次探到的**已验证下界**，不是上限；没有继续往 300s+ 推，因为结论已足以定型协议（见 ADR 0005）。
