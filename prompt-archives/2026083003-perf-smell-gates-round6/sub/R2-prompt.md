# Task R2
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

## R2 — Gateway tmux-client: bounded legacy pane history, refresh quiet period, cold pane no-copy
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/Y2-report.md` items 2, 3, 8 (verify in code first).
### Scope
apps/gateway/src/tmux-client/** (+ tests). Do NOT touch files/**, watch/**, api/**, hub/**, mesh/**.
### Items
1. `fetchPaneHistory()` legacy path: bound the capture (reuse the control-barrier 4096-line bound / same constant; capture only the screen mode that is active if the pane's alt-screen state is known, otherwise keep both but bounded); enforce a byte limit in the local and SSH command runners for these captures; coalesce concurrent requests for the same device/pane (share the in-flight promise). Tests: bound applied, concurrent callers share one capture.
2. Structure refresh: add a minimum interval / quiet period after each refresh (e.g. 150 ms) so churn cannot exceed ~6 refreshes/s, keep the explicit immediate-refresh path for user commands. Test with fake timers counting tmux commands during 1 s of continuous notifications.
3. Cold pane retention: in cold mode, advance sequence state without copying the payload and skip fan-out when there are no consumers; preserve segment behaviour for retained panes. Confirm no caller depends on the returned cold segment. Bench 5000×1 KiB cold before/after.
Verify: `cd apps/gateway && bun test src/tmux-client`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/R2-result.md
