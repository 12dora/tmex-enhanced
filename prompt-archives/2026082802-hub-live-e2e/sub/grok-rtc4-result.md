# RTC round 4 — result

## What changed

### Blocker 1 — handshake ↔ fanout
`handshakeDataChannel` no longer treats non-hello/sig frames as protocol errors. Binary LinkMux OPEN (and any other non-handshake frame) is collected while the handshake listener is attached. `recvQueue.stop()` returns leftover pending bytes instead of dropping them. After a successful verify, leftovers are prepended onto the fanout buffer via `reinjectMessages()` so a later `DataChannelLink` still sees OPEN in order.

Covered by `delayed sig then immediate OPEN is handed back to the later-attached link`.

### Blocker 2 — browser `sess` nonce → carrier
`waitFirstMessage()` now:
- `shiftPendingMessage()` if nonce+frames already sat in the fanout buffer
- detaches the one-shot listener after the nonce (and on timeout)

Fanout replay also re-buffers remaining queued frames if the listener unsubs mid-replay.

Covered by `browser sess nonce plus the first carrier frame back-to-back reaches the carrier`.

### Should-fix 3 — overflow closes instead of silent drop
Fanout / `DataChannelLink` / `DataChannelCarrier` pending buffers (cap 32) close the channel on overflow and log `[mesh][rtc] buffer overflow peer=… dropped=…`. Truncated streams are not delivered.

### Should-fix 4 — cooldown after verify + token bucket
Incoming wake cooldown is committed only after a successful signature verify (dropPeer still holds a 5s gate against DC churn). Verification work is bounded per peer: 5 tokens / 5s (refill 1/s). A single forged wake no longer blocks the next legitimate one.

### Re-dial after direct-link loss
Losing a live `dc` marks the peer and, once a quiesce-capable relay/ws-secure link is back, schedules upgrade retries at 5s, 15s, 30s, 60s, then every 120s. Log: `[mesh][rtc] upgrade retry peer=… attempt=… in_ms=…`. Cancelled when DC is established, on revoke/stop, or when `direct_capable` is false. Upgrade-gate backoff is reset on DC loss so this schedule owns timing; wake cooldown is still respected.

Covered by `direct-link loss retries upgrade on the bounded schedule while relay stays up` (recording scheduler).

### Nit (revoked-case realism)
Skipped — needs a third online node + hub registry, not cheap inside this scope.

## Verification
- `cd apps/gateway && bun test src/mesh` — 353 pass, 0 fail
- `cd apps/gateway && bun test` — 2386 pass, 0 fail
- `bunx tsc --noEmit -p .` — 21 errors (baseline; none in touched files)
- `bunx biome check <changed files>` — clean

## Open issues
- Review-3 revoked integration still vacuum-passes (offline identity, no live uplink).
- Overflow closes the paired fake channel in tests; production close of one DC is the intended failover trigger.
