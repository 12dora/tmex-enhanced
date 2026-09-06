# P2 — Port mapping review fixes (findings 2–7 + peer export cleanup)

Fixes for `R1-portmap-review.md` findings 2–7 (finding 1, the missing `0049_relay_limits.sql`, was
already fixed in the tree) plus the best-effort peer-to-peer export cleanup requested by the
frontend review. Scope stayed inside `apps/gateway/src/portmap/**`, the portmap integration test,
the doc, and a two-line insertion in the mesh-internal route table.

## (2) Half-close — what Bun 1.3.14 actually offers

Measured on this machine (throwaway scripts under the scratchpad, matrix over
{`Bun.listen` accepted socket, `Bun.connect` socket} × {`end()`, `shutdown(true)`, `node:net`
`end()` with `allowHalfOpen`, POSIX `shutdown(fd, SHUT_WR)`}):

| primitive | write-half shutdown with continued reads |
| --- | --- |
| `Bun.Socket.end()` (listener side and dialer side, `allowHalfOpen: true`) | **no** — the local handle is detached at once (`readyState` -1), the read half dies with it |
| `Bun.Socket.shutdown(true)` | **no** — fires our own `end` callback and never sends a FIN to the peer |
| `node:net` `createServer({allowHalfOpen:true})` / `connect({allowHalfOpen:true})` + `socket.end()` | **no** — Bun's `net` is a shim over the same socket; `end()` immediately emits `end`+`close`, the reply after EOF is lost (measured, both server- and client-side) |
| `bun:ffi` → libc `shutdown(fd, SHUT_WR)` | **yes** — FIN delivered, socket stays readable, reply after EOF arrives |

**Deviation from the task hint:** `node:net` with `allowHalfOpen` is *not* the answer on Bun 1.3.14 —
it behaves exactly like `Bun.Socket.end()`. Rewriting the adapter onto `node:net` would have changed
a lot of code and fixed nothing. Instead `apps/gateway/src/portmap/half-close.ts` calls POSIX
`shutdown(fd, SHUT_WR)` through `bun:ffi`, using the same lazy-`dlopen`-with-fallback pattern the
repo already uses for `dup2` in `log/rotate.ts` (macOS `/usr/lib/libSystem.B.dylib`; Linux tries
glibc then musl so names). `socket.fd` is a real getter on Bun's socket prototype; the call is
guarded on `readyState === 1` so a recycled fd can never be hit. When FFI is unavailable the adapter
falls back to `socket.end()`, i.e. exactly the pre-existing behaviour.

Two more measured quirks that the implementation had to handle:

- **A raw `shutdown` in the same tick as `socket.resume()` makes Bun drop the read half** (reply
  silently lost). The adapter therefore defers the write-half shutdown by one macrotask; a microtask
  is not enough (measured).
- After a real remote FIN Bun fires the `end` callback **twice** when our write half is already shut
  down; `TcpStreamPump.onEnd()` is idempotent.

Pump semantics now: remote `END` → write-half shutdown only, keep pumping socket→stream until the
target's own FIN; both directions done → graceful `close()`. `LinkStream` semantics unchanged.
New test `pump.test.ts > keeps the read half after a stream END …` and the end-to-end
`portmap.integration.test.ts > delivers a reply the target only produces after the client half-closes`.

## (3) Shared per-peer budget

`apps/gateway/src/portmap/budget.ts`: one counter per peer nodeId, shared by A-side listeners (all
maps targeting that node, taken at `accept` before any stream is opened) and B-side inbound streams
(taken before the target is dialled; over budget → `stream.reset('portmap-peer-limit')`). Slots are
released only when the socket is actually disposed.

