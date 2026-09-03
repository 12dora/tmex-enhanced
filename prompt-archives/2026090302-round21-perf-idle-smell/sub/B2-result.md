# B2 result — 削减 gateway 空闲待机成本（O1 / O2 / O11 / O12 / O15 / O16 / O17）

Worktree: `/Users/konata/code/tmex-r21`（`feat/round21-perf-idle-slim`）。未触碰生产 tmex、名为 `tmex` 的 tmux session、allowlist / lockfiles / i18n 生成文件，也未改其他 agent 正在改的 `mesh-log.ts` / `rtc-log.ts` / `auth-routes.ts` / `uplink-pool.ts` / `ws/index.ts` / `session-close.ts` / `webhook.ts` / `packages/app/**`。

硬约束：未改任何 ping / liveness / miss-limit / 超时阈值。O16 真正发出的 heartbeat 仍是 10 s 响应超时。

## 改动摘要

### O1 — `[ws-metrics]` 全零不发

`apps/gateway/src/ws/gateway-metrics-log.ts`：`takeIfDue` 仍重置窗口；若 ping / terminal_output 窗口计数器全 0 且队列为空（不含 lifetime `terminationsByReason`、limit 字段），或 `gateway_activity` 的窗口计数器 / kinds 为空，则不 `console.log`。非零窗口照发。

**收益（推理）**：现场 64k / 96k 行即这三条每 30 s 各一行。空闲全零时 **3 行 / 30 s → 0**，约 **−8640 行/天**（≈ 现场 ws-metrics 的 60–90%），同步 stdout 写盘随之归零。非零窗口行为不变。

### O2 — `snapshotStats()` 纯读

`apps/gateway/src/tmux-client/retention/policy-scheduler.ts`：去掉 `snapshotStats()` 首行 `this.sweep()`。清扫仍由 deadline timer / `afterIngest` / `nudgePaneDeadline` 负责。既有 `pane-retention` 测试在断言 mode 变化前显式 `sweep()`，不依赖读副作用。

**收益（推理）**：每次指标发射少一次 O(pane) 的 `trimPaneReplay` + `advanceModeDeadlines` + `enforceBounds` + timer 重排。空闲有客户端挂着时，这是 30 s 一次的额外全量遍历 → **0**。

### O11 — `statusProvider()` / `os.networkInterfaces()` 缓存

`apps/gateway/src/mesh/mesh-runtime.ts`：`createTtlCache`（TTL **8 s**）包住 `interfacesFn`。`statusProvider` 走 `cache.get()`。`PeerManager.syncLocalFingerprint` 每 15 s 经 `refreshLocalInterfaces()` **强制 refresh**（不走 TTL），因此网卡变化仍在同一拍被看到；随后 N 个 `sendPeerStatus` 与 uplink `sendStatusIfChanged` 复用刚刷新的快照。内容去重（`lastAdvertisedStatusJson`）未改。

**收益（推理）**：idle syscall 从 **1 + N_peer + 1 / 15 s** 降到 **≈ 1 / 15 s**（fingerprint refresh 一次；同拍 status 命中缓存）。N=2 时约 **−8 syscall / min**。

### O12 — key-log head 进程内缓存

`apps/gateway/src/mesh/peer-manager.ts`：`sendPeerStatus` 缓存 `keyLogApplier.head(userId)`；`notifyKeyLogHeadChanged()` **先失效再 debounce 广播**。

**收益（推理）**：空闲 `users` SELECT 从 **N_peer × 4 / min** → **0**（head 不变则永不打 DB）。key-log 追加时仍立刻失效并重读一次。

### O15 — 事件循环 lag 按需采样 + suspend 分类

`apps/gateway/src/ws/event-loop-lag.ts`：默认 **10 s** 一拍（6 唤醒/min）；`snapshot()` / `demandFast()`（failover 结束读点、非零 metrics 发射）把节奏提到 **1 Hz** 并保持 30 s。`TMEX_EVENT_LOOP_LAG_DIAG=1` 常开 1 Hz。lag 用 monotonic（`performance.now()`）；wall − mono 漂移 ≥ 2 s 记为 `suspend`，不进 `lagMs` / `maxLagMs`、不 warn。未改 `runtime.ts` 启停点（仍 `startGatewayEventLoopLag()`）。

