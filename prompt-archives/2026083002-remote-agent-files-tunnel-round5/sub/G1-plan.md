# G1 Remote-node agent sessions — 实现计划

> 执行本任务的 agent：在 worktree `tmex-enhanced-wt-r5` 内只改 G1 范围文件。不 commit。

**Goal:** entry gateway（self）持有并跑全部 agent session（含绑定远端 pane 的）；LLM 用 self 的 provider；pane I/O 经 mesh 内部 RPC。

**Architecture:** `agent_sessions.node_id` NULL=self。远端 pane 走 `/api/mesh-internal/tmux/*`，仅 `acceptHttpStream` 打上的 `x-tmex-mesh-peer` 可访问；外部入口剥标记。`acquireRuntime(nodeId, deviceId)` 本地走 registry，远端走 `RemotePaneRuntime`。peer offline → `stopSessionsForNode`，`lastError=NODE_OFFLINE`。

**不改：** G2 文件（peer-manager / node-list-projection / mesh-routes / mesh-deps / types）、shared 契约形状、生产 tmex。

---
