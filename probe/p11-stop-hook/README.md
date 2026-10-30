# P11 · DSH Stop hook 能否阻止结束（本机未验通）

**状态：版本不配套，未实测**（见 [../RESULTS.md](../RESULTS.md) 的 P11 节）。

- app 自带的 `dsh-hooks-claude-code@0.1.2-rc.1` 要求 `@deepseek-ai/dsh-*@^0.1.2-rc.1`，
  nvm 全局的 dsh 是 `0.2.1-rc.2` → 被拒；`dsh plugin allow-version … --accept-risk` 后能进 config，
  但 `PreToolUse` / `Stop` 都没触发（hook 脚本零调用）
- 待验条件：用 Desktop 自带 runtime（0.1.2-rc.1）或等 0.2.x 的 bridge

文件：`hooks.json`（CC 事件格式）、`stop-hook.mjs`（首触发返回 `decision:block`）、`log-hook.mjs`（PreToolUse 探路）。
