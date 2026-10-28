# CHANGELOG

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前处于**设计阶段**，版本号用于标记设计与协议的里程碑。

## [0.4.1] - 2026-10-28

**PM 换成真实会话：三个真实 agent 并发跑完设计段，10/10。**

### Changed

- `examples/ops-direct-invoke/roles/pm.md` — PM 角色定义（流程表 + 派活/等活/判定/打回/回数上限）
- `examples/ops-direct-invoke/run-design.mjs` — PM 不再由脚本代劳，改为真实会话；脚本只负责搭空间、启进程、扮演人、验收
- `space_task_accept` 的 verdict 落到任务行（`reason`），`task_list` 支持按 `step` 过滤 —— 编排方不必去翻事件流

### Fixed

- **`verdict=pass` 不能带阻断级 gap**：实跑里 QA 判 pass 却写下「需求基线与文档冲突」，
  靠 PM 读 gaps 才补救。现由 server 拒绝（`blocking:true` / `severity:'blocker'`），并加回归断言

### 实跑结果（pm=dsh, architect=dsh, qa=opencode，human=脚本）

- 14 个任务全 DONE，10 份交付件约 200KB，87 条事件，`space verify` 通过
- CP1 两轮打回（QA 判 gap 一次、human reject 一次），`slots.design.round = 2`
- PM 自主加了一步 `0.0-requirement-question` 找人对需求基线；CP2.1 hold 后自行打回 2.1
- 事故：architect 首版把 add 写成 Softmax，QA 判 pass 但 gap 里点了问题，PM 据此纠重 —— 见 README

---

## [0.4.0] - 2026-10-28

**第一次用真实 agent 跑通 ops-direct-invoke 的「需求 → 设计 → 设计 review」段。**

### Added

- **`examples/ops-direct-invoke/`** — 把 cannbot-skills 的 `ops-direct-invoke` 映射进空间：
  - `roles/`：architect / qa / human 三个角色的空间版职责（承接原 agent 定义，补上空间协议）
  - `run-design.mjs`：1.1 → CP1 → 2.1 → CP2.1 → 2.2 → CP2.2，含一次 CP1 打回与修订
  - `README.md`：映射表、边界、第一次实跑结果与四个问题

### 实跑结果

`architect=dsh` + `qa=opencode` 两个真实会话并发，PM 与 human 由脚本驱动：

- 68 条事件 / 11 个任务 / **8 份真实交付件**（需求 34.9KB + 修订版 45.8KB、测试方案 24.7KB、开发方案 27.5KB、4 份验收报告）
- CP1 被人工打回 → `revision` 任务 → architect 按意见修订 → CP1 复核通过
- `slots.design.round = 1`：跨环节回退计入 design 槽
- `space verify` 通过（投影 == 事件归约）

### Fixed

- `space_verify` 的假阳性：人答问卷（`question` 类任务）的 DONE 不再被要求 handoff（只对产出交付件的任务必填）

### Notes（这次跑出来的问题，都还没修）

- opencode 的 `permission.external_directory` 会挡住跨目录读产物 → 非交互模式下 auto-reject，任务卡在 WORKING
- 编排方（PM 脚本）没有尊重 QA 的 `hold` 判定就继续往下走 —— 机制记下了 verdict，编排逻辑忽略了它
- headless agent 有空闲轮次预算，PM 下发慢就会自己收工
- 仍是同机共享 sqlite；中心化 hub + HTTP 未做

---

## [Unreleased]

### Planned（阶段 3：接入一个真实环节）
- 接 FPGA 那一步：跨机器（docker ↔ Windows）+ 人工介入 + 资源互斥三合一
- 必然引入 HTTP 传输（ADR 0006 的「何时重审」触发）

---

## [0.3.1] - 2026-10-28

**修正一次假绿灯：阶段 2 曾被错误标为「已完成」。**

四个独立 subagent（不变式 / 协议一致性 / 安全并发 / 测试有效性）在互不共享上下文的情况下审计，
结论一致：*机制的外壳是真的，不变式的内部是空的*。核心证据是变异测试——把 19 处实现逐个改坏，
**9 处仍 25/25 全绿**；把「人插话」这一步整个删掉，测试照样通过。