**收益（推理）**：空闲 **60 → 6 唤醒/min**。`max_lag_ms=56675` 这类睡眠唤醒不再被当成 JS stall。

### O16 — control-mode heartbeat 仅在通道静默时发送

`control-mode-lifecycle.ts`：30 s timer 仍在；若 `lastControlActivityAt` 或最近一次 `onTerminalOutput` 距今 < 30 s，**跳过** `display-message -p "tmex-hb"`，不武装 10 s 超时。真正发出的 beat 超时语义不变。`ControlStreamMetrics` 增加 `lastRawChunkAtMs()`（`recordRawChunk` 更新，`takeIfDue` 不重置），供测试 / 后续接线。只把 **终端输出** 算作繁忙（避免 attach / `%session-changed` 让现有 connect-then-sendHeartbeat 测试误跳过）。

**收益（推理）**：有输出的设备 **2 次/min 的 tmux server 唤醒 → 0**；静默设备仍 2 次/min（检测延迟不变）。

### O17 — `node_sessions` 半程才续期

`node-session-store.ts`：`expiresAt - now < TTL/2`（9 h）才 UPDATE。`NODE_SESSION_RENEW_THROTTLE_MS` 改为 `TTL/2`（仍导出），`session-middleware` 用该常量推进时钟的测试无需改文件即可过。硬 TTL 7 d 封顶未改。

**收益（推理）**：每远端会话 **12 次写事务/小时 → ≈ 0.11 次/小时**（每 9 h 一次）；**288 → ~2.7 次写/天/会话**。WAL 空闲增长基本归零。

## 测试

新增 / 扩展：

| 项 | 覆盖 |
|---|---|
| O1 | 全零 ping / terminal_output / gateway_activity 不发；随后非零窗口仍发且计数已重置 |
| O2 | `snapshotStats()` 不推进 grace、不 trim replay、不重武装 timer |
| O11 | `createTtlCache` TTL / invalidate / refresh；fingerprint 变化后 `refreshLocalInterfaces` 让 status 带上新地址 |
| O12 | `head()` 在多次 `refreshAdvertisedStatus` 间只调一次；`notifyKeyLogHeadChanged` 后失效再读 |
| O15 | wall 跳变 vs 平稳 monotonic → `suspend`；idle 10 s、`demandFast` 提到 1 Hz |
| O16 | 近期活动跳过 beat；静默后发送且武装 10 s timeout |
| O17 | 半 TTL 边界不续；越过半 TTL 才续；紧接着不再写 |

## 验证

| Check | Result |
|---|---|
| `cd apps/gateway && bun test` | **3786 pass / 8 fail**（基线 3750 + 3 fail + 2 error 已知 flake）。本任务新增用例均不在 fail 列表。本轮 fail 为并行改动/flake：`dropped=auth` 日志（`rtc-log.ts` 他组）、stream failover、24 MiB mesh push、multi-hub token、RTC ice summary 等，非本任务文件。 |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **0** `error TS`（基线 21，未超）。 |
| `bunx biome check` 本任务改动文件 | 通过。 |
| heartbeat 回归 `local-external` / `ssh-external` `-t heartbeat` | 6 pass。 |

## 本任务改动文件

- `apps/gateway/src/ws/gateway-metrics-log.ts` + `.test.ts`
- `apps/gateway/src/ws/event-loop-lag.ts` + `.test.ts`
- `apps/gateway/src/tmux-client/retention/policy-scheduler.ts` + `.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` + `.test.ts`
- `apps/gateway/src/mesh/peer-manager.ts` + `.test.ts`
- `apps/gateway/src/auth/node-session-store.ts` + `.test.ts`
- `apps/gateway/src/tmux-client/external/control-mode-lifecycle.ts` + `.test.ts`
- `apps/gateway/src/tmux-client/control-stream-metrics.ts` + `.test.ts`（O16 的 last-raw 信号）

## 风险 / 未做

- O16 生产路径用 `onTerminalOutput` 作为繁忙信号，未改 `ExternalTmuxCore`（他组文件）。原始字节（含 heartbeat 回包）不计入繁忙，避免“发一次就永远跳过”。
- O15 未改 `runtime.ts` / `forwarder-failover.ts`；failover **开始**时不会提前升采样，结束时 `snapshot()` 会把随后 30 s 提到 1 Hz。
- 未在生产节点实测 CPU（禁止碰 9883 / 生产目录）。上表均为代码路径推理。
