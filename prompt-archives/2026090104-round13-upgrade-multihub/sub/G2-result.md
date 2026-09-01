# G2 result — node-side ordered uplink failover, hub-set persistence, `/api/mesh/hubs`

## What landed

A node no longer pins a single `UplinkClient` to `TMEX_HUB_URL`. `UplinkPool` owns one live client at a time, tries `MeshHubStore.orderedEndpoints()` merged with config seeds, fails over after 3 connect/auth failures or 20 s without authenticated state, wrap-around backoffs 1 s → 60 s (jitter), and make-before-break switches back when a more-preferred hub answers `/healthz`. `node.list.hubs[]` (or a synthesized legacy `hub` row) is persisted in `mesh_hubs`. HTTP surfaces `/api/mesh/hubs` and multi-hub `isHub` / `hubMode`. Auth mode writer fields use `pickWriterHub`. Relay diagnostics follow the currently attached hub host.

Standby attachment is not gated locally; the node obeys whatever the hub returns.

## Public API

### `UplinkPool` (`apps/gateway/src/mesh/uplink-pool.ts`)

```ts
export const UPLINK_POOL_FAIL_LIMIT = 3;
export const UPLINK_POOL_AUTH_DEADLINE_MS = 20_000;
export const UPLINK_POOL_PROBE_INTERVAL_MS = 60_000;
export const UPLINK_POOL_PROBE_TIMEOUT_MS = 5_000;
export const UPLINK_SEED_PRIORITY_BASE = 1_000;

export type UplinkCandidate = {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode;
  writerEpoch: number;
  priority: number;
  caFingerprint: string | null;
};

export type AttachedHub = {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode | null;
  writerEpoch: number | null;
  since: number;
};

export type UplinkPoolNodeListMeta = {
  hubNodeId: string | null;
  generation: number;
};

export class UplinkPool {
  constructor(opts: UplinkPoolOptions)
  readonly identity: MeshIdentity
  get userId(): string
  get state(): UplinkState
  get link(): LinkSession | null
  attachedHub(): AttachedHub | null
  candidates(): UplinkCandidate[]
  currentGeneration(): number
  liveClient(): UplinkClient | null
  onAttached(cb: (hub: AttachedHub) => void): () => void
  onDetached(cb: () => void): () => void
  onNodeList(cb: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void): () => void
  onStateChange(cb: (state: UplinkState) => void): () => void
  setOnRelayStream(handler: InboundRelayHandler | null): void
  start(connectOnce?: (signal: AbortSignal) => Promise<void>): void
  connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
  sendCtl(msg: UplinkCtlMessage): void
  sendStatus(): void
  sendStatusIfChanged(): boolean
  openRelay(toNodeId: string): Promise<LinkStream>
  queryHubHead() / queryKeyLogAt() / appendAndAck()
  switchTo(publicUrl: string): Promise<void>  // tests + probe switch-back
}

export function mergeUplinkCandidates(stored, seeds: string[]): UplinkCandidate[]
export function recordsFromNodeList(list: UplinkNodeList): Array<Omit<MeshHubRecord, 'updatedAt'>>
```

`MeshRuntime.uplink` is now this pool (facade over the live `UplinkClient`). Existing `state` / `link` / `sendCtl` / `openRelay` / `stop` call sites keep working.

Helpers: `mergeUplinkCandidates` de-dupes by normalized URL; stored rows keep `orderedEndpoints()` order; unmatched seeds are appended with `mode:'active'`, `writerEpoch:0`, `priority = 1000+index`.

### `MeshRuntime.onNodeList` (G3 integration point)

```ts
onNodeList(
  cb: (list: UplinkNodeList, meta: { hubNodeId: string | null; generation: number }) => void
): () => void
```

Also: `attachedHub(): AttachedHub | null`. Generation is bumped on every successful promote; inbound `node.list` / `rtc.signal` / `enroll.redeemed` from a superseded client are dropped; the old client is `stop()`’d which cancels key-log catch-up.

### Config / env

Read from `MeshRuntimeConfig` (optional) then `gatewayConfig` for advertisement:

| Field | Env (G1) | Node-side use |
|---|---|---|
| `hubUrl` | `TMEX_HUB_URL` | first seed |
| `hubUrls` | `TMEX_HUB_URLS` | extra seeds after `hubUrl` |
| `hubPublicUrl` | `TMEX_HUB_PUBLIC_URL` | own `node.status.hub.publicUrl`; hub-role endpoint fallback |
| `hubMode` | `TMEX_HUB_MODE` | own advertisement `mode` |
| `hubPriority` | `TMEX_HUB_PRIORITY` | own advertisement `priority` |
| `hubWriterEpoch` | `TMEX_HUB_WRITER_EPOCH` | own advertisement `writerEpoch` |

Seeds used by the pool are **only** `config.hubUrl` then `config.hubUrls[]` (not a live read of `gatewayConfig.hubUrls`, so tests that pass a single `hubUrl` cannot accidentally pick up a shell `TMEX_HUB_URL`). If both are empty, fallback is `hubEndpointUrl(config)` (`hubPublicUrl` for hub role, else `http://127.0.0.1`).

**G5** should pass `hubUrls: config.hubUrls` (and `hubMode` / `hubPriority` / `hubWriterEpoch`) when assembling `MeshRuntimeConfig`. Until then a production node still failovers across `mesh_hubs` learned from `node.list`, plus the single configured `hubUrl`.

