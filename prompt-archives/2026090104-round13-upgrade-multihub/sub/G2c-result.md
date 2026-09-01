# G2c result — live-test fixes: uplink diagnostics, early TLS fingerprint, standby auto-authorize

## Root-cause hypothesis: **confirmed**

现场假设成立，证据在启动顺序，不是「pool 根本没试 B」。

1. `packages/app/src/runtime/assemble.ts` 先 `createAssembleAuthSurface` → `createNodeMesh` → `createMeshRuntime`。此时 `tlsSlot.service` 仍是 `undefined`。`tlsInfo` 读到的 `caFingerprint` 为 `null`。
2. `constructMeshDeps` 在构造时立刻 `await refreshTls()`，把 `state.caFingerprint = null` 钉死。
3. 之后才 `buildTlsLifecycle` 把 `TlsService` 放进 `tlsSlot`。
4. `mesh.start()` 原先只挂 **10 分钟** `scheduler.interval`，**第一次 tick 前不会再 refresh**。`uplink.start()` 鉴权成功后发出的 `node.status.hub.caFingerprint` 因此为空。
5. C 从 A 的 `node.list.hubs[]` 学到 B 时没有指纹，`hub_trust` 只有 A 的 pin。A 死后 pool **会**试 B（`tryCandidate` 走 WS），但 TLS 校验失败被 `catch {}` 吃掉，日志只剩 UplinkClient 的 `[uplink] offline reason=stopped`。这解释了「180 s 内 C 从未挂上 B、也没有任何 candidate 失败行」。

B 上 `HUB_NOT_WRITER` 的 `writerHubId/writerPublicUrl/writerEpoch = null` 是第二条独立根因：B 的 `TMEX_HUB_PEERS` 为空，G3b allowlist 下 B 看不到任何已授权 writer。`tmex hub standby` 现在会自动把当前主 hub 写进本机 `TMEX_HUB_PEERS`。

## Fixes

### 1. UplinkPool 诊断

`apps/gateway/src/mesh/uplink-pool.ts` `console.info`（同一 URL + 相同 `err` 60 s 限一次）：

```text
[uplink] try hub=<url> mode=<active|standby> epoch=<n> idx=<i>/<n> transport=<ws|memory>
[uplink] candidate failed hub=<url> err=<msg> fails=<k>
[uplink] failover → hub=<url>
[uplink] probe ok hub=<url>
[uplink] probe fail hub=<url>
[uplink] switch-back → hub=<url>
[uplink] ca pin stored url=<url> fp=<64-hex>
[uplink] ca bootstrap failed url=<url> err=<msg>
[uplink] no CA pin for <url> and no advertised fingerprint
```

`candidates()` 叠加 `lastError` / `lastAttemptAt`。TLS/证书错误且既无 pin 也无广告指纹时打最后那行。后续 `node.list` 带上指纹会立刻 `pinAdvertisedCa`（不坐等 probe tick）；成功 pin 会 abort wrap backoff。

### 2. Early TLS fingerprint

- `MeshRuntime.refreshTlsAndAdvertise()` 导出。
- `start()` 在 `uplink.start()` **之前** refresh 一次（10 分钟 poll 仍作 fallback）。
- `assemble.ts`：`tlsSlot.service` 赋值后立刻 `refreshTlsAndAdvertise()`；`TlsService.onStatusChange` 与 `PUT /api/tls` / `POST /api/tls/renew` 成功后再 refresh。

### 3. CLI auto-authorize

`tmex hub standby` 把**当前主 hub node id** 追加进 `TMEX_HUB_PEERS`（去重保序）：

1. `mesh_hubs` active 行（`pickWriterHubId`），跳过 self；
2. 否则 `peer_cache` 哨兵 `node_id='hub'` 的 `inventory_json.nodeId`；
3. 都没有 → 警告，不改名单。

`promote` / `demote` 不改名单，结束时打印当前 `TMEX_HUB_PEERS`。主 hub 仍须手动 `tmex hub allow <standby>`。

### 4. `GET /api/mesh/hubs`

`candidates[]` 从 `string[]` 变为对象（加法字段，FE 不用这个数组）：

```json
{ "publicUrl": "https://…", "lastError": null, "lastAttemptAt": null }
```

## Tests

