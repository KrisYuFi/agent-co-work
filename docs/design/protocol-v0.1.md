# 协议草案 v0.1

> 状态：**草案（未实现）**。本文只定语义与接口形状，不含实现代码。
> 背景与动机见 [background.md](../background.md)；关键决策的取舍理由见 [decisions/](../decisions/)。
> 定位：把 agent 编排从「进程内主 agent 同步调用 subagent」改为「多个独立 session 经中心协作空间异步协作」。
> 目的：让每个角色 agent 成为**可人工干预、可跨机器、可重启恢复**的独立会话。

## 变更记录

| 日期 | 来源 | 改动 |
|---|---|---|
| 2026-10-28 | 阶段 1 技术探针（[`probe/RESULTS.md`](../../probe/RESULTS.md) · [ADR 0005](../decisions/0005-wait-bounded-by-client-tool-timeout.md)） | §6.2 补 `wait` 时长受客户端工具调用超时约束（默认 20s、`max_block_sec` clamp、超时为正常返回、进度通知仅作优化）；§6.3 待实测项结案；§7 `space_attach`/`space_wait` 参数与返回值；§13 未定项 5/6 结案 |

> **版本策略**：仍有「草案（未实现）」阶段、无外部消费者时，修订**合并进本文**并记入上表；一旦阶段 2 产生实现或外部接入方，语义变更改为新建 `protocol-v0.2.md`、旧版标「已被取代」并保留。

---

## 0. 动机与边界

### 要解决的问题

| 现状 | 痛点 |
|---|---|
| PM 主 agent 同步调用 subagent | 子 agent 是进程内暗盒，**人无法中途干预**，不好调试 |
| 编码在 docker、硬件在另一台 Win + FPGA | 跨机器无法用同一进程编排 |
| 回退靠「复用原子会话」 | 会话一丢，返工上下文断链 |

### 明确不做的事

- **不追求跨组织互通**：v0 只服务自有 agent。与第三方 agent 互通是后续能力（见 §10）。
- **不用文件系统做通信介质**：文件只存产物与长期记录。
- **不取代 subagent**：peer/subagent 是两个正交维度，见 §1.3。

---

## 1. 总体模型

### 1.1 三个平面（核心结论）

文件数量爆炸的根因是「把瞬时信号也做成了文件」。所以严格分三层：

| 平面 | 内容 | 寿命 | 载体 | 落盘？ |
|---|---|---|---|---|
| **控制面** | 任务、认领、租约、即时消息、presence | 秒～小时 | 中心服务内存 + 关系表 | 队列状态落库；纯信号不归档 |
| **状态面** | 谁做到哪一步（`state`） | 长期，只要最新值 | 中心服务（**唯一写者**） | 落库，覆盖式 |
| **数据面** | 产物、大文件、handoff、报告 | 长期，要版本 | 文件系统 / git / NAS | 落盘 |

**跨平面的唯一铁律**：

> **消息里只传引用（URI + sha256 + size），不传 payload。**

### 1.2 拓扑

```
┌─ 各成员机器（实际工作仍在本地完成）──────────────┐
│  docker/Linux : dev-code, dev-test, dev-doc      │
│  Windows      : dev-hw（唯一连 FPGA 的成员）      │
│  你的本机      : human-*, pm                     │
└──────────────┬───────────────────────────────────┘
               │ MCP over stdio（本机）/ HTTP（内网）
               │ + 身份 token
┌──────────────▼───────────────────────────────────┐
│  space server（单进程 + 单 sqlite）               │
│  ├ 成员与鉴权                                     │
│  ├ 控制面：任务队列 / 认领 / 租约 / 消息 / presence│
│  ├ 状态面：events(append-only) → 归约 → state     │
│  ├ 数据面：制品索引（只存引用）                    │
│  └ 不变式：轮次上限、资源互斥、预算熔断            │
└──────────────┬───────────────────────────────────┘
               │ 引用
┌──────────────▼───────────────────────────────────┐
│  制品仓库：git（文本/代码）+ NAS/对象存储（大文件） │
└──────────────────────────────────────────────────┘
```