CA pin: per-URL `HubTrustStore`. If `hubs[]` carries `caFingerprint` and that URL has no pin, fetch `<publicUrl>/api/tls/ca.crt` with `tls: { rejectUnauthorized: false }` for that request only, verify SPKI SHA-256 equals the fingerprint that arrived on the authenticated uplink, then `HubTrustStore.put`. Fingerprints that did not arrive over an authenticated `node.list` are never trusted.

Probe: while attached to candidate index > 0, every 60 s `GET <preferred>/healthz` (5 s, per-URL pin). On success, `switchTo` (make-before-break) then `node.status`.

## HTTP

- `GET /api/mesh/hubs` (session required) → `{ hubs: HubEndpointInfo[], attached, writerHubId, candidates }`
- `GET /api/mesh/nodes`: `isHub` for every `MeshHubStore` id; `hubMode?: 'active'|'standby'`
- `GET /api/auth/mode`: `hubNodeId` / `hubPublicUrl` are the **writer** (`pickWriterHub`), not the attached or self-as-hub sentinel. Empty store falls back to the legacy `peer_cache` `node_id='hub'` row / hub-role self.

`listedNames` now carries `node.list.hubs[].name` into the nodes projection.

## Files touched

Owned:

- `apps/gateway/src/mesh/uplink-pool.ts` (new)
- `apps/gateway/src/mesh/uplink-pool.test.ts` (new)
- `apps/gateway/src/mesh/uplink-client.ts` (`attemptConnect`, public `hubUrl`, `waitUntilClosed`, `node.status.hub`)
- `apps/gateway/src/mesh/mesh-runtime.ts`
- `apps/gateway/src/mesh/mesh-runtime.test.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`
- `apps/gateway/src/mesh/mesh-routes.test.ts` (did **not** touch remote-upgrade cases ~1002–1479)
- `apps/gateway/src/mesh/node-list-projection.ts` (+test)
- `apps/gateway/src/mesh/peer-manager.ts` (+test; `hubHost` is a getter/provider)
- `apps/gateway/src/mesh/auth-routes.ts` / `auth-routes.test.ts` (writer hub only)
- `apps/gateway/src/mesh/index.ts` (re-export pool)

Necessary glue outside the original list (pass-through only; commander should keep):

- `apps/gateway/src/mesh/mesh-http.ts` — optional `hubStore` / `attachedHub` / `hubCandidates` forwarded to `MeshRoutes` and `AuthRoutes`. Without this, `/api/mesh/hubs` and writer fields cannot be wired from `MeshRuntime`.

Did **not** touch `apps/gateway/src/hub/**`, `src/system/**`, `mesh/forwarder.ts`, `packages/shared/**`, `config.ts`, `db/**`, `auth/mesh-hub-store.ts`, `packages/app/**`, `apps/fe/**`.

## Test counts

| Suite | Result |
|---|---|
| `uplink-pool.test.ts` | **10 pass** (order, 3-fail failover, 20 s deadline, wrap-around backoff, make-before-break `switchTo`, generation guard, per-URL pin, probe switch-back, merge/legacy records) |
| mesh-runtime / routes / projection / auth / peer-manager additions | persist `hubs[]`, legacy `hub` synthesis + prune keeps all hub ids, own advertisement, `/api/mesh/hubs`, `isHub`/`hubMode`, writer auth-mode, hubHost getter |
| `apps/gateway && bun test` | **3206 pass / 0 fail** (315 files) |
| `apps/gateway && bunx tsc --noEmit -p .` | **0 errors** |
| `bunx biome check` on G2 files | **clean** (15 files) |
| `src/mesh/integration` | **37 pass / 0 fail** |

No `src/system/**` or `src/hub/**` failures in this run (G4 appears complete).

## Commander / later agents

- **G3**: subscribe with `mesh.onNodeList((list, meta) => …)` to replicate the registry from the node-side `node.list`. `meta.generation` / `meta.hubNodeId` identify the producing uplink. Encode `hubs[]` on hub `node.list` (G1 already shipped the codec).
- **G5**: thread `hubUrls` / `hubMode` / `hubPriority` / `hubWriterEpoch` into `createMeshRuntime({ config })`. CLI `hub list` can call `GET /api/mesh/hubs`.
- **O2 / FE**: `/api/mesh/hubs` and per-node `hubMode` are ready.
- `MeshRuntime.uplink` type is `UplinkPool`. Duck-typed `state`/`link`/`openRelay` still work; `instanceof UplinkClient` would not.

## Open risks

- After a *successful* session drops, the pool sleeps one jittered 1 s (same family as the old client backoff) before retrying from the preferred candidate. This is required so tests (and real `wsFactory` swaps) can install the next transport; it is not the wrap-around 1 s→60 s ladder (that still only runs when **all** candidates fail).
- 20 s auth deadline uses `scheduler.sleep` but only aborts if `now()` actually advanced by ≥20 s, so `ImmediateScheduler` (instant sleep, frozen `now`) does not false-trigger failover.
- Same-process hub+node still uses in-memory `start(connectOnce)` on the first candidate (`uplinkHub` defaults to the local `HubRuntime`). Tests that need the fake WS factory with `roles.hub` can pass `uplinkHub: null`.
- `mesh-http.ts` was edited for pass-through. If the commander wants that file untouched, `/api/mesh/hubs` would only work on `MeshRuntime.handleRequest` after a wrapper — current wiring is the pass-through.