**Number deviation:** the task said 64, but 64 portmap streams × 1 MiB window = 64 of the mux's
`MAX_LINK_UNACKED` 65 MiB, which leaves nothing for the terminal/file/ctl traffic the same link
carries — the reviewer explicitly asked for reserved capacity. `PORT_MAP_MAX_PEER_STREAMS = 48`
reserves 17 windows. The per-map cap (`PORT_MAP_MAX_CONNECTIONS = 64`) is kept as a secondary guard.
Tests: `budget.test.ts` (accounting, idempotent release, per-peer isolation),
`manager.test.ts > two maps to the same node share one peer link budget` (the reviewer's
two-mappings reproduction), `accept-tcp-stream.test.ts` (inbound refusal + slot release).

## (4) Cold dial

- No more 1 MiB `early` buffer growth: the socket is **not** paused at accept (so a client that
  connects and leaves is still noticed immediately — Bun's `pause()` defers `data`/`end`/`close`
  alike, measured), but the *first* chunk that arrives before the pump exists pauses it. Excess
  bytes stay in the kernel buffer under normal TCP backpressure; the program holds one chunk.
  The 1 MiB cap survives only as a defensive backstop.
- `getLink` + `openStream` are bounded by `PORT_MAP_DIAL_DEADLINE_MS = 15_000` (`withDeadline` in
  `dial.ts`, which also resets a stream that arrives late).
- On any dial failure the listener `resume()`s before `terminate()` so a deferred `close` can fire,
  and calls `disposePumpSocketData` explicitly so the peer slot is released even if no close event
  ever arrives.
- Client-closed-mid-dial: the slot is released when the dial settles (attach → resume → deferred
  close → dispose), bounded by the 15 s deadline.
- Covered by `portmap.integration.test.ts > keeps the bytes sent while the peer link is still being
  dialled` (300 ms link dial delay, 2 MiB written into the window, byte-exact round trip).

## (5) Cancellable dial

`apps/gateway/src/portmap/dial.ts` — `dialTcp(options, timeoutMs)` returns `{ result, cancel() }`;
timeout and cancel both terminate the socket that connects anyway, so an address that silently drops
SYNs cannot accumulate descriptors. In `acceptTcpStream` the `stream.onAbort` handler is registered
**before** the dial starts (and re-checked after, since `onAbort` fires synchronously when the
stream is already aborted). `port-probe.ts`'s target probe now uses the same primitive. Pending and
active connections are bounded by the per-peer budget from (3), released on socket disposal rather
than on stream lifetime. Tests in `dial.test.ts`.

## (6) Resume

`PortMapManager.update()` now validates and binds **before** persisting `paused:false`; on failure
the row keeps `paused:true` and the `PortMapError` propagates (409/500 as before). Startup is retried
whenever the request is `paused:false` and there is no listener, which also covers a row whose
boot-time bind failed (`state:'error'`). Tests: `manager.test.ts > a failed resume keeps the row
paused and a later retry still binds` and `> resuming retries a map whose bind failed at boot`.

## (7) Tests

- `pump.test.ts`: response-after-FIN case added; the existing half-close assertions kept (all green).
- `portmap.integration.test.ts`: +3 tests — response after the client half-closes, slow reader
  (target reads nothing: asserts the map moved < 3 MiB of a 4 MiB push while stalled, then the full
  4 MiB round-trips after release and a second connection over the same peer link still works), and
  the cold-dial case above. `tcpClient` now uses `allowHalfOpen`.
- New `test-echo-server.ts` fixtures: `startAfterFinServer`, `startSlowEchoServer`.
- **Not done:** the reviewer also asked for a real secure peer transport in this suite instead of
  the in-memory pair. That is a rewrite of the mesh integration harness (secure-channel over a real
  ws peer server) shared with the other mesh integration tests and well outside this fix scope; the
  delayed-establishment and slow-reader gaps it was meant to expose are now covered directly.

## Extra — peer-to-peer export cleanup

- New `apps/gateway/src/portmap/internal-routes.ts`:
  `DELETE|POST /api/mesh-internal/portmap/exports/:mapId`, deletes the export **only** when its
  `fromNodeId` equals the verified peer marker (the marker is stamped by the receiving side from the
  handshake identity in `stream-targets.ts`, sender headers are stripped). Missing row = already
  clean. POST is accepted as well because the internal forwarder only ever sends POST.
