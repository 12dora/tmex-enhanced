## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: stream failover — final-review should-fixes (generation conflict, orphan upstream WS) + legacy gap coverage

Scope: `apps/gateway/src/mesh/forwarder.ts` (+test), `apps/gateway/src/mesh/mesh-http.ts`, `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`. READ-ONLY: `apps/gateway/src/ws/**`, `packages/shared/src/ws/**`. Others are editing `rtc/**`, `packages/shared/src/link/**`, `hub/**`, `peer-manager.ts`, `mesh-routes.ts` — don't touch.

Read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-final.md` §1 (Stream failover). The blocker about legacy replay order was just fixed in commit 073d049; re-read the current `forwarder.ts`. Remaining items to fix:
1. **Generation conflict during failover:** browser messages that arrive while failover is in progress must not race the synthesized replay — either queue browser→upstream messages until the replay completes and then apply them with generations *after* the replayed one, or snapshot state after draining the queue and drop superseded queued subscription frames. Test: subscribe change sent mid-failover ends up as the effective subscription on the new link (no generation conflict).
2. **Orphan upstream stream on browser close:** after every `await` in the failover/open path re-check the abort/closed flag and close any stream opened after the browser went away. Test: close browser during `getLink()`/`openWsStream()` → upstream stream gets closed (reviewer repro gave `{"opened":1,"orphanClosed":false}`).
3. **Legacy gap (reviewer blocker, partial):** legacy `TMUX_SUBSCRIBE_PANES` has no cursor, so output produced between the old session's death and the new subscription is lost. Mitigate as far as the protocol allows: after the replayed subscribe, request history/snapshot for each subscribed pane (the legacy `TMUX_SELECT wantHistory` path or a snapshot request — read `apps/gateway/src/ws` to see what a legacy client can ask for) so the terminal view is reconstructed, and document in the ops doc that legacy subscribers get a snapshot-based resume while canonical subscribers get cursor-exact resume. Make the integration test assert SEQ continuity *with* a producer active during the gap (the reviewer noted the previous test never advanced SEQ during the switch).

Verification: `cd apps/gateway && bun test src/mesh/forwarder.test.ts src/mesh/integration/stream-failover.integration.test.ts` then `bun test src/mesh` 0 fail; tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-failover3-result.md`
