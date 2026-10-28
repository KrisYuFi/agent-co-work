#!/usr/bin/env python3
"""
deploy/docker/member.py — 容器里的「成员」：最小 MCP over HTTP 客户端（只用标准库）

为什么是 Python：本机 docker 里没有 node 镜像可拉（无外网），但 `ascendai/cann`
镜像自带 Python 3.11 —— 那正是真实的编码环境（代码本来就在 docker 里）。

容器里**看不到 space.sqlite**，只能通过 hub 的 HTTP 接口干活。这就是跨机器。

角色：
  pm      派一个 broadcast 任务给 developer 角色，然后等它 DONE
  crash   认领 → WORKING → 挂住（等着被 docker kill）
  finish  认领 → WORKING → 写产物 → publish → DONE + handoff
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

_rid = 0


def rpc(url, token, method, params):
    global _rid
    _rid += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _rid, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            msg = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:200]}")
    if "error" in msg:
        raise RuntimeError(msg["error"].get("message"))
    return msg["result"]


def tool(url, token, name, args=None):
    result = rpc(url, token, "tools/call", {"name": name, "arguments": args or {}})
    payload = json.loads(result["content"][0]["text"])
    if result.get("isError"):
        err = RuntimeError(payload.get("message", "tool error"))
        err.code = payload.get("error")
        raise err
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", required=True, choices=["pm", "crash", "finish", "runner"])
    ap.add_argument("--url", required=True)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--artifacts", default="/artifacts")
    args = ap.parse_args()

    token = open(args.token_file).read().strip()
    role = args.role

    def log(m):
        print(f"[{role}] {m}", file=sys.stderr, flush=True)

    rpc(args.url, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": role, "version": "0"}})
    attached = tool(args.url, token, "space_attach", {"constitution_version": 1, "capabilities": {"max_block_sec": 20}})
    cursor = attached["cursor"]
    log(f"attached cursor={cursor}")

    if role == "pm":
        created = tool(
            args.url,
            token,
            "space_task_create",
            {"type": "broadcast", "role": "developer", "op": "kill-test", "step": "3.1", "expected": {"filename": "kernel.cu"}},
        )
        log(f"created {created['task_id']}")
        for _ in range(40):
            r = tool(args.url, token, "space_wait", {"since_cursor": cursor, "timeout_sec": 10})
            cursor = r["cursor"]
            for e in r["events"]:
                if e["kind"] == "task.transitioned" and e["payload"].get("to") == "DONE":
                    print(f"PM_DONE {e['task_id']}")
                    return 0
        print("PM_TIMEOUT")
        return 2

    for _ in range(60):
        r = tool(args.url, token, "space_wait", {"since_cursor": cursor, "timeout_sec": 10})
        cursor = r["cursor"]
        pending = [t for t in r.get("tasks", []) if t["state"] == "PENDING"]
        if not pending:
            continue
        task_id = pending[0]["task_id"]
        try:
            claim = tool(args.url, token, "space_task_claim", {"task_id": task_id, "lease_sec": 5})
        except Exception as exc:  # noqa: BLE001
            log(f"claim lost: {exc}")
            continue
        tool(args.url, token, "space_task_transition", {"task_id": task_id, "lease_id": claim["lease_id"], "to": "WORKING"})
        log(f"claimed {task_id} → WORKING")

        if role == "crash":
            log("holding… (this container is about to be killed)")
            time.sleep(600)
            continue

        if role == "runner":
            # 阶段 0：环境检查。这台「机器」没有 agent，只有一段脚本——
            # 正好对应真实场景里「连 NPU 的那台机器 / 那个容器」。
            import platform
            import subprocess

            def run(cmd):
                try:
                    out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20)
                    return (out.stdout or out.stderr).strip()[:600] or "(空输出)"
                except Exception as exc:  # noqa: BLE001
                    return f"(执行失败: {exc})"

            report = [
                "# 环境信息（由容器内的 runner 采集）",
                "",
                f"- 采集时间：{time.strftime('%FT%TZ')}",
                f"- 主机：{platform.node()} / {platform.system()} {platform.release()}",
                f"- Python：{platform.python_version()}",
                "",
                "## NPU",
                "```",
                run("npu-smi info 2>&1 | head -20 || echo 'npu-smi 不可用'"),
                "```",
                "",
                "## CANN",
                "```",
                run("ls -d /usr/local/Ascend/ascend-toolkit/latest 2>/dev/null || echo '未找到 CANN 安装目录'; echo \"ASCEND_HOME=${ASCEND_HOME:-未设置}\"".replace('\\"', '"')),
                "```",
                "",
                "## 构建工具",
                "```",
                run("cmake --version 2>/dev/null | head -1 || echo 'no cmake'; gcc --version 2>/dev/null | head -1 || echo 'no gcc'; nproc"),
                "```",
                "",
                "## 结论",
                "本机为容器环境：可完成编译类工作；**无 NPU 设备**（npu-smi 不可用），"
                "联调与性能验收需在带板卡的机器上进行。",
                "",
            ]
            text = "\n".join(report)
            uri = "artifacts/env-info.md"
            path = os.path.join(args.artifacts, "env-info.md")
            with open(path, "w") as f:
                f.write(text)
            body = text.encode()
            sha = hashlib.sha256(body).hexdigest()
            size = os.path.getsize(path)
            tool(args.url, token, "space_publish", {"uri": uri, "sha256": sha, "size": size, "media_type": "text/markdown", "task_id": task_id})
            tool(
                args.url,
                token,
                "space_task_transition",
                {
                    "task_id": task_id,
                    "lease_id": claim["lease_id"],
                    "to": "DONE",
                    "payload": {"handoff": {"uri": uri, "sha256": sha, "size": size}, "reason": "环境检查完成（容器内）"},
                },
            )
            print(f"RUNNER_DONE {task_id}")
            return 0

        uri = f"artifacts/kernel-{role}.cu"
        path = os.path.join(args.artifacts, os.path.basename(uri))
        body = f"// produced by {role} at {time.strftime('%FT%TZ')}\n".encode()
        with open(path, "wb") as f:
            f.write(body)
        sha = hashlib.sha256(body).hexdigest()
        size = os.path.getsize(path)
        tool(args.url, token, "space_publish", {"uri": uri, "sha256": sha, "size": size, "media_type": "text/x-cuda", "task_id": task_id})
        tool(
            args.url,
            token,
            "space_task_transition",
            {
                "task_id": task_id,
                "lease_id": claim["lease_id"],
                "to": "DONE",
                "payload": {"handoff": {"uri": uri, "sha256": sha, "size": size}, "reason": f"finished by {role}"},
            },
        )
        print(f"DEV_DONE {task_id}")
        return 0

    print("NO_TASK")
    return 3


if __name__ == "__main__":
    sys.exit(main())
