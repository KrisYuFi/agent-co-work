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
    ap.add_argument("--role", required=True, choices=["pm", "crash", "finish"])
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
