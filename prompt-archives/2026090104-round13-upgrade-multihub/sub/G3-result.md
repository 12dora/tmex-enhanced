# G3 result — hub active/standby, hub-set broadcast, standby replication, write fencing

## What landed

Phase-1 multi-hub on the hub side. A hub process now has `active` / `standby` mode, collects hub advertisements from `node.status`, broadcasts `hubs[]` / `writerHubId` / `writerEpoch` on `node.list`, fences itself when it sees a higher-epoch active, rejects HTTP writes in standby, and can project a remote `node.list` into `nodes` + `mesh_hubs`.

Did **not** touch `user-store.ts`. Membership upserts go through `node-persistence.upsertEnrolledNode`.

## New `HubRuntimeConfig` fields

All optional so existing constructors (`mesh-runtime.ts` still passes `{ publicUrl, stun, turn, nodeId, siteName }`) keep compiling. `HubRuntime` / `UplinkServer` apply defaults.

```ts
export type HubRuntimeConfig = {
  publicUrl: string;
  stun: string[];
  turn?: HubTurnConfig;
  nodeId?: string;
  siteName?: string;
  mode?: HubMode;          // default 'active'
  priority?: number;       // default 100 active / 200 standby
  writerEpoch?: number;    // default 1
  hubNodeId?: string;      // own node id; falls back to nodeId; must be 32-hex to upsert/broadcast
};
```

`hubNodeId ?? nodeId` is the own hub id. Invalid/missing id → no self row in `mesh_hubs`.

## `HubRuntimeOptions`

```ts
export type HubRuntimeOptions = {
  db: AuthDb;
  userStore: UserStore;
  keyLogSource: HubKeyLogSource;
  config: HubRuntimeConfig;
  authenticate: HubAuthenticate;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
  tlsInfo?: HubTlsInfoProvider;
  meshHubs?: MeshHubStore; // default: new MeshHubStore(opts.db)
};
```

`HubRuntime` also exposes `readonly meshHubs`, plus:

- `mode(): HubMode`
- `setMode(mode: HubMode)` — runtime demotion; upserts self; rebroadcasts
- `writerEpoch(): number`

`UplinkServerOptions` gained the same optional `meshHubs`. `UplinkServer` owns the mutable mode and implements the same getters/setters; `HubRuntime` delegates.

## `applyReplicatedNodeList`

```ts
// HubRuntime method (what G5/G2 should call)
applyReplicatedNodeList(
  list: UplinkNodeList,              // MeshUplinkNodeList from @tmex/shared/uplink
  meta: { hubNodeId: string | null } // source hub that sent the list
): void

// also exported from apps/gateway/src/hub (hub-replication.ts)
export function applyReplicatedNodeList(
  db: AuthDb,
  userStore: UserStore,
  meshHubs: MeshHubStore,
  list: UplinkNodeList,
  meta: { hubNodeId: string | null },
  self: { hubNodeId: string | undefined; record: OwnHubRow | null },
  now: number
): void
```

`UplinkNodeList` is `MeshUplinkNodeList` (node-side codec). Ignore when `meta.hubNodeId === own hubNodeId` (dual-role receiving our own broadcast).

For each listed node: upsert `nodes` **only** if `node_certs` has a non-revoked cert. Creates the `nodes` row when the cert exists but the registry row does not. Local nodes absent from the list are **not deleted**; their `last_seen_at` is left untouched (GET `/api/hub/nodes` still reports `online` from the in-memory registry, so they show offline unless currently uplinked).

`list.hubs` → `MeshHubStore.replaceAll`, always keeping the local own row (`mode` / `priority` / `writerEpoch` / `publicUrl` of this process). If `list.hubs` is omitted, hub rows are not touched (old writers).

## Exact 409 body

Standby rejects:

- `POST /api/hub/enrollments`
- `POST /api/hub/enrollments/redeem` (before body parse; public)
- `POST /api/hub/nodes/:id/rename`
- `POST /api/hub/nodes/:id/revoke`

Authenticated writes still 401 first if there is no session.

```ts
{
  code: 'HUB_NOT_WRITER',           // HUB_NOT_WRITER from @tmex/shared/uplink
  writerHubId: string | null,       // pickWriterHub(meshHubs.list())
  writerPublicUrl: string | null,   // that row's publicUrl
  writerEpoch: number | null        // that row's writerEpoch
}
```

All three writer fields are `null` when no active hub is in the store.

Reads stay 200: `GET /api/hub/nodes`, `GET /api/hub/enrollments/:id`, uplink auth, `node.list`, relay, rtc, `key.log.req`.

## `key.log.append` on standby

There is no separate “fresh append” ctl API. `key.log.append` is the catch-up path (node ahead of this hub pushes signed records). Standby **accepts** chain-extending, signature-verified appends. HTTP revoke/enroll is the fenced write surface.

