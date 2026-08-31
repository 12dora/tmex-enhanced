# EX3: Crash-safe upgrader blocker verification (read-only)

You are a read-only code explorer working in the worktree of branch `feat/crash-safe-upgrade` (already merged with main/1.1.5). The BIOS-style crash-safe upgrader lives in `packages/app/src/lib/upgrade-*.ts`, `packages/app/src/commands/upgrade.ts`, `apps/gateway/src/system/upgrade.ts`, `install.sh`. Design doc: `docs/release/2026083101-upgrade-crash-safety.md`. Do NOT modify files. Output your FULL report as your final message.

## Goal

A previous review (review-J, reproduced below) found 7 blockers + should-fix items. Your job: for EACH item, verify against the CURRENT code whether it still applies (line numbers may have drifted after the merge), pin down the exact current file:line anchors, and write a precise fix plan (what functions to change, new function signatures if needed, which tests to add). An implementer should be able to execute without re-exploring. Also flag any interactions between fixes (e.g. blocker 1 and 2 both touch `repairMissingJournal`).

## Review-J blockers

1. `runLockedUpgrade()` calls `repairUpgrade()` before reading the `--txn` staged package; no-journal repair (`repairMissingJournal` → `sweepUpgradeGarbage` → `sweepOrphanStaging`) and terminal-journal repair (`repairTerminalCleanup`) both delete the CURRENT txn's `staging/<txn>` — the very package the running CLI was extracted from. First real online upgrade always fails. Fix: thread current txnId through repair/GC, never cleanupTxn the executing txn; add a real download-staging→extracted-CLI→no-journal-repair→apply test.
2. `repairMissingJournal()` runs `convertLegacyLayout()` then immediately `removeLegacyTopLevelDirs()` — deletes top-level `resources/runtime/native/cli` that the still-running OLD service (1.1.3/1.0.2 layout) serves from, before commit. Fix: never remove legacy top-level dirs in missing-journal repair; only `finishCommittedCleanup()` after committed. Test: old service still running + preflight failure.
3. Preflight candidate only sets `TMEX_ROLES=standalone` — real runtime still starts Telegram/wechat refresh, push/watch, tunnel, agent-session resume, gateway-online notifications, TLS/ACME. Need an explicit preflight runtime mode running ONLY migrations + side-effect-free healthz. Anchors: `packages/app/src/lib/upgrade-apply.ts` (runPreflight), `apps/gateway/src/runtime.ts`, `packages/app/src/runtime/assemble.ts`. Integration test with side-effect probes = zero calls.
4. 1.0.2 healthz has neither `version` nor `startedAt`; old-version verification always requires `minStartedAt` → rollback/repair from 1.0.2 can never verify, journal stuck non-terminal. Fix: compat path — after confirmed managed-service stop/start and `current`→fromVersion, allow verification via service-manager running state + `status=ok` only. Tests with real 1.0.2 health body.
5. `serviceMode=none` PID ownership: `assertNoneModePidOwnership()` only does `kill(pid,0)`; `createDirectProcessControl.stop()` kills unconditionally. PID reuse → kills unrelated process, old gateway keeps running, DB restore under live writer. Fix: both Web entry and `stop()` must verify the PID's cmdline/start-identity matches this install's `current/runtime/server.js` or supported legacy runtime; refuse signals/DB-touching otherwise.
6. SHA256SUMS fail-open on 404 in CLI (`packages/app/src/lib/release-fetch.ts`), Web (`apps/gateway/src/system/upgrade.ts` stageGithubRelease), `install.sh`. Fix policy: target version ≥ 1.1.4 REQUIRES SHA256SUMS 200 + exact entry + digest match (404 aborts); older targets only via explicit `--allow-unverified` (never default/Web). Update the Web test that asserts fail-open.
7. Journal advances to `backup` BEFORE `service.stop()`; recovery maps `backup`→`restart_old`, `verifyOldServiceRunning()` unconditionally `service.start()` → second process in no-service mode when crash happened pre-stop. Fix: explicit `stopping` phase, or recovery first checks whether old service still runs (verify without restarting if so).

## Should-fix items to verify/plan likewise

- `upgrade-db.ts` `bun -e` argv off-by-one (`process.argv[1]` vs script reading `[2]/[3]`) — VACUUM INTO always fails, silently falls back to live file copy.
- `upgrade-native.ts` forces re-download from npm even when a valid addon exists locally (offline upgrade impossible); reuse verified addon when manifest/hash/platform/pin match.
- gateway `system/upgrade.ts` opens `upgrade.log` FD before no-service PID check; FD leak when check throws.
- `upgrade-legacy.ts` flips shim to `current/cli/bin/tmex.js` even when 1.0.2 layout has no `cli/` — shim points at nonexistent file after preflight failure.
- Commit-time readiness only checks HTTP /healthz version; TLS hub with failed HTTPS listener counts as success. (Assess effort; may descope with justification.)
- Gateway UpgradeController stuck `executing` when child exits early — verify whether the S2 fix from G5b already covers this (`pendingEarlyExit`), i.e. possibly already done.
- Same-version upgrade no-op, keepBackup in journal, repair sweeping journal-less garbage/`*.tmp` — G5b claims these are done (S3/S4/S5); verify and report DONE/NOT-DONE.

## Also report

- Current test file inventory for the upgrader and how the fake/real service manager + fake gateway are stubbed in tests (so new tests follow the same patterns).
- Whether the merge with main left any inconsistencies in `packages/app/src/commands/upgrade.ts` (flag parsing was merged by hand: `assertKnownUpgradeFlags` + `parseUpgradeRunFlags`).
