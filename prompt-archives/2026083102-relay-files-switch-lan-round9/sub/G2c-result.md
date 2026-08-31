# G2c 结果：用有界 pending-writes 门替换 G2b drain 回调

## 改了什么

G2b 把 DataChannel `send()` 在留下 remainder 时改成返回 `backpressure`，SwitchBarrier 再订 `onDrain` 重试 LIVE_RESUME。review-E 指出：accepted-backpressure 与未接收混淆、无 deadline、旧 drain callback 会吞掉新事务、cancel 会伪造 `handleDrain`。G2c 整段换掉。

1. **DataChannelCarrier.send()** 回到 G2b 之前：第一片被接受、remainder 交给 `onBufferedAmountLow → flushRemainder → onDrain` 时返回 `'sent'`。已有 remainder 时新帧仍返回 `'backpressure'`。
2. **Carrier** 增加可选 `hasPendingWrites?(): boolean`。只在 DataChannel 实现：`remainder !== null || bufferedAmount > DC_HIGH_WATER_BYTES`（4 MiB）。WebSocket / LinkStream 不实现（`undefined` 视为 false）。
3. **SwitchBarrier** 删光 G2b drain 机械（`onDrain`、`awaitingLiveResume`、`drainHooked`、barrier 里的 `handleDrain`）。发 LIVE_RESUME 之前（`wantHistory:false` 的 ACK 后、以及 history `sent` 之后）若 `hasPendingWrites?.()` 为真：保持 buffering，每 25ms 再查，变假再发。等待绑定 **pending 对象 + selectToken**；对象被换掉 / token 变了 / `session.closed` 则静默放弃。deadline 1500ms（`HISTORY_TIMEOUT_MS`），到期照发；若这次仍 `backpressure`/`closed`：`markStreamGap` + `ACKED|HISTORY_APPLIED → SELECT_FAILED → STABLE`（禁止 `ACKED → STABLE`）。poll timer 进 `pending.timers`，`cancelTransaction` 会清掉。
4. History 帧 **未被接受**（`backpressured`/`dropped`）：`markStreamGap` + 立刻 `dispatchLiveResume`（不等 pending writes），与 G2 一致。
5. ACK 发送失败同样走 `failTransaction`（`SELECT_FAILED → STABLE`），修掉 review-E blocker 2。

未改 `tmux-command-handlers.ts`。

## 最终语义（5 行）

1. DC 第一片入队即 `'sent'`，remainder 内部续传；新帧撞上 remainder 才 `'backpressure'`（调用方不要重发已接受的帧）。
2. `hasPendingWrites` 只在 DC 上报告「还有 remainder 或超过 4 MiB 高水位」；WS 没有该方法 → 立刻 LIVE_RESUME（G2 回归）。
3. 成功 history / `wantHistory:false` ACK 之后：pending writes 为真则继续缓冲并 25ms 轮询，假了再发 LIVE_RESUME（DC 上通常几毫秒）。
4. 等待有 1500ms 上限且按 pending/token 作废；取消或换 token 不会迟到发送；到期仍发，失败则合法状态机收尾。
5. History 帧没被通道接受：立刻 gap + 尝试 resume，不走这扇门。

## 文件

- `apps/gateway/src/ws/carrier.ts` — 可选 `hasPendingWrites?()`
- `apps/gateway/src/mesh/rtc/data-channel-carrier.ts` — `send()` 恢复 `'sent'` + `hasPendingWrites()`
- `apps/gateway/src/mesh/rtc/data-channel-carrier.test.ts` — remainder / 70 KiB 断言 `'sent'`；drain 后 `hasPendingWrites` 为假
- `apps/gateway/src/ws/borsh/switch-barrier.ts` — pending-writes 门；去掉 drain 回调
- `apps/gateway/src/ws/borsh/switch-barrier.test.ts` — 轮询延迟、token 作废、deadline、cancel、WS 立刻 resume、ACKED 失败走 SELECT_FAILED

## 测试 / tsc

| | before | after |
|---|---|---|
| `apps/gateway` `bun test` | **3008 pass / 0 fail** | **3013 pass / 0 fail**（+5：pending-writes 门与 ACKED 失败路径） |
| `bunx tsc --noEmit -p apps/gateway` | **21** | **21** |

`bunx biome check` 上述 5 个文件：通过。

未看到预存无关失败。

## 指挥官需知

- 不必改 `tmux-command-handlers.ts`、`websocket-send-guard.ts`、`legacy-feed-broadcaster.ts`。review-E blocker 1（legacy 流在 accepted-backpressure 期间 `skippedFrame → backpressure_gap`、RTC direct 未把 drain 转给 send-guard）不在本任务路径上：G2c 让 DC 大帧重新返回 `'sent'`，SwitchBarrier 也不再订 drain。
- WebSocket / `LinkStreamCarrier` / `BunSocketCarrier` 故意不实现 `hasPendingWrites`。
- `apps/gateway/src/ws/borsh/index.test.ts` 的「history 超时且 sendLiveResume 提前 return 应兜底解除门控」仍过：`sendLiveResume` 在 `waiting` 以外仍由 timeout 兜底 `stopOutputBuffering`。
