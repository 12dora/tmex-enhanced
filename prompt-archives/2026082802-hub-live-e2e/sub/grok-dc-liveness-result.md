# DataChannel liveness — result

## What changed

Application-level DC keepalive on **node↔node `DataChannelLink`** (not ICE):

- New `apps/gateway/src/mesh/rtc/liveness.ts`: ping/pong control fragments (`frameId=0`, 1-byte kind), `ChannelLiveness` watchdog.
- Defaults: `RTC_LIVENESS_INTERVAL_MS=3000`, `RTC_LIVENESS_TIMEOUT_MS=10000`. Env overrides via `readRtcLivenessConfig()` (`process.env.RTC_LIVENESS_*`, positive ints only).
- Idle channel: ping every interval. Any inbound (app or ping/pong) resets both timers — no extra ping load on busy links.
- After timeout with no inbound: log `[mesh][rtc] liveness timeout peer=… idle_ms=…`, close DC/PC (`liveness-timeout`). Existing `LinkMux` close → `dropPeer` → transport leaves `dc`; reconnect uses existing RTC wake cooldown (`PEER_RTC_WAKE_COOLDOWN_MS`).
- `DataChannelCarrier` (browser `sess`): intercepts ping/pong and replies to ping so they never become WS frames. Does **not** originate pings (FE `ws-client` does not speak this yet).
- `FakeClock` + `FakeDataChannel.dropSend` in `rtc/test-fakes.ts` for deterministic tests.

Docs: `docs/hub/2026082800-hub-node-operations.md` 直连 section + env table + troubleshooting.

`peer-manager.ts` unchanged (dropPeer already arms wake cooldown).

## How verified

- `cd apps/gateway && bun test src/mesh` — 331 pass, 0 fail
- `cd apps/gateway && bun test` — 2368 pass, 0 fail
- `bunx tsc --noEmit -p .` — **no new errors in scoped files**. Workspace count was 24 vs baseline 21; the extra 3 are `src/mesh/integration/stream-failover.integration.test.ts` (another agent).
- `bunx biome check` on changed TS files — clean

In-process: two PeerManagers on fake DC; `dropSend` silences the channel; `transportOf !== 'dc'` within timeout+interval; immediate wake/`getLink` does not storm.

## Open issues

- Browser `sess` still waits on ICE (~35 s) until FE sends/handles pings.
- UDP blackhole both ways is detected in ≤10 s; one-way loss is detected by the side with no inbound.
