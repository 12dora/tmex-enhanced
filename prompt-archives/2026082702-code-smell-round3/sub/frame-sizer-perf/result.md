# frame-sizer-perf 结果

## 背景

Canonical pane-data 热路径原先用 Borsh 实编做二分探测：`eventFits()` 每次完整序列化，`maxVariableDataBytes()` 约 `log2(cap)` 次探测（1 MiB 上限约 20 次，且每次 `new Uint8Array(middle)`）。`sendPaneData` 每个分段再算一次 max，随后 `send()` 再 `eventFits()`，真正出站时 `codec-borsh.ts` 还要再编一次 envelope。

## 改动

1. **精确尺寸**：新增 `encoded-size.ts`，按 Borsh schema 计算 payload 字节数（固定宽字段 + `u32` 长度前缀 + option tag + enum tag + envelope 16 字节），不再序列化。
2. **替换二分**：`maxPaneDataBytes` / `maxContentChunkBytes` 用「空 data 前缀 + `min(maxFrameBytes-16, CANONICAL_STATE_MAX_PAYLOAD_BYTES)`」一次算出最大 data。
3. **缓存**：按 `(eventKind, target.deviceId, target.paneId, serverEpoch.byteLength, paneEpoch.byteLength)` 缓存 max data（`maxFrameBytes` 在 sizer 实例上）。
4. **去掉二次 eventFits**：已按 max 切片的 PaneData / ScreenChunk / HistoryChunk 走 `sendFitted()`，只检查 session 是否关闭。其它事件仍走 `send()` + `eventFits()`（现为 O(1) 算术）。
5. **基准**：`apps/gateway/bench/frame-sizer.bench.ts`，`package.json` 增加 `bench:frame-sizer`。

## 文件

- `apps/gateway/src/ws/canonical/encoded-size.ts`（新）
- `apps/gateway/src/ws/canonical/frame-sizer.ts`
- `apps/gateway/src/ws/canonical/frame-sizer.test.ts`
- `apps/gateway/src/ws/canonical/pane-stream.ts`
- `apps/gateway/src/ws/canonical/transaction-sender.ts`
- `apps/gateway/src/ws/canonical/transaction-sender.test.ts`
- `apps/gateway/bench/frame-sizer.bench.ts`（新）
- `apps/gateway/package.json`（仅加 `bench:frame-sizer`；与并行 agent 的 `bench:parser` / `bench:retention` 共存）

未改 `packages/shared`、`ws/borsh/**`、`ws/index.ts`。

## 基准（同一脚本，改前/改后）

`bun ./bench/frame-sizer.bench.ts`；`fitChecks` 为 `eventFits` 调用次数（改前 ≈ Borsh encode 次数）。maxData 前后一致。

### BEFORE（二分 + 每次实编）

| 路径 | cap | cold | hot / call | fitChecks | maxData |
|---|---|---|---|---|---|
| maxPaneDataBytes | 4 KiB | 1.64 ms | 357.49 µs | 12 | 4007 |
| sendPaneData | 4 KiB | — | 219.31 µs | 14 | — |
| maxPaneDataBytes | 64 KiB | 1.93 ms | 1.82 ms | 16 | 32679 |
| sendPaneData | 64 KiB | — | 2.02 ms | 19 | — |
| maxPaneDataBytes | 1 MiB | 5.23 ms | 5.52 ms | 20 | 32679 |
| sendPaneData | 1 MiB | — | 5.42 ms | 23 | — |

64 KiB / 1 MiB 的 maxData 都被 `CANONICAL_STATE_MAX_PAYLOAD_BYTES=32752` 卡住（空 PaneData payload 73，故 32679），但二分仍按 1 MiB 搜索空间探测并分配大 buffer。

### AFTER（精确计算 + 缓存 + sendFitted）

| 路径 | cap | cold | hot / call | fitChecks | maxData |
|---|---|---|---|---|---|
| maxPaneDataBytes | 4 KiB | 236.71 µs（首次 JIT） | 872 ns | 0 | 4007 |
| sendPaneData | 4 KiB | — | 4.40 µs | 0 | — |
| maxPaneDataBytes | 64 KiB | 6.92 µs | 227 ns | 0 | 32679 |
| sendPaneData | 64 KiB | — | 11.49 µs | 0 | — |
| maxPaneDataBytes | 1 MiB | 3.79 µs | 254 ns | 0 | 32679 |
| sendPaneData | 1 MiB | — | 10.88 µs | 0 | — |

热路径加速：`maxPaneDataBytes` 约 400×–20,000×；`sendPaneData` 约 50×–500×。4 KiB 的 AFTER cold 偏高是该进程第一次走到 sizing 的 JIT，后续 cold 约 4–7 µs。

## 测试 / tsc / biome

- `bun test src/ws/canonical/frame-sizer.test.ts src/ws/canonical/pane-stream.test.ts src/ws/canonical/transaction-sender.test.ts src/ws/canonical-feed-session.test.ts`：22 pass / 0 fail。
- size-invariant：64 组随机 (data 长度, ids, epochs) + 32 组 chunk；精确尺寸 = 实编 payload；max data 贴合 cap，再多 1 字节则 `eventFits=false`。另覆盖 FeedReady / Error / SourceGap / Screen|History begin/commit / SubscriptionApplied / metadata snapshot+patch、非法 epoch、seq 错配、payload cap。
- 全包 `bun test`：1533 pass / 1 fail。失败是 `src/tmux-client/local-external-connection.test.ts`「disconnect during control attach…」（runtime-cancel 并行任务），与本改动无关。基线 1473 已因其它 agent 增测而升高。
- `bunx tsc --noEmit -p .`：31 个 error，**本任务文件 0 条**。基线 27；多出的来自 issue45 / supervisor / local-external / telegram / ssh 等并行改动。
- `bunx biome check --write`：本任务文件通过。

## 未做与原因

- **出站仍会 Borsh 编码一次**：`codec-borsh.encodeCanonicalEvent` / `ws/index.ts` 不在范围内。sizing 已不再编码；真正发送仍必须在 codec 编 envelope。若要「编一次、sizing 与 send 共用 payload」，需要 shared 侧暴露「只算长度」或「接受已编码 payload」的 helper，再改 `ws/borsh/**` 与 `ws/index.ts`。
- **未把 size helper 放进 `packages/shared`**：gateway 本地实现已与 schema 对齐，并由 invariant 测试钉死；shared 改动会超出 scope。
- **metadata partition 仍逐条 `eventFits`**：已改为算术而非实编，收益足够；未再做增量尺寸累加。
