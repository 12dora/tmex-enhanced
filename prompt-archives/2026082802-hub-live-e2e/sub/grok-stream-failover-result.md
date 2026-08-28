# Stream failover (node↔node WS) — result

## What changed

Forwarded `/n/:id/ws` pumps no longer die with the DataChannel. `Forwarder` tracks the bound link/transport and outbound protocol state (HELLO, DEVICE_CONNECT, TMUX_SUBSCRIBE_PANES, last TMUX_SELECT, AGENT_SUBSCRIBE, canonical `SetPaneSubscriptions`). On upstream abort it keeps the browser WS open, `getLink()`s the current best peer, reopens the stream, replays HELLO (swallows extra HELLO_S2C / DEVICE_CONNECTED), then replays subscriptions. Canonical pane cursors are patched from inbound `PaneData.seqEnd` so resume does not drop output.

If no link is ready, retries use bounded backoff (`STREAM_FAILOVER_BACKOFF_MS`, 7 attempts). Exhaustion closes the browser WS (`1011 failover-exhausted`) so the client reconnects as before. Log:

`[mesh][stream] failover stream=… from=dc to=relay|ws-secure|dc resumed=<n panes>`

GET/HEAD HTTP forwards retry `getLink` + `openHttpStream` up to `HTTP_FAILOVER_MAX_ATTEMPTS` before 503. POST/body requests are not retried (body already consumed).

Did not touch `peer-manager.ts` / `rtc/**`. Detection is the existing stream `onClose` (link RST/abort) plus `peers.getLink` / `transportOf`.

Docs: `docs/hub/2026082800-hub-node-operations.md` 直连 section now describes entry↔node stream failover.

## How verified

- `cd apps/gateway && bun test src/mesh` — 338 pass / 0 fail (includes new integration).
- Unit: failover replays subscribe and keeps browser WS; canonical cursor patched to last `seqEnd`; retries then resume; GET retries transient `getLink` failure; budget exhaustion closes browser.
- Integration (`src/mesh/integration/stream-failover.integration.test.ts`): real DC (fake native), pane SEQ producer, kill DC, entry-side SEQ contiguous, browser WS stays up. Observed `from=dc to=dc` when ICE comes back, `from=dc to=relay` when DC re-dial times out.
- `bunx biome check` on touched files — clean.
- `bunx tsc --noEmit -p .` — **no new errors in scoped files**. Repo-wide gateway count moved due to concurrent uplink-client work (not this task).

## Open issues

- After DC death, `getLink()` may spend up to RTC connect timeout (~15s) trying DC again before falling back to relay (PeerManager dial order). Failover still succeeds; the browser WS stays open during the wait. Shortening that belongs in peer-manager (out of scope).
- POST/streaming HTTP bodies are not retried.
- Full `apps/gateway bun test` was red from a concurrent agent’s broken `uplink-client` (`classifyUplinkConnectError` missing). Scoped mesh tests are green.
