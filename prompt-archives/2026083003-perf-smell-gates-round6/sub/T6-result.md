# T6 结果 — 上传路径统一（HTTP + RTC 同一 per-session 队列）+ watch 单调时钟

## 做了什么

针对 Z2 HIGH（upload 串行化未覆盖 mesh/RTC）和 MEDIUM（watch 用墙钟）。

### 1. HTTP / RTC 走同一条 per-session 队列

- 删除同步 `appendUploadChunk`（`appendFileSync`）。无剩余调用方。
- `FilesBulkHooks.appendUpload` 改为 async，经 `appendUploadChunkAsync` 入队；调用时快照 `session.received` 作为 offset（与 HTTP PUT 显式 offset 同一套校验）。
- `BulkTransferService` 每 channel 一条 `io` promise 链：put 数据 `await appendUpload`，`done` 排在未完成写入之后。abort/close 仍立即 `fail`；排队中的 write/done 见 `state !== 'put'` 则退出。append 抛错 → `unknown`。

交错：HTTP `appendUploadChunkAsync(offset=0)` 在 `fsPromises.write` 中挂起时，RTC `appendUpload` 仍看到 `received === 0` 并入队同一 offset → 恰好一个成功，磁盘只有胜者的 3 字节。

### 2. Watch 默认单调时钟；注入时钟回拨不推迟

- 默认 `performance.now()`（不再 `Date.now`）。
- 注入时钟保留。内部把 raw clock 折成从首次采样起的单调 elapsed（回拨不减少 elapsed，`Math.floor` 保持整数 delay）。
- `WatchService` 仍注入墙钟 `deps.now().getTime()`（本任务不能改 service.ts）；折算后 NTP/手动回拨不会把 due 推到一小时后。

## 文件

- `apps/gateway/src/files/transfer-session.ts`（删 sync append）
- `apps/gateway/src/files/transfer-session.test.ts`
- `apps/gateway/src/api/files.ts`
- `apps/gateway/src/api/files.test.ts`（HTTP 挂起 vs RTC 同 offset）
- `apps/gateway/src/mesh/rtc/bulk.ts`（仅 appendUpload hook 路径）
- `apps/gateway/src/mesh/rtc/bulk.test.ts`（slow append 必须在 done 之前完成）
- `apps/gateway/src/watch/scheduler.ts`
- `apps/gateway/src/watch/scheduler.test.ts`（回拨 + 默认 `performance.now`）

## 测量

scratchpad：`t6-measure.ts`。Z2 复现：5s 规则，时钟 4000 → −3_600_000。

| | BEFORE | AFTER |
|---|---|---|
| watch delays | `[5000, 3605000]`（Z2） | `[5000, 1000, 1000]` |
| watch dueAfterRollback | `[]` 且下一 delay ≈ 1h | `[]`，剩余仍 1000ms |
| HTTP∥RTC 同 offset=0 | 两个都 `ok`（文件交错/重复 offset） | `ok=1, bad=1, bytes=3`（2.36ms） |

上传是正确性修复，不是热路径加速。

## 验证

- `cd apps/gateway && bun test src/files src/api src/mesh/rtc src/watch` → **707 pass / 0 fail**（58 files）
- T6 文件 `bunx tsc --noEmit -p .` 无新错误（`transfer-session` / `files` / `bulk` / `scheduler` 均 0）
- 整包 tsc 目前被并行 agent 污染（`uplink-client.ts` 等，非本任务）；T6 范围未引入错误。基线曾为 21。
- `bunx biome check` 上述 8 个文件 → **clean**

RED：修前 HTTP 挂起 + RTC sync 两边都成功；回拨 delay=3605000；默认时钟走 `Date.now`；bulk 不 await 时 slow hook 的 `done` 抢跑。

## 未做 / 风险

- 未改 `watch/service.ts`（范围外）。生产仍注入墙钟，但 scheduler 折算后行为已单调。
- `ScheduledRule.deadline` 现在是相对首次 `now()` 的 elapsed，不再是 epoch ms。调度器内部自洽；外部没有读 deadline。
- RTC 连续帧依赖 bulk 的 `io` 链：若跳过 await，第二帧会在 `received` 仍为 0 时入队而 `bad_offset`。现有 happy-path / 64KiB 分帧测试覆盖此路径。
- abort 不排队：in-flight `appendUpload` 结束后若 session 已删，走既有 `cancelled` → bulk `invalid` + cleanup。
