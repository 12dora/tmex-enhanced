# T1B 结果 — Relay backend: current-error / live quota / switch

## 结论

四项交付均已落地：在线链路不再带 stale `lastError`；`relay.quota` 带实时 `usage`（5s 采样、有变化才推）；`GET /api/relay/metrics` 返回生效配额 + usage（含令牌桶 `bandwidthBytesPerSec`）；`POST /api/mesh/relay/switch` 可切换并记下首选中继。

## 测试

| 范围 | 结果 |
|---|---|
| `cd apps/gateway && bun test src/relay src/mesh` | **1376 pass / 0 fail**（基线 1359；新增约 17） |
| `bunx tsc --noEmit -p apps/gateway` | 0 errors |
| `cd packages/app && bun test` | **907 pass / 1 skip / 0 fail** |
| `bunx tsc --noEmit -p packages/app` | 0 errors |
| `cd packages/api-client && bun test` | **220 pass / 0 fail** |
| `bunx tsc --noEmit -p packages/api-client` | 0 errors |
| `cd packages/shared && bun test src/relay` | **75 pass / 0 fail** |
| `bunx tsc --noEmit -p packages/shared` | 0 errors |
| `bunx biome check --write`（仅触达文件） | 通过 |

## 新 API / 控制面字段（前端依赖）

### `GET /api/mesh/relay/status`（及 `POST /api/mesh/relay/switch` 200 同形）

