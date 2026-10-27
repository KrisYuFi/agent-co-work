# agent-co-work

> **Agent 协作空间**：让多个 agent 以**独立、可人工干预的会话**协作，而不是由一个主 agent 在进程内偷偷调用子 agent。
>
> **当前状态：设计阶段（协议草案 v0.1）+ 阶段 1 技术探针已通过；尚未实现协作空间。**

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
├── probe/                       # 阶段 1 技术探针（不实现空间）
│   ├── README.md                # 如何复现
│   ├── RESULTS.md               # 逐 runtime 实测结论
│   ├── run.mjs                  # (scenario, runtime) 运行器
│   ├── mcp/server.mjs           # 零依赖 stdio MCP 探针服务器
│   └── results/raw/*.json       # 原始记录
└── docs/
    ├── background.md            # 问题现场：场景、需求、约束、被否掉的方案
    ├── design/
    │   ├── README.md            # 设计文档索引
    │   └── protocol-v0.1.md     # 协议草案：状态机 / 接口 / 不变式 / schema
    └── decisions/               # 架构决策记录（ADR）
        ├── 0001-central-hub-over-shared-filesystem.md
        ├── 0002-two-planes-and-event-sourced-state.md
        ├── 0003-borrow-a2a-vocabulary-not-adopt.md
        ├── 0004-wakeup-model-wait-first.md
        └── 0005-wait-bounded-by-client-tool-timeout.md
```

**阅读顺序建议**：`background.md` → `decisions/` → `design/protocol-v0.1.md` → `ROADMAP.md`。
先知道为什么，再知道定了什么，最后才知道怎么做。

---

## 现在能用吗

**不能。** 仓库当前没有协作空间实现——只有文档，加一套阶段 1 探针。

那个「猜错就要重做」的前提已经测完了（[`probe/RESULTS.md`](probe/RESULTS.md)）：

> **agent 能在自己的一个 turn 里调用阻塞工具等待任务** —— ✅ 成立。

两个 runtime（opencode / dsh）都能 headless 跑、都能挂 MCP stdio、单次阻塞 150s 不被打断。**但有一个必须知道的约束**：单次阻塞时长受**客户端工具调用超时**限制，默认值只有 30s / 60s，超时即断。

所以 `wait` 默认 20s + 由客户端声明上限（[ADR 0005](docs/decisions/0005-wait-bounded-by-client-tool-timeout.md)）。下一步是阶段 2 的最小原型。

---

## 名字的由来

`co-work` 取「协作空间」之意：不是一个 agent 多开几个线程，而是**一个供多个 agent 与人共同驻留的空间**。