- Registered with a two-line edit (import + one list entry, appended last) in
  `apps/gateway/src/mesh/mesh-internal-tmux-routes.ts` — nothing reordered, so T1's concurrent edits
  to that table should merge cleanly.
- `export-cleanup.ts` calls it over the peer link through `getMeshAgentBridge().forwardInternalHttp`
  (5 s timeout); failures are logged only.
- `DELETE /api/portmap/:id` now returns `{ ok: true, exportRemoved: boolean }` — this matches the
  `DeletePortMapResult` that F1's `packages/api-client/src/portmap.ts` already parses. Injectable via
  `createPortMapRoutes({ removePeerExport })`; tested in `routes.test.ts` and `internal-routes.test.ts`.

## Files

New: `portmap/half-close.ts`, `budget.ts`, `dial.ts`, `socket-handlers.ts`, `internal-routes.ts`,
`export-cleanup.ts` (+ `budget.test.ts`, `dial.test.ts`, `internal-routes.test.ts`).
Changed: `portmap/pump.ts`, `listener.ts`, `accept-tcp-stream.ts`, `port-probe.ts`, `manager.ts`,
`routes.ts`, `store.ts` (`defaultPortMapExportStore()` moved here from `routes.ts`), `types.ts`,
`test-echo-server.ts`, the four portmap test files, `mesh/integration/portmap.integration.test.ts`,
`mesh/mesh-internal-tmux-routes.ts` (2 lines), `docs/mesh/2026090604-port-mapping.md`.

## Gates

- `bunx tsc --noEmit -p apps/gateway` → **0 errors from my files**. The only errors in the package
  are T1's in-flight transfer work, present at the time of writing:
  `src/transfer/dest-local.ts` (TS18048 ×4), `src/transfer/dest-remote.ts`,
  `src/transfer/receiver.ts` (TS2305: `./dest` has no exported member `ensureLocalParent`).
  An earlier run at 06:03, before those landed, was 0 errors across the whole package.
- `bun scripts/complexity/gate.ts` → **ok**, no violations from any of my files.
- `bunx biome check` on every file touched → clean.
- `bun test apps/gateway/src/portmap` → **48 pass / 0 fail** (9 files).
- `bun test apps/gateway/src/mesh/integration/portmap.integration.test.ts` → **9 pass / 0 fail**
  (last run while the package still compiled; it now aborts on import because it pulls in
  `mesh-runtime` → `transfer/dest.ts`, see below).
- Full `apps/gateway` suite at 06:03, before T1's transfer edits broke the imports:
  **5018 pass / 10 fail** across 5028 tests — the 10 are the documented baseline (9 `mesh phase-2
  integration` + 1 flaky DataChannel); no portmap test among them. The summary also showed 2
  "unhandled error between tests"; none of them came from a portmap file.
- A later full run (06:12) is **4482 pass / 39 fail / 39 errors**: every one of those is the same
  `SyntaxError: Export named 'ensureLocalParent' not found in .../transfer/dest.ts` aborting whole
  test files (including `runtime.test.ts`, `mesh-internal-tmux-routes.test.ts` and my
  `portmap.integration.test.ts`, all of which transitively import transfer). Nothing to do with this
  change — **the commander must re-run the suite once T1's transfer tree compiles.**

## Notes for the commander

1. On a platform where `bun:ffi` cannot open libc, half-close degrades to the old
   "END closes the socket" behaviour (logged nowhere; it is a silent capability check). Everything
   else keeps working. macOS and glibc/musl Linux are covered.
2. A half-closed connection now stays open until the *client* closes it (correct TCP semantics, but
   it holds a peer-budget slot). Well-behaved clients close on EOF.
3. `PORT_MAP_MAX_PEER_STREAMS = 48`, not 64 — see (3) for the reasoning; change the constant in
   `portmap/types.ts` if you want the literal 64.
