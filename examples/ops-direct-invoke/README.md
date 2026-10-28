# ops-direct-invoke → 协作空间：设计段映射（0.x 实验）

> 这份目录是**「空间里跑什么流程」**，不是空间实现本身（见本仓 `AGENTS.md` 的目录约定）。
> 来源：`cannbot-skills/plugins-official/ops-direct-invoke`（8 阶段 / 6 CP / 7 角色）。
> 当前只映射到**编码之前**的那一段：需求 → 设计 → 设计 review。

## 为什么先跑这一段

真实的算子开发要 CANN 工具链和 NPU（阶段 3.4 联调、CP3/CP4 性能验收都跑不了），
但**协作机制**恰恰在编码之前最密集：多角色产出交付件、逐级 handoff、CP 打回、轮次预算。
这一段能在一台没有 NPU 的机器上完整跑通，而且正是现有 subagent 流程最难受的地方
（人只能在最后看到结果，中途无法插手）。

## 映射表

| 流程表 | 原来的执行者 | 空间里的形态 |
|---|---|---|
| 1.1 需求分析 | architect（subagent） | `assign` 任务 → 成员 `architect` 认领 → `publish` 需求文档 → `DONE` + handoff |
| ⛔ CP1 需求确认 | QA + 用户问卷 | QA 做 `CP1` 验收任务 → 完成后 PM 发 `question` 任务给 `human` → `WAITING_INPUT` |
| 2.1 测试方案设计 | architect | `assign` 任务，`inputs` 引用需求文档的 handoff |
| CP2.1 测试检查 | QA | `assign` 任务（非 ⛔，不找人） |
| 2.2 开发方案设计 | architect | `assign` 任务，`inputs` 引用需求文档 |
| ⛔ CP2.2 方案检查 | QA + 用户问卷 | 同 CP1 |
| CP1/CP2.2 打回 | 「复用原会话追加 prompt」 | `revision` 任务 + `refs` 指向原任务 + `cp` 字段；slot 由 server 按 §5.2 查出 |
| `state.json` | PM 手写 | **不再手写**：`space_state_get` 由事件归约得出 |
| 回退轮次上限 | `error-handling.md` 里靠 PM 记 | `slots` 表 + `LOOP_EXHAUSTED`（design/joint_debug/acceptance 各 3） |
| 「回退复用原会话」 | 会话销毁就断链 | 不再需要：返工上下文靠 handoff 落盘，新会话也能接 |

## 本次实验的边界（先说清，避免又吹）

- **PM 是脚本**，不是 LLM 会话。它用和 agent 完全相同的 MCP 工具派活/验收，所以「编排逻辑」这一层没被验证；
  下一轮再把 PM 也换成真实会话。
- **QA 的验收结论是 agent 写的**，但本次不校验它是否真的读了文档（验收质量属于人的判断，不属机制）。
- **只到 CP2.2**，不碰编码、编译、NPU。
- 人工确认点由脚本扮演 `human` 成员回答（可换成真人在 GUI 里答）。

## 跑法

```bash
node examples/ops-direct-invoke/run-design.mjs --keep
node examples/ops-direct-invoke/run-design.mjs --architect dsh   # 默认 architect=dsh, qa=opencode
```

产物落在临时目录的 `artifacts/<op>/` 下，`space trace --dir <space>` 可看全链路。


---

## 第一次实跑结果（2026-10-28）

配置：`architect = dsh`、`qa = opencode`，两个**真实会话**并发；PM 与 human 由脚本按同一套 MCP 工具驱动。

链路（68 条事件 / 11 个任务 / 8 份交付件）：

```
1.1 需求分析(DONE) → CP1(QA pass) → ⛔问卷 → 人 reject
   → 1.1-r2 revision(DONE) → CP1-r2(QA pass) → ⛔问卷 → 人 approve
   → 2.1 测试方案(DONE) → CP2.1(QA pass)
   → 2.2 开发方案(DONE) → CP2.2(QA hold) → ⛔问卷 → 人 approve
```

产出（都是由 agent 写、经 handoff 交回的真文件）：

| 文件 | 大小 |
|---|---|
| `1.1-需求分析.md` / `1.1-需求分析-v2.md` | 34.9 KB / 45.8 KB |
| `2.1-测试方案设计.md` | 24.7 KB |
| `2.2-开发方案设计.md` | 27.5 KB |
| `CP1-需求验收报告.md` / `-r2.md` | 4.4 KB / 5.7 KB |
| `CP2.1-测试方案验收报告.md` / `CP2.2-方案验收报告.md` | 5.0 KB / 4.8 KB |

**R2 槽位**：`slots = [{op:'add', slot:'design', round:1}]` —— 跨环节回退记进 design 槽，没有清零。
**可重放**：`space verify` 通过（投影 == 事件归约）。

值得记的细节：v2 需求文档在开头就写明了「修订依据 = CP1 退回意见」+ 原任务 id + 上游输入 sha256。
返工上下文是**落盘可追溯的**，不依赖「复用原会话」——这正是 ADR 0004 想解决的那个「会话一销毁就断链」。

## 这次跑出来的四个问题

1. **opencode 的目录权限挡住了跨目录读**（`permission.external_directory`）。产物目录在 agent 的 project 目录之外时，
   非交互模式直接 auto-reject，任务卡在 WORKING 长达 5 分钟。这是「文件系统当协作空间」会撞的第一堵墙。
   映射层必须显式授权，或者把产物目录放进 agent 的工作目录。
2. **`hold` 没有被编排方尊重**：QA 对 CP2.2 判了 `hold`（两处末 tile 示例有误），但我的 PM 脚本只看「任务 DONE」就往下走了。
   机制侧没错（`cp.judged` 已经记下 verdict），错在编排逻辑——**这是把「判断口径」留在宪法、把「流程」交给 PM 的代价**。
3. **空闲 agent 会自己退出**：headless 会话有有限的轮次预算，PM 迟迟不下发下一个任务时 agent 就收工了。
   真实部署里这是「人开着会话」的退化形态，得靠足够长的 `wait` 预算（这里用了 60s × 30 轮）。
4. **`verify` 自己有个假阳性**：把「人答问卷」的 DONE 也要求 handoff。已修（handoff 只对产出交付件的任务必填）。

## 下一步

- PM 换成真实会话（现在是脚本），并把 `hold` → revision 的分支做进去
- 把 `state.json` 的等价视图做出来（现在要用 `space_state_get` 自己拼）
- 跨机器：这一步必须换成中心化 hub + HTTP（当前仍是同机共享 sqlite）
