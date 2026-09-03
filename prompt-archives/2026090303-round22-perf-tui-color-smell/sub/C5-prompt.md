# TASK C5 — 修复后端评审发现

## 用户指令

读取 `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/0685432d-fa27-4053-992e-6fa2f83cfd6c/scratchpad/r22/review/backend-review.md`，按其中“最小修复”修复 finding 1–7，并为每项增加修复前失败、修复后通过的聚焦单元测试。

具体约束：

1. send-guard 仅在所有跳过帧都是可由 screen 重建的终端数据（legacy `TERM_OUTPUT` / canonical `PaneData`）时发送 `SourceGap`；跳过任意其他 kind 时保持 `terminate('backpressure_gap')`；保留 4 MiB 硬限制。
2. event-bridge 不得在普通物化输出时清除 cold-output dirty；只在成功 screen capture / 新客户端基线、pane 或 server epoch 变化、pane 删除时清除。回归场景：cursor seq 0、cold 跳过 50 bytes、后续物化输出、canonical 旧 cursor 订阅必须得到 `needsScreen=true`。
3. `peer-manager.ts` 仅在真实重建连接（该 peer 曾有 live link 且已丢失）时调用 `this.dcUpgrade.onPeerReconnected(peerNodeId)`；首条连接不得调用；原有 disabled DC upgrade cooldown 测试保持通过；增加 disabled → 同 endpoint reconnect → 立即重试测试。
4. control-mode unescape 按活跃 dispatch 深度租用 scratch；导出的普通 helper 返回 owned copy。
5. 从 app 配置（`TMEX_DIRECT_ENABLED` / nativeDir）向 `RtcPeerManager` 显式传 `canLoadNative`；direct 显式关闭时 `available` 立即为 false，仅“启用但尚未加载”乐观。`mesh-runtime.ts` 只允许改接线，不得改 `start()` body 或 `uplink.onStateChange` block。
6. gateway PID wrapper 重新接受 JSON 数字字符串 pid，共享 CLI strict parser 保持严格；测试 `{"pid":"1234"}`。
7. `terminal-output-batcher.ts` 与 canonical `pane-stream.ts` 的时间表进行超过一个 cooldown 的惰性淘汰并设置容量上限；canonical device detach 删除对应 device 前缀。

验收：在 `apps/gateway` 运行指定 `bun test src/ws src/tmux-client src/mesh/peer-manager src/mesh/rtc src/system`（已知 flaky multi-hub integration 可忽略）、`bunx tsc --noEmit -p .`、变更文件 `bunx biome check`；仓库根运行 `bun scripts/complexity/gate.ts`。不得执行 git 操作。结果最后写入 `sub/C5-result.md`。

并遵守用户提供的 Common rules 与仓库 `AGENTS.md`：Bun-only、不触碰生产 tmex/tmux session、共享 worktree 中只修改点名源码及对应测试、不得弱化测试或遗留 TODO，结果文件最后写。
