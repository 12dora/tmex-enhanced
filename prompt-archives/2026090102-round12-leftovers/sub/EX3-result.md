# EX3 — Mesh node list DTO audit

## 1. Current behaviour

`GET /api/mesh/nodes` is authenticated and returns `collectNodes()` through `jsonBody`; the browser’s singleton resident poller refreshes it every 30 seconds and skips hidden tabs. (`apps/gateway/src/mesh/mesh-routes.ts:101-105`, `apps/gateway/src/mesh/mesh-routes.ts:172-174`, `apps/fe/src/node/mesh-nodes.ts:364-424`, `apps/fe/src/node/mesh-nodes-resident.tsx:7-15`)

| Fields | Size class | Computation |
|---|---|---|
| `id`, `name` | Small | Node set is self plus non-revoked certificate IDs. Names resolve listed name → registry name → self name → fallback. (`apps/gateway/src/mesh/mesh-routes.ts:267-298`, `apps/gateway/src/mesh/node-list-projection.ts:78-94`) |
| `publicKey` | Fixed medium, normally 43 base64url characters | Self uses `nodePk`; peers decode `ed_pk` from their certificate, then encode it. Nodes without a valid key are omitted. (`apps/gateway/src/mesh/node-list-projection.ts:97-110`, `apps/gateway/src/mesh/node-list-projection.ts:197-201`) |
| `online`, `reach` | Tiny | `online` is self, hub-presence, or reachable peer; `reach` comes from the live peer address/transport classification. (`apps/gateway/src/mesh/node-list-projection.ts:176-188`, `apps/gateway/src/mesh/peer-manager.ts:612-625`) |
| `transport`, `rttMs` | Tiny | Reads cached live-link state; self is always `null`. No REST RTT probe is performed. (`apps/gateway/src/mesh/node-list-projection.ts:141-148`, `apps/gateway/src/mesh/peer-manager.ts:425-430`) |
| `version`, `direct_capable` | Small | Comes from stored peer metadata, overridden by live node status for self; version also falls back to `inventory.version`. (`apps/gateway/src/mesh/node-list-projection.ts:54-69`, `apps/gateway/src/mesh/node-list-projection.ts:190-206`) |
| `inventory` | Largest, unbounded variable | JSON-parsed stored peer metadata, or live self status. Its type is `unknown`; no size limit is applied. (`apps/gateway/src/mesh/node-list-projection.ts:6-10`, `apps/gateway/src/mesh/node-list-projection.ts:177-194`) |
| `loggedIn`, `isHub` | Tiny | `loggedIn` checks the request cookie map; `isHub` compares the resolved hub node ID. (`apps/gateway/src/mesh/node-list-projection.ts:197-210`) |
| `peerAddress`, `linkSinceAt` | Variable | Read from the in-memory live link. (`apps/gateway/src/mesh/node-list-projection.ts:125-138`, `apps/gateway/src/mesh/peer-manager.ts:433-440`) |
| `endpoints` | Variable | Parsed from stored `endpointsJson`; all string entries are retained. (`apps/gateway/src/mesh/node-list-projection.ts:210-217`) |
| `directFailure` | Variable, potentially large | Reads the last direct-attempt diagnostic, including arbitrary WS/DataChannel error strings. (`apps/gateway/src/mesh/peer-manager.ts:433-440`, `packages/api-client/src/auth/types.ts:181-189`) |

The request performs full-table reads of certificates, peer cache, and node registry. `listReach()` itself reads `peer_cache`, then `collectNodes()` reads it again; `getHubMeta()` can issue another peer-cache query. JSON parsing and certificate decoding are per request, but link, transport, and RTT values are cached in memory. (`apps/gateway/src/mesh/mesh-routes.ts:263-298`, `apps/gateway/src/auth/user-store.ts:296-298`, `apps/gateway/src/auth/user-store.ts:354-356`, `apps/gateway/src/auth/user-store.ts:397-414`, `apps/gateway/src/auth/user-store.ts:462-464`)

