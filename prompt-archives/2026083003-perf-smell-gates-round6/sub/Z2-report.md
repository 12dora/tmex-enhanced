# Exploration Z2 — Round 3 Verification

`ratio = HEAD / BASE`; values below 1.0 are faster.

## Measurements

| Benchmark | BASE ms | HEAD ms | Ratio | Result |
|---|---:|---:|---:|---|
| Forwarder `noteInbound`, 10 MiB | 87.150 | 46.463 | 0.533 | 1.88× faster |
| Agent windowed history, 10k rows | 22.696 | 0.824 | 0.036 | 27.5× faster; exact window match |
| Hub broadcast fan-out, 100 links | 7.452 | 0.413 | 0.055 | 18.0× faster |
| Rsync list, 200k ordered | 100.59 | 113.32 | 1.127 | Regression, +12.7%; RSS 160.6→67.5 MiB |
| Rsync list, 200k reversed | 110.43 | 175.75 | 1.592 | Regression, +59.2%; RSS 161.5→70.6 MiB |
| Cold pane ingest, 5000×1 KiB | 2.301 | 0.921 | 0.400 | 2.50× faster |
| Watch upsert, 5000 | 11.03 | 6.63 | 0.601 | 1.66× faster |
| Devices list, 100 devices | 0.162 | 0.095 | 0.586 | 1.71× faster; 202→3 queries |

The hub row measures the encoding/fan-out hot path. Including the initial node projection, the first actual broadcast was 9.27 ms on BASE versus 7.13 ms on HEAD.

## Findings

### HIGH — Upload serialization does not cover the mesh/RTC path

Files: `apps/gateway/src/files/transfer-session.ts:188-226`, `apps/gateway/src/api/files.ts:79-91`, `apps/gateway/src/mesh/rtc/bulk.ts:229-245`.

HTTP uploads use the serialized async queue, but RTC/bulk uploads still call synchronous `appendUploadChunk`. A deterministic interleaving is: HTTP starts an async append at offset 0 and suspends during `fsPromises.write`; RTC then sees `received === 0`, synchronously appends its chunk, and advances the session; the HTTP write resumes and also succeeds from committed offset 0. Depending on timing, the resulting file order is reversed or both chunks are accepted with the same logical offset.

The upload benchmark and filesystem tests could not run because the sandbox rejects `mkdtemp`, but the race follows directly from the two actual code paths. Route all upload sources through the same per-session queue, or make `FilesBulkHooks.appendUpload` asynchronous and await it from `BulkTransferService`.

Expected gain: correctness; prevents mixed-transport corruption and duplicate-offset acceptance. Risk: propagating async control flow through RTC backpressure and error handling. Estimated net change: **+12 to +25 lines**.

### MEDIUM — Bounded rsync collection trades significant CPU for memory

File: `apps/gateway/src/files/rsync.ts:312-389`.

The bounded heap retains only 2,001 entries and cuts RSS by roughly 90 MiB, but the 200k reversed workload increased from 110.43 ms to 175.75 ms, with the ordered workload also 12.7% slower. This is a real worst-case regression for large remote directories, not just a noisy single-recipient path.

Optimize the heap comparison/key path while preserving the existing directory/name ordering semantics; benchmark adversarial names and both directory placements before changing the algorithm. The target should be to recover most of the lost CPU while retaining the bounded memory behavior.

Expected gain: approximately 65–95 ms on the measured 200k workloads. Risk: accidentally changing truncation order or directory precedence. Estimated net change: **0 to +8 lines**.

### MEDIUM — Watch deadlines use wall-clock time

Files: `apps/gateway/src/watch/scheduler.ts:41-53`, `:216-233`.

A direct scheduler reproduction added a 5-second rule, moved the injected clock from 4,000 ms to −3,600,000 ms, and produced:

```json
{"dueAfterRollback":[],"delays":[5000,3605000]}
```

The rule therefore misses its due time and is rescheduled roughly one hour away after a backward clock adjustment. The existing 11 scheduler tests pass, but none cover clock rollback.

Use a monotonic default clock such as `performance.now()` for scheduler deadlines, retaining the injectable clock for tests. This is likely a one-line behavioral fix because these deadlines are process-local and do not need wall-clock meaning.

