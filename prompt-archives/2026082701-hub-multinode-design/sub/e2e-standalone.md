# standalone e2e 基线（feat/hub-node，2026-08-28，commit 2069932 之后）

`cd apps/fe && bun run test:e2e`：94 passed / 7 failed / 1 skipped（9.6 min）。

7 个失败与既有基线完全一致（非回归）：mobile-settings:5、mobile-terminal-interactions:79/140/221/303、settings-llm:42、ws-borsh-theme-resize:39。1 skip 为 ssh-device-connect 外部环境门控。gateway 日志中的 `AI_APICallError` 来自 settings-llm 用例访问不存在的 LLM endpoint，属既有行为。
