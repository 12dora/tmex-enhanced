# T5b result — review fixes for commit 18a25a8a (relay metrics)

## 做了什么

1. **frames 速率单调累计**  
   `RelayMetricsCollector` 持有 process 级 `retired{framesIn,framesOut,bytesIn,bytesOut}`。`RelayRegistry.onLinkRemoved` 在 `removeLink` / 替换 / `clear` 时把该链路最终 `stats()` 折入 retired；采样累计 = retired + Σ online。`muxStatsOf` 只调公开 `stats()`，不再 duck-type 私有 `mux`。  
   `WebSocketLink.stats()` 委托给内层 mux。

2. **新 key / 回绕速率**  
   有 baseline 之后，tenant/member 缺 previous 视为 prev=0；`curr < prev` 视为计数器复位，delta = curr（不再 clamp 成 0）。

3. **心跳 RTT**  
   `beat()` 在 `awaitingPong` 期间只加 miss / 检查超时，不覆盖 `pingAt`、不发第二发 ping；pong 到达后才允许下一发。

4. **forget 记账**  
   metering / registry 都有幂等的 `forgetMember` / `forgetTenant`（`metering.forget` 仍是 tenant 别名）。  
   - 吊销：`disconnectNode(..., 'revoked')`（key-log append 与 pack-http 共用）  
   - 删租户：`handleRelayTenantDelete` 同时 `metering.forgetTenant` + `registry.forgetTenant`  
   kick 不断开成员身份，不清 reconnect（成员仍可重连）。关闭回调后再 `forget*` 安全。

5. **`RelayAdminApi.metrics` overload**  
   `metrics({ members: false })` → `Promise<Omit<RelayMetricsResponse, 'members'>>`；默认 overload 仍是完整类型。`members` 未改成 optional。

## 文件

- `apps/gateway/src/relay/relay-metrics.ts`、`relay-metrics.test.ts`
- `apps/gateway/src/relay/relay-registry.ts`、`relay-registry.test.ts`
- `apps/gateway/src/relay/relay-metering.ts`
- `apps/gateway/src/relay/relay-uplink-server.ts`、`relay-uplink.test.ts`
- `apps/gateway/src/relay/relay-admin-routes.ts`、`relay-admin.test.ts`
- `apps/gateway/src/relay/relay-test-harness.ts`（透传 `heartbeatMissLimit`）
- `packages/shared/src/link/websocket-link.ts`、`websocket-link.test.ts`
- `packages/api-client/src/relay/admin-api.ts`、`admin-api.test.ts`

未改 `mux.ts`（已有 `stats()`）、`metrics-types.ts`、`apps/fe/**`、`apps/gateway/src/mesh/**`。

## 测试

| 范围 | before | after |
|---|---|---|
| `apps/gateway` `src/relay` | 134 pass / 0 fail（T5） | **143 pass / 0 fail / 0 errors** |
| `packages/shared` `src/link` | 67 pass | **68 pass / 0 fail** |
| `packages/api-client` | 219 pass | **219 pass / 0 fail** |
| tsc `apps/gateway` / `packages/shared` / `packages/api-client` | 0 | **0 errors** |
| biome（本任务触及文件） | — | **clean** |
| `bun scripts/complexity/gate.ts` | — | **ok**（无本任务新增违规；forwarder.ts 非本范围） |

## 未做 / 注意

- `handleRelayTenantKick` 不清 metering/registry：kick 只作废令牌并断开，成员行仍在，重连计数应保留。
- 吊销后若 stream pump 再 `recordMember`，会重新插入 live counter；测试里关闭后再 `forgetMember` 一次即可清掉（幂等）。