`relays[n]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `lastError` | `string \| null` | **当前**错误原文。`online === true` 时必为 `null`。`stopped` / `aborted` 也当无错误。 |
| `lastErrorCode` | `RelayLinkErrorCode \| null` | 稳定分类，供 i18n。在线或无错误时 `null`。 |
| `lastErrorAt` | `number \| null` | 当前错误时间戳（ms）。同上，在线时 `null`。 |

`RelayLinkErrorCode` 闭集：

`connect-failed | connect-timeout | auth-timeout | auth-rejected | heartbeat-lost | kicked | dns | refused | tls | protocol | unknown`

`quota`（仅当前 attached 的中继；未挂载 / 旧中继仍为 `null`）：

```ts
{
  maxNodes: number
  maxStreams: number
  bandwidthBytesPerSec: number | null
  currentNodes?: number
  usage?: {
    currentNodes: number
    currentStreams: number
    bytesInPerSec: number
    bytesOutPerSec: number
    bandwidthBytesPerSec?: number  // 令牌桶放行速率；与上限同口径，不要用 in+out
    sampledAt: number              // ms
  } | null
}
```

旧中继不下发 `usage`，节点侧会原样忽略。

### `POST /api/mesh/relay/switch`

- Body: `{ url: string }`（会 canonicalize）
- Auth: 与其它 `/api/mesh/relay/*` 相同（node-session）
- 成功：200，body 与 GET status 同形；该 URL 写入本机 `gateway_kv` 键 `relay.preferredUrl`，启动时候选顺序把它排第一
- 错误：
  - `400 INVALID_URL`
  - `404 RELAY_UNKNOWN` — 不在本机已配置列表
  - `409 RELAY_KICKED` — 该中继已踢本租户
  - `409 RELAY_ALREADY_ATTACHED` — 已挂在目标且在线
  - `502 RELAY_SWITCH_FAILED` — `{ code, lastError, lastErrorCode }`；旧链路按 pool 策略保留

`RelayTenantApi.switchRelay(url)` 已指向此路径，未改。

### 控制消息 `relay.quota`

向后兼容：旧中继可省略 `usage`；旧节点解析时丢掉未知字段。

```ts
{
  t: 'relay.quota'
  maxNodes: number
  maxStreams: number
  bandwidthBytesPerSec: number | null
  currentNodes?: number
  usage?: {
    currentNodes: number
    currentStreams: number
    bytesInPerSec: number
    bytesOutPerSec: number
    bandwidthBytesPerSec?: number
    sampledAt: number
  }
}
```

服务端：接入后立刻推一次（含 usage，速率可为 0）；之后每 5s 跟 metrics 采样拍，**用量指纹有变才再推**（不含 `sampledAt`）。

### `GET /api/relay/metrics`

| 字段 | 说明 |
|---|---|
| `tenants[n].quota` | **生效配额**（租户覆盖 ?? 默认），不再是 raw override（不再为 `null` 表示跟随默认） |
| `tenants[n].usage` | `{ currentNodes, currentStreams, bytesInPerSec, bytesOutPerSec, bandwidthBytesPerSec }` |
| `totals.bandwidthBytesPerSec` | 全中继令牌桶放行速率之和 |

`bandwidthBytesPerSec` usage：在 `TokenBucket.take()` **成功之后**累加该 chunk 字节，再按采样窗口算速率。同一转发 chunk 在 in/out 上各记一次，UI 对比上限请用这个字段，不要 `bytesInPerSec + bytesOutPerSec`。

运营者侧 `GET /api/relay/status` 的 `tenants[n].quota` **未改**：仍是 raw override（`null` = 跟随默认）。

## 改动文件

### 新增

- `apps/gateway/src/mesh/relay-link-error.ts` + `.test.ts` — 错误分类器
- `apps/gateway/src/mesh/relay-preferred.ts` + `.test.ts` — 首选 URL kv + 排序

### 节点侧

- `relay-uplink-client.ts` / `uplink-client.ts` — 认证成功清 `lastConnectError`
- `uplink-pool.ts` — `promote` 时 `noteSuccess` 清 diag `lastError` / `lastErrorAt`
- `relay-status-row.ts` — `lastErrorCode`；在线强制三字段为 null
- `relay-routes.ts` — `POST /switch`；status 带分类码
- `relay-wiring.ts` — 候选按首选 URL 提前；暴露 `switchTo`
- `relay-secrets.ts` — `preferredRelayUrl` / `setPreferredRelayUrl`

### 中继侧

- `relay-quota-ctl.ts` — 带 `usage` 的 ctl
- `relay-metering.ts` — `recordAdmitted`
- `relay-stream-router.ts` — `take()` 成功后记 admitted
- `relay-metrics.ts` — 生效配额、tenant usage、令牌桶速率、`onSample` 推送
- `relay-uplink-server.ts` / `relay-uplink-auth.ts` — 首推 + 5s 变化推送
- `relay-runtime.ts` — 接线 metrics → uplink

### 共享 / 客户端

- `packages/shared/src/relay/codec.ts` — `RelayQuotaUsage`；`relay.quota.usage` 可选
- `packages/api-client/src/relay/metrics-types.ts` — additive：`tenants[].usage`、`totals.bandwidthBytesPerSec?`
- `packages/api-client/src/relay/tenant-api.ts` — `RelayQuotaUsage.bandwidthBytesPerSec?`；错误码常量 `RELAY_UNKNOWN` / `RELAY_KICKED` / `RELAY_ALREADY_ATTACHED` / `RELAY_SWITCH_FAILED`（`switchRelay` 路径未改）
- `packages/app/src/lib/relay-session.ts` — 解析 `lastErrorCode` / `lastErrorAt`

## 行为要点

1. **当前错误，不是最近错误。** 成功上线清客户端 `lastConnectError` 和 pool diag；路由层再保险：`online === true` → 三字段全 null。`stopped`/`aborted` 分类为无错误。
2. **首选中继**只写本机 `gateway_kv`（`relay.preferredUrl`），**不**改 signed `set-relays`。启动时 `relayUplinkOverrides.candidates()` 把该 URL 排第一。
3. 切换超时 10s；失败不持久化首选。`switchTo` 失败时 pool 保留旧 live（make-before-break 未 promote）。

## 未做 / 不确定

- `POST /switch` 超时后，底层 `UplinkPool.switchTo` 可能仍在后台跑（HTTP 已 502）。若随后连上，pool 仍可能 promote。未加取消令牌。
- `tenant-api.ts` 的 `RelayQuotaUsage.bandwidthBytesPerSec` 标成可选，因旧中继不下发；新中继**总会带**。`normalizeRelayStatus` 缺省补 `0`。
- 未改 `apps/fe/**`、locale、docs。
