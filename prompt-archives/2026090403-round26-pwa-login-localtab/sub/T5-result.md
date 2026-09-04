# T5 result — `GET /api/relay/metrics` + missing counters

## 做了什么

- 新增 `RelayMetricsCollector`（5s 采样、60 条 ring、timer `unref`，`stop()` 停表），由 `RelayRuntime` 启动/关闭。
- 管理路由 `GET /api/relay/metrics`（`adminAuth.authorize()`，与 `/status` 同鉴权）。`?members=0` 从 JSON 中省略 `members`。响应形状对齐 `packages/api-client/src/relay/metrics-types.ts`；不含 token hash、密钥、密封包字节、key-log。
- 字节语义（代码注释 + handler）：`bytesIn` = 从成员收到的字节，`bytesOut` = 发给成员的字节；租户累计对同一份中转字节 in/out 各记一次（与 `RelayMetering` 落库一致）。成员 live counter 按方向：源 `bytesIn`、目标 `bytesOut`。
- 计数器：
  - 成员 RTT：`noteRelayPing`/`noteRelayPong`；`connectedAt` + `reconnects`（替换或再次接入 +1，断线后仍保留）。
  - 成员流数：`reserveMemberPair`/`releaseMemberPair`。
  - `LinkMux.stats()`：`sendFrame`/`handleFrame` 累加 frames/bytes；openStreams 不含 ctl。
  - `sealed_pack_updated_at`：migration 0046，`putPack(now)` 写入，`rotateRoot` 清空。
  - 进程：`memoryUsage`、`cpuUsage` 差值利用率、`loadavg` 全 0 则为 null、既有 event-loop sampler、`openSockets`、`authenticatedLinks`。
- 成员 `name`：`relay_nodes` / node list 无 name 字段，恒为 `null`。
- `RelayAdminApi.metrics()`；`members: false` → `?members=0`。

## 文件

- `packages/shared/src/link/mux.ts`、`mux.test.ts`
- `apps/gateway/src/relay/relay-metrics.ts`、`relay-metrics.test.ts`、`relay-registry.ts`、`relay-registry.test.ts`、`relay-metering.ts`、`relay-stream-router.ts`、`relay-uplink-server.ts`、`relay-uplink-auth.ts`、`relay-tenant-store.ts`、`relay-pack-http.ts`、`relay-admin-routes.ts`、`relay-runtime.ts`、`types.ts`
- `apps/gateway/src/db/schema/relay.ts`、`managed-migrations.ts`、`relay-pack-updated-at.migration.test.ts`
- `apps/gateway/drizzle/0046_relay_pack_updated_at.sql`、`drizzle/meta/_journal.json`
- `packages/api-client/src/relay/admin-api.ts`、`admin-api.test.ts`

未改 `metrics-types.ts`、`apps/fe/**`、`apps/gateway/src/mesh/**`。

## 测试

| 范围 | before | after |
|---|---|---|
| `apps/gateway` `src/relay` | 126/0 | **134 pass / 0 fail / 0 errors** |
| `apps/gateway` `src/relay` + `src/db` | — | **247 pass / 0 fail** |
| `packages/shared` `src/link` | — | **67 pass / 0 fail** |
| `packages/api-client` | 218/0 | **219 pass / 0 fail** |
| tsc `apps/gateway` / `packages/shared` / `packages/api-client` | 0 | **0 errors** |
| biome（本任务触及文件） | — | **clean** |

`mux.ts` 在 allowlist 文件行上限 807：实现 `stats()` 后压到 798 行，未改 allowlist。

## 未做 / 注意

- 成员显示名：中继侧没有 name 列，`name` 只能是 `null`。
- 生产链路是 `WebSocketLink`（未在 scope 内改）；采集端用 `stats()` 或内部 `mux.stats()` duck-type 聚合。
- 全仓 `bun scripts/complexity/gate.ts` 仍有 `apps/gateway/src/mesh/forwarder.ts` 违规（另一 agent 范围），本任务文件未新增门禁项。