### Fixed（两个 100% 命中的 P0）

- **回收死锁**：`claims_count` 作为终身计数从不回退 → 一次租约过期或一次吊销，任务就停在 `PENDING` 但谁都认领不了；`attempts` 不再增长，`FAILED` 升级永不到达。改为「当前活跃认领数」（回 `PENDING` 归零），重试预算只由 `attempts` 承担
- **回收破坏 R1**：`sweepExpired` 的 `select` 在事务外、`UPDATE` 无守卫 → 能把刚提交的 `DONE` 复活成 `PENDING`，也能覆盖别人刚认领的租约。改为事务内判决 + `state/lease_until` 守卫 + SQL 自增
- **R2 是参数不是机制**：`slot`/`op`/`type` 全由客户端给，改个字符串就重置轮次。改为客户端只报 `cp`、server 查表定 `slot`、`op` 取自 `refs[0]` 的原任务、只能对自己可见的任务开 revision
- **R3 是自报**：`payload.relax_hard_gate === true` 由被约束方自己填。删除该通道，改为 `space_task_accept`（只有 human 能 relax，且三类证据缺一即拒）
- **吊销后任务仍卡死**：回收时同步改派给该成员的角色；token 过期走同一路径；新增 `space token unrevoke`

### Fixed（安全与并发）

- `task_heartbeat` 无事务无谓词 → 能把别人刚拿到的 300s 租约砍成 2s。改为事务内 + `owner/lease_id` 谓词
- `lease_sec` / `max_block_sec` 无上限（`1e9` 让任务 31 年不可回收；`NaN` 让 `wait` 永不返回）→ 收口到 3600 / 300 且拒绝非有限数
- 消息 `to` + `topic` 并存 = 私聊全员可见；`text` 无上限（一次 `wait` 返回 200MB）→ 二选一 + 1000 字符上限
- 未 `attach` 就能使用其它工具（宪法版本门形同不存在）→ `NOT_ATTACHED`
- 读侧无可见性、scope 只覆盖 4 个工具 → 可见性过滤 + `TOOL_SCOPES` 表化
- `SPACE_TOKEN` 静默覆盖 `--token-file`（身份混淆）→ 显式参数优先并告警
- 未知工具返回 `TASK_NOT_FOUND`（误导排障）→ `UNKNOWN_TOOL`

### Changed

- **协议**：§2.2 标注路径级 ACL 未实现；§2.3 attach 成为硬前置；§4.2 补中断态出边与回收语义、标注 `REJECTED`/`EXPIRED` 缺口；§5 R2/R3 改为服务端确定归属、R4/R5 标注未实现；**§7 按实现重写接口表（16 个工具）**；§11 补 4 个真实错误码；§12 说明 claims 语义
- **验收**：`test/acceptance.mjs` 从 25 条重写为 **55 条**，每条都能说清「哪个缺陷会让它变红」；关键结论直查 sqlite；新增对账器负向测试、租约回收后可再认领、未 attach 被拒、scope 生效、`max_block_sec` 生效等回归
- **e2e**：用 `attach` 返回的游标（不再 `since_cursor:0`）、产物真实落盘并校验 sha256/size、断言同一任务的状态链；agent 自述降级为旁证
- **ROADMAP**：阶段 2 的通过标准改为逐条标注**证据强度**，并记下这次误判
- **ADR**：[0008](docs/decisions/0008-reclaim-semantics-and-mechanism-integrity.md) 回收语义与机制完整性；[0009](docs/decisions/0009-verification-must-be-mutation-tested.md) 验收必须做变异测试

### 验收

| 项 | 证据 | 结果 |
|---|---|---|
| 假成员验收 | 55 条断言（含 12 条安全回归） | 55/55 |
| 真实 runtime e2e | opencode(dev-code) + DSH(pm)，同任务状态链 + 产物 sha 校验 | 9/9 |
| 变异测试 | 13 个变异 | 11 个被杀死（存活 2 个是双重防护） |

### Notes

