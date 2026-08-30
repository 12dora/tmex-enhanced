# G2 result — Mesh link reach classification + RTT

## What changed

`PeerReach` is now `'lan' | 'wan' | 'relay' | null`.

- `relay` transport → `relay` (unchanged).
- `ws-secure` / `dc` → classify the live link’s remote address:
  - lan: loopback, RFC1918, link-local, IPv6 ULA, IPv4-mapped forms of those, `localhost`
  - otherwise (including missing address) → `wan` (never claim lan without evidence)
- `online` treats `wan` like `lan` (`isPeerReachable`).
- Peer ping/pong records last RTT (`performance.now()`, integer ms), reset on transport switch; exposed as `rttOf(nodeId)`.
- `GET /api/mesh/nodes` rows include `reach`, `transport`, `rttMs`.
- Node-change events now carry `reach` including `wan`, plus `transport` / `rttMs` on the internal payload. Material RTT changes (≥ 10 ms or ≥ 20% of previous) emit a node event, rate-limited to once per ~10 s per node. Transport/reach changes emit immediately.

## Address sources

| Transport | Address used |
| --- | --- |
| `ws-secure` inbound | `PeerServer` `requestIP` (`onAccept` remoteIp) |
| `ws-secure` outbound | hostname of the dial URL |
| `dc` | `pc.getSelectedCandidatePair()?.remote.address` (or ICE candidate IP); else previous live path address; else wan |
| `relay` | ignored (reach is always `relay`) |
| `linkFactory` / in-memory with no address | `wan` |

**dc note:** `RtcPeerManager` does not expose a persistent selected-pair API (rtc/ is out of scope). We read `getSelectedCandidatePair()` on the `pc` returned by `connectToPeer`. If ICE is not yet connected at that moment, pair is null → previous ws-secure address if any, else `wan`.

Hub `uplink-server` node lists do **not** carry entry↔node `reach`/`rttMs` (hub presence ≠ peer link). Left unchanged.

## Node event wire gap

`packages/shared/src/ws-borsh` `NodeEventSchema` has no `transport` / `rttMs` fields and is **out of this task’s file scope**. `encodeNodeEvent` therefore only serializes existing fields. `reach: 'wan'` **does** go on the wire (string). Internal `NodeEventPayload` and `GET /api/mesh/nodes` already have `transport` + `rttMs`. O3 should read RTT from GET; live RTT events fire (deduped) so a later schema add will start carrying them without another peer-manager change.

## Files

**New**

- `apps/gateway/src/mesh/address-class.ts`
- `apps/gateway/src/mesh/address-class.test.ts`

**Edited**

- `apps/gateway/src/mesh/types.ts`
- `apps/gateway/src/mesh/mesh-deps.ts`
- `apps/gateway/src/mesh/peer-manager.ts`
- `apps/gateway/src/mesh/peer-manager.test.ts`
- `apps/gateway/src/mesh/node-list-projection.ts`
- `apps/gateway/src/mesh/node-list-projection.test.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`
- `apps/gateway/src/mesh/mesh-routes.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` (list/event projection + `onLinkInfo` + `wan` skip of synthetic offline; did not touch G1’s `notifyNodeOffline` / `mesh-agent-bridge`)
- `apps/gateway/src/mesh/node-event-dedupe.ts` (fingerprint includes `transport`/`rttMs`)
- `apps/gateway/src/mesh/node-event-dedupe.test.ts`
- `apps/gateway/src/mesh/auth-routes.test.ts` (`FakePeers`: `wan` + `rttOf`)

Did **not** edit `stream-targets.ts` / `mesh-http.ts` / `forwarder.ts` / `uplink-server.ts`.

## Verification

- `bun test src/mesh/address-class.test.ts src/mesh/node-list-projection.test.ts src/mesh/node-event-dedupe.test.ts src/mesh/mesh-routes.test.ts src/mesh/peer-manager.test.ts src/mesh/mesh-runtime.test.ts` → **130 pass / 0 fail**
- Also passed: `peer-manager.upgrade.test.ts`, `auth-routes.test.ts` (in a 82-pass mesh batch)
- `bunx biome check` on the 14 files above → clean
- `bunx tsc --noEmit -p .` in `apps/gateway`: **0 errors in G2 files**. Package-wide count is **29** (baseline 21). Extra errors are other agents (`agent/run-finish.test.ts` nodeId, `files/directory-browse.ts`, `stream-targets.test.ts`, etc.) — not G2.
- Full `apps/gateway && bun test`: **2458 pass / 35 fail**. Visible failures are G1’s `agent_sessions` migration (`ALTER TABLE __new_agent_sessions RENAME TO agent_sessions` in telegram tests). Mesh tests above are green.

## Left / risky

1. Node event **wire** still lacks `transport`/`rttMs` until `NodeEventSchema` is extended (shared, not in G2 scope). `reach=wan` is on the wire.
2. `dc` selected-pair is snapshotted at `connectToPeer` return, not updated if ICE later switches candidate.
3. Hostname that is not an IP (except `localhost`) → `wan`.
4. First RTT is only after the first ping interval (`PEER_PING_INTERVAL_MS` = 15s) unless tests tick the scheduler.
