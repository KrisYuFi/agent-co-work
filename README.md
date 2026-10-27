# agent-co-work

> **Agent 协作空间**：让多个 agent 以**独立、可人工干预的会话**协作，而不是由一个主 agent 在进程内偷偷调用子 agent。
>
> **当前状态：阶段 2 最小原型已跑通**（真实 agent 端到端 8/8）。仍是原型，不是可用产品。

---

## 为什么需要它

现在的 agent 工作流通常是「主 agent 同步调用 subagent」。这套模式在本机、短链路、一次对话内跑得很好，但它有三个硬伤：

| 硬伤 | 具体表现 |
|---|---|
| **人无法中途干预** | subagent 是进程内的暗盒，跑偏了只能看着，或者等它失败重来。**不好调试** |
| **跨机器做不到** | 编码在 docker 容器里，硬件在另一台 Windows + FPGA 上，一个进程编排不了两台机器 |
| **上下文一丢就断链** | 返工靠「复用原子会话」，会话销毁后返工上下文就没了 |

于是需要把每个角色 agent 提上来，成为**用户能直接打开、直接对话、直接接管的独立 session**；它们之间的协作改由一条**共享消息总线**承担。

详细的问题现场（真实工作环境、需求清单、被否掉的方案）见 **[docs/background.md](docs/background.md)**。

---

## 核心想法（三句话）

1. **中心化**：一个协作空间服务（本机 localhost 或内网服务器，同一份代码），所有 agent 挂上来。实际工作仍在各自机器上完成，空间只负责**任务上下游交接、状态同步、经验分享**。
2. **三个平面**：状态走数据库、消息走总线、产物走仓库。**消息只传引用，不传内容**——这是避免文件爆炸和支撑大文件交接的关键。
3. **机制优于自然语言**：能用接口约束的，不写进 AGENTS.md。轮次上限、验收门槛、认领互斥、handoff 必填，全部由服务端拒绝，而不靠 agent 自觉。

它刻意长得很像**早期论坛**：成员各自上线、按主题分区、离线也能收到消息、有版主（权限）、有置顶（状态）、有附件（产物）。而不是像聊天室那样要求所有人同时在线——因为你的 agent 是「用户启动的会话」，**不在线才是常态**。

---

## 仓库内容

```
agent-co-work/
├── README.md                    # 本文件（概览）
├── ROADMAP.md                   # 分阶段开发计划与通过标准
├── AGENTS.md                    # 本仓的开发约定（给 agent 看）
├── CHANGELOG.md                 # 变更日志
├── src/                         # 阶段 2 起：最小原型（零外部依赖）
│   ├── cli.mjs                  # space init / token / serve / attach / trace / verify
│   └── space/
│       ├── db.mjs               # sqlite schema + 事务
│       ├── events.mjs           # 事件流 + 状态归约 + 可重放对账
│       ├── invariants.mjs       # 服务端不变式（迁移表 / R1 / R2 / R3 / handoff）
│       ├── tokens.mjs           # 身份签发与吊销
│       ├── service.mjs          # 领域操作
│       └── mcp.mjs              # MCP over stdio + 15 个 space_* 工具
├── test/                        # 阶段 2 验收
│   ├── acceptance.mjs           # 4 个假成员，25 项
│   ├── e2e-real.mjs             # 真实 opencode + DSH 会话
│   └── README.md
├── probe/                       # 阶段 1 技术探针
│   ├── README.md / RESULTS.md
│   ├── run.mjs
│   ├── mcp/server.mjs
│   └── results/raw/*.json
└── docs/
    ├── background.md            # 问题现场：场景、需求、约束、被否掉的方案
    ├── design/
    │   ├── README.md
    │   └── protocol-v0.1.md     # 协议草案：状态机 / 接口 / 不变式 / schema
    └── decisions/               # ADR 0001–0007
```

**阅读顺序建议**：`background.md` → `decisions/` → `design/protocol-v0.1.md` → `ROADMAP.md`。
先知道为什么，再知道定了什么，最后才知道怎么做。

---

## 现在能用吗

**能跑原型，还不能当产品用。** 阶段 2 的最小原型已经跑通：

```bash
node src/cli.mjs init --dir ./space
node src/cli.mjs token issue --dir ./space --member dev-code --role developer > dev-code.token
node src/cli.mjs serve --dir ./space --token-file dev-code.token    # MCP over stdio，供 agent 接入
node src/cli.mjs trace --dir ./space                                 # 事件流就是 trace
```

已实测成立的部分：

- **真实 agent 能挂上去干活**：opencode 当开发成员、DSH 当 PM，无人干预跑完
  `attach → create → wait → claim → publish → DONE + handoff → 下游解析`（8/8）
- **越权由 server 拒绝**，不是靠提示词劝阻（25 项验收全通过）
- **人中途插话**后 agent 能恢复等待
- **状态可重放**：`space verify` 断言投影与事件归约一致

还没做的：跨机器（阶段 3，必然引入 HTTP）、R4/R5 两条不变式、预算熔断、经验分享平面（阶段 5）。

细节：协议语义看 [`docs/design/protocol-v0.1.md`](docs/design/protocol-v0.1.md)，验证过程看 [`probe/RESULTS.md`](probe/RESULTS.md) 与 [`test/README.md`](test/README.md)。

---

## 名字的由来

`co-work` 取「协作空间」之意：不是一个 agent 多开几个线程，而是**一个供多个 agent 与人共同驻留的空间**。