- **仍未实现**：R4/R5、预算熔断、路径级写 ACL、`claims_max > 1`（显式拒绝）、资源租约心跳与回收、消息 TTL、变异测试进 CI
- 这轮的教训写进了 AGENTS.md 的提交前自检：涉及不变式的改动，必须说清哪个断言会变红

---

## [0.3.0] - 2026-10-28

**阶段 2 完成：最小原型跑通。真实 agent（opencode + DSH）端到端 8/8，假成员验收 25/25。**

### Added

- **`src/` 最小原型**（零外部依赖，Node 内置 `node:sqlite`）
  - `src/cli.mjs` — `space init / token issue|list|revoke / serve / attach / trace / verify / tasks / members`
  - `src/space/db.mjs` — sqlite schema + `BEGIN IMMEDIATE` 事务封装（WAL）
  - `src/space/events.mjs` — append-only 事件流、状态归约、`verifyProjection` 可重放对账
  - `src/space/invariants.mjs` — 迁移表、R1 终态不可变、handoff 必填、认领互斥、R2 轮次槽位、R3 硬门槛归人
  - `src/space/tokens.mjs` — 签发/校验/吊销（库内只存 sha256 + prefix），吊销即回收名下任务
  - `src/space/service.mjs` — attach / wait / task_* / publish / msg / state_get / resource_*
  - `src/space/mcp.mjs` — MCP over stdio（自建 NDJSON 传输，15 个 `space_*` 工具）
- **`test/`** — `acceptance.mjs`（4 个假成员，25 项）、`e2e-real.mjs`（真实 opencode + DSH 会话，8 项）、`README.md`
- **ADR 0006** — 阶段 2 选型：Node 内置 sqlite + 每成员一个 stdio 服务进程（N 进程共享单库）
- **ADR 0007** — token 由 CLI 签发、库内只存哈希、吊销即时回收任务（结案协议未定项 #3）

### Changed

- **协议 §1.2** — 注明实现偏离（「单进程 + 单 sqlite」→「N 个无状态进程 + 单 sqlite」，ADR 0006）
- **协议 §3.2** — 事件类型补 `message.sent` / `task.requeued` / `token.revoked`
- **协议 §7** — `space_attach` 增加 `cursor` 与 `constitution_version` 入参；`space_wait` 语义见 ADR 0005
- **协议 §12** — 存储从草案改为已实现 schema，并说明「投影 + 事件归约对账」的实现形态
- **ROADMAP** — 阶段 2 标记完成，附通过标准逐条证据；阶段 3 成为下一步

### 验收结果

| 项 | 证据 | 结果 |
|---|---|---|
| 全链路无人干预 | 真实 agent：opencode(dev-code) + DSH(pm) | ✅ 8/8 |
| 越权被 server 拒绝 | `LEASE_MISMATCH`/`FORBIDDEN_ROLE`/`RESOURCE_BUSY`/`TOKEN_REVOKED` | ✅ |
| 人插话后恢复 wait | 假成员验收：放弃挂起的 wait → 收消息 → 恢复 | ✅ |
| 事件流可作 trace | `space trace` + `space verify` | ✅ |

### Notes

- 明确**未实现**：R4 杠杆评估门、R5 修改不越权、预算熔断（等阶段 4 与现有工作流对齐）
- E2E 的提示词把协议步骤写死在步骤里；阶段 4 要下沉到宪法 + server 校验，提示词只留判断口径

---

## [0.2.0] - 2026-10-28

**阶段 1 完成：技术探针通过，B 档（`wait` 长轮询）确认成立。**

### Added

- **`probe/`** — 可复现的技术探针（不实现空间，只验证假设）
  - `mcp/server.mjs` — **零依赖** stdio MCP 服务器，工具 `probe_ping` / `probe_block` / `probe_block_progress`，把每次调用起止写进 JSONL 日志
  - `mcp/smoke-client.mjs` — 本地自检客户端，先证明服务器本身正确，避免把 runtime 问题误判为协议问题
  - `run.mjs` — `(scenario, runtime)` 运行器：生成临时配置（不碰全局配置）、计时、读回服务器日志、落 `results/raw/*.json`
  - `README.md` / `RESULTS.md` — 复现方式与逐 runtime 结论表