There is no application-level gzip/Brotli or API ETag. `json()` only serializes JSON, and the Bun server directly returns assembled responses. ETag/304 exists only in the static frontend handler. (`apps/gateway/src/api/http.ts:1-8`, `packages/app/src/runtime/server.ts:42-47`, `packages/app/src/runtime/serve-frontend.ts:63-86`)

A representative five-node serialization containing 32-byte public keys, two-device inventories, two endpoints on one node, and one direct-failure object is approximately **2.5 KB UTF-8 per response**. A compact `{id,name,online,loggedIn}` version of the same five nodes is approximately **0.45 KB**. These estimates exclude HTTP headers and TLS and reflect the field shapes covered by the DTO and route tests. (`packages/api-client/src/auth/types.ts:191-225`, `apps/gateway/src/mesh/mesh-routes.test.ts:173-247`, `apps/gateway/src/mesh/mesh-routes.test.ts:430-456`)

## 2. Client consumers

| DTO field | Current consumers | Sidebar steady state |
|---|---|---|
| `id`, `name`, `online`, `loggedIn` | Sidebar entries, node-offline state, brand name, login gate, device groups, settings table, join-token membership checks. (`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:61-77`, `apps/fe/src/node/node-offline.ts:25-40`, `apps/fe/src/components/brand.tsx:44-52`, `apps/fe/src/auth/use-node-login.ts:80-100`) | **Yes** |
| `inventory` | Offline sidebar devices and offline device-page fallback. (`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:295-301`, `apps/fe/src/pages/devices/node-device-group.tsx:235-247`) | **Only for offline nodes** |
| `publicKey` | Login pinning and settings fingerprint generation. (`apps/fe/src/auth/session-login.ts:381-412`, `apps/fe/src/node/mesh-nodes.ts:163-166`, `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:107-109`) | **No; auth/settings only** |
| `reach` | Settings reach column and device-page relay/LAN/WAN badge. (`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:51-56`, `apps/fe/src/node/device-node-badges.tsx:56-69`) | **No** |
| `transport`, `rttMs` | Device-page badge and diagnostics. (`apps/fe/src/node/device-node-badges.tsx:178-200`, `apps/fe/src/node/direct-diagnostics.ts:52-68`) | **No** |
| `peerAddress`, `linkSinceAt`, `directFailure` | Diagnostics popover only. (`apps/fe/src/node/device-node-badges.tsx:156-175`, `apps/fe/src/node/device-node-badges.tsx:287-300`) | **No; diagnostics only** |
| `endpoints` | No browser consumer uses this DTO field. The direct carrier instead uses node-scoped `/api/mesh/connection`, `/api/mesh/rtc-config`, and `/api/rtc/authorize`. (`apps/fe/src/node/node-runtimes.ts:112-123`, `packages/ws-client/src/direct/direct-carrier-controller.ts:526-614`) | **No** |
| `version` | Settings table, upgrade confirmation/status, and device-group header. (`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:97-99`, `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:184-187`, `apps/fe/src/pages/devices/node-device-group.tsx:143-150`) | **No** |
| `direct_capable`, `isHub` | Settings table and device-group header. (`apps/fe/src/node/mesh-nodes.ts:171-176`, `apps/fe/src/pages/devices/node-device-group.tsx:135-150`) | **No** |

## 3. WebSocket versus REST

The mesh WebSocket already broadcasts `status`, `reach`, `inventory`, `version`, `direct_capable`, `name`, `transport`, and `rttMs`. (`apps/gateway/src/mesh/mesh-routes.ts:366-389`, `apps/fe/src/node/mesh-events.ts:21-34`)

REST remains necessary for:

- Initial authoritative membership and public keys; events only patch already-known rows and do not add new rows. (`apps/fe/src/node/mesh-nodes.ts:42-48`)
- `loggedIn`, `isHub`, `peerAddress`, `linkSinceAt`, `endpoints`, and `directFailure`, none of which are carried by `NODE_EVENT`. (`apps/fe/src/node/mesh-events.ts:21-34`, `apps/fe/src/node/mesh-nodes.ts:56-72`)
- Full refresh after WebSocket reconnection, admission, or other missed events.

