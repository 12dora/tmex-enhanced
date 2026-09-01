# G2 — Node side: ordered uplink failover across multiple hubs, hub-set persistence, `/api/mesh/hubs`

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `prompt-archives/2026090104-round13-upgrade-multihub/plan-00.md` (§目标 3) and `sub/G1-result.md` (the foundation you build on: `HubEndpointInfo` / `HubAdvertisement` / `node.list.hubs` in `packages/shared/src/uplink/codec.ts`, config fields `hubMode/hubPriority/hubWriterEpoch/hubUrls` in `apps/gateway/src/config.ts`, table `mesh_hubs` + `MeshHubStore` in `apps/gateway/src/auth/mesh-hub-store.ts`). Architecture background: `docs/hub/2026082700-hub-node-architecture.md` §1, §3 "node 侧", and `sub/EX3-result.md` §2–§3 (all single-hub assumptions are listed there with file:line).

## Goal

A node today keeps exactly one uplink to `TMEX_HUB_URL` (`apps/gateway/src/mesh/uplink-client.ts` `UplinkClient`, wired in `mesh-runtime.ts`). Make the node **fail over in order across a set of hubs** and persist the hub set it learns from `node.list`.

## Requirements

1. **Endpoint set**: candidates = `MeshHubStore.orderedEndpoints()` (persisted from previous `node.list`) merged with config seeds (`hubUrl`, then `hubUrls[]`; seeds without a known hubNodeId get `mode:'active'`, `writerEpoch:0`, `priority` = 1000+index). Order: active hubs by `writerEpoch` desc then `priority` asc, then standbys by `priority` asc, then seeds. De-duplicate by normalized URL.
2. **`UplinkPool`** (new `apps/gateway/src/mesh/uplink-pool.ts`) owning one live `UplinkClient` at a time:
   - Try candidates in order; a candidate is "failed" after 3 consecutive connection/auth failures or 20 s without reaching authenticated state (whichever first); then move to the next; wrap around with the existing exponential backoff (1 s → 60 s, jitter) once all failed.
   - While attached to a non-preferred candidate (index > 0 in the current order), probe the preferred ones every 60 s (a cheap `GET <publicUrl>/healthz` with the per-URL TLS pin from `HubTrustStore`, timeout 5 s); when a more-preferred hub answers, switch: open the new uplink, only after it authenticates close the old one (make-before-break), then re-send `node.status`.
   - A **generation counter** guards every inbound `node.list`/`key.log`/`rtc.signal` handler so frames from a superseded link are ignored; cancel that link's key-log catch-up tasks (`uplink-key-log-sync.ts`).
   - Expose `attachedHub(): { hubNodeId: string | null; publicUrl: string; mode: HubMode | null; writerEpoch: number | null; since: number } | null`, `candidates()`, `switchTo(publicUrl)` (used by tests), and events for `mesh-runtime` (`onAttached`, `onDetached`).
   - Each URL uses its own CA pin: look at how `mesh-runtime.ts` (~line 854) builds the uplink fetch/WebSocket with `HubTrustStore` for the single URL and generalize per URL. If a `hubs[]` entry carries `caFingerprint` and no pin exists yet for that URL, fetch `<publicUrl>/api/tls/ca.crt` **through the currently attached, already-trusted hub link** is not possible — instead fetch it directly with TLS verification disabled ONLY for that one request, verify the returned CA's SPKI fingerprint equals the advertised one (which arrived over the authenticated uplink), then `HubTrustStore.put`. Never trust a fingerprint that did not arrive over an authenticated uplink.
