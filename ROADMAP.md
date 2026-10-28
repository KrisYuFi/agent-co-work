# ROADMAP

> 分阶段推进，**每阶段有明确通过标准**，不通过不进入下一阶段。
> 当前进度：**阶段 0、1、2 已完成**，阶段 3 待启动。

```
阶段 0 ──✅── 阶段 1 ──✅── 阶段 2 ──✅── 阶段 3 ──▶ 阶段 4 ──▶ 阶段 5+
 设计          技术探针      最小原型      真实环节      全量映射      能力扩展
            (阻塞假设已验) (骨架成立)   (三个硬需求)   (承载现流程)
```

---

## 阶段 0 · 设计与决策 ✅ 已完成

| 项 | 内容 |
|---|---|
| **目标** | 把「从进程内编排改为跨机器协作空间」这件事的语义、边界、取舍定清楚 |
| **交付物** | [background.md](docs/background.md) · [protocol-v0.1.md](docs/design/protocol-v0.1.md) · 4 条 [ADR](docs/decisions/) |
| **通过标准** | 三平面模型、任务状态机、接口形状、5 条服务端不变式、唤醒三档 均有明确结论；被否掉的方案有书面理由 |

---

## 阶段 1 · 技术探针 ✅ 已完成

> **本阶段不写协作空间。** 只验证假设。这是唯一「猜错就要重做架构」的地方，必须最先做。

| 项 | 内容 |
|---|---|
| **目标** | 验证**主唤醒方案（`wait` 长轮询）**在各 runtime 上是否成立 |
| **交付物** | `probe/` 下的可复现脚本 + 一份实测结论表（逐 CLI 填） |

### 要测的三件事

| # | 假设 | 不成立的后果 |
|---|---|---|
| P1 | 目标 CLI 支持 **headless 非交互执行**（`opencode run` / `claude -p` / `codex exec` 等） | 唤醒 D 档（无人值守）不存在 |
| P2 | 目标 CLI 能挂 **MCP over stdio** | 接入层要重选（退化为自建 HTTP + 提示词约定） |
| P3 | **单 turn 内调用阻塞工具不会被硬超时打断** | **B 档不成立 → 架构退回 A 档（纯拉取）+ 人工通知，§6 整体重写** |

### 通过标准

P3 在**至少一个** runtime 上成立 → 可以进入阶段 2，并以该 runtime 为首个支持目标。
若 P3 全部不成立 → 暂停，回来重做 §6 唤醒模型再评估。

### 实测结论（2026-10-28）

| 假设 | opencode 1.18.23 | dsh 0.1.2-rc.1 |
|---|---|---|
| P1 headless | ✅ | ✅ |
| P2 MCP over stdio | ✅ | ✅（多一次 `server/discover` 探测） |
| P3 单 turn 阻塞 150s | ✅ 调高超时后跑满 | ✅ 调高超时后跑满 |
| P3 默认配置 | ❌ 30s 断 | ❌ 60s 断 |
| 进度通知续期 | ✅ 有效 | ❌ 不发 `progressToken` |

**通过**：P3 在两个 runtime 上均成立（标准是「至少一个」）→ 可进阶段 2。
**新增约束**：`wait` 单次时长受**客户端工具调用超时**限制，默认值仅 30s / 60s → [ADR 0005](docs/decisions/0005-wait-bounded-by-client-tool-timeout.md)，协议 §6.2 已同步。

证据与复现：[`probe/RESULTS.md`](probe/RESULTS.md) · [`probe/README.md`](probe/README.md)

### 风险

- 各 CLI 的 headless / MCP 支持差异大且演进快，**以实测为准，不要以文档为准**
- 阻塞工具可能被「工具调用超时」而非「turn 超时」打断，两者要分别测

---

## 阶段 2 · 最小原型 ✅ 已完成

| 项 | 内容 |
|---|---|
| **目标** | 跑通骨架：两个成员 + 一个算子的一条最短链路 |
| **技术选型**（默认） | 单进程 + **sqlite** + localhost + **MCP over stdio** → 落地为 **N 个无状态进程 + 单 sqlite（WAL）**，理由见 [ADR 0006](docs/decisions/0006-node-sqlite-per-member-stdio.md) |
| **交付物** | `src/`：`space init / token / serve / attach / trace / verify`；`test/`：假成员验收 + 真实 runtime 端到端 |

### 验收剧本

```
成员 A: attach → wait
成员 B: attach → task_create(assign → A)
成员 A: 收到 → claim → publish 产物 → transition(DONE + handoff)
成员 B: wait 收到 task.done 事件 → 读 handoff → 继续
人:     中途插话打断 A 的 wait → A 响应 → 恢复 wait
人:     拿另一个 token attach，验证越权操作被拒绝
```

### 通过标准

- 全链路无人手动干预即可推进
- 人插话后 agent 能恢复等待
- 越权操作被 server 拒绝（不是被 prompt 劝阻）
- 事件流可作为调试 trace 使用

### 实测结论（2026-10-28，经独立 review 打回后重测）

