# RTC wake / transport / diagnostics review fixes (e2facea)

## What changed

1. **Wake is end-to-end signed.** `encodeRtcWakeSdp` now signs `{domain:'tmex-rtc-wake', from, to, rtcSession, nonce, issued_at}` with the sender node's Ed25519 key. Receiver verifies against the trusted `node_certs` `ed_pk` for `from`, and rejects bad signature, `|now - issued_at| > 60s`, replayed nonce (256-entry FIFO), `from`/`to`/`rtcSession` mismatch, or a revoked cert. Hub still only forwards the `rtc.signal` envelope; the signature lives inside `sdp`.

2. **Receiver rate limit + offerer check.** Incoming wakes are authenticated before a success log. Valid wakes consume a 5s per-peer cooldown. Drops (auth / not-offerer / rate) use `rtcLogRateLimited`. Receiver must be the lexicographically smaller id (offerer); otherwise drop.

3. **Sender cooldown no longer swallows reconnect.** `releaseRtcWakeAttempt` (renamed from `clearRtcWake`) clears inflight and cancels a deferred resend. If cooldown blocks a needed wake, `armDeferredRtcWake` fires at `nextEligibleAt` (cancelled when DC is live or the pending dial ends). Incoming cooldown is cleared on `dropPeer` so a reconnect wake is accepted.

4. **`waitForTransport` / `stop()`.** The waiter closure now forwards the resolve value, so `stop()` yields `false`. Each waiter has its own timeout `AbortController`; early success/stop/revoke aborts the sleep.

5. **Revoke fails waiters immediately** via `failTransportWaiters`.

6. **Single native callback + fanout.** `fanoutDataChannel` registers `onOpen`/`onClosed`/`onError`/`onMessage`/`onBufferedAmountLow` once on the real `node-datachannel` object (which keeps one `ThreadSafeCallback` per event in `src/cpp/data-channel-wrapper.cpp`, e.g. `mOnOpenCallback = std::make_unique<ThreadSafeCallback>(…)`) and fans out to diagnostics, open-waiter, handshake, and `DataChannelLink`/`DataChannelCarrier`. `test-fakes.ts` now overwrites like native so a missing fanout fails the new test.

7. **`maskIceAddress`** handles `::ffff:a.b.c.d`, `[::ffff:a.b.c.d]:port`, bracketed v6 with port, and `a.b.c.d:port`.

8. **Integration test** `src/mesh/integration/rtc-wake.integration.test.ts`: hub + two in-process nodes, real authenticated uplink. Forged wakes (unsigned / wrong key / spoofed `from` / revoked node) create no PeerConnection; single-sided `getLink()` from the larger id then yields `dc` both sides.

Docs: `docs/hub/2026082800-hub-node-operations.md` wake paragraph updated.

Did not change `mesh-runtime.ts` / `mesh-routes.ts` / uplink protocol (signature is inside `sdp`).

## Why wake needed signing; SDP/candidates left unsigned

Wake is a control poke with no follow-up handshake of its own: a compromised hub can inject `dc:A:B + {type:rtc.wake}` and make B create a PeerConnection and emit host/srflx/TURN candidates. SDP/ICE on the same `rtc.signal` envelope are still unsigned, but they are bound after the DataChannel opens: `handshakeDataChannel` signs a `tmex/peer/v1` transcript that includes each side's DTLS fingerprint (from SDP `a=fingerprint` / `pc.remoteFingerprint()`), verified against the peer's `node_certs` Ed25519 key. A hub-forged offer cannot complete that handshake or reach the data plane. Incoming SDP can still start a dial (same ICE-metadata class as unsigned wake), but that is existing glare/late-signal behavior and is not a new identity hole; signing the whole envelope would be a protocol change. Not widened.

## Verification

- `cd apps/gateway && bun test src/mesh` — **309 pass, 0 fail**
- `cd apps/gateway && bun test` — **2336 pass, 0 fail** (was 2321)
- `bunx tsc --noEmit -p .` — **21 errors** (baseline)
- `bunx biome check` on changed files — clean

## Open issues

None in scope. A compromised hub can still induce ICE gathering by injecting an SDP offer (handshake then fails); only wake was signed.
