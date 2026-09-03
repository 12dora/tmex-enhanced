# CAN：Canonical State 客户端迁移 prompt 存档

## 任务 prompt（2026-09-03）

工作区：`/Users/konata/code/tmex-r21`，分支 `feat/round21-perf-idle-slim`。多个 agent 并行修改同一 worktree，只能修改本任务涉及文件；禁止修改复杂度 allowlist、`package.json`、锁文件、i18n 生成文件及任何构建产物；禁止 git 写操作；禁止触碰生产 tmex、9883 服务及名为 `tmex` 的 tmux session；不得启动开发服务器；运行时和测试均使用 Bun。机械重构必须保持副作用、错误码及顺序不变。

完成 ws-borsh v1 的 canonical state-stream 客户端迁移。服务端 canonical 实现、共享 wire schema 和客户端事件解码器已经存在，但客户端尚未发送 `KIND_CANONICAL_COMMAND`（0x0901），生产流量仍全部走 legacy。

必须先阅读：

- `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`；
- `docs/ws-protocol/2026021403-ws-state-machines.md`；
- `packages/shared/src/ws-borsh/canonical-state.ts`、`canonical-scan.ts`、`canonical-state-validation.ts`；
- `apps/gateway/src/ws/canonical-feed-session.ts` 及 `apps/gateway/src/ws/canonical/`；
- legacy 路径：`packages/stores/src/pane-subscriptions.ts` → `packages/ws-client/src/transport-command-encoder.ts` → `apps/gateway/src/ws/tmux-kind-handlers.ts` → `legacy-feed-broadcaster.ts`；
- `packages/ws-client/src/client.ts` 的 `serverCapabilities`；
- `apps/gateway/src/mesh/stream-replay-state.ts`。

实现要求：

1. 在 `packages/ws-client/src/transport-command-encoder.ts`（必要时新增同包模块）实现 server `CanonicalFeedSession` 接受的全部命令：attach/subscribe、unsubscribe、input、resize、screen request、带 cursor 的 history request，以及由源码和协议确定的其他命令。
2. capability gate：只有 HELLO capability 包含 `canonical-state-v1` 时启用 canonical；否则 legacy 完全不变。增加默认开启、可强制关闭的客户端 kill switch；通过客户端 diagnostics/state 暴露当前 feed 选择。
3. 接通 consumers：`packages/stores/src/pane-subscriptions.ts`、`packages/ws-client/src/pane-sink-registry.ts`、history/screen、input/resize。维持现有 store shape；正确处理订阅 ACK/拒绝、epoch、各 scope `SourceGap`、screen/history Begin/Chunk/Commit，并让 gap 显式触发重同步。
4. canonical frame 上限为 `min(32 KiB, effectiveMaxFrameBytes)`，禁止使用 generic CHUNK；screen/history/metadata 只用各自事务分块。
5. legacy 不得删除。若 canonical schema 没有某种能力，可显式保留单项 legacy，并在报告说明。

新增测试必须覆盖：encoder golden；完整 client↔server canonical round trip（subscribe → output → input → resize → screen → cursor history → gap → re-sync）；capability gate 与可观察字段；failover/replay 确认 `stream-replay-state.ts` canonical 分支被执行。

验证要求：shared 442、ws-client 319、stores 420、gateway 3750（已知 3 fail + 2 error）、fe 1737；涉及包 tsc 不超过基线；变更文件 biome 通过；不运行 Playwright。

最终报告写入 `prompt-archives/2026090302-round21-perf-idle-smell/sub/CAN-result.md`，包含设计、回放分支核验、测试结果及 reviewer 风险清单。

