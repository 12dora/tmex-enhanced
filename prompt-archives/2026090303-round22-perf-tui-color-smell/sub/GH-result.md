# GH 结果：T6 mesh view 解码 + T9 legacy 背压 resync

## 改动文件

- `apps/gateway/src/mesh/stream-replay-state.ts` — `tryDecodeEnvelope` 改走 `decodeEnvelopeView`
- `apps/gateway/src/mesh/stream-targets.ts` — `acceptWsStream` 入站同样改 view
- `apps/gateway/src/ws/websocket-send-guard.ts` — 丢帧 drain 发 Stream `SourceGap`，不再 `terminate('backpressure_gap')`；硬顶 4 MiB 仍关连接
- `apps/gateway/src/runtime.ts` — `backpressureLimit` 1 MiB → 4 MiB，`closeOnBackpressureLimit: true` 保留
- 测试：`stream-replay-state.test.ts`、`stream-targets.test.ts`、`websocket-send-guard.test.ts`
- 新 bench：`apps/gateway/bench/envelope-view.bench.ts`
- **例外改动** `apps/gateway/src/ws/index.test.ts`：原断言「skipped drain → terminate」与 T9 新语义冲突，必须改，否则 `src/ws` 少一次 pass。生产代码 `ws/index.ts` 未改。`forwarder.ts` 无需改（已走 `noteOutbound` / `noteInbound`）。

## T6

`noteOutbound` / `noteInbound` / `rewriteQueuedFrame` / `paneSubPayloads` 以及 mesh `acceptWsStream` 只读 `kind`/`seq`（及随后对 payload 的 schema 解码）。逐分支核对：

- 持久化一律 `bytes.slice()`（HELLO / DEVICE_CONNECT / SUBSCRIBE / SELECT / AGENT），不是 `env.payload`
- schema 解码（`decodePayload` / `decodeCanonical*` / `peekCanonicalPaneDataHeader`）自行拷贝；`ScreenChunk` 只读 `byteLength`
- `stream-targets` 不持有 envelope；`attachStreamSession.onDecodedEnvelope`（`index.ts`，他组）已对 view payload `slice()`

32 KiB TERM_OUTPUT（`bun apps/gateway/bench/envelope-view.bench.ts`）：

| | µs/op |
|---|---:|
| `decodeEnvelope`（copy） | 55.852 |
| `decodeEnvelopeView` | 0.248 |
| **加速** | **225×** |

报告里的 ~300×（110 µs → 350 ns）是另一台测量；本机 copy 已更快，view 仍是常数时间。单元测试断言 view ≥ 10×，并锁死一组录制帧序列的 replay 决策（connect / subscribe / select / canonical cursor / disconnect）。覆盖原缓冲被 `fill(0)` 后 stored hello/device 仍可解。

## T9

**未发明新 wire kind。** `LIVE_RESUME` 需要匹配 `selectToken` 且只在 SELECT 事务里生效，无事务时客户端直接丢弃。已有且客户端在 legacy / canonical 都会处理的是 `KIND_CANONICAL_EVENT` + `SourceGap`（`SOURCE_GAP_REASON_PANE_GAP`，`scope: { Stream: {} }`）→ `rebase-required` → 所有挂载 pane `requestPaneScreen`（legacy 同时 `beginPaneHistoryGate`）。与 canonical `pane-stream` 丢字节后发 `pane_gap` 同族。

行为：

- 背压窗口内静默丢终端帧（不变）
- drain 且发生过 skip / `markStreamGap`：优先发一帧 Stream SourceGap，socket 保持打开
- 同一窗口无论丢多少帧只发一次；下一次独立 gap 再发一次
- `bufferedAmount >= 4 MiB` 或 send 返回 closed / 超时 / oversized：仍 terminate
- resync 自身 `dropped` 才回退 terminate

**把 Bun `backpressureLimit` 从 1 MiB 提到 4 MiB 的数字：**

- guard 在首次 `send() === -1` 后已停写 TERM_OUTPUT，1 MiB `closeOnBackpressureLimit` 对数据面基本冗余
- 旧 1 MiB 硬关 ≈ 16 × 64 KiB legacy 帧（canonical 32 帧）；`closeOnBackpressureLimit: true` 时越限的那次 send 往往直接关连接，guard 看不到 −1
- 4 MiB = 64 × 64 KiB，仍是 Bun 默认 16 MiB 的 1/4；给「第一次 −1 之前已经入队的突发」留余量，让 drain+SourceGap 有机会跑完
- `closeOnBackpressureLimit: true` 仍是最后手段；guard 在同一 4 MiB 处也会 `backpressure_gap` 关掉（单测覆盖）

## 测试 / tsc / biome / gate

- `cd apps/gateway && bun test src/mesh src/ws`：**1409 pass / 0 fail**（104 files）
- `bunx tsc --noEmit -p .`：0 error（基线 0）
- `bunx biome check`（本任务改动文件）：通过
- `bun scripts/complexity/gate.ts`：失败项是 `packages/panels/src/markdown/streaming-markdown.tsx`（并行 U3），**不是本任务文件**。GH 文件未进超标名单。

## 未做 / 限制

- 未改 `ws/index.ts`（他组）。入站 `decodeEnvelope` 仍是他们的 T6 尾巴。
- `index.test.ts` 的测试名/断言因 T9 语义必须改，已在上文说明。
- 未改 mesh-runtime / peer-manager / legacy-feed-broadcaster / terminal-output-batcher。
