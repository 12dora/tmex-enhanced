# G2b 结果：TERM_HISTORY → LIVE_RESUME drain-aware

## 改了什么

G2 在 TERM_HISTORY `sent` 后立刻发 LIVE_RESUME，并在发送失败时 `stopOutputBuffering` + `completeTransaction`。DataChannel 把帧切成 64 KiB 片，原先只把第一片交给 SCTP 就返回 `sent`，剩余在 `remainder`；紧接着的 LIVE_RESUME 撞上 remainder → `backpressure` → 事务被关掉、客户端永远收不到 LIVE_RESUME。

1. **SwitchBarrier**：LIVE_RESUME 真正被 carrier 接受后才停缓冲 / 转 LIVE / complete。`backpressure` 时保持 HISTORY_APPLIED（或 ACKED）+ buffering，挂 `carrier.onDrain`，drain 后用同一 token 重试；token 过期则静默放弃。history 发送 `backpressured` 时不 `markStreamGap`、不立刻 resume，等 drain 再发 LIVE_RESUME。history/ACK 超时仍在：history 超时若 `sendLiveResume` 提前 return（非 drain 等待）仍兜底 `stopOutputBuffering`（保住 `index.test.ts` 的门控泄漏用例）；若正在等 drain 则不停缓冲。
2. **DataChannelCarrier.send()**：整帧所有 fragment 刷完才返回 `sent`；留下 remainder 时返回 `backpressure`，由已有 `onBufferedAmountLow` → `flushRemainder` → `onDrain` 内部续传。未改 wire framing。

未改 `tmux-command-handlers.ts`、`carrier.ts`（现有 `'sent' | 'backpressure' | 'closed'` 足够）。

## DataChannel send 契约（对齐 WebSocket）

`CarrierSendResult` 未扩。语义：

| 返回值 | 含义 |
|---|---|
| `sent` | **整帧**已交给通道（所有 fragment 刷完，且未超 4 MiB high-water） |
| `backpressure` | 现在不能再发下一帧。两种情况：(a) 已有 `remainder` 或 bufferedAmount > 4 MiB，本帧未开始；(b) **本帧只排队了前缀 fragment**，`remainder` 非空，等 `onDrain` 内部 flush。调用方 **不要重发同一帧**（会重复），等 drain 再发 **下一帧** |
| `closed` | 通道已关 |

与 Bun WebSocket 的差别：WS `backpressure`（send === -1）表示本帧被丢掉、drain 后可重试同一帧；DataChannel remainder 的 `backpressure` 表示本帧已在内部续传。SwitchBarrier 因此在 history/LIVE_RESUME 遇 `backpressured` 时只等 drain 再发 LIVE_RESUME，不重发 TERM_HISTORY。

`onDrain` 只在 remainder 刷空且未 close 时触发（与原先 high-water 路径一致）。SwitchBarrier 在 drain 回调里先 `gatewayWebSocketSendGuard.handleDrain` 再重试，避免 send-guard 仍把后续帧标成 dropped（单测无 ws server drain 时也成立）。取消事务时若正在等 drain，同样 `handleDrain`，避免毒化下一笔 ACK。

## 文件

- `apps/gateway/src/ws/borsh/switch-barrier.ts` — drain-aware resume
- `apps/gateway/src/ws/borsh/switch-barrier.test.ts` — LIVE_RESUME backpressure 等到 drain；drain 后过期 token 忽略
- `apps/gateway/src/mesh/rtc/data-channel-carrier.ts` — remainder → `backpressure`
- `apps/gateway/src/mesh/rtc/data-channel-carrier.test.ts` — 既有 remainder 用例改为断言 `backpressure`；新增 70 KiB 用例

## 测试 / tsc

| | before | after |
|---|---|---|
| `apps/gateway` `bun test` | **2997 pass / 0 fail** | **3000 pass / 0 fail**（+3：70 KiB DC、drain 后再 LIVE_RESUME、过期 token） |
| `bunx tsc --noEmit -p apps/gateway` | **22** | **22** |

`bunx biome check` 上述 4 个文件：通过。

未看到预存无关失败。

## 指挥官需知

- 不必改 carrier 接口或 tmux-command-handlers。
- `apps/gateway/src/ws/borsh/index.test.ts`（非 owned）的「history 超时且 sendLiveResume 提前 return 时应兜底解除门控」曾因去掉无条件 `stopOutputBuffering` 失败；已在 `handleTimeout` 里对 **非 drain 等待** 恢复兜底，该文件未改。
- send-guard 对「同一批多帧中间 `backpressure`」仍会 `skippedFrame` → drain 时 `backpressure_gap` terminate。DataChannel 上典型 TERM_HISTORY（< 1 MiB maxFrameBytes）是单次 `send()` + 内部 fragment，不会踩这条。未扩范围去改 send-guard。