RTT is not REST-only: peer ping/pong updates cached RTT and emits link events asynchronously. (`apps/gateway/src/mesh/peer-manager.ts:1857-1878`, `apps/gateway/src/mesh/peer-manager.ts:1900-1908`)

## 4. Options

Assuming 2.5 KB and 120 polls/hour:

| Option | Approximate body saved/hour for five nodes | Trade-off |
|---|---:|---|
| A. Compact sidebar view | **~246 KB** | Major wire reduction, but requires separate summary/full caches. Devices, login, settings, and diagnostics still need full data. A compact projection that merely trims after `collectNodes()` does not reduce server computation. |
| B. ETag/304 | **~297.5 KB if unchanged** | Minimal client change and no DTO split, but the server still computes and serializes the projection unless it adds revision-based caching. RTT/link changes may invalidate the tag frequently. |
| C. Five-minute fallback + WS | **~270 KB**; event-only can approach **~300 KB** | Best balance. Requires reconnect/visibility/explicit-refresh handling and tolerates several minutes of REST staleness. |
| D. Do nothing | **0 KB** | Lowest risk; current volume is modest. |

## 5. Recommendation

Recommend **C first**:

- Change the resident fallback poll from 30 seconds to roughly five minutes.
- Refresh immediately on WebSocket reconnect, `visibilitychange` when stale, admission/revocation, explicit settings refresh, and diagnostics opening.
- Keep the full `/api/mesh/nodes` DTO unchanged for settings, login, device groups, and diagnostics.

The required hooks already exist: the event source exposes status listeners, visibility-aware polling already exists, and diagnostics explicitly refreshes the REST list. (`apps/fe/src/node/mesh-events.ts:343-356`, `apps/fe/src/node/mesh-nodes.ts:392-424`, `apps/fe/src/node/device-node-badges.tsx:259-263`)

If bandwidth remains material, add A later as an additive `?view=compact` or summary response. Do not replace the shared full `MeshNode` store with partial objects; use a distinct summary type and on-demand full fetches. Preserve the base endpoint unchanged. The current route matches by pathname, and older event frames are already decoded compatibly with missing optional fields preserved. (`apps/gateway/src/mesh/mesh-routes.ts:101-105`, `packages/shared/src/ws-borsh/schema.ts:554-573`, `apps/fe/src/node/mesh-events.ts:86-98`)

## 6. Files, diff size, risks, and value

For C, expected changes are approximately **40–80 lines**:

- `apps/fe/src/node/mesh-nodes.ts`: fallback interval and reconnect refresh.
- `apps/fe/src/node/mesh-nodes-resident.tsx`: resident interval configuration.
- `apps/fe/src/node/mesh-events.ts`: reconnect/status signaling if needed.
- Tests: `apps/fe/src/node/mesh-nodes.test.ts:423-498` and `apps/fe/src/node/mesh-events.test.ts:101-147`.

For A, expect roughly **250–450 lines** across `mesh-routes.ts`, `node-list-projection.ts`, API-client types/client, store, sidebar, devices, settings, and compatibility tests. For B, roughly **50–100 lines** in the route/HTTP helpers and tests.

Main risks are stale membership after a WebSocket gap, breaking login if `publicKey` is unavailable, and breaking offline device rendering if `inventory` is omitted. Test reconnect recovery, visibility refresh, unknown-node admission, old event frames, full-view fallback, and diagnostics freshness. (`apps/fe/src/auth/session-login.ts:384-412`, `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:295-301`, `apps/fe/src/node/mesh-nodes.ts:56-81`)

If the real concern is backend CPU rather than bandwidth, slimming the DTO is not compelling: the current cost is dominated by repeated DB reads and projection work, while five nodes consume only about 0.3 MB/hour. Lengthening polling is therefore the higher-value first change.