| 通过标准 | 证据 | 证据强度 | 结果 |
|---|---|---|---|
| 全链路无人干预推进 | 真实 agent（opencode 当 dev-code + DSH 当 pm）：**同一条任务**的 `created→claimed→WORKING→publish→DONE→handoff` 状态链，产物真实落盘且 sha256/size 与登记一致 | 客观核对（直查 sqlite + 校验文件） | ✅ 9/9 |
| 人插话后恢复等待 | 服务端收到 `notifications/cancelled` 后**中止 handler**（stderr 可证）、旧请求不再响应、恢复后 wait 收到人的消息 | 客观核对 | ✅ |
| 越权被 server 拒绝 | 8 类越权全部由 server 返回错误码：`LEASE_MISMATCH` / `FORBIDDEN_ROLE` / `RESOURCE_BUSY` / `TOKEN_REVOKED` / `NOT_ATTACHED` / `ARTIFACT_MISSING` / `TASK_ALREADY_CLAIMED` / `CONSTRAINT_*` | 客观核对 | ✅ 55 条断言 |
| 事件流可作 trace | `space trace` 覆盖 8 类事件；`space verify` 有**负向测试**（篡改投影必报 drift） | 客观核对 | ✅ |

**历史更正**：这个阶段第一次被评为「已完成」是**错的**。当时 25/25 全绿，但独立 review 做了 19 个变异，**9 个存活**——把 R1、租约回收、`verify`、`wait` 超时、scope 逐个删掉，测试仍然全绿。修复内容见 [ADR 0008](docs/decisions/0008-reclaim-semantics-and-mechanism-integrity.md)，验收标准改成「断言必须有牙」见 [ADR 0009](docs/decisions/0009-verification-must-be-mutation-tested.md)。

修复后的验收规模：**55 条断言**，13 个变异杀死 11 个（存活的 2 个是双重防护）。

未实现、明确留给后续阶段：
- **R4 杠杆评估门**、**R5 修改不越权**（需要现有工作流语义，阶段 4）
- 预算熔断（`BUDGET_EXCEEDED` 仍是预留码）、路径级写 ACL（§2.2，阶段 3 选存储时一起落）
- 多成员竞争消费（`claims_max > 1`，v0.2 **显式拒绝**而非假装支持）
- 资源租约无心跳无回收；消息无 TTL；变异测试未进 CI

### 风险

- 上下文成本会在这里第一次显形（每个新 session 要重读宪法 + handoff + 产物）
- 可能发现接口设计需要调整——**此时改，比阶段 4 改便宜 10 倍**

---

## 阶段 3 · 接入一个真实环节 ⬅ 下一步

| 项 | 内容 |
|---|---|
| **目标** | 用一个**真实环节**替掉现有 subagent 流程中的一段 |
| **推荐场景** | **连 FPGA 的那一步** |
| **理由** | 一次同时验证三个硬需求：跨机器（docker ↔ Win）、人工介入（必须看板子）、资源互斥（只有一个板子） |

### 通过标准

- 该环节能在协作空间里完整跑完一次真实算子开发
- 人能中途接管并把它交回
- `resource_acquire('fpga:0')` 能真正阻止两个成员同时抢板子

### 风险

- Windows 侧 agent 的运行时能力可能弱于 Linux 侧
- 跨机器延迟会不会拖慢人的交互体验

---

## 阶段 4 · 与 ops-direct-invoke 全量映射

| 项 | 内容 |
|---|---|
| **目标** | 承载现有工作流的全部：8 阶段 / 6 个 CP / 三条回退链 / 三个轮次槽位 |
| **交付物** | 映射文档 + 角色 agent 的 peer 化定义 + 宪法（AGENTS.md）v1 |

### 通过标准

- `error-handling.md` 的全部回退规则由 server 不变式保证，无一条依赖 agent 记忆
- 静默模式（`mode=silent`）语义在空间中成立
- 支持中途恢复：杀掉任意成员，任务自动回队并被重新认领

---

## 阶段 5+ · 能力扩展（不在当前承诺内）

| 项 | 说明 | 触发条件 |
|---|---|---|
| **经验分享平面** | 跨算子的长期可检索记忆。与现有两个平面都不同层，须防污染 | 阶段 4 完成后 |
| **A2A 互通** | 在空间外包一层 A2A Server 门面，内部核心不动 | 出现第一个**非自有** agent 要接入 |
| **跨组织身份** | 同事/供应商 agent 的接入与访问控制。优先评估 AGNTCY | 需要突破单组织边界时 |
| **实时协同** | 多人/多 agent 同时看同一产物（CRDT） | 有真实需求再说 |

---

## 未定项清单

这些会在对应阶段决策，不阻塞当前：

| # | 未定项 | 何时定 |
|---|---|---|
| 1 | 交接的**上下文成本**（最小信息集要精确到哪一层） | 阶段 2 实测后 |
| 2 | token 发放 / 吊销的**操作流程** | 阶段 2 前 |
| 3 | 大文件存储后端（NAS / 对象存储 / LFS） | 阶段 3（原型可先用本地目录） |
| 4 | 静默模式在空间中的语义映射 | 阶段 4 |
| 5 | 经验分享平面的设计与防污染机制 | 阶段 5 |
| 6 | 是否支持多空间（一个 server 多个 space） | 有第二场景时 |
