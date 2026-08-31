# RV1: Code review — crash-safe upgrader fixes (branch feat/crash-safe-upgrade)

You are a code reviewer with read-only access to the worktree at /Users/konata/code/tmex-enhanced-wt-upg. Review the diff at `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/review-upg.diff` (commit "升级器 review-J 七个 blocker 与 should-fix 全量修复" on top of the already-reviewed BIOS-style upgrader). Read surrounding code in the worktree as needed. Output your FULL report as your final message.

Context: a previous review (review-J) found 7 blockers; this diff claims to fix all of them plus should-fix items. The per-item fix intents are described in `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/EX3-result.md` (the verification/fix-plan doc) and the implementers' reports `C1a-result.md` / `C1b-result.md` in the same directory.

Review focus, in priority order:
1. **Correctness of each blocker fix** — does the fix actually close the failure sequence from review-J? Specifically re-trace: (1) first online upgrade with delegated extracted CLI + no-journal repair keeps the active staging; (2) missing-journal repair with a still-running legacy service; (3) preflight runtime truly has zero side effects (check the preflight mode wiring end-to-end: env var set in runPreflight → server.ts → assemble → gateway runtime; any component still started?); (4) rollback/repair against a 1.0.2 healthz body; (5) PID ownership on both CLI stop() and Web entry — any path left that signals an unverified PID or proceeds to DB restore; (6) SHA256SUMS fail-closed on all three entries (CLI, Web, install.sh) with consistent version threshold; (7) stopping-phase crash windows — any remaining window where recovery double-starts or backs up a live DB.
2. **New crash windows introduced by the fixes themselves** (journal phase ordering, error paths that skip cleanup, lock handling).
3. **Flag unification** — the delegated apply passes `--txn/--no-service/--version/--apply-current-package`; verify both flag tables accept exactly this set and `--allow-unverified` never reaches the apply subprocess.
4. Test quality: do the new tests actually exercise the failure sequences (not just stubs)?

Classify findings as Blocker / Should-fix / Nit with file:line and a concrete failure sequence for each Blocker. Be precise; do not pad the report with restatements of the diff.
