# Stream failover 2 — pane feed never continues

## Root cause

LAN capture (`evidence-seq-capture-lan.err.txt`) matches the Borsh kinds:

| kind | name |
| --- | --- |
| 0x2 | HELLO_S2C |
| 0x102 | DEVICE_CONNECTED |
| 0x208 | STATE_SNAPSHOT |
| 0x209 | STATE_SNAPSHOT_DIFF |
| 0x305 | TERM_OUTPUT (legacy) |

`scripts/hub-e2e/driver/terminal.ts` is a **legacy** subscriber: HELLO → DEVICE_CONNECT → wait DEVICE_CONNECTED + STATE_SNAPSHOT → TMUX_SUBSCRIBE_PANES → TMUX_SELECT (`windowId: null`, `wantHistory: true`). SEQ markers are taken only from 0x305.

The previous failover (c5a845b) replayed HELLO, then **immediately** dumped DEVICE_CONNECT + SUBSCRIBE + SELECT. Target `handleMessage` is fire-and-forget (`void handleBorshMessage`), and `handleDeviceConnect` is async. `handleSubscribePanes` / `handleTmuxSelect` no-op when `connections.get(deviceId)` is missing. After a slow dc→ws-secure failover the idle-grace entry is gone, so subscribe is dropped. DEVICE_CONNECT later sends 0x208 (forwarded; HELLO_S2C / DEVICE_CONNECTED swallowed) and never re-arms legacy observers → no more 0x305. Seq reset is a red herring (0x208 seq=3 is the new session).

The old integration test injected 0x305 onto any negotiated client and never sent DEVICE_CONNECT, so it could not catch this.

## What changed

`apps/gateway/src/mesh/forwarder.ts` (plus `STREAM_FAILOVER_RESUME_WAIT_MS` in `mesh-deps.ts`):

1. Replay HELLO, wait HELLO_S2C.
2. Replay DEVICE_CONNECT only.
3. Wait until DEVICE_CONNECTED (all devices) **and** STATE_SNAPSHOT/CHUNK if there are legacy pane subs (8s timeout; tests that stub `sleep` still skip instantly).
4. Then replay canonical resume, TMUX_SUBSCRIBE_PANES, TMUX_SELECT, agent subs.

Log is now:

`[mesh][stream] failover stream=… from=… to=… resumed=N mode=legacy|canonical|none panes=<ids> cursor=<pane:seq or ->`

`mesh-http.ts` / `link-stream-carrier.ts` unchanged (bug was replay order, not HTTP or the carrier).

## How verified

- Unit: `legacy failover waits for DEVICE_CONNECTED and snapshot before replaying subscribe` — was RED (SUBSCRIBE/SELECT sent with DEVICE_CONNECT), now GREEN. Log includes `mode=legacy panes=%1 cursor=-`.
- Integration: `legacy HELLO/DEVICE_CONNECT/SUBSCRIBE/SELECT keeps 0x305 SEQ after dc death` — delayed second `acquireRuntime`, release idle entries on session close, live `broadcastTerminalOutput` producer; 0x305 continues after failover with contiguous SEQ.
- `bunx biome check` on touched files — clean.
- `bunx tsc --noEmit -p .` — 21 errors (baseline).
- Scoped: `bun test src/mesh/forwarder.test.ts src/mesh/integration/stream-failover.integration.test.ts` — 41 pass / 0 fail.

## Open issues

- `bun test src/mesh` / full `apps/gateway bun test`: **2389 pass / 5 fail**. Failures are concurrent rtc work outside this scope (`data-channel-link` 1 MiB fragment, `fragmenter` max mux frame, `channel-fanout` 2 MiB burst, plus two bulk HTTP-over-DC tests). Not caused by this change.
- SEQ produced while the old session is dead and the new one is not yet subscribed is still dropped (tmux already printed it). After observers re-arm, 0x305 continues; that window is the failover gap, not a stuck feed.
- TMUX_SELECT with `windowId: null` remains a no-op on the target; the live feed is armed by SUBSCRIBE, same as `terminal.ts`.
