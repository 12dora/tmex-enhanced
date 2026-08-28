# Slow DataChannel 8 MiB stall after L6 re-dial (round 3)

## Root cause

Harness run 10 L7 still aborted at `sent=1048508` ~11–14 s after the **new** DC (L6 upgrade retry after UDP drop/undrop). That is not a reused mux: each DC gets a fresh `LinkMux`. It is also not a receive-window RST.

Instrumented L6→L7 on the rebuilt image showed:

1. Node-a (HTTP client) **did** send WINDOW on stream 3 (`delta=68` HEAD, `16384` first Bun slice, `1032124` rest of the 1 MiB window).
2. Node-b **did** apply those credits (`window recv stream=3`).
3. Node-b then spun `dc flush … ok=false` on the last 49 KiB fragment of the first 1 MiB DATA frame while `bufferedAmount` kept rising by that fragment size (~0 → 3+ MiB). Native `sendMessageBinary` **queued the bytes and returned false**. The sender retried the same fragment, flooding SCTP. The next mux DATA never left. ~11 s later the driver fetch reset; `openHttpStream` `cancel()` sent mux RST `aborted`.

A second, related hole: `receiving` was cleared in `onMessage`’s `finally` before V8 microtasks, so WINDOW/`pong` could still call native send on the receive stack. 7fc5e92’s `setTimeout(0)` flush was not enough.

Not `LINK_STREAM_BACKPRESSURE_BYTES`. Not a parked/stale mux after re-dial.

## Fixes

- **`data-channel-link.ts`**: hold `callbackDepth` until `DC_FLUSH_RETRY_MS` after every native `onMessage`; never `trySendRaw` while it is raised. Treat `sendMessageBinary === false` **and** `bufferedAmount` increased as accepted (do not retry that fragment). `onBufferedAmountLow` only arms the retry timer.
- **`stream-targets.ts`**: log mux close reason after HTTP head (`reason=rst message=aborted` vs `link-closed`).
- **`mux.ts`**: log RST send/recv and protocol errors (payload text).
- **Tests**: fake DC holds the receive callback across a macrotask; keeping-up consumer + delayed rate-limited channel; 8 MiB immediately after DC re-dial; native false-but-queued send must not duplicate fragments.

## Live proof (shaped LAN, L4→L8)

netem on both `eth1`: `delay 80ms rate 16mbit`. After G, node-b re-enrolled as `51431e4ac22449cfccc2657bc1dd9235`. File `/e2e/bulk.bin` expect `a280a69d443f814dd86a28e04229587d2385e19c156b9bbda1f26a4485fd5191`.

**L4** UDP drop → `transport=ws-secure`. **L6** undrop → `transport=dc`.

**L7** (sha256 immediately after DC re-open):

```
{"ok":true,"status":200,"bytes":8388608,"sha256":"a280a69d443f814dd86a28e04229587d2385e19c156b9bbda1f26a4485fd5191","headers":{"content-type":"application/octet-stream"},"bulkPath":"browser-only"}
```

Hash matches. No `forward aborted` on that transfer.

**L8** UDP drop again (`wait-transport ws-secure` timed out, `relay_wait=1` as in the harness); sha256 again `8388608` / `a280a69d443f814dd86a28e04229587d2385e19c156b9bbda1f26a4485fd5191`.

## Verification

- `packages/shared bun test src/link`: **53 pass, 0 fail**; `tsc --noEmit`: **0**.
- `apps/gateway bun test src/mesh`: **401 pass, 0 fail**; `tsc --noEmit`: **21** (baseline).
- `biome check` on changed files: **clean**.

## Open

- Native `sendMessageBinary` returning false after accepting a buffer is a libdatachannel quirk; we now advance on `bufferedAmount` increase.
- L8 mesh-list `transport` can lag the actual fallback; the REST read still succeeds.
- `docker restart` does not pick up a new image; live deploys need `--force-recreate` plus re-attach `tmex-split-local_lan`.