**单机与团队是同一套**：`--listen 127.0.0.1` 与 `--listen 0.0.0.0` 只是监听地址差异。

### 1.3 拓扑层级与调用粒度正交

- **peer 边界**（走空间）：需要人工干预 / 跨机器 / 长耗时 / 可并行 的环节。
- **subagent 调用**（本地 fan-out）：短链路、强耦合、不需人插手的子任务拆分。

**约束**：subagent 的中间活动不必上报，但其**对外交付物必须由父 peer 发布**。
否则人看不到产物，可观测性失效——而这正是本次改造的初衷。

由此推得：消息量由 peer 边界数量决定，**不由 agent 内部步骤数决定**。

---

## 2. 成员与身份

### 2.1 成员类型

| 类型 | 说明 | 可做的事 |
|---|---|---|
| `role` | 执行角色（architect / dev-code / dev-test / dev-doc / qa / pm） | 认领任务、发布产物、发消息 |
| `human` | 人（也是成员，**同一套协议，无特权旁路**） | 以上全部 + 作废租约、回答问卷、接受收口 |
| `supervisor` | 可信任的自动化（仅限显式授权） | + 触发 headless spawn（见 §6.3） |

**人不是特权旁路**：人的介入也走 task / answer / handoff，否则状态会分叉。

### 2.2 身份与授权

- `attach` 必须携带 token；token 由空间管理员（人）发放，绑定 `member_id` + `role` + `scopes[]` + 有效期。
- 支持吊销；吊销后已发出的 task 自动回 `PENDING`。
- **权威边界在 server**：不在共享目录里放"权限配置文件"——那只能防误操作，不能防越权。
- 写权限模型（继承 `ops-direct-invoke` 的类别语义，加一维 owner）：

| 维度 | 取值 |
|---|---|
| 目录类别 | `intermediate` / `test` / `doc` / `code`（沿用现有判定） |
| 扩展名 | `"*"` 或后缀数组 |
| **独占区** | 每个成员只能写 `inbox/<自己的 id>/` 与自己名下任务的产物路径 |

### 2.3 空间宪法（AGENTS.md）

- 空间根有 `AGENTS.md`，**带版本号**（如 `constitution: 3`）。
- `attach` 时成员上报自己遵守的版本；server 拒绝过旧版本（`CONSTITUTION_OUTDATED`）。
- 目的：消灭「六个 agent 各自读着三个不同版本的规范在干活」的协议漂移。

**宪法只留机制管不了的东西**：判断口径、证据标准、决策归属（谁能拍板）、何时必须找人。
凡是能变成接口约束的条款，一律下沉为机制（判据见 §9）。

---

## 3. 事件流与状态归约

### 3.1 铁律：agent 不写状态，只发事件

```
agent ──append──▶ events（append-only，只增不改，不可删）
                       │
                 server 归约（唯一写者）
                       ▼
              state（覆盖式，只存最新值）
```

- **单写者**：只有 server 能算 state，并发覆盖问题从根上消失。
- **trace 免费**：事件流就是调试记录——直接解决「子 agent 不好调试」的原始痛点。
- **可重放**：state 算错时重放事件即可重算。

### 3.2 事件类型（v0 最小集）

| event | 关键字段 |
|---|---|
| `member.attached` / `member.detached` | `member_id`, `capabilities[]` |
| `task.created` | `task_id`, `type`, `to`/`role`, `op`, `inputs[]`, `expected`, `refs[]` |
| `task.claimed` | `task_id`, `member_id`, `lease_id`, `lease_until` |
| `task.transitioned` | `task_id`, `from`, `to`, `reason` |
| `task.expired` | `task_id`, `attempts` |
| `artifact.published` | `uri`, `sha256`, `size`, `media_type`, `by` |
| `handoff.written` | `task_id`, `uri`, `sha256` |
| `cp.judged` | `op`, `cp`, `verdict`, `slot`, `round` |
| `loop.exhausted` | `slot`, `round`, `evidence[]` |
| `resource.acquired` / `released` | `name`, `lease_id` |
| `budget.consumed` | `member_id`, `op`, `tokens`, `cost` |

