# DC HTTP bulk truncation (~2 MiB + 16 KiB, silent 200)

## Root cause

Live `GET /n/<node-b>/api/files/raw` of an 8 MiB file returned **exactly 2,113,536 bytes** (16 KiB + 2 MiB) with HTTP 200 and no error logs.

Bun `Response(Uint8Array)` chunks an 8 MiB body as **16 KiB, then 2 MiB slices**. `acceptHttpStream` writes those chunks onto a mux stream (`MAX_FRAME_PAYLOAD` / `INITIAL_STREAM_WINDOW` = 1 MiB).

Two bugs combined:

1. **Fragment reassembly cap was 1 MiB, but a mux DATA frame is 1 MiB payload + 10-byte header.** After the 16 KiB chunk is consumed and WINDOW restores a full 1 MiB send window, the next DATA frame is `encodeFrame` of 1,048,586 bytes. `FrameReassembler` threw `reassembled frame exceeds 1048576 bytes`, closed the DataChannel (`rtcLog` is `console.log`, not warn/error), and the mux aborted.

   If the 2 MiB write started before the 16 KiB WINDOW returned, leftover send-window kept those frames under the cap, so the first 2 MiB write succeeded. The *next* 2 MiB write hit a full window → 1 MiB+10 frame → close. Body delivered = 16 KiB + 2 MiB.

2. **Fanout / DataChannelLink / DataChannelCarrier pending buffers were a 32-message cap.** A 2 MiB burst of 64 KiB DC fragments is exactly 32 messages; the 33rd closed the channel. That is the wrong unit (count vs bytes) and far below `MAX_LINK_UNACKED`.

Silent 200: mux abort used to `controller.close()` the readable (clean EOF). `openHttpStream` then closed the HTTP body after HEAD, so the entry returned 200 with a short body.

## Fixes (this scope)

- `fragmenter.ts`: `MAX_REASSEMBLED_FRAME_BYTES = MAX_FRAME_PAYLOAD + FRAME_HEADER_SIZE`.
- `channel-fanout.ts`, `data-channel-link.ts`, `data-channel-carrier.ts`: pending cap is **byte-based** `FANOUT_MAX_PENDING_BYTES = MAX_LINK_UNACKED` (32 MiB). Overflow still closes the channel (cannot NAK already-received DC messages). Mux WINDOW still throttles an attached consumer at 1 MiB/stream.
- `mux.ts`: RST / link-close **rejects** `readable` pull (`Promise.reject` / hanging pull waiter) instead of a clean EOF. `controller.error()` was avoided: Bun treats it as an unhandled test/runtime exception on in-memory RST.

`DataChannelLink.flush` already waits on `bufferedAmount()` / `onBufferedAmountLow` (`DC_HIGH_WATER_BYTES` 4 MiB). No change needed there.

## HTTP 5xx / abort — other agent (`stream-targets.ts`, not edited)

Mux now rejects the next/in-flight `reader.read()` on link death. That is **not enough** for a 5xx: `openHttpStream` (`apps/gateway/src/mesh/stream-targets.ts` ~350–373) still does:

```ts
} catch (err) {
  if (head.status) {
    try { controller.close(); } catch { controller.error(err); }
  } else {
    controller.error(err);
  }
}
```

After HEAD, a closed/errored mux stream becomes a **clean HTTP body EOF** → 200 + short body. `forwarder.ts` `adaptResponse` then does `new Response(upstream.body, { status: upstream.status, headers })`, so the entry cannot change status once HEAD is sent.

Required change in `openHttpStream` (and only if HEAD is not yet sent, let the throw become 503 in `forwarder.handleRemoteHttp`):

- On `reader.read()` failure **always** `controller.error(err)` — never `controller.close()` after HEAD.
- Also `stream.onAbort(() => controller.error(...))` so an abort that still looks like EOF cannot complete the body.
- If `done === true` but `stream.closed` reason is not `'end'`, error the body the same way.

That turns a mid-body DC death into a reset/truncated-chunk connection instead of a silent short 200. Before HEAD, keep throwing so `handleRemoteHttp` returns 503.

## Verification

- `apps/gateway` `bun test src/mesh/rtc` + `dc-http-bulk.integration.test.ts` + `stream-targets.test.ts` + `link-stream-carrier.test.ts`: **144 pass, 0 fail**.
- `packages/shared` `bun test src/link`: **51 pass, 0 fail**.
- `apps/gateway bunx tsc --noEmit -p .`: **21 errors** (baseline).
- `packages/shared bunx tsc --noEmit -p .`: **0**.
- `bunx biome check` on all changed files: **clean**.

New coverage: 8 MiB HTTP-style over two `RtcPeerManager`s (slow consumer + keeping-up / full 1 MiB frames), 1 MiB mux frame over 64 KiB fragments, 33×64 KiB detached fanout stays open, mux readable rejects on link close.

## Open

- Full `apps/gateway bun test src/mesh` / `bun test`: **1 fail**, `mesh phase-2 integration > node joins twice` (hub redeem **409** vs expected 200). Unrelated to DC/mux; hub enrollment, not this change.
- Silent-200 body still possible until `stream-targets.ts` stops `controller.close()` after HEAD (see above).
