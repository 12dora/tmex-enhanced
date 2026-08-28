# Slow DataChannel 8 MiB stall after 9bfecf0

## Root cause

Live I1/L7 (netem `delay 80ms rate 16mbit` on `eth1`) still aborted at `sent=1048508` (`INITIAL_STREAM_WINDOW` minus HTTP HEAD) with `http stream aborted`. That is **not** `LINK_STREAM_BACKPRESSURE_BYTES`. Two bugs stacked:

1. **WINDOW / pong sent from inside the native DC `onMessage` callback.** Mux credits (`sendWindowCredit`) and liveness pongs run on the receive stack. libdatachannel `sendMessageBinary` from that callback can return true without transmitting. 9bfecf0 queued control frames but still flushed them synchronously from `onMessage`. The receiver consumed the first 1 MiB (so it *should* have sent WINDOW), the sender never got credit, then ~10 s later liveness killed the DC.

2. **Mux treated a late/duplicate WINDOW as a link-level protocol error.** Live logs: `protocolError invalid WINDOW delta 12 on stream 0 (outstanding 0)` — ctl ping WINDOW arriving after outstanding was already 0 **closed the whole mux**, aborting the HTTP file stream at one window. Native send also returned false for urgent frames while SCTP `bufferedAmount` was only ~50–600 KiB; 8 ms retry drains that, but extra ctl WINDOWs still happen.

Not a receive-window RST (`stream N exceeded receive window` was not in the RST payload). Abort reason after HEAD is still the generic `http stream aborted` from `openHttpStream` `onAbort`.

## Fixes

- **`data-channel-link.ts`**: while `onMessage` is running, `flush()` only sets a flag; after the callback returns, flush is scheduled with `setTimeout(0)` so WINDOW/pong/RST leave the native callback. Control vs data queues from 9bfecf0 kept.
- **`mux.ts` `handleWindow`**: clamp delta to `outstanding` and remaining send window; ignore surplus instead of `protocolError` / link close. Malformed WINDOW payload still closes the link.
- **Tests**: fake DC drops in-callback sends (models native); rate-limited delayed DC in `dc-http-bulk` does the same. Mux tests now expect late WINDOW to keep the link open and still unblock the writer.

## Live proof (shaped LAN DC)

netem on both nodes `eth1`: `delay 80ms rate 16mbit`. After harness G revoked original node-b, it was re-enrolled as `35e4d7e14bde2bc9053bb19e6a12109b`. File `/e2e/bulk.bin` expect `012122680bc9f6e4c354bc278841f46ab748749234ee44170c96b8c15d4c6445`.

**L7 / I1 (transport=dc, reach=lan):**

```
{"ok":true,"status":200,"bytes":8388608,"sha256":"012122680bc9f6e4c354bc278841f46ab748749234ee44170c96b8c15d4c6445","headers":{"content-type":"application/octet-stream"},"bulkPath":"browser-only"}
```

Hash matches. No `forward aborted` / `liveness timeout` on that transfer.

**L8:** `iptables -I OUTPUT -p udp -j DROP` on node-a; `wait-transport ws-secure` timed out (`transport=null` in the listing, same pattern as harness `relay_wait=1`); sha256 again matched `8388608` / `012122680bc9f6e4c354bc278841f46ab748749234ee44170c96b8c15d4c6445`. UDP drop rule removed after.

## Verification

- `packages/shared bun test src/link`: **53 pass, 0 fail**; `tsc --noEmit`: **0**.
- `apps/gateway bun test src/mesh`: **397 pass, 0 fail**; `tsc --noEmit`: **21** (baseline).
- `biome check` on changed files: **clean**.

## Open

- Native `send()` still returns false for control while SCTP is congested; bounded by the 8 ms retry / low-water path.
- Duplicate ctl WINDOW can still be sent; they are now no-ops instead of tearing down the link.
- L8 mesh-list `transport` may lag the actual fallback; transfer still succeeded (same as the split harness L8 row).
