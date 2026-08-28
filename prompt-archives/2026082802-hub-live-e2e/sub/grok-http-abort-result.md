# HTTP forward abort on mid-body mesh death

## Problem

`openHttpStream` treated a post-HEAD stream failure as a clean body EOF:

```ts
} catch (err) {
  if (head.status) {
    try { controller.close(); } catch { controller.error(err); }
  } else {
    controller.error(err);
  }
}
```

After headers, a DC/mux RST became HTTP 200 with a short body (live: 2,113,536 of 8 MiB). Mux already rejects in-flight `reader.read()`; this layer still closed.

## Change (`apps/gateway/src/mesh/stream-targets.ts`)

- Mid-body failure always `controller.error(err)` — never `controller.close()` after HEAD.
- `stream.onAbort` also errors the HTTP body (covers abort that still looks like EOF).
- If `content-length` is present and delivered bytes are short on clean END, error the body.
- Rate-limited (1s) `console.warn`: `[mesh][http] forward aborted status=… sent=… expected=… reason=…` (`expected=-` when no length).

Complete bodies with matching `content-length` still close normally. Pre-HEAD death still rejects `openHttpStream` (existing 503 path).

## Tests

- Unit: RST after HEAD → `res.arrayBuffer()` rejects (not a short 200).
- Unit: END short of `content-length` → body errors.
- Unit: matching `content-length` still delivers.
- Integration (`dc-http-bulk`): HEAD + 64 KiB then DC close → entry-side body read errors, not a silent short 200.

## Verification

- `bun test src/mesh/stream-targets.test.ts src/mesh/integration/dc-http-bulk.integration.test.ts`: **25 pass, 0 fail** (RED on the three new cases before the fix).
- `bun test src/mesh`: **373 pass, 0 fail**.
- `bunx tsc --noEmit -p .`: **21 errors** (baseline).
- `bunx biome check` on the three changed files: **clean**.

## Open

- After HEAD, HTTP status stays 200; the client sees a reset/incomplete transfer, not a 5xx. Status cannot change once headers are sent (`forwarder.adaptResponse` reuses `upstream.status`).
- Abort log reason is often `http stream aborted` because `onAbort` wins the first `failBody` over the later rejected `read()`. Truncation uses `http body truncated: sent=… expected=…`.
