# T1 result — shared transfer engine + node-to-node file transfer backend

Branch `feat/round32-relay-quota-transfer-portmap`, worktree `/Users/konata/code/tmex-r32`.

---

## 1. What was built

### 1.1 New workspace package `@tmex/transfer` (`packages/transfer/`)

Two entry points, added to the root `packages/*` glob (a `bun install` was run; `bun.lock` is
modified and four workspaces gained a `@tmex/transfer` dependency: gateway, api-client,
ws-client, panels).

| Export | File | Notes |
|---|---|---|
| `.` (browser-safe) | `src/index.ts` | types, bytes, progress, chunker, ranges, push-driver |
| `./node` (Bun-only) | `src/node.ts` | re-exports `.` plus source / sink / sink-state |

- **`types.ts`** — `ByteRange`, `TransferProgressSample`, `ReceivedState`.
- **`bytes.ts`** — `concatBytes` / `copyBytes` / `toBytes`. Replaces the copies in
  `rtc/bulk.ts` and `ws-client/direct/bulk-client.ts`.
- **`progress.ts`** — `ProgressTracker` (sliding-window rate + ETA) and `throttleProgress`
  (time + byte double threshold, with `flush()`). **This is now the single rate implementation**;
  the elapsed-time loops in `upload-transfer.ts`, `download-transfer.ts` and
  `bulk-transfer.ts` (×2) were deleted in favour of it.
- **`chunker.ts`** — `iterateFrames(Blob | ReadableStream, frameSize, {onCancel})`; exports
  `BULK_FRAME_BYTES = 16 KiB` and `BULK_MAX_FRAME_BYTES = 64 KiB`. Replaces
  `iterateBulkFrames` (browser) and the hand-rolled buffering in `pumpDownload` (node).
- **`ranges.ts`** — `normalizeRanges` / `coveredBytes` / `complementRanges` / `rangesCover` /
  `chopRanges` / `splitRanges`.
- **`push-driver.ts`** — `runPush(transport, opts)`: offset negotiation → N disjoint ranges in
  parallel (worker pool, `streams` lanes) → failure classification → backoff ladder
  `[1,2,4,8,15,15,15]s` → resume. `maxRangeBytes` chops the gap into chunk-sized pieces
  (multipart-upload shape); without it the gap is split into exactly `streams` pieces
  (the upgrade push shape). Browser-safe — the browser upload uses the same driver.
- **`node/source.ts`** — `openRange(path, start, end?)` (half-open, `end` exclusive),
  `hashFilePrefix`, `sha256File`. Generalizes `remote-upgrade-io.ts:fileReadableStream`
  (which was deleted) and backs `file-http.ts:streamTempFile`.
- **`node/sink.ts` + `node/sink-state.ts`** — `ResumableSink`:
  - deterministic `.part-<id16>` naming (`deterministicPartPath(dest, key)`; for the upgrade
    package this reproduces the old `…tgz.part-<sha256[0..16]>` byte for byte);
  - `status()` → `{receivedBytes, ranges, complete}`;
  - `write(d, body, {offset, contentLength, maxWriteBytes, registerCancel})` with two modes:
    **append** (offset must equal on-disk length, incremental sha256 with prefix re-hash on
    resume — the exact old upgrade semantics) and **ranged** (preallocate + `pwrite` +
    received-range bitmap persisted to a `<part>.rx` sidecar under a per-part lock, final
    whole-file sha256 when a digest is known);
  - truncated body ⇒ keep the `.part`, return `incomplete`; full-length body with a bad digest
    ⇒ delete the `.part`; overflow ⇒ `too_large`; external cancel ⇒ `aborted`;
  - `commit()` = rm dest + rename + chmod; `discard()`; `sweep(dir, now, ttl)` (24 h TTL,
    also usable as the boot-time orphan scan).

### 1.2 Upgrade push re-pointed at the engine (no behaviour change)

