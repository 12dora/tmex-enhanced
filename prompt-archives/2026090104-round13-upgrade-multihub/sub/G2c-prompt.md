# G2c — Live-test fixes: uplink pool diagnostics, early TLS fingerprint advertisement, `hub standby/promote` auto-authorize the primary

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G2b-result.md` (UplinkPool, CA bootstrap, TLS 10-min poll), `sub/G3b-result.md` (authorized hubs), `sub/G5b-result.md` (CLI allow/standby).

## Field evidence (live three-instance test today, production mode from source)

Topology: A = `hub,node` active (self-signed TLS on https://localhost:21800), B = joined node turned `hub standby --public-url https://localhost:21801` (self-signed TLS enabled via `PUT /api/tls` **before** the standby restart), C = plain node. A ran `tmex hub allow <B>`; A and B restarted.

- C `GET /api/mesh/hubs` correctly listed A (active) and B (standby), `mesh_hubs` on C had both rows; standby write fencing on B worked (`409 HUB_NOT_WRITER`) **but with `writerHubId/writerPublicUrl/writerEpoch = null`** because B never authorized A (`TMEX_HUB_PEERS` empty on B) — so from B's point of view there is no authorized writer.
- After stopping A, **C never attached to B in 180 s**. C's log after A died shows only `[uplink] offline reason=stopped` — no attempt/failure lines for candidate B at all. C's `hub_trust` holds only A's pin. Root cause hypothesis (verify!): B's `node.status.hub.caFingerprint` was empty because in `packages/app/src/runtime/assemble.ts` the mesh runtime is created before the TLS service is placed into `tlsSlot`, so `refreshTls()` at start returns null and the next refresh is the 10-minute poll; consequently C received B's `hubs[]` entry without `caFingerprint`, could not bootstrap a pin for `https://localhost:21801`, and every WS attempt to B failed TLS verification silently.

## Fixes

1. **Diagnostics** (`apps/gateway/src/mesh/uplink-pool.ts`): log at info level every candidate attempt (`[uplink] try hub=<url> mode=<m> epoch=<e> idx=<i>/<n> transport=<ws|memory>`), every failure with the underlying error message (`[uplink] candidate failed hub=<url> err=<msg> fails=<k>`), failover decisions (`[uplink] failover → hub=<url>`), probe results and switch-backs, and CA bootstrap outcomes (`[uplink] ca pin stored url=… fp=…` / `ca bootstrap failed url=… err=…`). Rate-limit repeated identical failure lines to once per 60 s per URL. Also expose the last error per candidate in `candidates()` (add `lastError?: string | null`, `lastAttemptAt?: number | null`) and surface it in `GET /api/mesh/hubs` (`candidates` entries; extend the JSON shape additively — the FE ignores extra fields).
2. **Early TLS fingerprint**: make the local CA fingerprint available to the advertisement as soon as the TLS service exists — (a) `MeshRuntime` exposes `refreshTlsAndAdvertise(): Promise<void>` (the internal helper at ~mesh-runtime.ts:1347 already exists — export it on the runtime object); (b) `packages/app/src/runtime/assemble.ts` calls it right after the TLS service is assigned to `tlsSlot` / after `setTlsInfo`, and again after a TLS mode change via `PUT /api/tls` (find where the TLS routes apply a new config — `packages/app/src/runtime/tls-routes.ts`/`tls service` — and trigger the refresh after a successful change); (c) keep the 10-minute poll as a fallback. Test: fake tlsInfo that returns null first and a fingerprint after `refreshTlsAndAdvertise()` → `node.status.hub.caFingerprint` is sent (via `sendStatusIfChanged`).
3. **CA bootstrap resilience** (`uplink-pool.ts`): when a candidate has no pin and no fingerprint, and the connection fails with a TLS/certificate error, log it explicitly (`no CA pin for <url> and no advertised fingerprint`) so operators see why. When a later `node.list` brings a fingerprint for that URL, retry bootstrap immediately (not only at the next probe tick).
4. **CLI** (`packages/app/src/commands/hub.ts`): `tmex hub standby` automatically adds the **current primary hub's node id** to the local `TMEX_HUB_PEERS` (source: the local DB — `mesh_hubs` active rows, falling back to the `peer_cache` sentinel row `node_id='hub'` whose `inventory_json.nodeId` is the hub id; read-only DB access like `hub list` does). Print what was authorized. `tmex hub promote` and `tmex hub demote` keep the list untouched but print the current list. Tests for the auto-authorize (mesh_hubs source, sentinel fallback, none found → warning printed).
5. Update `docs/hub/2026090104-multi-hub-standby.md` 操作手册 accordingly (standby 自动授权当前主 hub；主 hub 仍需手动 `allow` 备用 hub；诊断日志行说明；`/api/mesh/hubs.candidates[].lastError`).

## Files you own

- `apps/gateway/src/mesh/uplink-pool.ts` (+test), `apps/gateway/src/mesh/mesh-runtime.ts` (only to export `refreshTlsAndAdvertise` and the hubs route candidates shape), `apps/gateway/src/mesh/mesh-routes.ts` (+test; `/api/mesh/hubs` additive fields)
- `packages/app/src/runtime/assemble.ts` (+test), `packages/app/src/runtime/tls-routes.ts` (only to trigger the refresh hook), `packages/app/src/commands/hub.ts` (+test), `packages/app/src/lib/install.ts` (additive)
- `docs/hub/2026090104-multi-hub-standby.md`

Do NOT touch `forwarder.ts`, `stream-targets.ts`, `src/system/**`, `src/hub/**`, `packages/shared/**`, `apps/fe/**`, the integration test files under `src/mesh/integration/` (other agents are editing them).

## Verification

`cd apps/gateway && bun test src/mesh && bunx tsc --noEmit -p .` (0 fail / 0 tsc), `cd packages/app && bun test src && bunx tsc --noEmit -p .` (1 pre-existing error) and `bun run build:cli`, biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G2c-result.md` — confirm/refute the root-cause hypothesis with evidence, list the new log lines, tests. Write it, then exit.
