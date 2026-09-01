# G2b result — RV3 node-side fixes + G6 attached.hubNodeId

## Fix mapping

| Item | Status |
|---|---|
| F1 RV3 blocker 2 — per-candidate transport; dual-role standby uplinks to active | Done |
| F2 RV3 blocker 4 — re-sync after live `node.list` (attached meta + `syncProbe`) | Done |
| F3 RV3 should-fix 1 — single-flight switch token + probe in-flight + ±20% jitter | Done |
| F4 RV3 should-fix 3 — CA bootstrap 5s / 64KiB / single CA PEM / 64-hex / per-URL single-flight | Done |
| F5 RV3 should-fix 4 — relay only on live; fork/relay generation-guarded | Done |
| F6 RV3 should-fix 5 — CA fingerprint refresh | Done (poll) |
| F7 RV3 nit — post-promote `sendStatusIfChanged` only | Done |
| F8 RV3 should-fix 2 node part — `onNodeList` meta `hubNodeId` is attached hub | Done |
| F9 RV3 blocker 5 node part — `HUB_NOT_WRITER` non-fatal sync + local-write gate | Done |

`authorizedHubIds:` line in `new HubRuntime({ config })` was already present from G3b; kept.

## F1 — transport per candidate

`UplinkPool.start(connectOnce)` no longer lock-in to the first candidate. The connect loop always walks the ordered list. For each candidate:

- **InMemoryLink** via `connectLocal` iff `isLocalCandidate(cand)` (default wiring: `uplinkHub` is set **and** `isSelfHubCandidate` — `hubNodeId === own node id` **or** normalized URL equals own `hubPublicUrl` / `hubEndpointUrl(config)`).
- otherwise the normal WS factory + per-URL CA pin.

Active hub: self is preferred → in-memory. Standby: active ranks above self → WS to active, in-memory self only as fallback; probe/switch-back treats self as just another candidate.

Auth transcript still signs the URL actually dialled (`UplinkClient.hubUrl`).

## F2 / F8 / G6

After each live `node.list`:

1. `opts.onNodeList` persists (`handleUplinkNodeList` → `MeshHubStore.replaceAll`)
2. refresh `attached.{hubNodeId,mode,writerEpoch}` from the list row then from `candidates()` matching the attached URL
3. emit listeners with `meta.hubNodeId = attached.hubNodeId` (authenticated sender, **not** `list.hub.nodeId` / writer)
4. `syncProbe()` — if attached is no longer index 0, the 60s (±20%) probe starts and can `switchTo`

G6 skip un-skipped: first seed attach now fills `attached.hubNodeId` from the live list.

## F3

Shared `switchToken`: `switchTo` and `tryCandidate` both `beginSwitch()`. A completed older connect never `promote`s over a newer live link; if superseded while already online, it waits on the current live session instead of starting a competing loop.

Probe: in-flight guard (overlapping ticks no-op); interval `jitteredIntervalMs(base, 0.2)` → `[0.8, 1.2] × 60s`. Tests pass `probeJitter: 0` for a deterministic 60s.

## F4

`defaultFetchCaPem`: 5s timeout (`CA_BOOTSTRAP_TIMEOUT_MS`), 64 KiB max (`CA_BOOTSTRAP_MAX_BYTES`), abort even if the injected fetch ignores `signal`. Fingerprint must be 64 hex **before** any fetch. Body must be exactly one PEM **and** `X509Certificate.ca === true`. Per-URL single-flight map. Existing dummy-PEM tests still override `fingerprintPem` and skip the CA parse.

## F5

`setOnRelayStream` installs only on `live`. `spawn` does not attach relay to pending. `onKeyLogFork` is wrapped with `this.live !== client`. Pending relay/fork is ignored.

## F6

`HubTlsInfoProvider` is a getter only — **no change callback**. `createMeshRuntime` polls every **10 minutes** (`TLS_STATUS_POLL_MS`, overridable `tlsPollIntervalMs`) when `tlsInfo` is set, refreshes `state.caFingerprint`, and calls `sendStatusIfChanged()` on change.

## F7

`promote` calls `client.sendStatusIfChanged()` (UplinkClient already sent `node.status` on authenticate). Duplicate send only if status actually changed.

## F9 rule (exact)

**HTTP (`POST /api/auth/keylog`, all passkey/TOTP/admit/revoke records go through this):**