---

## 4. 任务状态机

### 4.1 状态枚举（借用 A2A v1.0 词汇）

A2A 的 `TaskState` 分三类，我们照抄分类，并补两个它没有的状态：

| 我们的状态 | A2A 对应 | 类别 | 说明 |
|---|---|---|---|
| `PENDING` | `SUBMITTED` | 活跃 | 已创建，等认领 |
| `CLAIMED` | — | 活跃 | 已认领，持租约 |
| `WORKING` | `WORKING` | 活跃 | 执行中 |
| `WAITING_INPUT` | **`INPUT_REQUIRED`** | **中断（可恢复）** | **等人/上游给信息 ← 即 ⛔ CP 确认点** |
| `WAITING_AUTH` | `AUTH_REQUIRED` | 中断 | 等授权 |
| `BLOCKED` | — | 中断 | 资源被占（如 FPGA） |
| `DONE` | `COMPLETED` | 终态 | 完成，含 handoff |
| `FAILED` | `FAILED` | 终态 | 失败 |
| `REJECTED` | `REJECTED` | 终态 | 明确拒绝承接 |
| `CANCELED` | `CANCELED` | 终态 | 取消 |
| `EXPIRED` | **（A2A 无）** | 活跃 | **租约过期 → 回 `PENDING`，`attempts+1`** |
| `REVISION_REQUESTED` | **（A2A 无）** | 活跃 | 验收不通过 → 生成 revision 子任务 |

**为什么 A2A 没有 `EXPIRED`**：它同步请求-响应，连接在即人活着；我们是**异步队列 + 会崩的 session**，必须靠租约回收。**不要为对齐标准而删掉租约。**

### 4.2 迁移表

| from → to | 触发者 | 附加约束 |
|---|---|---|
| `PENDING → CLAIMED` | 任意匹配成员 | 原子；`claims` 已满则拒绝（竞争消费） |
| `CLAIMED → WORKING` | 租约持有者 | — |
| `WORKING → WAITING_INPUT` | 租约持有者 | 必须发 `question` 给指定成员 |
| `WORKING → BLOCKED` | 租约持有者 | 必须先试 `resource.acquire` |
| `WORKING → DONE` | 租约持有者 | **必须同时提交 handoff 引用**，否则拒绝 |
| `WORKING → FAILED` | 租约持有者 | 必须附 `reason` 与可复现证据 |
| `WORKING → REVISION_REQUESTED` | **QA（非本人）** | 见 §5 |
| `CLAIMED/WORKING → EXPIRED` | **server**（超时） | attempts+1；超上限转 `FAILED` |
| 终态 → 任何 | **禁止** | Task Immutability（借用 A2A 原则） |

**R1 终态不可变**：任务一旦终态即事实，不可重开。要改就**新建 revision 任务并 `refs` 引用原 task_id**。
→ 这同时替掉了现有「回退复用原会话」的脆弱设计：返工上下文靠 handoff 落盘，会话丢了也不断链。

---

## 5. 验收与轮次不变式（服务端强制）

现有 `error-handling.md` 的三条规则藏在文档里，靠 agent 记住**不可靠**。全部下沉为 server 端不变式。

### 5.1 轮次槽位

| slot | 覆盖环节 | 上限 |
|---|---|---|
| `design` | CP1 / CP2.1 / CP2.2（CP2.2 的 QA 打回与用户异议共用） | 3 |
| `joint_debug` | 3.4 → 3.1 / 3.2 | 3 |
| `acceptance` | CP3 / CP4 / CP5 → 3.1（CP3 归属测试方案时 → 2.1） | 3 |

### 5.2 R2 跨环节回退不清零发起方槽位

> 这是一条**容易忘、忘了就失去循环边界**的规则，必须由 server 保证。

