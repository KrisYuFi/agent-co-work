# test/ — 阶段 2 验收

两个脚本，两个层次。**都不 mock 空间本身**：一个用假成员验骨架，一个用真模型验「agent 真的挂得上」。

| 脚本 | 用什么当成员 | 验什么 | 耗时 | 成本 |
|---|---|---|---|---|
| `acceptance.mjs` | 脚本直说 MCP 的假成员 ×5+ | 骨架、不变式、越权、吊销、插话、回收、对账 | ~40s | 0 |
| `e2e-real.mjs` | **真实 agent**：opencode + DSH 各一个会话 | 模型能不能照着空间协议把活干完（含同任务状态链与产物 sha 校验） | 1–3 min | 两次模型会话 |

```bash
node test/acceptance.mjs          # 55 项，全离线
node test/e2e-real.mjs --keep     # 真实 runtime，需要 opencode + dsh 凭证
```

## acceptance.mjs 覆盖的 55 项

剧本严格对应 [ROADMAP 阶段 2](../../ROADMAP.md) 的验收剧本，另外补了不变式与吊销：

- **主链路**：attach → wait → task_create(assign) → 唤醒 → claim → WORKING → publish → DONE + handoff → 下游 wait 收到 → 解析引用
- **越权被 server 拒绝**（不是被提示词劝阻）：非持有者改任务 `LEASE_MISMATCH`、跨成员认领 `FORBIDDEN_ROLE`、抢资源 `RESOURCE_BUSY`
- **不变式**：缺 handoff `HANDOFF_MISSING`、handoff 指向未登记制品 `ARTIFACT_MISSING`、终态重开 `TASK_STATE_INVALID`（R1）、非 human 放宽硬门槛 `FORBIDDEN_ROLE`（R3）、宪法过旧 `CONSTITUTION_OUTDATED`
- **人插话**：挂着的 `wait` 被放弃（工具调用作废）→ 人发消息 → 恢复 wait 并收到
- **吊销**：旧 token 立刻失效（`TOKEN_REVOKED`）且名下 `WORKING` 任务回 `PENDING`
- **可重放**：`space_verify` 断言 `tasks` 投影 == `events` 归约，并有**负向测试**（篡改投影必报 drift）
- **回收**：租约过期 → `attempts=1` 且**能被另一位成员重新认领**；重复到期 → `FAILED`
- **安全回归**：未 attach 被拒、读侧可见性、消息私聊不泄漏、对别人任务开 revision 被拒、租约上限、心跳不能续别人的租约、吊销可解封

## 怎么读 trace

```bash
node src/cli.mjs trace --dir <space>            # 全量事件流
node src/cli.mjs trace --dir <space> --follow   # 跟上
node src/cli.mjs tasks  --dir <space> --op add  # 当前任务状态
node src/cli.mjs verify --dir <space>           # 投影 vs 事件归约
```

事件流本身就是调试记录（协议 §3.1「trace 免费」），不需要另建日志体系。

## 变异测试（ADR 0009）

验收脚本的价值不在通过数，而在「实现坏掉时会不会红」。提交前至少对每条 P0 做一次：

```bash
# 例：把 R1 的终态检查删掉 → 测试必须红
sed -i '' 's/assertNotTerminal(task) \/\/ R1 终态不可变/void 0/' src/space/service.mjs
node test/acceptance.mjs    # 期望 FAIL
git checkout src/space/service.mjs
```

2026-10-28 那次审计：19 个变异存活 9 个（53%）→ 重写后 13 个变异存活 2 个（且都是双重防护）。

## e2e-real.mjs 注意

- 它真的花钱、真的调模型。`--timeout-sec` 控制总时长，`PROBE_OPENCODE_MODEL` 换模型。
- 两个会话的提示词把协议**写死在步骤里**（`docs/design/protocol-v0.1.md` §6.2 的循环）。这不是最终形态——
  阶段 4 要把这些步骤下沉到空间宪法 + server 校验里，提示词只留「判断口径」。
- 失败时先看 trace：`tasks` 与 `events` 能区分「模型没照做」和「空间拒绝了它」。
