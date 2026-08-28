# RTC direct-path wake / transport / ICE diagnostics

## What changed

### Offerer wake-up (P0)
- Smaller node id is still the RTC offerer.
- When the *larger* id dials DC, it now sends an authenticated `rtc.signal` whose `sdp` is `{"type":"rtc.wake"}` (survives hub decode/forward with no hub protocol change; hub still only forwards).
- Receiver treats that as a wake: does not inbox it as SDP, calls `getLink()` so the smaller id runs the offerer path.
- Storm guards: one pending wake per peer, 5s cooldown (`PEER_RTC_WAKE_COOLDOWN_MS`), ignore when live transport is already `dc`.
- `node.list` / peer status already called `notifyPeerEndpointsChanged` after persisting `direct_capable`; flipping `false→true` now has a unit test that upgrades a live relay to `dc` from the larger-id side only.

### Transport API
- `PeerManager.waitForTransport(nodeId, kind, timeoutMs)`: resolves `true` immediately if already that transport, else waits; `false` on timeout/stop.
- `GET /api/mesh/nodes` adds `transport: 'ws-secure' | 'relay' | 'dc' | null` from `peers.transportOf(id)`. `reach` unchanged (`lan`/`relay`/`null`).
- Shared DTO: `packages/api-client/src/auth/types.ts` `MeshNode.transport?` (optional so existing FE constructors stay valid).
- `PeerLinkProvider.transportOf?` plus a one-line pass-through in `mesh-runtime.ts` (needed so production `collectNodes()` is not always `null`).

### ICE diagnostics
- `[mesh][rtc]` structured logs: dial start (peer, role, stun_count, turn_enabled), signal send/recv (kind, sdp_type, candidate_type, masked /24 addr), gathering/ice/peer state, DataChannel created/received/open/error/closed, dial failure + fallback, `ice failed peer=… local_types=[…] remote_types=[…]`.
- No full SDP, no ICE passwords, candidate IPs masked.
- `PeerConnectionLike` optional state accessors/callbacks wired from node-datachannel and `test-fakes.ts`. Candidate logs are rate-limited per peer/direction/type.

## Stream migration
Already-open **node↔node** streams stay on the old link during upgrade (existing retire/quiesce behavior). `carrier-switch.ts` only migrates **browser `sess`** GatewaySession carriers. New streams after `waitForTransport(..., 'dc')` use DC.

## Verification
- `cd apps/gateway && bun test src/mesh` — 295 pass, 0 fail
- `cd apps/gateway && bun test` — **2321 pass, 0 fail** (was 2311; +new tests)
- `bunx tsc --noEmit -p .` (gateway) — **21 errors** (baseline)
- `packages/api-client` tsc — **5 errors** (baseline)
- `bunx biome check` on changed files — clean

## Node id ordering tested
Forced hex ids: smaller `01`×16, larger `ff`×16 (`large.nodeId > small.nodeId`). Only `managerLarge.getLink(small.nodeId)` is called; both sides reach `transportOf === 'dc'`.

## Open issues
- None for this scope. Cross-NAT still needs STUN (and TURN for symmetric NAT); logs now distinguish “no srflx” vs “srflx both sides, no pair”.
- Touched `mesh-runtime.ts` and `auth-routes.test.ts` (FakePeers) so `transport` is actually populated; not in the original file list but required for the HTTP DTO.
