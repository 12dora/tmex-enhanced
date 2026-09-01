# G4b — Fix review findings on the staged-package remote upgrade (commit f35358fe)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `prompt-archives/2026090104-round13-upgrade-multihub/sub/G4-prompt.md`, `sub/G4-result.md` and the review `sub/RV2-result.md` (11 findings with file:line and failing scenarios). The commander has triaged them; fix **all 11** as specified below, TDD style (add a failing test per finding first where feasible).

## Decisions per finding

1. **Auth gating of staged endpoints** — `PUT /api/system/upgrade/package` and `POST /api/system/upgrade` with `source:'staged'` must be refused with `403 { code: 'UPGRADE_NOT_ALLOWED', reason: 'staged_requires_auth' }` unless the request is authenticated: i.e. it arrived through the mesh forwarded-stream path with a verified node session, or through a locally-authenticated session (check how `apps/gateway/src/mesh/session-middleware.ts` / the system route guard expose "authenticated vs open-mode short-circuit"; if the open-mode short-circuit is indistinguishable at the handler, thread an explicit `authenticated: boolean` from the dispatcher). Open-mode standalone must never accept a staged package. Release-source POST behaviour unchanged.
2. **PUT/POST mutual exclusion + atomic consume** — the controller owns a single staging mutex: while a PUT is streaming, another PUT (any version) → `409 UPGRADE_IN_PROGRESS`, and `POST` (any source) → `409 UPGRADE_IN_PROGRESS`; while the controller is non-idle, PUT → 409 (already). Each PUT writes to a unique temp name (`.part-<random>`), and `POST source:'staged'` must **atomically move** the staged `.tgz` into the transaction directory (`staging/<txnId>/`) before hashing/extracting, so no later PUT can swap it; hash the moved file (streaming, once — see 10), then extract from that path.
3. **WriteStream error handling** — replace the hand-rolled `writeAll()` with `node:stream/promises` `pipeline` (or keep listeners for the full lifetime) so open/write/close failures reject the promise and mark the job failed instead of emitting an unhandled `error`. Add a test with a non-writable cache dir.
4. **413 handling** — reject early from `Content-Length` when present and > cap; when the cap is exceeded mid-stream, stop reading and respond 413 **without** calling `reader.cancel()` first (cancel only after the response is produced, or let the response end the stream) so the peer stream can still carry the 413 back; add a forwarder-level test over the in-memory link asserting the entry sees 413, not 503.
5. **Timeouts** — per-step deadlines in the job: download 10 min, push 15 min, start 60 s (`AbortSignal.timeout`/own controller); `SHA256SUMS` fetch 30 s; on failure cancel any file stream not consumed by the forwarder. Test: a push that never responds ends the job as failed with a `push timeout` message and frees the node for a new start.
6. **Order of checks** — in `startRemoteMeshUpgrade` (or its caller) check the active-job map **first** (before GitHub latest / target info) and return `409 UPGRADE_IN_PROGRESS` deterministically; test via the service entry point.
7. **failedAt TTL** — retain failed jobs 10 min from `failedAt`, not `startedAt`.
8. **Reserved names in the crash-safe upgrader GC** — `packages/app/src/lib/upgrade-gc.ts` `sweepOrphanStaging()` (and anything else that sweeps `<installDir>/staging`) must treat `staged` and `release-cache` as reserved directories and never delete them; add tests. Also make the **local** upgrade path in `apps/gateway/src/system/upgrade.ts` use the shared `<stageRoot>/release-cache/` via `release-download.ts` (not a per-txn `.release-cache`), so entry-side and self downloads share one cache.
9. **Finalize under try/finally** — rename + sidecar write failures clean up `.part`/final/sidecar and surface as `500 { code: 'STAGE_FAILED' }` (PUT) / job failure (cache); orphan `.tgz` without sidecar are pruned by the TTL/count sweep.
10. **Streaming hash, once** — `requireStaged()`/`tryStart()`/`run()` must not read the whole file synchronously nor hash it multiple times: compute the streaming sha256 exactly once on the atomically-moved file (finding 2) and reuse the result.
11. **Reject invalid `source`** — `POST /api/system/upgrade` with `source` not in `release|staged` → `400`.

## Files you own

Same set as G4: `apps/gateway/src/system/{upgrade,upgrade-service,remote-upgrade-job,release-download}.ts` (+ their tests), `apps/gateway/src/api/system.ts` (+test), `apps/gateway/src/api/system-managed*.ts`, `apps/gateway/src/mesh/forwarder.ts` (+test), the remote-upgrade cases in `apps/gateway/src/mesh/mesh-routes.test.ts`, `packages/shared/src/contracts/system.ts`, plus **`packages/app/src/lib/upgrade-gc.ts` (+ test)** and `apps/gateway/src/mesh/stream-targets.ts` ONLY if finding 4 truly requires a change there (explain in the result). Do NOT touch `mesh-routes.ts`, `mesh-runtime.ts`, `uplink-*.ts`, `apps/gateway/src/hub/**`, `apps/fe/**`, other `packages/app` files.

## Verification

`cd apps/gateway && bun test src/system src/api src/mesh/forwarder.test.ts src/mesh/mesh-routes.test.ts && bunx tsc --noEmit -p .` (tsc: other agents may have transient errors in `src/mesh/uplink-*.ts`/`src/hub/**`; yours must be 0), `cd packages/app && bun test src/lib/upgrade-gc.test.ts && bunx tsc --noEmit -p .` (1 pre-existing error), biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G4b-result.md` — finding → fix mapping, new tests, counts. Write it, then exit.