```
revision 任务创建时按语义归属确定 slot：
  CP1 不通过            → slot=design
  CP2.1 不通过          → slot=design
  CP2.2 不通过/用户异议 → slot=design（归属需求则回 1.1，但 slot 仍是 design）
  CP3 不通过（实现侧）  → slot=acceptance
  CP3 不通过（测试方案）→ slot=acceptance   ← 回退目标是 2.1，但槽位不换
  CP4 / CP5 不通过      → slot=acceptance
  3.4 不通过            → slot=joint_debug

slot.round += 1
if slot.round > limit: → LOOP_EXHAUSTED（拒绝创建，落盘证据，暂停待人工决策）
```

### 5.3 R3 硬门槛不得由验收方自行放宽

需求级硬门槛（性能目标、精度标准）只能由 `human` 决策放宽：

- 验收方（QA）可给出「建议按已知限制收口」+ 完整依据，**无权自行放行**。
- 收口依据必须含：量化差距、实现级优化穷尽证据（已落地 + 负结果）、设计方向与实测矛盾的证据。
- 依据不全 → server 拒绝 `accept`，按阻断处理。
- 静默模式下的收口标记 `pending_user_review`，**是待复核决策，不是定案**。

### 5.4 R4 杠杆评估门（性能未达标前置）

性能未达标时，回退前先判「是否还有与实测瓶颈匹配、且未被证伪的实质杠杆」：

| 结论 | 处理 |
|---|---|
| 有实质杠杆 | 按归属回退，计入 `acceptance` 轮次 |
| 无实质杠杆 | **不回退、不计轮次**，转 §5.3 需求级决策 |

目的：截断「明知无收益仍重走整条复验链」的空转——轮次上限只能限次数，限不了单轮浪费。

### 5.5 R5 修改不越权

执行角色可定位、给根因证据，但**不得自行变更上游设计决策**（架构/Tiling/切分/接口）。
代码架构是用户在 CP1 拍板的，architect 亦不得自行改选，须回退 1.1 由人重新拍板。

---

## 6. 唤醒模型（三档并存，共用一套接口）

### 6.1 为什么不能「唤起交互式会话」

交互式 CLI 的 turn 由输入事件驱动：没人打字就没有 turn。强行注入（stdin / tmux send-keys）跨 runtime 不通用且脆弱，**不作为机制**。

正确提法是：**「它在线时，怎么让它知道自己该干活」**。

### 6.2 B 档（主路径）：`wait` 长轮询 + 人开的 session 天然在线

```
1. attach(token)            → 身份 + 未读任务（离线期间攒的）
2. loop:
     wait(since, timeout)    → 有活立刻返回；无活超时返回
     有活 → claim → 干活 → publish → transition(DONE + handoff) → 继续 wait
     无活 → 续租心跳 → 继续 wait
```

要点：

- `wait` 在 server 端是**挂住连接**（非轮询风暴）。
- `wait` 返回时**顺带续 lease + 心跳**，一次调用做三件事，不会漏续租。
- **单次 `wait` 的时长受客户端工具调用超时约束**：实测默认值仅为 opencode 30s / DSH 60s，超时即断（[ADR 0005](../decisions/0005-wait-bounded-by-client-tool-timeout.md)）。因此 `timeout_sec` **默认 20s**；客户端在 `capabilities.max_block_sec` 自报上限，**server 把 `timeout_sec` clamp 到该值**并在返回值回显 `effective_timeout_sec`。未声明按 20s。
- **超时返回是正常返回**（`reason: "timeout"`），不是错误，agent 必须继续循环。协议层不允许把超时当失败——否则 agent 会「礼貌地」放弃等待。
- **进度通知只作优化**：server 可在 `wait` 期间发 `notifications/progress`（opencode 据此续期超时，实测有效），但 DSH 连 `progressToken` 都不发，**不得把续期当通用机制**。
- **人打字即打断**：人在会话里说一句话就是新 turn，挂着的 wait 作废（无害）。这就是「随时介入」，且**不需要任何额外机制**——交互式 session 天然可打断。
- 断线重连 = 再 `attach`，server 补投未确认任务。

