# G7 — RV3 后端 hardening 完成

RV3 全部后端 finding 已按当前代码核对并落地。FE 项不在范围内。

## 改动摘要

1. **write-forward 围栏**：帧追加 `writerHubId`/`writerEpoch`（legacy 剥离）。执行前校验 `isWriter()`、本机 ID、当前 epoch；不匹配回 409 `HUB_NOT_WRITER` ack。
2. **Hub 禁止 RTT 切换**：`UplinkPool.localRoles.hub` 时 `preferNearestActive` 恒为 false，写者 uplink 保持控制面。文档 RTT 节已写明「仅纯 node」。
3. **统一 live/generation 门控**：`hub.tokens` / `attachments` / `forward` / write-forward ACK / relay 由 pool 在 `live === client` 时才回调，并传入实际 `{hubNodeId, generation}`。writer-only 帧再核来源与 epoch。
4. **附件保活**：2 min 重发本机全量；授权 hub 的 uplink `pong` 调用 `refreshHub`。安静但仍在线的远端路由不会过 TTL。
5. **attachments 分页**：`{snapshotId, page, final}`，≤48 KiB/帧，单帧条目上限 256，发送前 assert 编码尺寸，接收端 `final` 页原子应用。
6. **跨 hub online**：`node.list.online` = 本地 registry **或** 未过期附着路由；过期/撤销后翻回 offline。`/api/mesh/nodes` 经 `listHubOnline` 吃这份投影。
7. **分片 ACK**：超 48 KiB 的 write-forward ACK 按 `{id, part, final, bytes}` 切分，standby 重组。请求体发送前尺寸检查，超限 413 `payload_too_large`。
8. **幂等缓存**：writer 侧有界 LRU，键 `(fromHubId, id)`；同 digest 重放 ACK，不同 digest 409 `idempotency_conflict`。
9. **Auto-promote**：不可达计时与 quorum 按 `(writerHubId, writerEpoch)`；只计 epoch 匹配的票；新鲜度用本机 `receivedAt`，不用对端 `observedAt`。
10. **启动广告**：`tlsInfo` 仅在 HTTPS listener `running` 时给出 CA 指纹；listener 失败则保持/撤回为 null。`onStatusChange` 在 apply 成功后刷新广告。
11. **Relay 边界**：`crossHubStreams` 在 `stream.closed`/`onAbort` 上摘除并删空集合；`RtcHubRouteTable` LRU 上限 1024；hub-relay OPEN 先检查 8 KiB 再 JSON，`visitedHubIds.length ≤ hop` 后才映射。

## 文件

- `packages/shared/src/uplink/codec.ts` + `codec.test.ts`
- `apps/gateway/src/hub/writer-forward.ts` + test
- `apps/gateway/src/hub/hub-attachments.ts`（新）
- `apps/gateway/src/hub/attachment-router.ts` + test
- `apps/gateway/src/hub/hub-relay.ts` + test
- `apps/gateway/src/hub/hub-peer-poller.ts` + test
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/uplink-server.ts` + test
- `apps/gateway/src/hub/index.ts`
- `apps/gateway/src/mesh/uplink-pool.ts` + test
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/mesh/rtc/signaling.ts` + test + `index.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` + harness（`online` 投影）
- `packages/app/src/runtime/assemble.ts` + test
- `docs/hub/2026090104-multi-hub-standby.md`

未改 `mesh-routes.ts`（online 已由 `node.list` → `listHubOnline` 传导）。未改 `server.ts`（与 `tls-service.onStatusChange` 协调即可）。

## 测试 / tsc

| 包 | bun test | tsc --noEmit |
|---|---|---|
| `apps/gateway` | **3508 pass / 0 fail**（329 files） | **0** |
| `packages/shared` | **430 pass / 0 fail** | **0** |
| `packages/app` | assemble + tls-service 64 pass | **1**（预存 `TS2688` `@types/node`） |

Biome check 已对全部改动文件 `--write`，干净。

覆盖：stale-generation `hub.tokens` 丢弃、fenced ex-writer write-forward 拒绝、pong 刷新路由、分页 snapshot 原子应用、跨 hub `online`、分片 ACK 重组、幂等重放、hub 角色不 RTT 切换、listener 未 running 不广告指纹。