- `apps/gateway/src/system/upgrade-staging.ts` is now a thin adapter: `stagedPartPath` via
  `deterministicPartPath`, `stagedSinkDescriptor()`, `stageFailureToResult()` (engine code →
  the existing `UPGRADE_OFFSET_MISMATCH` / `PACKAGE_TOO_LARGE` / `PACKAGE_INCOMPLETE` /
  `PACKAGE_SHA256_MISMATCH` / `STAGE_FAILED` HTTP semantics). `resumeStagedPart`,
  `truncatedTransfer`, `hashFilePrefix`, the local `fileSizeOrZero` are gone (moved into the
  engine).
- `apps/gateway/src/system/upgrade.ts`: `stagePackageLocked` now calls
  `resumableSink.write(...)`; `receiveStagedBody` deleted. The preempt hook (a newer PUT for
  the same package cancelling a stuck one) is preserved through `registerCancel`.
  `commitStagedPackage` deliberately keeps its own rename/chmod rather than calling
  `sink.commit()`, because it is one transaction with the JSON sidecar write and the prune,
  and its rollback path must undo all three.
- `apps/gateway/src/system/remote-upgrade-job.ts`: `runPushPhase` is now ~35 lines calling
  `runPush({streams: 1, resume, maxAttempts, backoffMs: PUSH_RETRY_BACKOFF_MS, deadlineMs,
  timeoutError: 'push failed: push timeout', shouldRestartFromZero})`. The job state machine
  (phases, budgets, watchdog, cancel/delete-staged, legacy attempt cap) is untouched.
- `apps/gateway/src/system/remote-upgrade-io.ts`: `fileReadableStream` removed (now `openRange`).
- **All 194 `apps/gateway/src/system/*.test.ts` tests pass unchanged** (including the nine
  resume cases and the ten `upgrade.test.ts` staging cases) — no assertion was edited there.

### 1.3 Browser upload / download re-pointed

Server:
- `files/transfer-session.ts` rewritten on top of `ResumableSink` in **ranged** mode. The
  session's `tmpPath` is now the *committed* file (created by rename when the last range
  lands); before that the bytes live in `<tmpPath>.part-<uploadId16>`. New API:
  `writeUploadRange(id, {offset, contentLength, body})`, `writeUploadBytes(id, offset, bytes)`,
  `uploadRanges(id)`, `session.complete`. `appendUploadChunkAsync` / `persistChunk` /
  `enqueueSessionOp` are gone (pwrite makes the per-session serialization unnecessary).
  Zero-byte uploads are completed at session creation.
- `api/file-transfer-routes.ts`:
  - `POST /api/files/upload/init` → `{uploadId, chunkSize, ranged: true}`
  - `PUT /api/files/upload/:id?offset=&length=` — accepts **out-of-order and concurrent**
    ranges, streams the body (no more full-chunk buffering), returns `{received, complete}`
  - `GET /api/files/upload/:id` (new) → `{size, received, complete, ranges: [[off,len],…]}`
  - `GET /api/files/download/:id/content` now honours `Range` (206 + `Content-Range`,
    416 when unsatisfiable, `Accept-Ranges: bytes` on the 200); the temp file is only
    reclaimed when the served range reaches EOF.
- `api/file-http.ts`: `parseRangeHeader`, `streamFileRange` (built on `openRange`);
  `streamTempFile` is now a wrapper.
- `files/device-storage.ts`: `pullFileFromDevice` short-circuits for `local` devices — it
  returns the real path with a no-op cleanup instead of rsync-copying the whole file into
  `$TMPDIR`. This removes one full copy from every local-device download.
- `api/file-transfer-sessions.ts`: `FilesBulkHooks` widened to
  `{status, writeRange(transferId, offset, bytes), openRange(transferId, range?), abort}`.
- `mesh/rtc/bulk.ts`: uses the new hooks, `iterateFrames` for `pumpDownload`, and
  `BULK_FRAME_SIZE = BULK_FRAME_BYTES` (16 KiB). The browser side
  (`ws-client/direct/bulk-client.ts`) now uses the same 16 KiB constant, so the
  **16 KiB / 64 KiB mismatch is gone** (`BULK_MAX_RECEIVED_FRAME_SIZE` stays 64 KiB for
  backward compatibility with older browsers).

