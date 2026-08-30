# Task Q1
## Ground rules (read carefully)
- Repo: tmex monorepo, Bun-only runtime (`bun`, `bunx`; never node/npm/npx for running). Worktree root: /Users/konata/code/tmex-enhanced-wt-r6. Work ONLY inside this worktree.
- Several other agents are editing this same worktree in parallel. Touch ONLY the files/directories listed in your scope (plus new files you create inside those directories, and the matching `*.test.ts(x)` / `bench/*` files for them). Do NOT run `git add/commit/stash/checkout/reset`. Do NOT run formatters over the whole repo; `bunx biome check --write <your files>` only.
- Never edit generated files: `packages/shared/src/i18n/resources.ts`, `packages/shared/src/i18n/types.ts`, anything under `resources/`, `dist/`. Do not add npm dependencies.
- Do not touch anything about the production tmex install (`~/Library/Application Support/tmex`, port 9883) or any tmux session named `tmex`. Tests must use isolated tmux sockets / test env only.
- Comments in code: only when the logic is genuinely non-obvious; existing comments are in Simplified Chinese — follow that.
- This is a PERFORMANCE round. Net line count matters: every change should be as small as the correct fix allows; prefer removing code over adding; do not add abstractions "for the future". Do not refactor beyond your fix list. Keep observable behaviour byte-for-byte identical unless the task says otherwise.
- Every fix must come with (a) a regression/behaviour test where behaviour could drift and (b) a quick before/after measurement where the task asks for one (put throwaway bench scripts in /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/, or extend an existing `bench/` file in the package). Report the numbers.
- Never leave TODOs, stubs, or "simplified versions". Finish the whole scope. If an item is genuinely wrong or not worth it after reading the code, say so in the result with the reason instead of doing it half-way.
- Verify before finishing: `cd <pkg> && bun test` (for apps/fe use `bun test src/`), `bunx tsc --noEmit -p .` in each package you touched (error count must not exceed baseline), `bunx biome check <changed files>`.
  Baseline (this round start): shared 365/0 tsc 0; ws-client 262/0 tsc 0; stores 321/0 tsc 1; panels 580/0 tsc 0; ui 47/0; terminal-ui 318/0; ghostty-terminal 189/0; api-client 132/0 tsc 5; app 414/1(pre-existing cpu-features stub) tsc 1; gateway 2671/0 tsc 21 (pre-existing); fe 866/0 tsc 0. `peer-manager.test.ts` can fail with EADDRINUSE when run concurrently with other agents' test runs — rerun it alone if so.
- When done, write a concise result report (what changed and why, file list, measurements, test/tsc/biome numbers, anything left or risky) to the absolute path given in your task, then exit.

## Q1 — stores: bounded retention of inactive agent session histories
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/Y1-report.md` item 1 (verify in code first).
### Scope
packages/stores/src/agent-session-crud-actions.ts, agent-history-sync.ts, agent-state.ts, agent-session-message-actions.ts if needed (+ tests). Do NOT touch packages/panels or apps/fe.
### Items
1. When the remote session list no longer contains a session, run the same per-session cleanup as `deleteSession()` (messages, historyLoaded, inProgress, queued state, subscriptions).
2. Bounded cache for inactive histories: keep the active session (per node) and any session that is running / has inProgress or queued state pinned; evict the least-recently-active histories beyond a budget (e.g. 8 sessions or ~4 MiB of message text, whichever first) by clearing their `messages` and `historyLoaded=false` so reopening refetches. Make sure the history-sync path refetches cleanly for an evicted session and that the sidebar (which reads session metadata, not messages) is unaffected.
3. Test with the real store: open 200 sessions with 1 KiB histories → retained message arrays ≤ budget; refresh list to empty → 0 retained; evicted session reopened → history refetched once.
Verify: `cd packages/stores && bun test` (baseline 327/0, tsc 1 pre-existing), biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/Q1-result.md