3. **Persist hub set**: on every `node.list` with `hubs[]`, `MeshHubStore.replaceAll(hubListToRecords(hubs))`; when `hubs` is absent (old hub) synthesize one record from the legacy `hub` field (`mode:'active'`, `priority:100`, `writerEpoch: writerEpoch ?? 1`). Keep the legacy `peer_cache` `node_id='hub'` sentinel updated as today (other code reads it) but make new code read `MeshHubStore`. `pruneStaleListedPeers` (mesh-runtime ~841) must protect **all** hub node ids, not one.
4. **Own advertisement**: when this process also runs the hub role (`config.roles` includes hub), `node.status` includes `hub: { publicUrl: config.hubPublicUrl, mode: config.hubMode, priority: config.hubPriority, writerEpoch: config.hubWriterEpoch, caFingerprint }` (caFingerprint from the local TLS service if a private CA is active — find how `HubRuntime`'s `tlsInfo` provider gets it and reuse the same source). Send it on attach and whenever it changes.
5. **HTTP surface** (`mesh-routes.ts`):
   - `GET /api/mesh/hubs` (session required, like `/api/mesh/nodes`) → `{ hubs: HubEndpointInfo[], attached: { hubNodeId, publicUrl, mode, writerEpoch, since } | null, writerHubId: string | null, candidates: string[] }`. Mark `online` per hub from the latest `node.list` if present.
   - `/api/mesh/nodes`: `isHub` becomes true for every node id in `MeshHubStore`; add `hubMode?: 'active'|'standby'` per node row. `auth mode` response's `hubNodeId` must be the **writer** hub id (`pickWriterHub`), `hubPublicUrl` the writer's URL.
   - `node-list-projection.ts`: carry `hubs` through to whatever internal projection feeds `/api/mesh/nodes`.
6. **PeerManager relay diagnostics** (`peer-manager.ts` ~433 `peerAddress` for relay): show the currently attached hub host, not the config hub host. Anything else in `peer-manager.ts` that reads a single `hubHost`/`uplink` must follow the pool's current link (make it a getter/provider, not a captured value).
7. **Behaviour when the attached hub is standby**: nothing special on the node side beyond what the hub returns; do not gate anything locally.

## Tests (TDD)

`uplink-pool.test.ts` (fake `UplinkClient` factory: ordering, failover after 3 failures / 20 s, wrap-around backoff, make-before-break switch-back, generation guard drops stale `node.list`, per-URL pins), extend `mesh-runtime*.test.ts` (hub set persistence from `hubs[]` and from legacy `hub`, prune keeps all hubs, own advertisement content), `mesh-routes.test.ts` (`/api/mesh/hubs`, `/api/mesh/nodes.isHub/hubMode`, auth mode writer fields), `node-list-projection.test.ts`. Keep the existing integration tests under `apps/gateway/src/mesh/integration/` green.

## Files you own

- `apps/gateway/src/mesh/uplink-client.ts`, new `uplink-pool.ts` (+tests), `uplink-key-log-sync.ts`, `mesh-runtime.ts`, `mesh-runtime*.test.ts`, `mesh-routes.ts`, `mesh-routes.test.ts` (**except** the remote-upgrade test cases around lines 1002–1479 which another agent may be editing concurrently — do not modify those blocks), `node-list-projection.ts` (+test), `peer-manager.ts` (+ its tests), `mesh-deps.ts`, `auth-mode-cache.ts`/`auth-routes.ts` only for the writer-hub fields.

Do NOT touch `apps/gateway/src/hub/**` (G3), `apps/gateway/src/system/**` and `mesh/forwarder.ts` (G4), `packages/shared/**` and `apps/gateway/src/config.ts` / `db/**` / `auth/mesh-hub-store.ts` (G1 — if you need an extra store method, add it in a new file `apps/gateway/src/auth/mesh-hub-store.ext.ts`? No — put helpers next to your own code instead), `packages/app/**` (G5), `apps/fe/**`.

Integration point for G3 (do this part exactly): `MeshRuntime` exposes `onNodeList(cb: (list: UplinkNodeList, meta: { hubNodeId: string | null; generation: number }) => void): () => void` so the hub role in the same process can replicate the registry from what the node side receives.

## Verification

`cd apps/gateway && bun test && bunx tsc --noEmit -p .` → 0 fail / 0 tsc errors (other agents add tests concurrently; ignore failures clearly inside `src/system/**` or `src/hub/**` if they are mid-edit, but report them), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G2-result.md` — include the public API of `UplinkPool`, the `onNodeList` signature, config/env behaviour, test counts. Write it, then exit.
