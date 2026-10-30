# P10 · opencode 能否在 `session.idle` 注入消息开新 turn

**结论：能**（见 [../RESULTS.md](../RESULTS.md) 的 P10 节）。

用法（在空目录里跑，脚本会自己起 `opencode serve`）：

```bash
cp -r .opencode <临时目录>/ && cp opencode.json <临时目录>/
node run.mjs --dir <临时目录>
```

`opencode.json` 里的 probe MCP 指向 `../mcp/server.mjs`，日志写到 `<临时目录>/mcp.jsonl`。
插件把每个事件写进 `./plugin.log`，只在**第一次** `session.idle` 时注入一条调用 `probe_ping` 的消息。

判定：`plugin.log` 出现 `session.idle` 与注入记录，且 `mcp.jsonl` 出现 `probe_ping` 的 `tools/call:start`。