**核心认识**：「能等人介入」与「能挂着等活」是同一件事的两面——都是「这个 session 一直活着」。

### 6.3 D 档（可选）：server 触发 headless 执行

```
server 派活给 dev-hw
├─ 在线（有挂着的 wait）→ 走 B 通道，毫秒级
└─ 离线 → supervisor 触发：
        opencode run --prompt "..." / claude -p "..." / codex exec "..."
     进程跑完退出，产物已在空间里
```

- **B 与 D 走同一套协议**，server 不关心 agent 是人开的还是自己起的。
  → 这一条决定「人工调试」与「夜间无人值守」不需要两套实现。
- D 档要求 `supervisor` scope，并受 `max_concurrent` + **预算上限**约束。
- **已实测**（阶段 1，见 [`probe/RESULTS.md`](../../probe/RESULTS.md)）：两个 runtime 的 headless 与 MCP stdio 均成立，**单 turn 内阻塞 150s 不被打断**（工具调用超时可配）。
  → 残留约束是**客户端超时需显式配置**，见 ADR 0005；`server/discover` 兼容性代价见同文。

### 6.4 A 档（兜底）：纯拉取

无 `wait` 能力时的降级：启动读 inbox，之后不主动。配合 IM 通知人「有活，去开 session」。

**三档共用 §7 同一套接口。**

---

## 7. 接口（MCP tools）

命名以 `space_` 前缀。本地走 MCP over **stdio**；远程走 MCP over **HTTP**（带 token）。选 MCP 的理由：跨 runtime 兼容性远好于 hook（部分 CLI 无 hook）。

| tool | 入参（要点） | 返回 |
|---|---|---|
| `space_attach` | `token`, `capabilities[]`（含 `max_block_sec`） | `{member, unread_tasks[], constitution_version}` |
| `space_detach` | — | `{ok}` |
| `space_wait` | `since_cursor`, `timeout_sec`（默认 20；server clamp 到 `max_block_sec`） | `{events[], tasks[], cursor, reason, effective_timeout_sec}`（阻塞；顺带续租） |
| `space_task_create` | `type`, `to` \| `role`, `op`, `step`, `inputs[]`, `expected`, `refs[]`, `priority`, `claims` | `{task_id}` |
| `space_task_claim` | `task_id`, `lease_sec` | `{lease_id, lease_until}` \| `TASK_ALREADY_CLAIMED` |
| `space_task_heartbeat` | `lease_id` | `{lease_until}` |
| `space_task_transition` | `task_id`, `lease_id`, `to`, `payload` | `{state}` |
| `space_task_list` | `filter{op,state,to,role}` | `{tasks[]}` |
| `space_publish` | `uri`, `sha256`, `size`, `media_type`, `meta` | `{artifact_id}`（**只登记引用**） |
| `space_artifact_resolve` | `artifact_id` | `{uri, sha256, size}`（**不返字节**） |
| `space_msg_send` | `to` \| `topic`, `text`, `refs[]` | `{msg_id}`（**不落盘归档**） |
| `space_state_get` | `op` | `state`（server 归约结果，只读） |
| `space_resource_acquire` | `name`（如 `fpga:0`）, `lease_sec` | `{lease_id}` \| `RESOURCE_BUSY` |
| `space_resource_release` | `lease_id` | `{ok}` |

### 7.1 任务类型（`type`）

| type | 语义 |
|---|---|
| `assign` | 定向派活给某成员 |
| `broadcast` | **广播 = 通知**，投给所有匹配 role 的成员；**不等于派活**，须配合认领 |
| `revision` | 返工，`refs` 引用原 task_id，携带结构化修改意见 |
| `question` | 需要信息（对应 `WAITING_INPUT`），收件人答 `answer` 类型任务 |
| `answer` | 对 `question` 的回复 |
| `notice` | 纯通知，无需动作 |

**R6 广播不得直接触发干活**：广播与决议必须分离——先广播通知，再原子认领。
否则同一 role 的两个 agent 都会认为该干，必然重复劳动。

