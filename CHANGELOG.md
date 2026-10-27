# CHANGELOG

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前处于**设计阶段**，版本号用于标记设计与协议的里程碑。

## [Unreleased]

### Planned（阶段 3：接入一个真实环节）
- 接 FPGA 那一步：跨机器（docker ↔ Windows）+ 人工介入 + 资源互斥三合一
- 必然引入 HTTP 传输（ADR 0006 的「何时重审」触发）

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
