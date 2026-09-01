# G6 结果 — TLS CA 变更立即重广告；opt-in 自动 promote；节点按 RTT 挂最近 hub

## 做了什么

### A. TLS CA 旋转后立即重广告

- `TlsService.onStatusChange` 只在 HTTPS listener **成功** apply 新材料后触发一次（self-signed / ACME / mode 切 none·external 的 `apply(null)`）。store upsert 不再单独发事件；listener bind 失败不广告。
- `assemble.ts`：`onStatusChange` 才 `refreshTlsAndAdvertise`；`onTlsApplied` 只失效 auth-mode cache（避免 ACME `applyMode` 在 listener 之前就广告）。
- `UplinkServer.updateSelfCaFingerprint` + `HubRuntime` 转发。`refreshTlsAndAdvertise` 更新 self CA 后发 `node.status`（in-flight coalesce）。10 分钟 poll 仍作兜底。
- `/api/hub/status`、`mesh_hubs` self 行、`node.status.hub.caFingerprint` 走同一指纹。

### B. Opt-in 保守自动 promote

- `TMEX_HUB_AUTO_PROMOTE` 默认关；`TMEX_HUB_AUTO_PROMOTE_TIMEOUT_MS` 默认 600_000。
- `/api/hub/status` 可选 `writerView: { hubNodeId, writerEpoch, reachable, observedAt }`。
- standby 自动 promote 须同时：开关开；本机是最低 priority（再最低 node-id）的已授权 standby；写者在本机连续不可达满超时（一次成功清零）；≥3 已授权 hub 时，其它 standby 的新鲜（≤2× poll 间隔）`writerView` 严格多数报写者不可达；恰好 2 hub 放弃 quorum（文档化脑裂风险）。
- 复用 G3 `executeHubRoleTransition`（env + epoch=`max(known)+1` + restart），`operationId=auto-<ts>`，打 `[hub] auto-promote` 错误日志。旧写者回网靠更高 epoch fence。

### C. 节点按 RTT 挂最近 hub

- `TMEX_UPLINK_PREFER_NEAREST`：`null`/未设 = 已知已授权 hub >1 时开启；`0/off/false` 强制关。
- `/healthz` RTT 做 EWMA（α=0.3）；≥2 样本后健康且 version ≥ 1.1.13 的 hub 按平滑 RTT 排序。切换还要 ≥30% 且 ≥15 ms，两次 RTT 动机切换间隔 ≥10 min。无足够样本时 failover 仍 epoch/priority。旧版 hub 不会排到写者前面。写者是兜底。浏览器仍走当前入口。

文档：`docs/hub/2026090104-multi-hub-standby.md` 「不做」列表、故障切换、选举、已知限制已改。

## 文件

- `packages/app/src/tls/tls-service.ts`、`tls-service.test.ts`
- `packages/app/src/runtime/assemble.ts`
- `apps/gateway/src/config.ts`、`config.test.ts`
- `apps/gateway/src/hub/{hub-peer-poller,hub-peer-poller.test,hub-runtime,hub-role-routes,uplink-server,index}.ts`
- `apps/gateway/src/mesh/{mesh-runtime,mesh-runtime.test,uplink-pool,uplink-pool.test}.ts`
- `apps/gateway/src/mesh/integration/{multi-hub-harness,multi-hub.integration.test}.ts`
- `docs/hub/2026090104-multi-hub-standby.md`

未改 `mesh-routes.ts`、`apps/gateway/src/api/**`、`system/**`、`tunnel/**`、`apps/fe/**`、`packages/shared/src/uplink/codec.ts`。

## 测试 / tsc

| 包 | bun test | tsc `--noEmit` |
|---|---|---|
| `apps/gateway` | **3493 pass / 0 fail** | **0** |
| `packages/app` | **646 pass / 1 fail** | **1**（既有：`Cannot find type definition file for 'node'`） |

`packages/app` 失败项仍是 `cpu-features stub plugin > packaged dist/runtime/server.js does not leave cpu-features as an external require`（无 built dist，基线如此）。TLS 单测 22 pass。

Biome：变更源文件 `biome check --write` 后 `biome check` 干净。

单测：TLS 成功一次回调 / bind 失败不回调；`refreshTlsAndAdvertise` 更新 snapshot 与 `/api/hub/status`；auto-promote quorum 矩阵、2-hub waiver、非最低 priority、过期 view、成功清超时；RTT 排序有/无样本、hysteresis、dwell、legacy 排除、forced-off。

集成：A down 超时 → B auto-promote → A 用旧 epoch 重建后被 fence。

## 未做 / 注意

- 两 hub 自动 promote 无法消除脑裂；只在显式开关 + 默认 10 分钟超时下允许。
- 浏览器不按 RTT 换 origin；cookie 仍是 host-only。
- 节点刚连上、尚无 2 个 RTT 样本时仍先走 epoch/priority（通常挂写者），样本齐了再按 hysteresis 切近。