Expected gain: watches continue firing at their configured intervals across NTP/manual clock changes. Risk: low; callers must not rely on scheduler timestamps being epoch milliseconds. Estimated net change: **−1 to +2 lines**.

### MEDIUM — Pending forward TTL can close a valid stream before WebSocket `open`

Files: `apps/gateway/src/mesh/forwarder.ts:542-550`, `:909-924`; `apps/gateway/src/mesh/mesh-http.ts:281-300`.

The stream is placed in `pendingStreams`, the HTTP upgrade succeeds, and the 15-second expiry is armed before the WebSocket `open` handler takes the stream. A scaled real-timer harness mapped the 15-second timer to 10 ms, deliberately delayed `open`, and observed:

```json
{"tokenCaptured":true,"streamClosedAfterScaled15s":1}
```

The later `open` path finds no pending stream and closes the browser socket with `no-stream`. This requires an unusually delayed upgrade/open callback, so it is not a common failure, but it is a concrete user-visible connection failure.

Keep the leak guard, but make the TTL configurable or longer and add a test that explicitly delays `open`; ideally use an upgrade lifecycle hook that distinguishes a never-opened socket from a merely slow one. Expected gain: avoids rare valid terminal connections being closed after 15 seconds. Risk: a longer fallback TTL retains abandoned remote streams longer. Estimated net change: **+2 to +8 lines**.

### LOW — Legacy history byte cap can split UTF-8

File: `apps/gateway/src/tmux-client/local-external-connection.ts:96-131`.

The rolling tail trims raw bytes without aligning to a UTF-8 boundary. A three-byte Euro sign truncated to a two-byte limit produced `"��"` with two U+FFFD replacement characters.

Before decoding, discard leading continuation bytes from the retained tail, or use a streaming decoder and preserve the incomplete leading sequence. Expected gain: clean history tails at the 4 MiB boundary. Risk: the result may contain 1–3 fewer bytes than the nominal cap. Estimated net change: **+5 to +10 lines**.

## Regression checks that are already fine

- Hub `node.list` fingerprint includes `key_log_head`; the focused append/rebroadcast test passes, and `uplink-server.test.ts` reports 17 passing tests.
- Peer idle lifecycle works with the real default scheduler and injected `idleMs: 50`: reach was `relay` at 20 ms and absent after 100 ms; seven deadline tests also pass.
- External `%window-close` is intentionally handled through metadata: `metadata/event-applier.ts:130-135` recursively removes the window subtree, and `runtime/event-bridge.ts:25-31` updates `lastSnapshot`; the metadata/runtime tests pass.
- Snapshot quiet-period and immediate trailing behavior passes 24 focused tests; the benchmark reduces three refreshes to two.
- Forwarder browser-close cleanup before `open` and expiry identity checks pass.
- Agent windowed history preserves the exact selected message window.
- Canonical pane header peeking materially reduces inbound decode cost without changing the measured result.
- Devices/tree query batching reduces the synthetic 100-device pattern from 202 queries to 3.

## Test status

- `apps/gateway`: **2507 passed, 198 failed, 1 error, 2705 tests**. Failures were dominated by sandbox restrictions: `mkdtemp`/`mkdir` `EPERM`, `Bun.serve` port-0 `EADDRINUSE`, and tmux integration access errors. The full suite is not a usable green gate in this environment.
- Gateway TypeScript: **21 errors on HEAD and 21 on BASE**; no error-count regression. The representative `historyText` error already exists on BASE.
- `packages/app`: **268 passed, 118 failed, 2 errors**; failures were sandbox filesystem/port restrictions plus a missing `dist/runtime/server.js` artifact.
- `packages/shared`: **376 passed, 0 failed**.
- Targeted hub, forwarder, peer, metadata, refresh, and scheduler tests passed. Upload filesystem tests were blocked by `mkdtemp` `EPERM`.

## What remains

One HIGH-value issue remains: the mixed HTTP/RTC upload serialization race. Other remaining issues are MEDIUM or LOW; no additional HIGH gateway hotspot was found.

Known deferred items remain deferred except that the mesh/RTC synchronous upload path is now backed by the concrete HIGH finding:

- `hasWsSecureCandidate` / `shouldTryDc` `listPeers().find`
- mesh/RTC synchronous `appendUpload`
- canonical frame-size cache
- tree endpoint query shape

No repository files were modified.