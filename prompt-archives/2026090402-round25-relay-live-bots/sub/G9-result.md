# G9 结果 — 中继模式节点名 + 未挂载 lastError

## 结论

两处 live 迁移里看到的问题都已修完：

1. **本机名不再落到 `self`**：任意角色的 `selfName()` / 状态块 `name` 都走同一条链：listed → hub `nodes` 行 → `node_identity.name` → `site_settings.site_name` → null。占位 `self` 与节点 id 一律跳过。
2. **未挂载中继行带失败原因**：uplink 池按候选记录 `lastError` + `lastErrorAt`；`GET /api/mesh/relay/status` 每行都下发。已挂载行仍只用 live client 的 `lastConnectError`（不拿池里的陈旧失败）。

## 改动文件

- `apps/gateway/src/mesh/node-list-projection.ts` — 抽出 `pickSelfDisplayName`（listed → registry → identity → site）。
- `apps/gateway/src/mesh/node-list-projection.test.ts` — 回退顺序与占位过滤。
- `apps/gateway/src/mesh/mesh-runtime.ts` — `selfName()` 与 relay `nameProvider` 共用 `selfDisplayNameOf`（hub 角色不再是唯一能落到站点名的路径）。
- `apps/gateway/src/mesh/uplink-pool.ts` — 候选诊断增加 `lastErrorAt`；失败时与 `lastError` 一起写入。
- `apps/gateway/src/mesh/uplink-pool-diag.ts` — 从 pool 抽出 diag merge（避免 `uplink-pool.ts` 超 allowlist 行数）。
- `apps/gateway/src/mesh/uplink-pool.test.ts` — 失败候选有 `lastErrorAt`，成功候选为 null。
- `apps/gateway/src/mesh/relay-status-row.ts` — `relayLinkError` / `buildRelayStatusRow`：挂载行用 client error，未挂载行用池候选。
- `apps/gateway/src/mesh/relay-status-row.test.ts` — 上述语义。
- `apps/gateway/src/mesh/relay-routes.ts` — status 每行带 `lastError` + `lastErrorAt`；view 增加 `candidates()`。
- `apps/gateway/src/mesh/relay-routes.test.ts` — 未挂载行暴露 `member-epoch_mismatch`；已挂载行仍用 client `bad-token`，不吃池里的 `stale-pool`。
- `apps/gateway/src/mesh/relay-wiring.ts` — 把 `uplink.candidates()` 接到 routes view。
- `packages/api-client/src/relay/tenant-api.ts` — `RelayLinkStatus.lastErrorAt`；`normalizeRelayStatus` 缺省 `null`。
- `packages/api-client/src/relay/tenant-api.test.ts` — 缺省补齐与透传。

未改 `packages/shared/src/contracts/**`（租户 status 类型在 api-client）。未 git、未 `build:i18n`。

## 验证

```
cd apps/gateway && bun test src/mesh
# 1175 pass, 0 fail, 85 files

cd apps/gateway && bunx tsc --noEmit -p .
# 仅既有 TS5097（packages/app/src/lib/native-datachannel.ts）

cd packages/api-client && bun test src/relay/tenant-api.test.ts
# 16 pass, 0 fail

cd packages/api-client && bunx tsc --noEmit -p .
# 5 errors（基线，全在 client.test.ts / files-download.test.ts，无新增）

bunx biome check <scope files>   # 0
bun run lint                     # complexity gate ok
```

## 遗留 / 不确定

- 已挂载行在 client 没有 `lastConnectError` 时 `lastError`/`lastErrorAt` 仍为 null（即使池里留着上一次失败）。这是任务要求的「attached 保持现语义」。
- 前端已渲染 `lastError`，`lastErrorAt` 目前只在 API / api-client 透出，FE 未改（不在本任务范围）。
