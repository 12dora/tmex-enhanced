# getLink binds to the established link, never an in-progress DC re-dial

## What changed

`apps/gateway/src/mesh/peer-manager.ts`:

- `getLink()` always returns the current established `live` session immediately. Upgrades run on a separate `upgrading` map so they never occupy the `pending` slot `getLink` waits on.
- If `getLink` is already waiting on a foreground dial, it races that dial against `live` appearing (inbound accept / promote) and returns the established session as soon as one exists.
- After DC loss (`lostDirect`), a foreground dial tries `ws-secure` then relay first; DC is last-resort only. Background upgrade retries still try DC once a fallback is live.
- DC drop promotes a still-open retiring relay/ws-secure back to `live`, so `transportOf()` and `getLink()` do not go through a null window that would wait on ICE.
- `transportOf()` still reads only `live.transport`; DC is tracked only after `rtc.connectToPeer` (handshake) returns.
- `openStream` on a session `getLink` already returned is allowed while that session is retiring, so a GET that raced a later DC swap stays on the healthy fallback.

Tests: `peer-manager.test.ts`, `peer-manager.upgrade.test.ts`, `direct-path.integration.test.ts` (8 MiB HTTP over relay while a stubbed DC re-dial fails for 5 s).

## How verified

- `cd apps/gateway && bun test src/mesh/peer-manager.test.ts src/mesh/peer-manager.upgrade.test.ts src/mesh/integration/direct-path.integration.test.ts` — 66 pass / 0 fail.
- `bun test src/mesh` — 389 pass / 0 fail.
- `bunx tsc --noEmit -p .` — 21 errors (baseline).
- `bunx biome check` on the four changed files — clean.

## Open issues

- Handshake completion itself is still owned by `rtc.connectToPeer` / the concurrent rtc agent; this change only refuses to wait on or bind streams to that dial until it has fully succeeded and `track()`d.
- First-ever connect (no `lostDirect`, no live fallback) still tries DC first; that is intentional.