- **`docs/decisions/0005`** — `wait` 单次阻塞时长默认 20s，上限由客户端 `max_block_sec` 声明并由 server clamp

### Changed

- **协议 §6.2/§7/§13** — `space_wait` 增加 `timeout_sec` 默认 20s、`effective_timeout_sec` 回显、`reason: "timeout"` 语义；`space_attach` 的 `capabilities[]` 增加 `max_block_sec`；§13 未定项 5、6 结案
- **`ROADMAP.md`** — 阶段 1 标记完成并附实测结论，阶段 2 成为下一步
- **ADR 0004** — 状态由「待验证」改为「已验证成立」，残留约束指向 ADR 0005

### 实测结论

| 假设 | opencode 1.18.23 | dsh 0.1.2-rc.1 |
|---|---|---|
| P1 headless 非交互 | ✅ | ✅ |
| P2 MCP over stdio | ✅ | ✅ |
| P3 单 turn 内阻塞 150s | ✅（需调高客户端超时） | ✅（需调高客户端超时） |
| P3 默认配置下 | ❌ 30s 处断 | ❌ 60s 处断 |
| 进度通知续期 | ✅ 有效 | ❌ 不发 `progressToken` |

- 打断来源是**工具调用超时**，不是 turn 超时：内置 `sleep 150` 两边都完整跑完。
- DSH 的 MCP 桥在标准 `initialize` 前先发 `server/discover`，失败后**重启进程**再走标准握手 → 空间服务端需实现该死方法，或接受 attach 时被拉起两次。

### Notes

- `claude -p` / `codex exec` 本机未安装，**未实测**；新接入 runtime 必须重跑 P3 两项，不得外推本表数值。

---

## [0.1.0] - 2026-10-28

**仓库初始化：完成设计阶段，无代码。**

### Added

- **`docs/background.md`** — 问题现场：真实环境（内网 / docker / Windows + FPGA）、现有 subagent 方案的失效点、7 条需求、5 条硬约束、**6 个被否掉的方案及理由**
- **`docs/design/protocol-v0.1.md`** — 协议草案
  - 三平面模型（控制面 / 状态面 / 数据面）+ 铁律「消息只传引用」
  - 成员类型与身份模型（`role` / `human` / `supervisor`）
  - 事件流 → server 归约的状态计算（单写者）
  - 12 状态任务机（借用 A2A 词汇，补 `EXPIRED` / `REVISION_REQUESTED`）
  - **5 条服务端不变式**（终态不可变、跨环节不清零轮次、硬门槛不得自行放宽、杠杆评估门、修改不越权）
  - 唤醒三档（`wait` 主 / headless 可选 / 纯拉取兜底）
  - 14 个 `space_*` 接口定义 + 6 种任务类型
  - 资源互斥与预算熔断、14 个错误码、sqlite schema 草案
- **`docs/decisions/`** — 4 条 ADR
  - 0001 用中心服务做协作总线，而非共享文件系统
  - 0002 消息/状态/产物三分平面；状态由事件归约
  - 0003 借用 A2A 的词汇与数据模型，不实现其协议
  - 0004 唤醒以 `wait` 长轮询为主路径（待验证）
- **`ROADMAP.md`** — 阶段 0～5 的计划与通过标准，含「唯一猜错就要重做」的风险点标注
- **`AGENTS.md`** — 本仓开发约定（文档先行 / 决策必记 ADR / 机制优于自然语言 / 探针先于实现 / 借鉴不绑定）

### Notes

- 关键待验证假设：**agent 能否在自己的一个 turn 内调用阻塞工具等待任务**。若某个 runtime 的 turn 有硬超时会打断阻塞调用，主唤醒方案失效，协议 §6 需整体重写。这是阶段 1 存在的唯一原因。
- 前置调研结论：A2A v1.0 是**点对点**协议，房间/成员/ACL/广播/共享黑板**均未定义**，不能直接用作协作空间。详见 ADR 0003。
