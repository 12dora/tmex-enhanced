# G3 result — hub node.list 预编码、O(1) peer 查找、deadline timer

## What changed and why

1. **`broadcastNodeList`**：投影编一次，同一 `Uint8Array` 发给所有 link；per-link `try/catch` 保留在 `sendBytes`。用 `version: 0` 的编码当指纹，投影未变则整网不发。`listVersion` 只在真正发送时递增。新节点 auth 时若投影未变，仍把缓存的上一份 `node.list` 发给该 link（否则 ghost/无投影变化的登录收不到列表）。
2. **`applyPeerStatus`**：`listPeers().find` 换成主键 `getPeer(nodeId)`。endpoints / inventory / `directCapable` 归一化后无变化则不 `upsertPeer`、不跑 upgrade；`lastSeenAt` 走窄更新 `touchPeerLastSeenAt`（item 2 要求保留 lastSeen 语义；scope 写了 only `getPeer`，但没有窄更新就无法在跳过全量 upsert 的同时写 lastSeen）。
3. **Idle / park / retire**：不再 1s×300 / 250ms×120 轮询。`MeshScheduler` 没有 `timeout`（types 不在 scope），用 `interval(remainingMs)` 当 one-shot：idle 间隔 = `idleMs`，park = 距 30s 上限的剩余，retire = `min(30s max, max(5s min, quiet 2s))`。stream 开/关与 quiesce ack 上 re-arm。回调里不 re-arm，以免 `ImmediateScheduler.tickIntervals` 死循环。时间门（quiet 2s / min 5s / max 30s）仍在回调里检查，假时钟提前 tick 不会误关。

未改 `packages/shared/src/uplink/codec.ts`：`encodeUplinkCtl` 已返回字节。

## Files

- `apps/gateway/src/hub/uplink-server.ts` — 预编码、指纹 skip、`sendBytes`、auth 补发缓存 list
- `apps/gateway/src/hub/uplink-server.test.ts` — N link 同引用编码；未变不发；冗余 broadcast 用例改用 auth 时的 list
- `apps/gateway/src/auth/user-store.ts` — `getPeer`、`touchPeerLastSeenAt`
- `apps/gateway/src/auth/user-store.test.ts` — `getPeer` 命中/缺失
- `apps/gateway/src/mesh/peer-manager.ts` — O(1) status、投影变更才 upsert、deadline timer
- `apps/gateway/src/mesh/peer-manager.test.ts` — 变更 vs 未变 status；idle / park / retire 假时钟；双 quiesce 立即结束

## Measurement（100 links）

Bench: `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/g3-broadcast-bench.ts`

payload ≈ 34.8 KiB，100 recipients，20 轮平均：

| 路径 | ms |
|---|---|
| before：每 link `encodeUplinkCtl` + send | 7.850 |
| after：encode 一次 + 复用 bytes | 1.304 |
| `broadcastNodeList` 首次（含 DB 投影） | 7.083 |
| `broadcastNodeList` 投影未变 skip | 0.916 |

约 6× 去掉 N−1 次 JSON/UTF-8 编码。skip 路径不再 fanout。

## Verify

- `cd apps/gateway && bun test src/hub src/mesh src/auth`：592 pass / 0 fail（含 `peer-manager.test.ts`，无 EADDRINUSE）
- `bunx tsc --noEmit -p .`：21 errors（= 本轮基线 21），触及文件 0
- biome：6 个改动文件 clean

## Left / risk

- 投影未变时不再给已在线节点升 `version` 重发 `node.list`（含 key.log 相同记录重试）。新登录仍能拿到缓存列表。
- `touchPeerLastSeenAt` 是 scope「only getPeer」之外的 4 行；没有它，未变 status 要么丢 lastSeen，要么仍全量 upsert。
- deadline 仍走 `interval`，真实时钟上第一次回调即到期；假时钟依赖时间检查，与旧 poll 测试兼容。
- `hasWsSecureCandidate` / `shouldTryDc` 仍是 `listPeers().find`，不在本任务范围。
