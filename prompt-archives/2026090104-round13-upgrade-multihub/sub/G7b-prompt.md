# G7b — Fix RV5 blockers on upgrade cancellation (backend)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G7-prompt.md`, `sub/G7-result.md` and the review `sub/RV5-result.md` (items 1, 2, 3, 4, 6 are yours). The user's hard requirement stands: **after any Stop, no half-downloaded/half-staged garbage may remain, and "已取消" must never be reported while the target is actually still upgrading.**

## Fixes (TDD — write the failing test for each race first)

1. **RV5-1 PUT landed, ACK not yet received** (`remote-upgrade-job.ts` `cancelRemoteUpgradeJob`, `job.pushed`): on cancel during the push phase, abort the PUT, **await the PUT promise to settle**, then always call `DELETE /api/system/upgrade/package?version=` on the target (idempotent; 404 = nothing there). On the **target**, serialize `DELETE package` with an in-flight PUT of the same version under the controller's staging mutex: if a PUT for that version is still streaming, the DELETE must wait for it to finish (or fail) and then remove whatever landed — never return 404 while a PUT is mid-flight. Test: PUT completes on the target but the entry aborts before reading the response → after cancel, `staging/staged/` is empty.
2. **RV5-2 cancel racing the staged POST handoff**: once the job has issued `POST /api/system/upgrade {source:'staged'}`, cancel must **not** abort that request. Instead: await the start response; if the target accepted (2xx) → the job is handed off → forward `DELETE /api/system/upgrade` to the target and return **its** result (200 cancelled if the target was still downloading/verifying; `409 UPGRADE_NOT_CANCELLABLE` if `executing`); if the start failed → clean up as a cancelled job. The job's overlay must never say `UPGRADE_CANCELLED` unless the target is confirmed not running. Test both branches with a slow fake target.
3. **RV5-3 shared download inflight + abort**: move waiter/ref/abort accounting into the single cache-key inflight layer in `release-download.ts`: each caller registers its own signal; a caller's abort removes only that caller (its promise rejects with an abort error) and the underlying fetch is aborted **only when the last caller is gone**, in which case the `.part` is removed. Local upgrades and remote jobs must both use this layer (remove the duplicate ref-count in `remote-upgrade-job.ts`). Tests: local+remote sharing one download — cancelling the remote does not break the local; cancelling both aborts and cleans `.part`; cancelling the first caller does not affect the second.
4. **RV5-4 orphan sidecar after crash**: make staged-start atomic w.r.t. the sidecar (remove the `.json` **before** moving the `.tgz`, or move both), and extend `pruneOrphanStagedFiles()` / `loadStagedFromDisk()` to delete a sidecar whose `.tgz` is missing (and a `.tgz` whose sidecar is missing, already handled). Test: sidecar-only leftover is pruned on next start.
5. **RV5-6 target without cancel support**: add `'upgrade-cancel'` to `upgradeCapabilities` in `/api/system/info` (1.1.12+). The entry records the target's capabilities in the job; on cancel **after the push completed** (or while the target is downloading/verifying a staged start) against a target lacking `'upgrade-cancel'`, do not claim cancelled — respond `501 { code:'UPGRADE_CANCEL_UNSUPPORTED', nodeId }` and keep the job running. During entry-side download / mid-push (nothing landed yet, or the truncated PUT cleans itself) cancelling remains allowed for any target. Log non-2xx from `deleteStagedBestEffort` at warn level. Test with a fake 1.1.11-like target (has `staged-package`, no `upgrade-cancel`, no DELETE routes).

## Files you own

`apps/gateway/src/system/{upgrade,upgrade-service,remote-upgrade-job,release-download}.ts` (+tests), `apps/gateway/src/api/system.ts` (+test), `apps/gateway/src/mesh/mesh-routes.test.ts` (remote-upgrade cases only), `packages/shared/src/contracts/system.ts`. Do NOT touch `apps/fe/**`, `src/hub/**`, other mesh files, `packages/app/**`.

## Verification

`cd apps/gateway && bun test src/system src/api src/mesh/mesh-routes.test.ts && bunx tsc --noEmit -p .` (0 fail / 0 tsc), `cd packages/shared && bun test && bunx tsc --noEmit -p .`, biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G7b-result.md` — per finding: fix + the test proving it; the final cancel decision table (phase × target capability → response). Write it, then exit.
