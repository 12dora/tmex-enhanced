# GI — 死代码删除结果

工作区：`/Users/konata/code/tmex-r22`（`feat/round22-perf-tui-color-smell`）
日期：2026-09-03

每条删除前均重新 `grep`；非测试源码仍有引用的符号一律跳过。并行 agent 已改过的文件以终态为准。

行数：整文件删除 **995** 行，文件内再删约 **200** 行，合计约 **1,200** 行。

---

## 1. 已删除

### 1.1 死 HTTP 路由（§2.1 / §2.4）

| 路由 | 处理 |
| --- | --- |
| `GET/PUT /api/devices/:id/tree-order` | 删 `api/tree-order.ts` + `tree-order.test.ts`；从 `device-routes.ts` 摘掉 `treeOrderRoutes` |
| `PATCH .../windows/:windowId/name`、`PATCH .../panes/:paneId/name` | 同上（同文件四联） |
| `POST .../weixin/.../users/:userId/test` | 删 `handleTestWeixinUser` 及路由；账号级 `POST .../accounts/:accountId/test` **保留** |
| `DELETE .../weixin/.../users/:userId` | 删 `handleDeleteWeixinUser`；DB helper `deleteWeixinUser` 仅此路由使用，一并删（表/列未动） |
| `GET /api/capabilities` | 删 `api/capabilities.ts` + 测试；`system-routes.ts` 的 `capabilitiesRoutes`、`api/index.ts` 接线 |

`GET /api/capabilities` 全链：

- 服务端路由 + 测试
- `packages/api-client/src/capabilities.ts`（`FeatureSet` / `fetchCapabilities`）及 barrel `export *`
- `packages/stores/src/site.ts` 的 `capabilities` / `loadCapabilities`
- `apps/fe/src/main.tsx` 启动拉取与过期注释
- `site-theme.test.ts` capabilities 用例、`api-client/client.test.ts` 的 `FeatureSet` 用例
- `GATEWAY_CAPABILITIES` 去掉无消费者的 `tmex-ws-borsh-v1` / `tmex-agent-v1` / `tmex-split-v1`；保留 `canonical-state-v1`（WS HELLO）

`route.test.ts` 通配样例 `/api/devices/dev-1/tree-order` 改为 `unknown-subpath`；`dispatchRoutes` 夹具路径改为 `/api/example`。`stream-targets.test.ts` 把真实打到 `/api/capabilities` 的两处改为 `/healthz`，auth:null 负向用例改为 `/api/devices`（401 发生在 dispatch 之前，不依赖活路由）。

未动：`/api/tmux/tree`、`/api/settings/theme`、`POST /api/hub/nodes/:id/revoke`、`/api/system/*`、`/api/mesh-internal/*`、`/api/hub/status`、`/api/tls/ca.crt`、`/api/manifest.webmanifest`。未改 `db/schema.ts`。

### 1.2 死导出（§1.1，已 grep 确认仅声明本身）

| 符号 | 文件 |
| --- | --- |
| `openWebSocketLink` | `mesh/peer-protocol.ts` |
| `guardTunnelAccess` | `tunnel/access-guard.ts` |
| `logGenerationPath` | `log/rotate.ts` |
| `infoLine` | `mesh/mesh-log.ts` |
| `DataChannelLinkSlot` `EstablishedPeerLink` `LookupPeerCert` `RelayOpenPayload` | `mesh/types.ts` |
| `TunnelOsArch` | `tunnel/platform.ts` |
| `CloudflaredEnv` | `tunnel/provider.ts` |
| `HubRoleTransitionRow` | `hub/hub-role-transitions.ts` |
| `NodeLoginRequiredBody` | `api-client/src/auth/types.ts` |
| `ToolCardConfirmation` | `panels/.../tool-call-card.tsx` |
| `MotionDurationName` | `ui/src/components/motion.tsx` |

weixin ilink 四常量按报告保留，未动。

### 1.3 死文件（§1.4）

- `packages/app/scripts/poc/node-datachannel-loader.ts`（217 行；零 importer、无 package.json script）
- `scripts/health-check.sh`（190 行；`package.json` / `docs/` / `.github` / CI 零引用）

---

## 2. 跳过及原因

### 2.1 死导出：他 agent 占用 / `ws/*` / `local/*`

| 符号 | 原因 |
| --- | --- |
| `resetSharedDirectDialLimiter` | `peer-ws-race.ts` |
| `canonicalEventFrameBytes` | `ws/canonical/encoded-size.ts`（`ws/*`） |
| `demandGatewayEventLoopLagFast` | `ws/event-loop-lag.ts`（`ws/*`） |
| `readKeepAlivePool` | `panels/.../terminal-keep-alive.ts`（任务明确 SKIP） |
| `NetworkInterfacesFn` | `mesh/mesh-runtime.ts` |
| `TlsErrorCode` | `api-client/src/local/tls-types.ts`（`local/*`） |
| `ApiErrorBody` | `api-client/src/local/types.ts`（`local/*`） |

### 2.2 §1.3 七个 contracts 类型 — **不是死代码**

均被同文件活接口字段引用（非测试源码）：

