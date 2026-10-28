# 跨机器：中心化 hub + 容器里的成员

> 这个目录回答一个问题：**「所有成员连到一台服务器上的协作空间」到底是什么形态，能不能真跑？**

## 拓扑

```
              ┌──────────────────────────────────────┐
              │  宿主机 = 服务器                      │
              │  space serve --listen 0.0.0.0:7321   │
              │  ├ 单进程                             │
              │  ├ 单 sqlite（只有它挂这个文件）      │
              │  └ MCP over Streamable HTTP + bearer │
              └───────────────┬──────────────────────┘
                              │ HTTP（跨网络，不是共享文件）
        ┌─────────────────────┼─────────────────────┐
   ┌────▼─────┐        ┌──────▼────┐         ┌──────▼────┐
   │ 容器 dev-a│        │ 容器 dev-b │         │ 容器 pm   │
   │ 只挂      │        │ 只挂       │         │ 只挂      │
   │ tokens/   │        │ tokens/    │         │ tokens/   │
   │ artifacts/│        │ artifacts/ │         │ artifacts/│
   └───────────┘        └────────────┘         └───────────┘
```

**关键约束**：成员容器**看不到 `space.sqlite`**。这一步不是洁癖——它把「共享文件当协作空间」这条捷径物理堵死，
剩下唯一的通路就是 hub 的 HTTP 接口。这正是 ADR 0001 想要的形态。

## 两种跑法

| 跑法 | 需要什么 | 用在哪 |
|---|---|---|
| `run-kill-test.mjs`（**本机已验证**） | 一个自带 Python 的镜像（本机用 `ascendai/cann`，它本身就是真实的编码环境） | 无外网、拉不到 node 镜像时 |
| `compose.yml` + `Dockerfile` | 能拉 `node:22-alpine` | 有 registry 的机器，更干净（hub 也在容器里） |

本机 Docker Hub 不通（`registry-1.docker.io` 超时），且本地镜像里都没有 node，
所以走的是第一种：**hub 用宿主的 Node，成员用容器里的 Python**（`member.py` 只用标准库）。
成员是「假成员」（不调模型）——这里验的是传输与回收机制，不是智能。

## 已验证：掉线回收（`run-kill-test.mjs`）

```
pm  容器：派 broadcast 任务给 developer 角色
dev-a 容器：认领 → WORKING → 挂住
dev-b 容器：在旁边等
── docker kill dev-a（= 一台机器掉线）──
dev-b：租约过期后接手 → 写产物 → DONE
```

实测 **10/10**，从 kill 到恢复完成 **4.0 秒**：

```
member.attached  dev-a
task.claimed     dev-a          ← 认领
task.transitioned dev-a WORKING
member.attached  dev-b
task.expired     {"attempts":1,"from":"WORKING","to":"PENDING"}   ← 租约过期，任务回队
task.claimed     dev-b          ← 另一个容器接手
artifact.published dev-b
task.transitioned dev-b WORKING→DONE + handoff
```

这件事**同机共享 sqlite 的测试根本做不出来**（没有「掉线」这回事）：
ROADMAP 阶段 4 那条「杀掉任意成员，任务自动回队并被重新认领」就靠这个验证。

## 实现要点

- **身份随每个请求走**（`Authorization: Bearer`），hub 无连接态 → 吊销天然即时生效
- **`attach` 的会话状态存在 hub 进程内存里**（`sessions: Map`），所以 **hub 重启后成员要重新 attach**（原型阶段的取舍）
- **取消语义**：HTTP 下没有 `notifications/cancelled` 通道，改成「客户端断开连接 = 取消」，服务端据此中止在飞的 handler
- **`wait` 就是 POST 长轮询**，服务器把 `requestTimeout` 设为 0，不让 HTTP 层先掐断
- `GET /mcp` 回 405：声明不支持服务端主动推送（探针实测 opencode 能容忍；要服务端事件推送时才需要实现 SSE）

## 容器也可以当「没有 agent 的机器」

`member.py` 有个 `runner` 角色：它不调模型，只在容器里跑环境检查（`npu-smi` / CANN 目录 / 编译工具），
把结果写成 `env-info.md` 交回空间。用法见 `test/multimachine-design.mjs`：

```
0 环境准备（容器里的 runner，无 agent）
1.1 需求分析 / 2.1 测试方案 / 2.2 开发方案（宿主上的真实 agent）
CP1 / CP2.1 / CP2.2（宿主上的 QA agent）+ 人工确认
```

这对应你原本的现场：**编码容器是一台机器，agent 会话可以不在它里面**。

## 还没做的

- **真实 agent 进容器**：需要镜像里有 opencode/dsh（本机无 node 镜像，暂时做不到）。当前容器成员是脚本。
- **真的 Windows + FPGA**：docker 在 Mac 上是 Linux，模拟不出那台机器；CANN 镜像也跑不了 NPU。
- **hub 重启后的重连补投**：`attach` 状态在内存里，重启即丢；未确认任务的补投还没做验证。