## Advertisement / broadcast / fencing

- Self upserted at `UplinkServer` construct (`online: true`).
- `node.status.hub` → upsert `MeshHubStore` (`hubNodeId` = sender, `online: true`, `lastSeenAt` = now).
- That node disconnects → `online: false` (never mark **self** offline).
- `node.list` includes `hubs` (online overlaid from registry; self always online), `writerHubId` / `writerEpoch` from `pickWriterHub`, and legacy `hub` = **writer** if known else self.
- Hub-set changes reuse the existing coalesced `broadcastNodeList` path (`broadcastAllNodeLists`).
- Active + advertisement `mode:'active'` + `writerEpoch` **greater** than own → `console.error('[hub] fenced: higher writerEpoch=… from hub=…')`, `setMode('standby')`, upsert self, rebroadcast.
- Equal epoch from another active → `console.warn('[hub] split-brain: equal writerEpoch=… from hub=…')` every 60s (`HUB_SPLIT_BRAIN_LOG_INTERVAL_MS`). Never auto-promote.

G1: v1.1.5 decoder ignores unknown keys. **Legacy encoder is not used.**

## Replication limitations (phase 1)

- **Enrollment tokens are not replicated.** Standby cannot create or redeem them (`HUB_NOT_WRITER`). Pending tokens that only exist on the writer are invisible on the standby until a later phase.
- Key log / `node_certs` are **not** copied by this path; they continue to arrive via existing node catch-up (`key.log.req` / `key.log.append`) on the dual-role node side (same DB).
- `nodes` rows are only created for ids that already have a non-revoked cert. Unknown ids in the list are ignored.
- `node.list` `online` on a standby is live uplink state on **this** hub, not the writer’s online bitmap (absent-from-list nodes are simply not refreshed).

## Files touched

- `apps/gateway/src/hub/types.ts`
- `apps/gateway/src/hub/hub-runtime.ts`
- `apps/gateway/src/hub/hub-runtime.test.ts`
- `apps/gateway/src/hub/uplink-server.ts`
- `apps/gateway/src/hub/uplink-server.test.ts`
- `apps/gateway/src/hub/node-persistence.ts`
- `apps/gateway/src/hub/hub-replication.ts` (new)
- `apps/gateway/src/hub/hub-replication.test.ts` (new)
- `apps/gateway/src/hub/index.ts`

Not touched: `user-store.ts`, `src/mesh/**`, `src/system/**`, `config.ts`, `db/**`, `auth/mesh-hub-store.ts`, `packages/**`, `apps/fe/**`.

## Commander / G5 wiring (required)

`mesh-runtime.ts` still constructs `HubRuntime` without the new config fields (G2 owns that file). G5 should pass:

```ts
config: {
  publicUrl: hubEndpointUrl(config),
  stun: config.stunServers,
  turn: ...,
  nodeId: identity.nodeIdHex,
  hubNodeId: identity.nodeIdHex,
  siteName: resolveSiteName(),
  mode: config.hubMode,
  priority: config.hubPriority,
  writerEpoch: config.hubWriterEpoch,
},
meshHubs, // share the MeshHubStore instance with the node-side pool
```

On every `node.list` the **local node uplink** receives from the hub it is attached to:

```ts
hub.applyReplicatedNodeList(list, { hubNodeId: sourceHubNodeId /* not self */ });
```

Until that call is wired, standby registry replication is dormant (method is ready).

## Verification

| Check | Result |
|---|---|
| `apps/gateway` `src/hub/**` | **85 pass / 0 fail** (7 files, 817 expects). **+12** new tests. |
| gateway tests excluding `src/mesh/**` and `src/system/**` | **2482 pass / 0 fail** (254 files) |
| full `apps/gateway && bun test` | started; ran >18 min concurrent with G2’s mesh suite and was aborted. Not chased. Re-run after G2/G4 land. Baseline this round was 3134; G1 already saw G4 holes. |
| `bunx tsc --noEmit -p .` | **0 errors in `src/hub/**`**. Remaining: `src/mesh/mesh-runtime.ts` (`UplinkClient` vs `UplinkPool`), `src/mesh/uplink-client.ts` (`UplinkStatus.hub`) — G2 in-progress. |
| `bunx biome check` on the 9 G3 files | **clean** |

## Open risks

- Replication is unused until G5/G2 call `applyReplicatedNodeList`. Dual-role must pass the **remote** hub id so self-sourced lists are ignored.
- Standby `key.log.append` can still extend the chain. That is required for catch-up when nodes failover while ahead; HTTP writes remain fenced.
- `HubRuntimeConfig` fields are optional. If G5 forgets `mode: 'standby'`, a standby process stays active and will accept writes.
