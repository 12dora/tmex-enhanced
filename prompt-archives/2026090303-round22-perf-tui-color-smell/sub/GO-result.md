# GO 结果：B15 `canonical-state-client.ts` 减重 + 命令克隆合一

## 改动文件

- `packages/ws-client/src/canonical-state-client.ts` — 抽走 metadata identity / snapshot ingest / PaneData 判定 / 订阅指纹 / rejection 应用
- `packages/ws-client/src/canonical-state-helpers.ts` — `clonePendingCommand` 升级为唯一实现；`paneEpochsFromRecords` 迁出
- `packages/ws-client/src/websocket-transport.ts` — 删除本地 `cloneCommand` / `mergeSendResult` / `orderedInput`，改 import helpers
- **新建** `packages/ws-client/src/canonical-metadata-identity.ts` — 纯函数（含 ingest 编排）
- **新建** `packages/ws-client/src/canonical-metadata-identity.test.ts`
- **新建** `packages/ws-client/src/canonical-state-helpers.test.ts` — clone 隔离单测

未改：`client.ts`、`index.ts`、`direct/*`、`pane-output-coalescer.ts`、`protocol-dispatcher.ts`、`canonical-pending-commands.ts`（继续 import `clonePendingCommand`）。

## 行为锁

- `handleEventPayload` 仍先 `peekCanonicalPaneDataHeader`，命中后 `handlePaneData(..., true)` 再 `data.slice()`；未命中才 `decodeCanonicalEventPayload`
- `isLegacySizeCommand`（resize / sync-size 走 legacy 控制面）原样留在 `websocket-transport.ts`，含 round 21 注释

## 行数

| 文件 | 前 | 后 |
|---|---:|---:|
| `canonical-state-client.ts` | 892 | **740**（目标 ≤750） |
| `canonical-state-helpers.ts` | 201 | 199 |
| `websocket-transport.ts` | 434 | 392 |
| `canonical-metadata-identity.ts` | — | 391 |

门禁余量：900−740=160 行。

## 测试 / tsc / biome / gate

- 基线 `cd packages/ws-client && bun test`：**398 pass** / tsc **0**
- 之后：**407 pass / 0 fail**（+9：identity 8 + clone 1）；既有 `canonical-state-client*.test.ts`（含 96-round decode-equivalence）、`canonical-roundtrip.test.ts`、`websocket-canonical-gate.test.ts` 原样通过
- `bunx tsc --noEmit -p .`：0 error
- `bunx biome check`（本任务 6 个文件）：通过
- `bun scripts/complexity/gate.ts`：`complexity gate ok`

## 未做 / 限制

- `canonical-pending-commands.ts` 不在拥有列表，未改；它已走 helpers 的 `clonePendingCommand`，自动吃到统一实现
- clone 对非 screen/history 命令从「返回原引用」变为浅拷贝（与原 `websocket-transport.cloneCommand` 对齐），pending 队列更安全；既有测试无对象身份断言
