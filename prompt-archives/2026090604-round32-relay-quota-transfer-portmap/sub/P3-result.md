# P3 — Port-mapping socket layer reworked onto `node:net`

Fixes the live-test failure the commander hit through a real relay topology: transfers ≥ 20–50 MiB
through a mapping were RST with `portmap-buffer-overflow` / `portmap-client-gone`.

## Root cause (re-measured on Bun 1.3.14)

`Bun.listen` / `Bun.connect` sockets honour `socket.pause()` only before the first `resume()`.
After a resume, a saturating sender (python `socket.sendall` loop) is not throttled at all — even
calling `pause()` in every `data` callback. The pump's in-process queue grew to 32–43 MiB and the
overflow guard tore the connection down. Confirmed with the commander's `bunlisten-c.ts` /
`pump-repro.ts`.

`node:net` on the same machine: `pause()` is real backpressure — 0 bytes delivered after pause,
`readableLength` parked at ~3 MiB, the python sender blocked in the kernel. So both sides are now
`node:net`.

Three Bun `node:net` quirks had to be worked around (each verified with a throwaway script):

| quirk | workaround |
| --- | --- |
| `createServer({allowHalfOpen:true})` / `connect({allowHalfOpen:true})` options are **ignored** (accepted socket reads `allowHalfOpen === false`), so a peer FIN destroys the socket | set `socket.allowHalfOpen = true` on every **instance** (`prepareSocket()`); measured: a reply written 300 ms after the peer's FIN then arrives |
| `socket.end()` still closes both halves | keep the FFI POSIX `shutdown(fd, SHUT_WR)`, applied to `socket._handle` (present with `fd` + `readyState` on both accepted and `net.connect` sockets); FFI bypasses node's write queue, so the adapter waits for all in-flight write callbacks first |
| a peer **RST** is reported as plain `end` (no `error`, no `close`) — with `allowHalfOpen` the socket would hang forever holding a budget slot | in the `end` handler, `socket._handle` is already gone on RST but still present (`readyState === 1`) after a real FIN — the missing handle is treated as "peer gone": destroy → `close` → slot released, stream RST as before |

`server.listen()` reports bind errors only via an event, but the bind itself is synchronous:
`server.address()` is `null` immediately when the port is taken (verified for IP hosts *and*
hostnames like `localhost`, which Bun resolves synchronously). `PortMapListener.start()` uses that
to keep throwing `PortMapError('port_in_use')` synchronously; a late `error` event goes through the
new `onBindFailed` callback which flips the manager row back to `state:'error'`.

## Water marks / flow control

- **local → remote**: queue > **1 MiB** (`PENDING_HIGH_WATER`) ⇒ `socket.pause()`; back under
  **256 KiB** (`PENDING_LOW_WATER`) ⇒ `socket.resume()`. `await stream.write` is the actual drain.
  Hard cap `MAX_PENDING_BYTES = 8 MiB` is now only a safety net (8× the HWM).
- **remote → local**: each mux chunk is written to the socket; if `socket.write()` returns `false`
  (past `writableHighWaterMark`) the pump waits for `drain` before pulling the next chunk. Since the
  mux only returns `WINDOW` credit when the app reads, "not reading" is the cross-mesh backpressure.
- Dial window unchanged: not paused at accept (so "connect and leave" is still noticed), paused on
  the first chunk, 1 MiB `MAX_EARLY_BYTES` backstop, 15 s dial deadline.

## Files touched