Client:
- `api-client/upload-transfer.ts` now drives `runPush` with N parallel PUTs
  (`streams` default 4, `maxRangeBytes = chunkSize`), per-range retry (409/5xx → backoff +
  re-negotiate offsets from `GET /api/files/upload/:id`) instead of restarting the transfer.
  Falls back to a single sequential stream when the node did not advertise `ranged`.
- `api-client/download-transfer.ts` resumes leg 2 with `Range: bytes=<received>-` (3 attempts);
  if the peer answers 200 instead of 206 it restarts cleanly.
- `api-client/transfer-types.ts`: `TransferOpts.streams`, plus `DIRECT_UPLOAD_STREAMS = 4`,
  `RELAY_UPLOAD_STREAMS = 2`, `pickUploadStreams(viaRelay)` (re-exported from
  `@tmex/api-client`). **The caller decides** — `bulk-transfer.ts` just forwards `opts`.

### 1.4 `SystemInfo.transferCapabilities`

`packages/shared/src/contracts/system.ts` gained
`transferCapabilities?: TransferCapability[]`; `system/info-public.ts` reports
`['transfer-v2', 'transfer-ranged-parallel']`.

### 1.5 Node-to-node transfer (`apps/gateway/src/transfer/`)

| File | Role |
|---|---|
| `bridge.ts` | global mesh bridge (`selfNodeId`, `transportOf`, `forwardInternalHttp`), wired from `mesh-runtime.ts` exactly like `mesh-agent-bridge`; `streamsForTransport()` (relay ⇒ 2, else 4) |
| `grants.ts` | one-shot grants on B: 10 min TTL, `timingSafeEqual` token, bound to `fromNodeId`/`destRootId`/`destPath`, consumed on first redemption |
| `dest.ts` | `resolveDestContext`, `normalizeRelPath` (rejects `..`, absolute, NUL), `ensureLocalParent` (mkdir -p + re-run `checkAndNormalize` on the parent so symlink escapes are caught after creation) |
| `receiver.ts` | B-side service: sessions (10 min idle + 1 min GC timer), per-file `ResumableSink` descriptors, conflict check, commit (local ⇒ rename in place; ssh ⇒ stage locally, `mkdir -p` over `execSshCommand`, then `pushFileToDevice`) |
| `mesh-routes.ts` | `/api/mesh-internal/transfer/*`, registered in `mesh-internal-tmux-routes.ts` behind the existing `requirePeerMarker` gate; every session call re-checks `session.fromNodeId === readMeshPeerMarker(req)` |
| `channel.ts` | `TransferChannel` abstraction + `createLocalChannel` (A === B calls the same receiver in-process) |
| `mesh-channel.ts` | peer implementation over the extended `forwardInternalHttp` |
| `expand.ts` | A-side recursive expansion (5000 files / depth 32 caps), `relPath` preserved, over-limit files pre-marked `quota_file_size` |
| `job-registry.ts` | in-memory jobs (finished kept 30 min), NDJSON event fan-out, 200 ms progress throttle |
| `job-runner.ts` | expand → open session → per-file `runPush` → commit |
| `routes.ts` | browser API |

`mesh/forwarder.ts`: `forwardInternalHttp(nodeId, path, body, signal, input?)` gained
`{method, query, headers, rawBody, onProgress}`, mirroring `forwardAuthorizedHttp`
(byte counting + throttled progress reuse the same helpers).

---

## 2. HTTP / NDJSON protocol summary (what F1 must follow)

All error responses carry a **top-level `code`** (plus `error` with the same value and an
optional `detail`), matching the files/tunnel convention.

### 2.1 Grants — on the **destination** node B