- `TunnelJobState` → `TunnelJobStatus.state`
- `TunnelAuthStatus` / `TunnelConfigStatus` / `TunnelProcessStatus` → `TunnelStatusResponse`
- `UninstallState` → `UninstallStatus.state`
- `FileContentEncoding` → `FileContentResponse.encoding`
- `LlmModelSource` → `LlmModelInfo.source`

按任务规则「非测试源码有引用则不是死代码」跳过。内联会改活类型的导出面，不是删死代码。

### 2.3 §1.2 十五个未用 `*Row` 类型 — 未删

未改 `db/schema.ts`（GF 已拆成 `schema/*.ts` barrel）。仍零引用、仅列出：

`UserRow` `UserKeyRow` `UserKeyLogRow` `NodeSessionRow` `NodeCertRow` `EnrollmentTokenRow` `NodeIdentityRow` `PeerCacheRow` `TlsConfigRow` `HubTrustRow` `MeshHubRow` `TunnelConfigRow` `TunnelAccessRow` `LocalAuthSettingsRow` `NodeAccessPolicyRow`

（`NodeRow` 有消费者，不在此列。）

### 2.4 §2.5 版本门

| 常量 | 处理 |
| --- | --- |
| `CHECKSUMS_REQUIRED_SINCE` | 跳过。并行 agent 已把网关校验并入 `packages/shared/src/release/verify.ts` 且 fail-closed；`release-download.ts` 里该常量已不存在 |
| `SHA256SUMS_REQUIRED_SINCE` | 跳过。`upgrade-verify.ts` 仍被 `commands/upgrade.ts` 的 `--allow-unverified` 占用（文件内注释写明须保留 `< 1.1.4` 分支）；且该文件正被并行 agent 改 |
| `TERM_VIEWPORT_MIN_SERVER_VERSION`（1.1.7） | 不提升。`ws-client/server-features.ts` 注释写明给尚未升级、不认识 `KIND_TERM_VIEWPORT` 的 mesh 节点；仓内无「生态下限 = 1.1.13」的通用声明（1.1.13 只是 hub tokens / admit-hub 等特性门） |
| `MIN_REMOTE_UPGRADE_VERSION`（1.1.0） | 不提升。`upgrade-batch.ts` 注释写明这是网关首次暴露 `/api/system/upgrade` 的版本 |

### 2.5 文档（未改）

`docs/frontend/packages.md`、`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` 仍写 REST `/api/capabilities` 与 `FeatureSet`。不在本任务可编辑文件内，未改。

---

## 3. 测试 / tsc / biome / complexity

| 项 | 结果 |
| --- | --- |
| `cd apps/gateway && bun test src/api src/tunnel src/log src/mesh/peer-protocol src/mesh/mesh-log src/mesh/stream-targets.test.ts src/db/weixin.test.ts src/hub/hub-role-transitions` | **676 pass / 0 fail** |
| `cd packages/shared && bun test` | **514 pass / 0 fail** |
| `cd packages/stores && bun test` | **440 pass / 0 fail** |
| `cd packages/api-client && bun test` | **175 pass / 0 fail** |
| `cd packages/ui && bun test` | **62 pass / 0 fail** |
| `cd packages/panels && bun test src/agent` | **78 pass / 0 fail** |
| `cd apps/fe && bun test src/` | **1750 pass / 2 fail**：`use-page-module.test.ts` 两例（`requestPageModule`），非本任务文件，属并行 agent 的懒加载改动 |
| biome（本任务改过的 24 个文件） | **通过** |
| tsc `--noEmit` error 数 vs 改前基线 | gateway 1→**0**；shared 0→**0**；stores 1→**1**；api-client 5→**5**；ui 0→**0**；panels 2→**0**；fe 5→**3**。均未超基线；剩余错误均不在本任务改的生产文件 |
| `bun scripts/complexity/gate.ts` | **失败 1 条，与本任务无关**：`packages/panels/src/markdown/streaming-markdown.tsx:111 openFenceTail` CC 17>15。**0 条陈旧 allowlist**（没有因本任务删函数而过期的条目，未改 allowlist） |

---

## 4. 改动文件清单

删除：

- `apps/gateway/src/api/tree-order.ts`
- `apps/gateway/src/api/tree-order.test.ts`
- `apps/gateway/src/api/capabilities.ts`
- `apps/gateway/src/api/capabilities.test.ts`
- `packages/api-client/src/capabilities.ts`
- `packages/app/scripts/poc/node-datachannel-loader.ts`
- `scripts/health-check.sh`

编辑：

- `apps/gateway/src/api/{device-routes,system-routes,index,weixin-routes,route.test}.ts`
- `apps/gateway/src/db/{weixin,index}.ts`
- `apps/gateway/src/mesh/{types,mesh-log,peer-protocol,stream-targets.test}.ts`
- `apps/gateway/src/tunnel/{access-guard,platform,provider}.ts`
- `apps/gateway/src/log/rotate.ts`
- `apps/gateway/src/hub/hub-role-transitions.ts`（终态已无 `HubRoleTransitionRow`）
- `packages/shared/src/capabilities.ts`
- `packages/stores/src/{site.ts,site-theme.test.ts}`
- `packages/api-client/src/{index,client.test,auth/types}.ts`
- `packages/ui/src/components/motion.tsx`
- `packages/panels/src/agent/messages/tool-call-card.tsx`
- `apps/fe/src/main.tsx`
