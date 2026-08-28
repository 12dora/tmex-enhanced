# Slow DataChannel 8 MiB stall (WINDOW/pong starved, liveness kill)

## Root cause

Live I1 WAN: node-a aborted at `sent=1048508` (~`INITIAL_STREAM_WINDOW` minus the HTTP HEAD) with `http stream aborted`, then hub `liveness timeout idle_ms=10000`. LAN of the same transfer passed.

After the first 1 MiB mux window, the receiver must send WINDOW credits (and liveness pongs). Those frames went through `DataChannelLink.send()` on a FIFO queue that:

1. Stopped flushing when native `send()` returned false.
2. Waited only on `onBufferedAmountLow` with threshold **1 MiB**. If SCTP refused while `bufferedAmount` was still below that mark, the event never fired, so the queue froze.
3. Dropped ping/pong when `bufferedAmount > 4 MiB` (or when `send()` failed), with no retry.
4. Could not preempt an in-flight DATA fragment, so WINDOW sat behind stalled payload.

Hub then saw no inbound for 10s and killed the DC. Node-a’s mux stream aborted (`onAbort` → `http stream aborted`) *before* its own liveness timer because the link/stream died locally (window unrestored → next DATA would have been a receive-window violation; fragment timeout could also drop a mid-frame). `LINK_STREAM_BACKPRESSURE_BYTES` is the WS carrier cap and was not this abort.

## Fixes

- **`data-channel-link.ts`**: separate control vs data queues; WINDOW/RST/END/ctl and liveness bypass high-water and preempt DATA fragments; queue ping/pong instead of dropping; retry flush every 8ms; temporarily drop the low-water threshold to 0 when native send fails.
- **`liveness.ts`**: `sendPing` throws no longer kill the ping interval.
- **`fragmenter.ts`**: refresh per-frame deadline on each fragment so a slow trickle does not drop an in-progress frame.
- **`mux.ts`**: receive-window overflow RSTs that stream instead of closing the whole link (liveness/other streams survive); do not drop a chunk if `enqueue` throws.

## Verification

- `packages/shared bun test src/link`: **53 pass, 0 fail**.
- `apps/gateway bun test src/mesh/rtc` + `dc-http-bulk.integration.test.ts`: **137 pass, 0 fail**.
- `apps/gateway bun test src/mesh`: **396 pass, 0 fail**.
- `packages/shared tsc --noEmit`: **0**. Gateway: **21** (baseline).
- `biome check` on changed files: **clean**.

New coverage: WINDOW/liveness bypass saturated DC send; WINDOW inserted between DATA fragments; flush retry below low-water; trickle reassembly; mux WINDOW not blocked by in-flight DATA send; window overflow RST; 8 MiB over 64 KiB/50ms + 80ms delay + 500 KiB/s consumer with hash and no abort.

## Open

- Native `send()` still returning false for *control* while the SCTP buffer is truly full can delay WINDOW until the 8ms retry / low event; that is bounded, not a hang.
- After HEAD, HTTP status stays 200 if a later abort happens (`openHttpStream`); unchanged, out of scope.