---

## 8. 权限与资源

### 8.1 竞态处理

| 操作 | 保证方式 |
|---|---|
| 认领 | 单条 DB 事务；`claims` 已满即拒绝 |
| 资源互斥（FPGA 等） | `resource_acquire` 表唯一约束 + 租约 |
| 状态更新 | 唯一写者是 server |
| 幂等 | 所有 transition 带 `task_id`；重复调用返回当前态而非报错 |

**集中化的最大隐性收益**：跨机分布式锁、心跳、重投、资源互斥全部退化为单库事务。

### 8.2 资源模型

- 资源是**一等的**，不是变通：`fpga:0`、`npu:0`、`board:win-01`。
- 认领即持租约，超时自动释放；`BLOCKED` 态即「等资源」。
- 这在 subagent 模式下不会遇到（只有一个在跑），**提成 peer 后是新增的必须处理项**。

### 8.3 预算熔断

无人值守 + 多 agent + 长任务，成本容易失控。server 侧记录 `budget.consumed`，超限拒绝新建任务并暂停。

---

## 9. 约束下沉判据

每写一条空间宪法条款，问一句：

> **这条能不能变成接口约束？能 → 搬进机制；不能 → 才留在 AGENTS.md。**

| 我们要的规则 | 现状载体 | 目标载体 |
|---|---|---|
| 不许越权写别人目录 | AGENTS.md + hook | server 鉴权（**硬**） |
| 消息不许传 payload | AGENTS.md | 接口无此参数（**硬**） |
| 回退不清零轮次 | `error-handling.md` | server 不变式 R2（**硬**） |
| 硬门槛不得自行放宽 | prompt | 只允许 `human` 角色调用（**硬**） |
| 广播不触发干活 | prompt | 广播无 target 绑定认领（**硬**） |
| handoff 必须写 | prompt | `→ DONE` 前校验（**硬**） |
| 判断口径 / 证据标准 / 决策归属 | AGENTS.md | **保留在宪法**（机制管不了） |

---

## 10. 与 A2A 的关系（借鉴不实现）

**结论：借用它的数据模型，不实现它的协议。**

A2A 是**点对点**的（Client↔Server，无中央 broker）；房间/成员/ACL/广播/共享黑板**全部「协议未定义」**，且与它「agent 是 opaque 的」原则直接冲突。它缺的正是我们要的。

| 借来 | 说明 |
|---|---|
| `TaskState` 分类与枚举 | 活跃 / 中断（可恢复）/ 终态；`INPUT_REQUIRED` 就是人介入的原语 |
| **Task Immutability** | 终态不可重开，改须新建 Task —— 见 R1 |
| `contextId` 分组 | 同算子的任务归组 |
| `tenant` 字段挂载点 | 语义留空，可用来放空间/组织 ID |
| Extension 机制 | 将来把 room/broadcast 形式化为 A2A Extension 的正规出口 |

不实现的理由：① 它缺空间语义（等于自己写它缺的全部）② 版本半年内两次结构级变动（v0.3 → v1.0 不兼容改，2026-08 迁入 AAIF），现在压核心等于提前买重构成本 ③ v0 不需要互通。

**切换触发条件**：出现第一个非自有 agent 要接入时。届时在空间服务外包一层 A2A Server 门面，内部核心不动（因为词汇已对齐）。

> 若未来需要**跨组织身份与访问控制**，优先评估 **AGNTCY**（发现 OASF / 身份可验证凭证 / 消息 SLIM / 可观测），它比 A2A 更贴近该需求。
> ACP 已被 A2A 吸收合并，不再作为选项。

---

## 11. 错误码

