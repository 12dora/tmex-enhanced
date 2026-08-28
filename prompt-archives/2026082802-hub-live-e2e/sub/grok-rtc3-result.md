# RTC wake / fanout review round-2 (93a09db)

## What changed

1. **Fanout handoff (blocker).** `fanoutDataChannel` buffers messages while no `onMessage` listener is attached, replays them in order to the first subscriber, and replays terminal close/error to late subscribers. `handshakeDataChannel` detaches its message/closed listeners on `stop()`. `DataChannelLink` (and carrier) queues frames until `onData`/`onMessage` and replays close to late `onClose`. After handshake, `connectToPeer` refuses a closed channel instead of handing out a dead link. Tests cover: A finishes handshake and sends a LinkMux OPEN before B constructs its link; close during the window (`linkClosed:1, isOpen:false`).

2. **Incoming cooldown.** Per-peer `nextEligibleAt` is set *before* parse/verify, so bad signatures cannot force unbounded Ed25519 work. `dropPeer()` no longer deletes the gate; it floors `nextEligibleAt` at `now + 5s` so DC churn cannot immediately redial.

3. **Replay cache.** Per-peer `Map<from, Map<nonce, expiresAt>>`, retained until `issued_at + 60s`, pruned by time. Per-peer cap 256; at cap, new nonces are rejected (no FIFO eviction of still-valid entries).

4. **Nonce.** `parseRtcWakeSdp` (and accept path) require canonical base64url of exactly 16 bytes.

5. **`maskIceAddress`.** Expand `::` to 8 hextets, then mask to IPv6 /48 with zeroed remainder: `[2001:db8::dead:beef]:3478 → [2001:db8::]:3478`, `2001:db8::1 → 2001:db8::`, `::1 → ::`.

6. **Revoked integration.** The revoked-node wake is sent through the answerer's authenticated uplink (`rtc.signal` with a session that includes the revoked cert). Hub `rtcNodesOwnedBy` drops it; no more direct `receiveRtcSignal` inject.

## Verification

- `cd apps/gateway && bun test src/mesh` — **321 pass, 0 fail**
- `cd apps/gateway && bun test` — **2351 pass, 0 fail**
- `bunx tsc --noEmit -p .` — **21 errors** (baseline; none in RTC files)
- `bunx biome check` on changed files — clean

## Open issues

Forged wakes now consume the incoming 5s cooldown (intended). The hub integration success path may wait for that window before the offerer dials; still inside the 20s test budget. Finding 6 uses hub forwarding of a revoked *session*, not a third live uplink that is revoked mid-connection.