Rewritten: `apps/gateway/src/portmap/pump.ts` (took over the commander's uncommitted watermark
experiment; the Bun-specific `setTimeout` resume dance is gone since node's pause is real),
`socket-handlers.ts` (now `prepareSocket` / `attachPumpSocketHandlers` / `netPumpSocket` /
`destroySocket`), `listener.ts` (`net.createServer`), `dial.ts` (`net.connect`, cancellable,
signature simplified to `dialTcp({host, port}, timeoutMs)`), `test-echo-server.ts` (all fixtures on
`node:net` so their own pause/half-open behave).
Adapted: `accept-tcp-stream.ts`, `port-probe.ts`, `manager.ts` (+`markBindFailed`),
`half-close.ts` (comment only — the FFI code is unchanged, it now receives `_handle`).
Tests: `pump.test.ts`, `dial.test.ts`, `accept-tcp-stream.test.ts` (async `afterEach` so deferred
socket closes return their budget slot before the counter is reset),
`mesh/integration/portmap.integration.test.ts`.
Docs: `docs/mesh/2026090604-port-mapping.md` — new "为什么两侧都用 `node:net`" section with the
measurements above, rewritten 背压 / 半关闭与中断, plus the bind-error-timing note.

Public API kept: `PortMapManager`, routes, `budget.ts`, `store.ts`, `dispatch.ts`, error codes,
`port_in_use` / probe behaviour, `setNoDelay(true)`, counters, per-peer budget
(`PORT_MAP_MAX_PEER_STREAMS = 48`). `PumpSocket.write` changed from `number` (bytes written) to
`boolean` (false ⇒ wait for drain) — internal to the portmap module.

## Verification

**Saturating sender through the real pump** (`node:net` listener + `TcpStreamPump` + in-memory
`LinkMux` pair + slow consumer, python `sendall` loop, script kept at
`…/scratchpad/p3/saturate.ts` + `sat-send.py`):

| consumer delay | pushed | moved | **max pending** | destroy reason | RSS |
| --- | --- | --- | --- | --- | --- |
| 2 ms / chunk | 300 MiB offered, 269 MiB accepted in 19 s | 247 MiB | **1.49 MiB** | none | 158 MiB |
| 20 ms / chunk | 400 MiB offered, 95 MiB accepted in 14 s | 34 MiB | **1.48 MiB** | none | 141 MiB |

Peak queue ≈ 1.5× the 1 MiB high-water mark in both cases, i.e. well inside the required 2×, and the
sender is visibly blocked instead of the link being torn down.

**Unit + integration**: `bun test apps/gateway/src/portmap apps/gateway/src/mesh/integration/portmap.integration.test.ts`
→ **63 pass / 0 fail** (10 files, 6.7 s). New/updated coverage: high/low-water pause+resume,
drain-gated downlink, socket-close-without-FIN ⇒ RST, response-after-FIN in both directions,
cold dial (300 ms link dial + 2 MiB in flight), slow reader, cancellable dial, per-peer budget,
**56 MiB single-connection round trip** (byte-exact via FNV-1a, `bytesIn == bytesOut == 56 MiB`) and
**8 concurrent connections × 6 MiB** over one peer link. The slow-target assertion was retightened:
32 MiB pushed at a target that reads nothing stalls under 8 MiB in flight (kernel + shim buffers
included) instead of swallowing the payload.

**Full package**: `bun test apps/gateway/src` → **5048 pass / 11 fail** (5059 across 459 files,
215 s). 10 of the 11 are the documented baseline (9 `mesh phase-2 integration` + the flaky
DataChannel 8 MiB test); the 11th, `relay enroll and tenant fan-out > enroll proof 端到端`, passes
**6/6 in isolation** — load-related flake, unrelated to portmap.

**Gates**: `bunx tsc --noEmit -p apps/gateway` → 0 errors. `bunx biome check` on every touched file
→ clean. `bun scripts/complexity/gate.ts` → ok (no new violations, no allowlist entries).

**Real end-to-end** (hub harness booted from source on 19771/19772 — the relay harness ports were
left alone; torn down afterwards, no processes or tmux servers left):

```
-- map on A: listening 47121 -> 47120
n=100        ok=True
n=5242880    ok=True  190.9 MB/s
n=20971520   ok=True  214.3 MB/s
n=52428800   ok=True  273.1 MB/s
half-duplex n=3145728 ok=True eof-propagated=True
8 concurrent 2 MiB      ok=True ×8 (~35 MB/s each)
paused: connect refused as expected  /  resume: n=1000 ok=True
counters: totalConnections=14 bytesIn=98567244 bytesOut=98567244
delete: {"ok":true,"exportRemoved":true}; exports left on B: []; port freed: free=true
```

Extra live runs on a second mapping: **200 MiB round trip ok=True (272 MB/s)** and a
**64 MiB push against a client that throttles itself to ~1 MiB/s for 6 s** — `ok=True`, no RST,
`bytesIn == bytesOut == 276824064`.

## Deviations / notes for the commander

1. **P2's conclusion that `node:net` does not help is superseded.** It does — but only with the
   per-instance `allowHalfOpen` flag; the constructor option that P2 tested is silently ignored by
   Bun. The FFI `shutdown` P2 built is kept as-is and is still required.
2. **A client's hard abort (RST) is detected via the missing `_handle`**, which is the only signal
   Bun's `net` shim gives. If a future Bun version starts surfacing `ECONNRESET` properly this can be
   simplified; the `end`-handler check is harmless either way.
3. A half-closed connection still lives until the target side also finishes (unchanged from P2) —
   it holds one peer-budget slot until then. Well-behaved services close on EOF.
4. `PumpSocket.write` now returns `boolean`. Anything outside `apps/gateway/src/portmap/**` that
   implements that interface would need updating; nothing does today.
5. The commander's uncommitted watermark experiment in `pump.ts` was taken over and replaced — the
   `setTimeout`-deferred resume it needed for Bun sockets is unnecessary on `node:net`.
