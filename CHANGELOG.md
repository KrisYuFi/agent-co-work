# CHANGELOG

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前处于**设计阶段**，版本号用于标记设计与协议的里程碑。

## [Unreleased]

### Planned（阶段 2：最小原型）
- `space serve` / `space attach`：sqlite + localhost + MCP over stdio
- 验收剧本：两个假成员跑通 `create → wait → claim → publish → DONE + handoff`
- 人中途插话打断 `wait`；越权操作被 server 拒绝

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
