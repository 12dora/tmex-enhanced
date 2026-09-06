# T4 result — node-to-node transfer review fixes (R1-n2n, all 17 findings)

Branch `feat/round32-relay-quota-transfer-portmap`, worktree `/Users/konata/code/tmex-r32`.
Scope kept to `apps/gateway/src/transfer/**`, `apps/gateway/src/mesh/forwarder.ts` (+ one new
`mesh/forwarder-body.ts`, see §4), the mesh transfer integration test,
`packages/shared/src/contracts/transfer.ts` (additive only) and one new doc.
`packages/transfer/**`, `files/**`, `api/file-*`, portmap, relay and fe were not touched.

---

## 1. Findings → fixes

| # | Fix | Where |
|---|---|---|
| 1 | Granted-directory boundary, symlink-safe. `DestContext` now carries `realDestDir` (realpath of the *granted* dir). Local placement walks each component from that realpath: `lstat` per segment, symlink ⇒ `outside_roots`, missing ⇒ `mkdir` then re-`lstat` + realpath re-check; the `.part-<hash>` name is checked too (a symlink there is an attack). SSH placement runs one `sh` walk on the remote that verifies root→destDir realpath containment, refuses symlinked components, creates missing dirs, and reports the realpath dir + whether the target exists; rsync then targets that realpath dir. Residual SSH TOCTOU documented. | `dest.ts`, `dest-local.ts` (new), `dest-remote.ts` (new) |
| 2 | `skip` is enforced at placement: local via T3's atomic `sink.commit(d, {onConflict:'skip'})` (`link(2)`, EEXIST ⇒ skipped), SSH via `rsync --ignore-existing` plus the remote pre-probe. The early existence check is now only a fast path. | `receiver-files.ts`, `dest-remote.ts` |
| 3 | Expansion no longer uses the paginated browse listing (2000-entry cap). New `enumerateTree()` does one recursive `rsync --list-only -r` per directory item (works for local and ssh), bounded by a total-entries cap; a truncated collection fails the job with `too_large` instead of silently transferring a subset. | `enumerate.ts` (new), `expand.ts` |
| 4 | Destination collisions detected during expansion → the later entry is marked `dest_conflict` (new contract code) and the job fails. Receiver records are keyed by canonical `relPath` and a re-registration with a different size is rejected (`dest_conflict`) instead of reusing the record. | `expand.ts`, `receiver-files.ts` |
| 5 | Admission: per-user 8 / global 32 queued+running jobs → `429 {code:'too_many_jobs'}`. Expansion now happens **after** the session is opened (i.e. after grant redemption). Receiver-side per-session budgets: 5000 files, aggregate bytes `min` gate (64 GiB default, `TMEX_TRANSFER_SESSION_MAX_BYTES`, never below the per-file limit), 16 active writes, 4 sessions per peer / 32 total. Visited-entry cap (20000) counts directories. | `limits.ts` (new), `routes.ts`, `job-runner.ts`, `receiver.ts`, `receiver-files.ts` |
| 6 | Cancellation reaches the local channel (body piped with the job signal, plus explicit cancel on failure), the driver (T3's signal-aware `runPush`), the sink (`write(..., {signal})` bound to the session), and the remote rsync (`placeFileOnRemote` gets `session.abort.signal`). Checked before ranges and before commit; the terminal state is `cancelled` whenever the job signal fired, and a driver-internal `cancelled` while the job was *not* aborted is reported as a failure, never a false cancel. | `channel.ts`, `push-file.ts`, `job-runner.ts`, `receiver-files.ts` |
| 7 | Sessions have a `closing` state: new ops rejected (`beginOp`), active ops awaited (`whenIdle`), only then partials discarded / staging removed / session dropped. `DELETE /sessions/:sid` awaits that. | `receiver.ts`, `mesh-routes.ts` |
| 8 | Keep-alive by byte activity (incoming body piped through a `touchSession` transform) and by `activeOps > 0` (GC skips busy sessions). `getSession` checks expiry *before* refreshing. New `POST /sessions/:sid/keepalive` + `channel.keepAlive`, called on a 2-minute timer while the source file is being staged. | `receiver.ts`, `receiver-files.ts`, `mesh-routes.ts`, `push-file.ts` |
| 9 | `ReceivingFile` splits `stagedDone` (local rename done) from `committed` (final placement done). For ssh, `committed` is set only after rsync succeeds; a repeated commit resumes at the placement step. | `receiver-files.ts` |
| 10 | `runTransferJob` wraps the whole run: exception ⇒ `failed` (normalized code), abort ⇒ `cancelled`, and a job that somehow falls through gets a terminal state anyway. Session close stays in `finally`. | `job-runner.ts` |
| 11 | `forwardInternalHttp` cancels the wrapped body when `getLink`/`openHttpStream` throws before transport ownership; `forwardAuthorizedHttp` does the same when every attempt failed or the call was pre-aborted. | `mesh/forwarder.ts`, `mesh/forwarder-body.ts` |
| 12 | NDJSON subscriptions use a bounded, pull-driven buffer (`CountQueuingStrategy` HWM 32 + a 256-entry queue). `progress`, `item:<index>` and `snapshot` coalesce in place; over-budget consumers are dropped but still receive `end`. Item byte updates are no longer emitted per callback — they ride the same 200 ms throttle as `progress`. | `job-events.ts` (new), `job-registry.ts`, `routes.ts` |
| 13 | Partial identity is `(grant scope = destRootId + realDestDir, relPath, size)`, independent of session id, so a new grant/session resumes an existing `.part`. SSH staging dirs are derived from the same scope (`tmex-rx-<sha256(scope)[0..16]>`) instead of `mkdtemp`. A process-local claim map prevents two live sessions from writing the same partial (second gets `dest_conflict`). New bounded orphan sweep (boot + every 6 h, skipped under `NODE_ENV=test`): local roots walked breadth-first (≤2000 dirs, depth ≤6, no symlink descent, strict `.part-<16 hex>` match, 24 h TTL, claimed parts skipped) and `tmex-rx-*` staging dirs by TTL. The stale restart-resume comment in `job-registry.ts` was corrected. | `receiver.ts`, `receiver-files.ts`, `sweep.ts` (new), `job-registry.ts` |
| 14 | Finished jobs are evicted by a 60 s timer independent of API traffic, plus a 200-job retention cap (oldest finished evicted first). | `job-registry.ts` |
| 15 | Expansion emits explicit `dir` entries (including empty ones and the top-level directory). New `POST /sessions/:sid/dirs` + `channel.mkdir` create them through the same authorized resolver (local: `resolveAuthorizedDir`; ssh: the same remote walk). `TransferJobItem.type?: 'file' \| 'dir'` added. | `expand.ts`, `receiver-files.ts`, `mesh-routes.ts`, `channel.ts`, `job-runner.ts` |
| 16 | One validated normalizer (`normalizeTransferError`) shared by the mesh channel, the local channel and the runner. `NODE_UNREACHABLE` → `node_unreachable`, `NODE_LOGIN_REQUIRED` → `peer_mismatch`, valid `FileErrorCode`s preserved, everything else → `unknown`; cancellation handled separately. | `errors.ts` (new) + call sites |
| 17 | Integration test rebuilt (see §3). | `mesh/integration/transfer.integration.test.ts` |

---

## 2. Contract changes (`packages/shared/src/contracts/transfer.ts`, additive only)

- `TransferErrorCode` gains `'dest_conflict'` (two sources landing on the same destination
  relative path, or a receiver record whose identity changed) and `'limit_exceeded'`
  (receiver-side session budgets).
- `TransferJobItem.type?: 'file' | 'dir'` (absent means `file`).

**The commander must wire up two follow-ups in fe (out of my scope):**
1. `apps/fe/src/pages/devices/transfer/send-transfer.ts:KNOWN_ERROR_CODES` does not list the two
   new codes, so they currently render as the generic “unknown” message. Adding them needs the
   three locale JSONs (`devices.transfer.errors.dest_conflict` / `.limit_exceeded`) plus
   `bun run build:i18n`.
2. `429 {code:'too_many_jobs'}` from `POST /api/transfer/jobs` is a route-level code (not a
   `TransferErrorCode`); fe shows the generic error for it today.

Directory items now appear in the job item list with `size: 0` — the fe list renders them as
zero-byte rows unless F1 special-cases `item.type === 'dir'`.

## 2.1 New env knobs

- `TMEX_TRANSFER_SESSION_MAX_BYTES` — per-session aggregate byte budget (default 64 GiB).
- `TMEX_TRANSFER_CHUNK_BYTES` — chunk size advertised to the source (default 8 MiB, floor
  64 KiB). Added mainly so the integration test can exercise many chunks cheaply; it is a
  legitimate operational knob and is documented.

---

## 3. Tests

New / rewritten:

- `apps/gateway/src/transfer/receiver.test.ts` (10 tests): symlink component refused; the
  boundary is the granted dir, not the root; skip keeps / overwrite replaces; identity change ⇒
  `dest_conflict`; aggregate byte budget; closing rejects new ops and leaves no `.part`;
  **a partial survives a simulated crash and a fresh grant resumes it**; orphan sweep removes
  expired partials but keeps claimed ones; directory entries via the authorized resolver.
- `apps/gateway/src/transfer/job-events.test.ts` (4 tests): 5000 item updates coalesce to ≤4
  events; finished job yields `snapshot`+`end`; over-budget consumer disconnected with a
  terminal `end`; error normalizer table.
- `apps/gateway/src/transfer/transfer.test.ts` (16 tests): existing cases updated for the new
  expansion shape, plus empty-directory manifest, destination collision, complete enumeration,
  and the per-user admission budget (429 + another user unaffected).
- `apps/gateway/src/mesh/integration/transfer.integration.test.ts` (11 tests, real `LinkMux` +
  real forwarder + real mesh-internal routes + real sink, chunk size 256 KiB):
  - 6 chunks with `streams: 4` — asserts ≥6 PUT streams and **maxConcurrentPuts ≥ 4**;
  - **live stream reset + link swap** mid-PUT: the fixture truncates a PUT body and replaces the
    `LinkSession` pair (real reconnection); asserts resume by ranges (a post-reset `status`
    reported non-zero bytes and total uploaded bytes stay under 2× the file);
  - **cancel after bytes were written** (abort fired from inside the PUT body once a chunk had
    gone out): job ends `cancelled`, destination file absent;
  - empty-directory case (dir created at the destination);
  - destination collision case (`dest_conflict`, first file intact);
  - truncation case: a 2100-entry directory expands completely (the old browse listing capped at
    2000 and silently dropped the rest);
  - forwarder body cancellation when `getLink` rejects (finding 11);
  - plus the original relay/single-file, peer-mismatch, A===B and skip cases.

### Results

| Suite | Result |
|---|---|
| `bun test src/transfer` | 30 pass / 0 fail |
| `bun test src/mesh/integration/transfer.integration.test.ts` | 11 pass / 0 fail |
| `bun test src/mesh` | 1429 pass / 0 fail |
| `bun test` (apps/gateway, full) | **5050 pass / 10 fail / 2 errors, 5060 tests across 461 files** — the 10 failures are exactly the documented baseline (9 `mesh phase-2 integration` + the flaky 8 MiB DataChannel re-dial), and both “unhandled error between tests” blocks come from those same two files (`mesh.integration.test.ts` login 400, `dc-http-bulk.integration.test.ts` LinkError). Nothing from `src/transfer`, `src/mesh` or `src/relay` fails. |

`bunx tsc --noEmit -p apps/gateway` → 0 errors (also 0 for `packages/shared`,
`packages/api-client`, `packages/panels`, `apps/fe` after the contract change).
`bunx biome check` clean over every file I touched.
`bun scripts/complexity/gate.ts` → **ok**, no allowlist entries added or changed.

---

## 4. Deviations worth knowing

1. **`apps/gateway/src/mesh/forwarder-body.ts` (new file).** `forwarder.ts` was already at its
   allowlisted 964-line ceiling, so the +15 lines of finding 11 would have required bumping the
   allowlist. Instead I moved three self-contained, forwarder-only helpers
   (`throttledProgress`, `countStreamBytes`, and the new `cancelForwardBody`) into a new module;
   `forwarder.ts` is now 938 lines and the gate passes untouched.
2. **No-clobber for SSH** could not go through `files/device-storage.ts:pushFileToDevice`
   (out of scope, and it lacks a no-clobber mode), so `dest-remote.ts` builds its own rsync argv
   from the exported `rsyncTargetArg` + `runRsync`, adding `--ignore-existing` for `skip`.
   `--ignore-existing` is supported by both GNU rsync and macOS openrsync (verified locally).
3. **Complete enumeration via recursive `rsync --list-only -r`** rather than `readdir`/`ssh find`:
   it is one round trip, identical for local and ssh devices, already returns type+size+relative
   path, and reuses the existing bounded collector. A truncated result is a hard failure.
4. **Env knobs are read directly** (`process.env`) in `transfer/limits.ts` rather than through
   `apps/gateway/src/config.ts`, which is outside my scope and shared with other agents.
5. **The receiver no longer cancels the request body on early rejections.** Doing so RSTs the mux
   stream and the source never sees the error code (it retried five times instead of skipping).
   The body is left to the caller: the mesh route replies with the error code, and the local
   channel cancels the file stream itself.
6. Engine-side dependencies landed while I worked: T3's `commit(d, {onConflict})` →
   `{committed, skipped}`, `write(..., {signal})`, the new `conflict` / `sealed` sink codes
   (mapped to a retryable `offset_mismatch` and to “already placed”, respectively), and the
   signal-aware `runPush`. All are used as delivered; nothing in `packages/transfer` was edited.

### A note on the full-suite numbers

One full run mid-session reported 12 failures — the 10 baseline ones plus two relay integration
tests (`relay r3 join path`, `relay root rotation`). Both pass in isolation
(`bun test src/relay` → 177/0) and together with everything I added
(`bun test src/relay src/transfer src/mesh/integration` → 291/0). That run overlapped with another
agent running the full suite in the same worktree (their logs from the same minutes show a
*different*, equally fluctuating failure set and no relay failures), so those two were
CPU-contention flakes, not a regression. Two later uncontended full runs — one with my source
changes but my two new test files temporarily moved aside, one with everything in place — both came
back with exactly the 10 baseline failures and no relay failures.

## 5. Residual risks / notes for the commander

- SSH destinations keep a TOCTOU window between the remote boundary walk and rsync (documented in
  `docs/files/2026090604-node-to-node-transfer.md`). Local destinations do not.
- The orphan sweep walks enabled **local** file roots (≤2000 dirs, depth ≤6, 24 h TTL, strict
  `.part-<16 hex>` match). It only ever deletes files in this module's own naming namespace.
- The integration fixture is still an in-memory `LinkMux` pair (now with a real link swap for the
  reset case). Exercising a **real relay hop** for transfers would need the docker/relay harness;
  it is not covered here — worth a live check during the round's manual verification.
- New doc: `docs/files/2026090604-node-to-node-transfer.md` (背景 / 授权模型 / 协议 / 限制 / 清理).
