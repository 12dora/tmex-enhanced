# G9 result — RTC bulk backpressure, watch monotonic clock, snapshot coordinator phase

review-be3 findings 1–6 已在代码中核实并落地。未改 `files/**`、`forwarder`、`peer-handshake`。

## 改了什么、为什么

### 1–2. bulk 上传队列预算 + append 续期 idle watchdog（blocker + should-fix）

`onMessage` 把每一帧 `copyBytes` 后挂到无界 `ch.io` 链上。下载方向的背压是**发送侧** `bufferedAmount` / high-water（`waitDrain`），`DataChannelLike` **没有**接收暂停 API，bulk 协议也没有 credit/ack。无法暂停对端时，超过预算只能干净失败。

- 默认 `BULK_UPLOAD_QUEUE_BUDGET_BYTES = 8 MiB`（可注入 `uploadQueueBudgetBytes`）
- 入队前若 `queuedBytes + frame > budget` → `{ok:false, code:'backpressure'}` + `abortTransfer`
- 成功 `appendUpload` 后 `armIdle`：磁盘进度算活动，避免 backlog > 30s 时把仍在写盘的上传 idle abort

### 3. Watch 调度单调钟，去掉 delta-accumulation adapter

`WatchRuleScheduler` 的 `now` 就是 deadline 时钟，默认 `performance.now()`，不再把相邻采样的正 delta 累加。`WatchService` 的 `deps.now()` 只给事件时间戳；可选 `monotonicNow` 给测试注入。墙钟回拨/前跳不再推迟或瞬间到期。`armGroup` 对 `performance.now()` 浮点差 `Math.round`，避免 4999.91 vs 5000。

Rollback 测试不再在回拨前采样 4s。另测墙钟前跳不制造数小时 delay。

### 4. SnapshotRefreshCoordinator 分 phase

- `waiting`：quiet wait（含尚未装上 `cancelQuiet` 的同一 tick）里到达的 `request()` **不**记 trailing，即将到来的 refresh 已经覆盖
- `refreshing`：refresh() 期间的请求仍 coalesced trailing 一次
- `requestImmediate()` 在 `phase !== 'refreshing'` 时设 `skipQuiet` 并 `cancelQuiet?.()`，同一 tick `request(); requestImmediate()` 在 wait 开始前升级，总共一次 refresh

有限 burst：初始 refresh + 一次 coalesced，没有第三次。

## 文件

- `apps/gateway/src/mesh/rtc/bulk.ts`（+ `bulk.test.ts`）
- `apps/gateway/src/watch/scheduler.ts`（+ `scheduler.test.ts`）
- `apps/gateway/src/watch/service.ts`（clock injection only，+ `service.test.ts`）
- `apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts`（+ `.test.ts`）

## 测量

scratchpad：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/g9-bench.ts`

| | before | after |
| --- | --- | --- |
| 上传 5×80B 慢 append，预算 200B 时队列 | 400 B 全入队 | 160 B，第 3 帧 `backpressure` |
| 墙钟注入 scheduler 后回拨 1h 的 re-arm delay | 3 605 000 ms | 5 000 ms（monotonic） |
| 有限 burst（refresh 中 + quiet wait 中）refresh 次数 | 3 | 2 |

## 测试 / tsc / biome

- `cd apps/gateway && bun test src/mesh/rtc src/watch src/tmux-client/snapshot-refresh-coordinator.test.ts`：**235 pass / 0 fail**（22 files）
- gateway `tsc --noEmit`：**21**（等于 baseline 21）
- `bunx biome check` 上述 8 个文件：**clean**

## 残留 / 风险

- 磁盘跟不上、队列超过 8 MiB 的上传会收到 `backpressure` 并清理临时文件。浏览器 `bulk-client` 把任意 `{ok:false, code}` 当失败（可回落 REST）。这是刻意的行为变化：协议无法暂停发送端。
- `code: 'backpressure'` 是新错误码；旧客户端只当通用失败，不区分。
- 连续 1s 结构通知的刷新上限测试仍要求 6–7 次；phase 修复不改变持续负载下的 quiet-period 速率。
