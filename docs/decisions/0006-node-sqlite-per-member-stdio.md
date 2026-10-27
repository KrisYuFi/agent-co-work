# 0006. 阶段 2 选型：Node 内置 sqlite + 每成员一个 stdio 服务进程

- **状态**：已接受
- **日期**：2026-10-28
- **影响面**：实现栈 / 接入拓扑 / 阶段 3 的传输演进

## 背景

协议 §1.2 画的拓扑是「**单进程 + 单 sqlite**」，接入写「MCP over stdio（本机）/ HTTP（内网）」。落实时撞上一个硬事实：

> **MCP over stdio 是 1:1 连接。** 一条 stdio 只服务一个客户端进程。

而阶段 2 的验收要求**两个成员会话同时挂在同一个空间上**。于是「单进程」与「MCP over stdio」在实现层不能同时成立，必须选一边。三个候选摆在这里：

| 方案 | 形态 | 关键风险 |
|---|---|---|
| A. N 个进程 + 单 sqlite | 每个成员 `space serve` 各起一个进程，共享一个 sqlite 文件（WAL） | 跨进程写入靠 sqlite 事务；`wait` 只能轮询 |
| B. 单进程 + HTTP MCP | 一个 hub 进程监听 localhost，成员用 remote MCP 接入 | **remote MCP 未实测**；opencode 的 remote 接法可能牵出 OAuth 回调，DSH 只支持 streamable-http |
| C. 单进程 hub + 每成员 stdio 桥 | 成员侧薄桥接（stdio↔HTTP），hub 单写者 | 进程数 N+1，两层传输，阶段 2 就要维护两套代码路径 |

阶段 1 实测的是 **stdio**（两个 runtime 都通过），remote MCP **一次都没测过**。按「探针先于实现」的约定，不能把阶段 2 的骨架压在一个未验证的传输上。

## 决策

1. **运行时**：Node ≥ 22（本机 26.1.0），**零外部依赖**。
2. **存储**：内置 `node:sqlite`（`DatabaseSync`），WAL + `busy_timeout`，写操作一律 `BEGIN IMMEDIATE` 事务。
3. **拓扑：方案 A** —— 一个 space 目录 = 一个 sqlite；**每个成员一个 `space serve` 进程**，进程无状态（除 sqlite），随会话生灭。
4. **`wait` 实现为库级轮询**（250ms 粒度），单次调用 ≤ `max_block_sec`（默认 20s，见 [ADR 0005](0005-wait-bounded-by-client-tool-timeout.md)）。返回时顺带续租。
5. **MCP 传输自建**（NDJSON over stdio），不引 SDK：阶段 1 的探针服务器就是这个形态，两个 runtime 都已实测通过。
6. **HTTP 传输推迟到阶段 3**，与跨机器需求一起决策（同核心，只换传输层）。

**对协议 §1.2 的偏离**：「单进程 + 单 sqlite」改为「**N 个无状态进程 + 单 sqlite**」。协议正文已同步注明。

## 后果

**正面**

- 阶段 2 的骨架完全建立在**已实测**的传输上，没有未验证假设
- 零外部依赖 → 内网部署不需要私有 registry，`node src/cli.mjs` 即可跑
- 进程无状态，成员会话崩溃/重启不需要清理服务端资源；「agent 离线是常态」在实现层自然成立
- sqlite 事务把认领互斥、资源互斥、租约回收全变成单库事务——正是 ADR 0001 预判的收益
- 阶段 3 加 HTTP 时，业务层（service/invariants/events）完全不动

**负面 / 代价**

- **`wait` 变成 250ms 轮询**：不是「挂住连接」而是「反复问」。单成员 CPU 可忽略，但 N 个成员 × 25 次/分钟 的库查询，规模上去后要重新评估
- **事件推送有最多 250ms 延迟**（原型可接受，交互式场景感知不到）
- **N 个进程共享一个 sqlite 文件** → 必须同机同盘。跨机器（阶段 3 的 docker ↔ Windows）**直接失效**，那时必须上 HTTP
- 单写者不变式从「一个进程」退化为「一个库 + 一组事务」。正确性仍由事务保证，但**审计与 trace 的时序**要依赖 `events` 表自增 id，不能依赖内存顺序
- 每次 attach 会被 DSH 拉起两次（`server/discover` 探测失败后重启，见 [`probe/RESULTS.md`](../../probe/RESULTS.md)）→ 要求 `space serve` 启动**无副作用**（本实现满足：一切副作用都在 `space_attach` 工具调用里）

## 备选方案

| 方案 | 放弃理由 |
|---|---|
| B：单进程 HTTP MCP | remote MCP 未实测，且 opencode 的 remote 走 OAuth 客户端注册流程，DSH 的 streamable-http 也是全新代码路径。**把唯一的骨架压在没测过的传输上，违背「探针先于实现」** |
| C：hub + 桥 | 阶段 2 就要维护 stdio + HTTP 两套传输，进程数最多，收益（单写者）与 A 的差距在 sqlite 事务面前不明显 |
| 用 sqlite 之外的嵌入式库（LMDB/LevelDB） | 需要外部依赖；sqlite 的事务 + 单文件 + 可人工查看（`sqlite3` CLI）对本项目更重要 |
| 用内存 + JSON 落盘 | 多进程下没有事务，认领互斥无法保证 |

## 何时重审

出现以下任一情况，本 ADR 作废：

- 阶段 3 需要跨机器接入（**必然触发**）→ 新增 ADR 引入 HTTP 传输，核心不变
- `wait` 轮询在 N ≥ 8 成员时出现可观测的库争用
