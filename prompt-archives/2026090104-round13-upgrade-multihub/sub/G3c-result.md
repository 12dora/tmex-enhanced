# G3c result — hub-to-hub status polling so a promoted standby fences the old writer

## What landed

Public `GET /api/hub/status` plus a `HubPeerPoller` owned by `HubRuntime`. Authorized peers are probed at start (2 s) and every 60 s (±20% jitter). A higher-epoch active status fences this process through the same path as an authorized `node.status.hub` advertisement.

This closes the live gap: promoted B attaches to itself and never sends `node.status.hub` to A; A (or a returning old writer) now learns the new epoch over HTTP.

## Endpoint

`GET /api/hub/status` — no session, same class as `/healthz`. Body from `ownHubSnapshot()`:

```json
{
  "hubNodeId": "<32-hex>",
  "publicUrl": "https://…",
  "mode": "active",
  "priority": 100,
  "writerEpoch": 2,
  "name": "optional",
  "caFingerprint": null,
  "now": 1234567890
}
```

Missing/invalid own hub id → `503 { error: "hub_unconfigured" }`.

## Poller

`apps/gateway/src/hub/hub-peer-poller.ts`, started when `HubRuntimeOptions.hubTrust` is set (production `createMeshRuntime` always passes it).

- Targets: `mesh_hubs` rows whose id ∈ `authorizedHubIds`, excluding self.
- Fetch: `<publicUrl>/api/hub/status`, 5 s timeout. TLS pin via `HubTrustStore.get` + `uplinkWebSocketTls` / `joinHubPath` from uplink-pool (no duplicated pin logic). No pin + https → system trust. TLS failures logged once / 10 min / URL.
- Body `hubNodeId` must be 32-hex **and** equal the row id; mismatch → warn, ignore, do not fence.
- Success → `UplinkServer.applyAuthorizedHubAdvertisement(..., 'peer-status')`: upsert `online: true`, fencing, split-brain warn, rebroadcast.
- Higher-epoch active → `setMode('standby')`, log `[hub] fenced by peer status: higher writerEpoch=… from hub=…`.
- Equal epoch active → existing split-brain warn, no demote.
- 3 consecutive failures → `online: false`, row kept.
- Immediate poll on `setMode()` and when a new authorized hub row appears (uplink ad or replicated `node.list`).
- `pollPeersNow()` for tests / immediate triggers. Timers are `unref`'d; closed-DB / abort after `mesh.stop()` is swallowed (see commander).

Security (code comment + docs): status is trusted only because the URL is TLS-authenticated (pin or system CA) **and** the hub id is on the local allowlist. An unauthorized URL/id cannot fence us.

## Files touched

- `apps/gateway/src/hub/hub-peer-poller.ts` (new)
- `apps/gateway/src/hub/hub-peer-poller.test.ts` (new)
- `apps/gateway/src/hub/hub-runtime.ts` / `hub-runtime.test.ts`
- `apps/gateway/src/hub/uplink-server.ts` — public `applyAuthorizedHubAdvertisement` / `isAuthorizedHub`; `onModeChange` / `onNewAuthorizedHub`
- `apps/gateway/src/hub/index.ts` — re-export poller
- `apps/gateway/src/mesh/mesh-runtime.ts` — `hubTrust: new HubTrustStore(db)` in `new HubRuntime({...})`
- `apps/gateway/src/mesh/integration/hub-peer-poll.integration.test.ts` (new; harness read-only)
- `docs/hub/2026090104-multi-hub-standby.md` — section「hub 间状态探测」

Did **not** touch `uplink-pool.ts`, `uplink-client.ts`, `forwarder.ts`, `src/system/**`, `packages/**`, `apps/fe/**`, `multi-hub-harness.ts`, `multi-hub.integration.test.ts`. No git operations.

## Tests

| Suite | Result |
|---|---|
| `hub-peer-poller.test.ts` | higher-epoch fence + broadcast; body id mismatch ignored; equal epoch warn only; offline after 3 fails; timeout abort; jitter `[48000,72000]`; `setMode` triggers poll |
| `hub-runtime.test.ts` | `GET /api/hub/status` shape, no auth |
| `hub-peer-poll.integration.test.ts` | promote B active epoch 2; `A.pollPeersNow()` → A standby; C's `node.list` writer = B |
| `src/hub` + `src/mesh/integration` | **153 pass / 0 fail** (18 files, 1810 expects). Was G3b hub 90; **+8** hub tests + 1 integration |

## Verification

| Check | Result |
|---|---|
| `bunx biome check` on 8 owned files | **clean** |
| `cd apps/gateway && bun test src/hub src/mesh/integration` | **153 pass / 0 fail** |
| `bunx tsc --noEmit -p .` | **0 errors** |

## Commander

`mesh.stop()` still does not call `hub.stop()`. The poller therefore survives mesh shutdown in tests; it `unref`s timers and swallows closed-DB errors. Production process exit is fine. Optional one-liner in `assembleMeshRuntime` `stop()`:

```ts
['hub', () => hub?.stop() ?? Promise.resolve()],
```

That file is owned by other agents; not applied here.

## Open risks

- First-phase poll uses the peer's stored `publicUrl`. If that URL is stale, we need a later `node.list` / allow to refresh it.
- `TMEX_HUB_PEERS` is still per-machine env; a returning old writer that never `allow`ed the new writer still will not fence itself.
- Immediate poll on first authorized advertisement will HTTP-probe that URL even when we just got the ad over uplink (redundant, not wrong).