| code | 含义 |
|---|---|
| `TOKEN_INVALID` / `TOKEN_REVOKED` | 身份无效 / 已吊销 |
| `NOT_MEMBER` | 非空间成员 |
| `CONSTITUTION_OUTDATED` | 遵守的宪法版本过旧，须先升级 |
| `FORBIDDEN_ROLE` | 角色无权执行该操作（如非 human 放宽硬门槛） |
| `TASK_NOT_FOUND` | 任务不存在 |
| `TASK_ALREADY_CLAIMED` | 已被认领（认领竞争失败，**非错误路径**） |
| `TASK_STATE_INVALID` | 非法迁移（如终态重开） |
| `LEASE_EXPIRED` / `LEASE_MISMATCH` | 租约过期 / 不是持有者 |
| `HANDOFF_MISSING` | 未提交 handoff 就转 `DONE` |
| `LOOP_EXHAUSTED` | 轮次槽位耗尽 → 暂停待人工决策 |
| `EVIDENCE_INSUFFICIENT` | 收口/失败证据不全 |
| `RESOURCE_BUSY` | 资源被占 |
| `BUDGET_EXCEEDED` | 预算熔断 |
| `ARTIFACT_MISSING` | 引用的制品不存在 |

---

## 12. 存储草案（sqlite）

```
members(id, role, scopes[], token_hash, status, last_seen_at)
constitution(version, body, updated_at)
tasks(id, op, step, type, slot, refs[], to, role, state, attempts,
      lease_id, lease_until, expected_json, created_at)
task_events(id, task_id, from_state, to_state, by, reason, at)
artifacts(id, uri, sha256, size, media_type, by, op, step, at)
resources(name, lease_id, holder, lease_until)
events(id, kind, payload_json, at)        -- append-only，trace 来源
slots(op, slot, round)                    -- 轮次计数，R2 强制
budget(member_id, op, tokens, cost)
messages(id, to|topic, text, refs[], at)  -- TTL 清理，不归档
```

`state` 不单独存表：由 `events` 归约得出，按需缓存快照。

---

## 13. 未定项（v0.1 不解决）

| # | 项 | 影响 | 何时定 |
|---|---|---|---|
| 1 | 交接的**上下文成本** | 每个新 session 要重读宪法+handoff+产物，token 可能失控。需把「最小信息集」精确到文件的具体章节 | 原型跑通后，实测成本再定 |
| 2 | **经验分享平面**（跨算子长期记忆） | 与控制面/数据面都不同层：要可检索、要防污染。是第三套东西 | 单独设计 |
| 3 | token 发放/吊销的**操作流程** | 安全入口，决定能否真的「权限外的同事接不进来」 | 实现前必须定 |
| 4 | 大文件存储后端（NAS / 对象存储 / LFS） | 影响 `space_publish` 的 uri 形态 | 原型可用本地目录先凑 |
| 5 | **headless 能力实测** | 决定 D 档是否存在 | ✅ 已定：两个 runtime 均成立（阶段 1） |
| 6 | 长 `wait` 是否被 runtime 硬超时打断 | **若被打算，B 档不成立，架构退回 A 档** | ✅ 已定：不成断，但受客户端超时约束（ADR 0005） |
| 7 | 静默模式在空间里的语义 | 现有 `mode=silent` 如何映射（不弹问卷、默认决策、`pending_user_review`） | 协议稳定后 |
| 8 | A2A 互通的最终形态 | 门面 or Extension | 有第三方接入需求时 |

---

## 14. 最小验证路径

| 步 | 内容 | 验证什么 |
|---|---|---|
| **1** | **技术探针**（不写空间）：各 CLI headless 能否跑 / 能否挂 MCP stdio / 单 turn 内阻塞工具是否被硬超时 | **唯一「猜错要重做」的假设**：B 档是否成立 |
| 2 | sqlite + localhost + MCP stdio，两个假成员跑一轮：`create → wait → claim → publish → handoff → DONE →` 下游 `wait` 收到 → 人中途插话 | 骨架是否成立 |
| 3 | 接**一个真实环节**：建议选 **FPGA 那一步** | 同时验证跨机器（docker↔Win）、人工介入、资源互斥三个硬需求 |
| 4 | 再谈 `ops-direct-invoke` 全量映射（8 阶段 / 6 个 CP / 三条回退链） | 状态机能否承载现有工作流 |