```
if attachedHub() is null → keep previous behaviour
  (dual-role / hub: local apply then best-effort publish;
   node-only: hub-sync first)
if attachedHub() is set AND is not pickWriterHub(MeshHubStore)
  → 409 { code:'HUB_NOT_WRITER', writerHubId, writerPublicUrl, writerEpoch }
    BEFORE keyLogService.apply / publishAndAck
attached is writer if attached.hubNodeId === writerId
  OR sameHubUrl(attached.publicUrl, writer.publicUrl)
if store has no writer at all but attached is known
  → 409 with null writer fields (do not extend a chain toward a non-writer)
```

Offline-capable local ops do not regress: unknown/offline attach (`attachedHub() === null`) still applies locally on dual-role.

**Catch-up (`UplinkKeyLogSync.pushMissingToHub`):** `error === 'HUB_NOT_WRITER'` is non-fatal. Log once (`[uplink] key-log append deferred: attached hub is not writer; will retry after hub change`). Keep local records. Do not tear down. Do not retry in the same generation (no hot loop). `reset()` on the next attach clears the skip so catch-up retries.

Shared codec still drops extra ack writer fields; the node keys off `error`.

Origin (from G3b, confirmed): the only local-first user-signed path is `AuthRoutes.handleKeyLog` without hub-sync (dual-role / hub). Node-only already hub-first. Gated both before that branch.

## Harness (F1 + G3b allowlist)

Dual-role B/E/twin now use `wsFactory: router.factory` (no `uplinkHub: A's hub`). A authorizes B/E/twin via `config.hubPeers` at **HubRuntime construction** (no runtime setter). `createPendingNode()` allocates identity first so A can take `hubPeers: [pending.identity.nodeIdHex]` before the peer advertises. E/twin omit A from their own `hubPeers` so the harness seed `writerEpoch: 99` does not fence them at start (G3b F2 trap).

## Files touched

- `apps/gateway/src/mesh/uplink-pool.ts` / `.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` / `.test.ts`
- `apps/gateway/src/mesh/uplink-key-log-sync.ts` / `.test.ts`
- `apps/gateway/src/mesh/auth-routes.ts` / `.test.ts`
- `apps/gateway/src/mesh/mesh-http.ts` (`attachedHub` → AuthRoutes)
- `apps/gateway/src/mesh/integration/multi-hub-harness.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts` (un-skip G2; E/twin pending identity)

Did **not** touch `src/hub/**`, `config.ts`, `src/system/**`, `packages/**`, `apps/fe/**`, `forwarder.ts`, `stream-targets.ts`, remote-upgrade cases in `mesh-routes.test.ts`.

## Test counts

| Suite | Result |
|---|---|
| `uplink-pool.test.ts` | **20 pass** (was 10; +F1 dual-role, F2 resync/probe, F8 meta, F3 switch/probe, F5 pending, F7, F4 CA) |
| `uplink-key-log-sync.test.ts` | **6 pass** (+F9a HUB_NOT_WRITER non-fatal) |
| `auth-routes.test.ts` | +F9b 409 before local apply; +offline/unknown still applies |
| `mesh-runtime.test.ts` | +F6 TLS poll advertisement |
| `multi-hub.integration.test.ts` | **11 pass / 0 skip / 0 fail** (G2 un-skipped) |
| `cd apps/gateway && bun test src/mesh` | **646 pass / 0 fail** (51 files) |
| `bunx tsc --noEmit -p .` | **0 errors** |
| `bunx biome check` on G2b files | **clean** (11 files) |

## Open risks

- TLS fingerprint uses 10 min poll; a CA rotation is advertised late until the next tick (or process restart). No TLS service event exists to hook.
- `start(connectOnce)` is accepted but ignored; dual-role must use `connectLocal` / `isLocalCandidate`.
- Node-only tests that pass `uplinkHub: <remote HubRuntime>` still match in-memory because `hubEndpointUrl` for a node is `hubUrl` (the remote). Dual-role uses `hubPublicUrl` so standby does **not** treat the remote as self. Intentional for existing A+B in-memory tests; G6 C/D already pass `uplinkHub: null` + `wsFactory`.
- Fresh standby first boot: unmatched `hubUrl` seeds still append after stored self (G2 merge). Harness pre-seeds A as active. Production first attach to a remote active still depends on that stored order (or a prior `node.list`).
