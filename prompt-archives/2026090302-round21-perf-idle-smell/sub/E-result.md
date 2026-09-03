# TASK E 结果 — `packages/app` assembly root + TLS/ACME 复杂度拆分

## 做了什么

机械拆分，行为与错误码抛出顺序不变。未改测试、未改 allowlist。

### 1. `assembleTmex` → `assemble-routes.ts`

抽出并保持原调用 / 副作用顺序：

| 函数 | 原片段 | 内容 |
| --- | --- | --- |
| `buildLocalRouteDeps` | `routeDeps` 对象 | Local/setup 路由依赖 |
| `buildHttpAndWs` | `createHttpDispatch` 数组 + `routeWebsocket` | HTTP dispatch + WS 路由；`tlsHandler` 经 `setTlsHandler` 回填 |
| `wireTlsLifecycle` | caches / refresh / `buildTlsLifecycle` / `setHealthzTlsProvider` | 先建 listener/TLS，再赋 handler，再 `refreshTlsAndAdvertise`，再 healthz |
| `createAssembledLifecycle` | `start` / `stop` / `setProcessShutdown` / `isRestartRequested` | 停机顺序不变：unsub → healthz/site null → agent → mesh → auth → hub → gateway |

路由装配用到的私有 helper（`createHttpDispatch`、`routeWebsocket`、`buildTlsLifecycle`、`tryStop`、`advertisedTlsInfo` 等）一并搬到 `assemble-routes.ts`，避免循环 import。`assemble.ts` 从该模块 re-import `tryStop` / `advertisedTlsInfo`。

为把 `assembleTmex` 的 CC 从拆完 4 段后的 ~19 压到 ≤15，同文件另抽了三个无行为变化的薄封装：`maybeMeshHubStore`、`applySiteSettingsLink`、`subscribeReplicatedNodeList`。`processShutdown` / `restartRequested` 收成 `shutdown` 对象，供 `scheduleRestart` 与 lifecycle 共享。

### 2. `resolveAcmeDnsPatch` → `acme-dns-patch.ts`

抽出三个纯函数（错误码抛出顺序与 round-19 DNSPod dns-01 语义一致）：

1. `resolveRequestedProvider(input, current)`
2. `resolveIncomingCredentials(input, legacyToken)` — 仍先算 `incoming`，再抛 `dns_provider_required`，再抛 `dns_credentials_required`
3. `resolveStoredFallback(input, current, requestedProvider, usedNewFields)` — 非 dns-01 先 `return {}`，再 stored 命中，再 `dns_credentials_required` / `cloudflare_token_required`

另抽私有 `dnsPatchFromIncoming`（原 incoming+provider 成功路径），使 `resolveAcmeDnsPatch` CC ≤ 12。`tls-service.ts` 改为 import `resolveAcmeDnsPatch`。

抛出顺序（未改）：

1. dns-01 且无 provider：`usedNewFields` → `dns_provider_required`，否则 `cloudflare_token_required`
2. 有 `dnsCredentials` 无 `dnsProvider` → `dns_provider_required`
3. 有两者但 normalize 失败 → `dns_credentials_required`
4. incoming+provider 再 normalize 失败 → `dns_credentials_required`
5. stored 未命中：`usedNewFields \|\| dnsProvider` → `dns_credentials_required`，否则 `cloudflare_token_required`

### 3. `doRunAcme` → `tryReuseValidCert`

抽出 `tryReuseValidCert(row, secrets, reason, epoch, tuple): Promise<boolean>`。命中时跑原来的 `runIfJob` 复用证书路径并 `return true`，`doRunAcme` 随即 `return`。

## 复杂度（`bun scripts/complexity/gate.ts --report` 同算法实测）

| 函数 | CC | 行数 | 门槛 |
| --- | ---: | ---: | --- |
| `assembleTmex` | **10** | **86** | ≤15 / ≤120 |
| `resolveAcmeDnsPatch` | **10** | 27 | ≤12 |
| `doRunAcme` | **11** | 73 | ≤12 |
| `tryReuseValidCert` | 7 | 29 | 默认 |
| `buildLocalRouteDeps` | 1 | 45 | 默认 |
| `buildHttpAndWs` | 3 | 36 | 默认 |
| `wireTlsLifecycle` | 1 | 46 | 默认 |
| `createAssembledLifecycle` | 1 | 37 | 默认 |

未改 `scripts/complexity/allowlist.json`。`assembleTmex` 仍在 allowlist（cc 18 / lines 156），实测已低于默认阈值。

## 验收

- `assemble.test.ts` + `tls-service.test.ts`：75 pass，0 fail（无测试改动）
- `cd packages/app && bun test`：**687 pass，1 fail**（已知 `cpu-features stub plugin` / packaged dist external require）
- `cd packages/app && bunx tsc --noEmit -p .`：1 error（基线：`Cannot find type definition file for 'node'`）
- `bunx biome check` 改动文件：通过

## 触及文件

- `packages/app/src/runtime/assemble.ts`（改）
- `packages/app/src/runtime/assemble-routes.ts`（新）
- `packages/app/src/tls/tls-service.ts`（改）
- `packages/app/src/tls/acme-dns-patch.ts`（新）
- `prompt-archives/2026090302-round21-perf-idle-smell/sub/E-prompt.md`
- `prompt-archives/2026090302-round21-perf-idle-smell/sub/E-result.md`
