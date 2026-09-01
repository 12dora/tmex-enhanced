# O3b — Fix RV5 findings on the Nodes page cancel/restore (frontend)

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it. Then read `sub/O3-prompt.md`, `sub/O3-result.md` and the review `sub/RV5-result.md` (items 5, 7, 8, 9, 10, 11 are yours). Backend contract changes landing concurrently (G7b): the entry may answer a cancel with `501 UPGRADE_CANCEL_UNSUPPORTED` also *after* the push when the target lacks the `'upgrade-cancel'` capability; `409 UPGRADE_NOT_CANCELLABLE` when the target is already installing; nothing else changes for you.

## Fixes (TDD with injected `UpgradeIo`)

1. **RV5-5 Stop during `pending` (POST in flight)** — pressing Stop must guarantee the upgrade does not proceed silently: record `cancelRequested` for the node; abort nothing yet; when the POST resolves: `started`/`unconfirmed` → immediately issue `cancel(row)` (DELETE) and handle its result normally (200 → idle+「已取消」; 409 → keep watching with warning; 501 → warning + keep watching); `failed`/`alreadyLatest` → idle as today. If the DELETE during `pending` returned `UPGRADE_NOT_RUNNING`, treat it as "not yet registered" and retry once after the POST resolves instead of just an info toast. Test: Stop pressed while `start()` is pending → after start resolves, `cancel` is called exactly once and the row ends idle.
2. **RV5-11 cancelling state** — add phase-independent `cancelling: boolean` to the entry; Stop button disabled + spinner while a cancel request is in flight; no double DELETE on double click.
3. **RV5-7 restore concurrency** — one hook-level semaphore (3) shared by all restore rounds; test: two rounds overlapping never exceed 3 concurrent `poll` calls.
4. **RV5-8 restore vs manual start** — while a node's restore GET is in flight, its row Upgrade button is disabled (`title`「正在同步升级状态…」) and `startAll()` excludes such nodes (and refuses entirely while `restoring`, with the info toast); if a manual start still races (e.g. keyboard), the `onActive` handoff must not be dropped — queue it and attach the watcher once the exclusive slot frees. Test both.
5. **RV5-9 membership** — `restoredRef` must forget ids that left the row set so a node that disappears and re-appears is restored again. Test.
6. **RV5-10 old entry compatibility** — map DELETE responses `404`/`405`/`501` (any of `code` missing) to「该节点版本不支持中断」(warning, keep watching), not a generic failure. Test.

## Files you own

`apps/fe/src/pages/settings/nodes/management/{use-node-upgrade.ts,use-node-upgrade.test.ts,upgrade-batch.ts,types.ts,nodes-table.tsx,nodes-management.tsx,nodes-management.test.tsx}`, locale JSONs (`translation.nodes.upgrade` only; run `bun run build:i18n`). Do NOT touch `apps/gateway/**`, `packages/api-client/**`.

Baselines: `cd apps/fe && bun test src/` 1225 pass / 0 fail; `bunx tsc --noEmit -p apps/fe` 0.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/O3b-result.md`. Write it, then exit.