| Suite | Result |
|---|---|
| `uplink-pool.test.ts` | **26 pass**（G2b 20；+try/fail/failover/lastError、60s 限流、无 pin TLS 日志、ca pin stored/failed、fingerprint 立即 bootstrap、probe/switch-back） |
| `mesh-runtime.test.ts` | +`refreshTlsAndAdvertise`：构造时 null，调用后发出指纹 |
| `mesh-routes.test.ts` | candidates 对象形；`lastError`/`lastAttemptAt` 透出 |
| `assemble.test.ts` | TLS 入槽后调用 `refreshTlsAndAdvertise`（构造时 `tlsInfo` 仍为 null） |
| `tls-routes.test.ts` | PUT 成功调 `onApplied`；校验失败不调 |
| `hub.test.ts` | mesh_hubs 源、sentinel fallback、找不到警告、promote/demote 打印且不改名单 |
| `cd apps/gateway && bun test src/mesh/uplink-pool.test.ts src/mesh/mesh-runtime.test.ts src/mesh/mesh-routes.test.ts` | **136 pass / 0 fail** |
| `cd apps/gateway && bun test src/mesh` | **660 pass / 1 fail** — 失败在 `forwarder.test.ts`「GET retries a transient open failure; POST does not retry」，多了 `error: "post failed"`。`forwarder.ts` 禁止改，属并发 agent。本任务文件无关。 |
| `cd packages/app && bun test src` | **629 pass / 0 fail**（G5b 623；+6） |
| `apps/gateway bunx tsc --noEmit -p .` | 本任务文件 **0 error**。剩余 1 条在 `src/mesh/integration/large-push-harness.ts`（禁止改的 integration，并发 agent：`PeerLinkProvider` 缺 `listReach`/`onNodeEvent`） |
| `packages/app bunx tsc --noEmit -p .` | **1 pre-existing**：`Cannot find type definition file for 'node'` |
| `bunx biome check` 本任务 ts | **clean**（`--write` 只动了本任务文件） |
| `bun run build:cli` | 成功，`cli-node.js` 208.41 KB |

## Files touched

Owned:

- `apps/gateway/src/mesh/uplink-pool.ts` / `.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` / `.test.ts`（导出 `refreshTlsAndAdvertise`；`start()` 先 refresh；`hubCandidates` 传完整 candidate）
- `apps/gateway/src/mesh/mesh-routes.ts` / `.test.ts`
- `packages/app/src/runtime/assemble.ts` / `.test.ts`
- `packages/app/src/runtime/tls-routes.ts` / `.test.ts`
- `packages/app/src/commands/hub.ts` / `.test.ts`
- `packages/app/src/i18n/index.ts`（CLI 文案；不在 owned 列表但 `t()` 必须有 key，否则 standby 不会打印被授权的 node id）
- `docs/hub/2026090104-multi-hub-standby.md`

未改：`install.ts`（`applyHubModeEnvKeys.hubPeers` 已够用）、`forwarder.ts`、`src/system/**`、`src/hub/**`、`packages/shared/**`、`apps/fe/**`、`src/mesh/integration/**`。无 git 操作。

## Commander

1. **`apps/gateway/src/mesh/mesh-http.ts`** 把 `hubCandidates?: () => string[]` 放宽为 `() => Array<string | UplinkCandidate>`（或与 `MeshRoutesDeps` 相同）。目前 `mesh-runtime.ts` 用 `as unknown as string[]` 把对象塞过去，运行时没问题，类型是撒谎。
2. 可选：`packages/api-client` `MeshHubsResponse.candidates` 从 `string[]` 改成 `{ publicUrl, lastError, lastAttemptAt }[]`。FE 不读 `candidates`，现网 JSON 已是对象。
3. 并发噪声不要算在本任务：`forwarder.test.ts` 1 fail、`large-push-harness.ts` tsc。

## Open risks

- 现场「C 不切 B」还依赖 B **在 A 死之前**已经广告出指纹。本修复保证 standby 启动时（TLS 已在 `tlsSlot`）和 `PUT /api/tls` 之后立刻广告；若 TLS 在 uplink 已 online 之后才 apply，走 `onApplied`/`onStatusChange`。
- `TMEX_HUB_PEERS` 仍是各机 env，不会随 mesh 复制。standby 自动授权主 hub；**主 hub 仍须手动 allow standby**。
- 诊断日志是 `console.info`，测试跑 pool 时 stdout 会变吵。