```
POST /n/<B>/api/transfer/grants
body  { fromNodeId, destRootId, destPath }        // fromNodeId may be "self"
200   { grantId, token, expiresAt }               // TransferGrantResponse
400   { code: 'invalid' | <FileErrorCode> }       // e.g. outside_roots / root_not_found
503   { code: 'unavailable' }                     // mesh bridge not up yet
```
`fromNodeId` accepts `self` (→ B's own node id) or a 32-hex id. `destPath` is normalized and
must resolve inside `destRootId`; the normalized directory is what the grant is bound to.

### 2.2 Jobs — on the **source** node A

```
POST   /n/<A>/api/transfer/jobs
body   { toNodeId, items:[{rootId,path}], destRootId, destPath,
         grant:{grantId,token}, onConflict?: 'skip' | 'overwrite' }   // toNodeId may be "self"
200    { job: TransferJobSnapshot }
400    { code: 'invalid' } | { code: 'grant_invalid' }

GET    /n/<A>/api/transfer/jobs          → { jobs: TransferJobSnapshot[] }   // newest first, own uid only
GET    /n/<A>/api/transfer/jobs/:id      → { job: TransferJobSnapshot } | 404 { code:'not_found' }
DELETE /n/<A>/api/transfer/jobs/:id      → { ok: true }                      | 404 { code:'not_found' }
GET    /n/<A>/api/transfer/jobs/:id/events   → NDJSON
```

`snapshot.path` is `'local'` when A === B, `'relay'` when the live peer transport is relay,
otherwise `'direct'`. `snapshot.streams` is the negotiated parallelism (relay 2 / direct 4 /
local 1).

**NDJSON event order** (`TransferJobEvent`, one JSON object per line):

1. `{type:'snapshot', job}` — always first, emitted immediately on subscribe.
2. then any of
   - `{type:'snapshot', job}` again when the item list is filled in / `expanding` flips false,
   - `{type:'progress', jobId, currentIndex, progress, updatedAt}` — throttled to 200 ms,
     flushed unthrottled at each item boundary,
   - `{type:'item', jobId, index, item}`,
   - `{type:'state', jobId, state, error?, errorDetail?}`.
3. `{type:'end'}` and the stream closes, when the job reaches `done`/`failed`/`cancelled`.
   Subscribing to an already-finished job yields exactly `snapshot` then `end`.
   A client disconnect just unsubscribes (nothing further is written).

Item states: `pending → running → done | failed | skipped`. `skipped` means the destination
already had the file and `onConflict` was `skip`. Item `error` values come from
`TransferErrorCode` (`quota_file_size` for over-limit files, `dest_exists`, `peer_mismatch`,
`grant_invalid`, `grant_expired`, `checksum_mismatch`, `incomplete`, `cancelled`, …).
A job whose items include a failure ends `failed` with that code; a job with only
skips/dones ends `done`.

### 2.3 Browser upload/download changes F1/panels may rely on

- `UploadInitResponse` gained `ranged?: boolean`.
- `PUT /api/files/upload/:id?offset=&length=` → `{received, complete}`; 409 for a truncated
  range, 413 `too_large` (with `maxBytes`) for an over-limit chunk.
- `GET /api/files/upload/:id` → `UploadStatusResponse {size, received, complete, ranges}`.
- `GET /api/files/download/:id/content` honours `Range`.
- `TransferOpts.streams` + `pickUploadStreams(viaRelay)` from `@tmex/api-client`.

### 2.4 Peer-only surface (informational; browsers are 403'd from `/api/mesh-internal/*`)

```
POST   /api/mesh-internal/transfer/sessions                  {grantId, token, onConflict}
       → {sessionId, capabilities, maxFileBytes, chunkSize, expiresAt}
POST   /api/mesh-internal/transfer/sessions/:sid/status      {relPath, size} → {receivedBytes, ranges}
PUT    /api/mesh-internal/transfer/sessions/:sid/files?rel=&size=&offset=&length=   (raw body)
       → {received, complete}
POST   /api/mesh-internal/transfer/sessions/:sid/commit      {relPath, size} → {ok, skipped}
DELETE /api/mesh-internal/transfer/sessions/:sid             → {ok}
```

---

## 3. Contract changes (`packages/shared/src/contracts/`)

**No field of `contracts/transfer.ts` was renamed or removed** — F1's client compiles against
it unchanged. Additions elsewhere:

- `contracts/system.ts`: `SystemInfo.transferCapabilities?: TransferCapability[]`
  (imports the type from `./transfer`).
- `contracts/files.ts`: `UploadInitResponse.ranged?: boolean`, new `UploadStatusResponse`.
- `contracts/transfer.ts` itself: **formatting only** (biome would otherwise fail
  `bun run lint`; no semantic change).

---

## 4. Tests

New:
- `packages/transfer/src/{ranges,progress,chunker,push-driver}.test.ts` and
  `src/node/sink.test.ts` — 42 tests. The sink tests port the upgrade resume cases
  (offset mismatch reports the real size, short body ⇒ keep `.part` + `incomplete`,
  full-length + bad digest ⇒ delete, corrupt prefix, `maxBytes`, external cancel, TTL sweep)
  plus the ranged-mode cases (out-of-order reassembly, truncated range bookkeeping,
  beyond-total rejection, whole-file digest verification).
- `apps/gateway/src/transfer/transfer.test.ts` — 13 tests (grant single-use / wrong peer /
  wrong token / expiry, rel-path escapes, stream negotiation, routes incl. `self`
  normalization, top-level `code`, uid isolation, NDJSON snapshot-first/end-last, recursive
  expansion with a pre-marked over-limit file).
- `apps/gateway/src/mesh/integration/transfer.integration.test.ts` — 8 tests over a **real**
  `LinkMux` pair (`createInMemoryLinkPair` + real `acceptHttpStream` + real `Forwarder`
  + real mesh-internal routes + real sink): single file over the relay-labelled path,
  4 parallel streams byte-identical over 6 MiB, **mid-transfer stream reset resumed**
  (the harness truncates one PUT body the way a relay RST looks), directory expansion with
  nested `relPath`, grant bound to a different peer rejected, cancel, A === B local copy,
  `onConflict: skip`.

Updated (protocol legitimately changed): `apps/gateway/src/files/transfer-session.test.ts`
(rewritten for ranged writes), `api/file-transfer-routes.test.ts`, `api/files.test.ts`,
`api/file-transfer-sessions.test.ts`, `mesh/rtc/bulk.test.ts`,
`mesh/integration/direct-path.integration.test.ts` (hook renames),
`packages/api-client/src/files-upload.test.ts` (PUT URL now carries `&length=`),
`packages/panels/src/files/bulk-transfer.test.ts` (same),
`packages/ws-client/src/direct/bulk-client.test.ts` (frame size 16 KiB).

### Results

| Package | Result |
|---|---|
| `packages/transfer` | 43 pass / 0 fail |
| `packages/api-client` | 278 pass / 0 fail |
| `packages/ws-client` | 413 pass / 0 fail |
| `packages/panels` | 1070 pass / 0 fail |
| `packages/shared` | 799 pass / 0 fail |
| `packages/stores` | 435 pass / 0 fail |
| `packages/app` / `ui` / `notifications` | 945 / 414 / 23 pass, 0 fail |
| `apps/fe` (`bun test src/`) | 2758 pass / 0 fail, tsc 0 |
| `apps/gateway` | 4986 pass / 10 fail — exactly the documented baseline set (9 `mesh phase-2 integration` + the flaky `HTTP-style bulk … 8 MiB after a DC re-dial`). Baseline was 4913/10; the four relay failures present mid-round are gone (R1 landed). |

`bunx tsc --noEmit` is 0 errors for transfer, api-client, ws-client, panels, shared, stores,
ui and fe. `apps/gateway` is 0 errors in everything I own; as of this writing it reports 3
errors in T2's `src/portmap/{accept-tcp-stream,listener,pump.test}.ts`
(`PumpSocket.endWrite` missing on Bun's `Socket`) that landed after T2 finished — the
commander needs those fixed. `bunx biome check` is clean over everything I touched.
`bun scripts/complexity/gate.ts` → **ok** (no allowlist entries added; three functions were
split to stay inside the limits: `wireMeshHttp`, `runPush`, `drainContent`).

---

## 5. Notes / things to verify

1. **Worktree baseline drift.** When I started, `apps/gateway` was 4909 pass / 14 fail — the
   documented 10 (9 `mesh phase-2 integration` + the flaky 8 MiB DataChannel test) plus 4
   relay failures from R1's in-flight edits. The failing set keeps moving as R1/T2 land
   changes, so compare per-area rather than by total.
2. **`file_roots` foreign key + shared in-memory DB.** My gateway tests insert devices/roots
   into the process-global `:memory:` DB. They now delete both tables in `afterEach`; without
   that, `default-local-device-seed.test.ts` fails (its `delete(devices)` is blocked by the FK).
   Worth remembering for anyone adding file-root tests.
3. **`.part` litter on the destination.** A local-device destination writes
   `<dest>.part-<token>` next to the target. Session close (explicit, or the 10 min idle GC
   that now runs on a 1 min timer) discards uncommitted parts, but a hard process kill leaves
   them. There is no boot-time sweep over user file roots — deliberately, since sweeping
   arbitrary user directories is riskier than the litter. `tmex-rx-*` staging dirs (ssh
   destinations) *are* covered by `sweepOrphanTransferTemps()`.
4. **`enqueueDeviceJob` still serializes per device.** Parallel streams help the wire, not the
   rsync leg: an ssh source/destination still funnels through one rsync at a time. Local
   devices bypass rsync entirely now (both read and write), which is where the parallelism pays.
5. **A === B uses `streams: 1`** (a local copy through the same receiver — parallelism would
   only add syscalls).
6. `apps/gateway/src/api/file-transfer-routes.ts` contains R1's `transferMaxBytesNow` call at
   `handleUploadInit`; I rebuilt the rest of the file around it, so the two edits are already
   merged in the working tree.
7. **A real bug the parallel test caught.** The ranged sink originally opened a missing
   `.part` with `'w+'`, which *truncates*. With four concurrent ranges racing to create the
   file, a late `'w+'` zeroed what an earlier stream had already written — reproducible as a
   1 KiB run of zeros in the committed file. It now creates with `'a'` (create, never
   truncate), reopens `'r+'`, and only grows with `truncate(total)` when the file is short.
   `packages/transfer/src/node/sink.test.ts` has a dedicated regression case, and
   `transfer-session.test.ts` covers it end to end through the upload session.
8. **Formatting fixes on three files outside my scope.** `bun run lint` was failing on
   `packages/api-client/src/portmap.ts`, `packages/panels/src/files/transfer-jobs-store.ts`
   and `transfer-job-stream.ts` (F1/T2 files, both agents finished). I ran
   `biome check --write` on exactly those three — formatting/import-order only, no semantic
   change. **After that, `biome check .` still reports 4 findings that landed later from
   another agent's in-flight edits — all in F1's files, none in mine:**
   `apps/fe/src/pages/devices/transfer/send-runner.ts` (`lint/suspicious/noAssignInExpressions`
   at :34:24 — a real rule violation, not formatting — plus import order),
   `apps/fe/src/pages/devices/transfer/pane-state.ts` (format) and
   `packages/panels/src/files/transfer-job-stream.test.ts` (format). The commander needs
   those fixed before `bun run lint` passes.
9. **`streams` for browser uploads is caller-chosen.** Nothing in panels picks relay vs direct
   automatically — F1 (or the fe caller) should pass `streams: pickUploadStreams(reach ===
   'relay')`. Left unset it is 4.
10. **Where the bridge comes from.** `setTransferMeshBridge` is wired inside
   `wireMeshHttp`, i.e. wherever `createMeshRuntime` runs —
   `packages/app/src/runtime/assemble.ts` does that for every role including standalone, so
   production always has it. A bare `apps/gateway` dev server (`apps/gateway/src/index.ts`,
   no mesh runtime) has no bridge and `/api/transfer/*` answers `503 {code:'unavailable'}`,
   exactly like the agent and notification bridges behave there.
11. The mesh-internal transfer routes were appended to the route table in
   `mesh-internal-tmux-routes.ts` (one import + three lines) and `/api/transfer/*` to
   `apps/gateway/src/api/index.ts` (one import + one spread line), per the shared-file rules.
   `mesh-runtime.ts` gained `wireTransferBridge(...)` next to `setMeshAgentBridge` and a
   `setTransferMeshBridge(null)` in the teardown block.
