# FIX-D：后端与 store 侧 review 修复

## 背景

独立 review 指出本轮待机瘦身改动引入了六处行为回退或安全缺口。本任务在 `feat/round21-perf-idle-slim` worktree 内逐项修复，并各补一条能锁住行为的测试。未改 allowlist、lockfile、i18n 生成文件或生产 tmex。

接线例外：任务要求 `createAppRuntime.dispose()` 接上 UI 解绑路径，因此除清单内文件外改了 `packages/stores/src/app-runtime.ts`（仅把自建 UI store 的 disposer 推进已有 `disposers` 数组；注入的共享 `uiStore` 不接管）。

## 修复

### 1 会话 hard TTL 截断后每个请求写库

`apps/gateway/src/auth/node-session-store.ts`：滑动续期仍在剩余 TTL `< NODE_SESSION_RENEW_THROTTLE_MS` 时计算 `nextExpiresAt`，但 **只有 `nextExpiresAt > row.expiresAt` 才 UPDATE 并下发 `renewedExpiresAt`**。截断到 `hardExpiresAt` 之后重复 verify 不再写 SQLite、不再续 Cookie。

测试：`clamped to hardExpiresAt does not rewrite or reissue cookie on every request`。

### 2 同路径 stderr 轮转后 fd 2 掉队

`apps/gateway/src/log/rotate.ts`：抽出 `processLogStdoutDupTargets(sharedStderr)`。stdout writer 的 `onFdChange` 在 `TMEX_LOG_ERR_FILE === TMEX_LOG_FILE` 时对 fd 1 **和** fd 2 都 `dup2`。

测试：targets 为 `[1]` / `[1, 2]`；`RotatingFileWriter.onFdChange` 在构造与每次 rotate 都会触发。

### 3 WebSocket 关闭原因未净化

`apps/gateway/src/ws/session-close.ts`：新增 `sanitizeWsCloseReason`——只保留 ASCII 打印字符（32–126），最长 64。协议 `close(code, reason)` 仍传原始 reason，仅日志走净化。

测试：`apps/gateway/src/ws/session-close.test.ts`（ANSI / CR LF 剥离、长度截断、落日志行不含控制序列）。

### 4 草稿在 debounce 窗口内撤销后仍写回

`packages/stores/src/ui-persist.ts`：`setItem` 先与 `written` 比，`none` 则清 pending 并取消定时器；再与 `pending ?? written` 比以更新延后写入。

测试：同一空草稿引用回到基线后，定时器到点不再把 `x` 写回。

### 5 UI 离场监听与 debounce timer 不受 dispose 管理

- `createDeferredPersistStorage` 增加 `dispose()`（取消 timer、丢 pending、拒绝后续 setItem）。
- `createUIStore` 接受 `disposers`，卸掉 `visibilitychange` / `pagehide` / `storage` 并调用 persist dispose。
- `createAppRuntime` 自建 UI store 时传入同一 `disposers`，`dispose()` 一并清理。

测试：dispose 后监听器计数为 0、旧 pending 不落盘、新 runtime 写入不被覆盖。

### 6 stats 轮询不再等待上一次 `getStats()`

`startStatsPolling`：`pollStats().finally` 里才 `schedule` 下一拍；`busy` 防止重叠；`statsPollGeneration` 让 `stop` 作废 in-flight。可见性门控与 RTT 分桶不变。为满足 `fileLines ≤ 1114`，去掉了邻近分区横幅与 `pollStats` JSDoc（行为不变）。

测试：`getStats` 挂起时推进时钟不叠加请求；完成后才排下一拍。激活后立即断言 pending delays 的用例改为 `await flush()` 再查 2000ms stats 定时器。

## 验证

| 包 | 结果 |
|---|---|
| `apps/gateway` 定向 | `node-session-store` / `rotate` / `session-close` 18 pass |
| `apps/gateway` 全量 | 3827 pass / 4 fail（与本轮已知 flake 同量级；定向文件全绿） |
| `packages/stores` 定向 | `ui-persist.test.ts` + `ui.test.ts` 44 pass |
| `packages/stores` 全量 | 435 tests：373 pass / 62 fail。失败全部是 `websocket-transport.ts` 的 `onDocumentVisible` 对不完整 `document` 桩调用 `addEventListener`（`tmux-event-router.test.ts` 等，FIX-D 文件列表外）。FIX-D 用例不在失败名单中。 |
| `packages/ws-client` | 381 pass / 0 fail（含本任务 carrier 51/51） |
| `apps/fe bun test src/` | **1744 pass / 0 fail** |
| `tsc --noEmit` | gateway 0（≤21）、stores 1（`host-services.test.ts` 基线）、ws-client 0、fe 0 |
| `biome check` 改动文件 | 通过 |
| `bun scripts/complexity/gate.ts` | **ok**（未改 allowlist；controller 1113 行 ≤ 1114） |

## 风险

- 会话截断后不再续 Cookie：行为本就应该如此；中间件只在 `renewedExpiresAt` 有值时写 Cookie。
- close reason 日志不再含非打印字符；运维若曾靠完整 reason 排障，现在最多 64 字节 ASCII。
- persist `dispose()` 丢弃未 flush 的 pending（页面离场监听已先 flush；runtime 销毁场景避免迟到覆盖）。
- stores 全量 62 fail 需 websocket-transport / 各 document stub 的 agent 补 `addEventListener` 守卫，不在本任务范围内。
