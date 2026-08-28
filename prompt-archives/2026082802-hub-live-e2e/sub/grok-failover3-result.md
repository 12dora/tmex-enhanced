# Stream failover 3 — generation conflict, orphan WS, legacy gap

## What changed

`apps/gateway/src/mesh/forwarder.ts` (tests + ops doc). `mesh-http.ts` unchanged — close/open still delegate into Forwarder.

1. **Generation conflict.** Browser frames during failover stay queued (`failingOver`). Replay still uses live `StreamReplayState` (so a mid-failover `SetPaneSubscriptions` is the resume snapshot). After the synthesized canonical resume is sent, `markCanonicalResumeSent()` records that generation; `flushQueue` rewrites any queued `SetPaneSubscriptions` to `max(queued, resume)+1` so the new link never sees two different sets at the same generation. A second flush after `failingOver=false` catches the flag-flip race.

2. **Orphan upstream WS.** Failover tracks `pump.inflight` around `openWsStream()`. After every `await` (`sleep` / `getLink` / `openWsStream` / replay) it re-checks `browserClosed` / abort. If the browser is gone, `discardStream()` closes the just-opened stream. `handleForwardSocketClose` also closes `inflight`. Initial `/n/:id/ws` open checks `req.signal` after `getLink`/`openWsStream` and closes a stream opened after abort.

3. **Legacy gap.** After replaying `TMUX_SUBSCRIBE_PANES` + `TMUX_SELECT`, resume synthesizes `TMUX_FETCH_PANE_HISTORY` for every subscribed pane (no windowId needed; `windowId: null` SELECT remains a no-op). Target answers with `TERM_HISTORY` so the view is snapshot-reconstructed. Canonical path is unchanged (cursor-exact `terminalSeq`).

Ops: `docs/hub/2026082800-hub-node-operations.md` now states canonical = cursor-exact resume, legacy = snapshot/`TERM_HISTORY` resume, plus queued generation bump.

## How verified

TDD: three unit tests were RED, then GREEN.

- `subscribe change sent mid-failover wins on the new link without generation conflict` — was RED (`generation 5` then queued `4`); now last sub is `%2` and generations strictly increase.
- `closing the browser during failover getLink/openWsStream closes the orphan upstream` — was RED (`waitUntil` timeout, `orphanClosed=false`); now the failover `openWsStream` result is `closedOnce`.
- Legacy replay kinds now include `TMUX_FETCH_PANE_HISTORY` for `%1`.

Integration: producer keeps incrementing SEQ during the DC-dead gap; fake runtime `fetchPaneHistory` returns that buffer; after failover the entry sees `TERM_HISTORY` covering gap SEQ plus live `TERM_OUTPUT`. Union of SEQ from start is contiguous (`1..max`).

- `bunx biome check` on changed TS — clean.
- `bunx tsc --noEmit -p .` — **21 errors** (baseline).
- `bun test src/mesh/forwarder.test.ts src/mesh/integration/stream-failover.integration.test.ts` — 43 pass / 0 fail.
- `bun test src/mesh` — **369 pass / 0 fail**.

## Open issues

- Legacy resume is still snapshot-based, not cursor-exact. Output that tmux already dropped from the pane history buffer cannot be recovered; FETCH only rebuilds what `fetchPaneHistory` still has.
- `TMUX_SELECT` with `windowId: null` remains a no-op; live feed is armed by SUBSCRIBE, history by FETCH.
- POST/streaming HTTP bodies are still not retried (unchanged).
