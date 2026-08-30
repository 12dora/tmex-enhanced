# Task G7
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

Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/review-be2-report.md` (verify each finding in code before changing).
## G7 — watch scheduler: empty-group re-arm, absolute per-rule deadlines, no dropped ticks (findings 2, 5, 6)
### Scope
apps/gateway/src/watch/scheduler.ts, apps/gateway/src/watch/service.ts (+ tests). Nothing else.
### Items
1. Blocker: attaching a rule to a group that has no timer (e.g. last rule detached while a tick was in flight) must always (re)arm; delete empty groups immediately and track in-flight work separately. Test: detach last rule during in-flight tick → attach new rule → it gets scheduled.
2. Replace "accrue minIntervalMs and reset" with absolute per-rule deadlines on a monotonic clock (injectable `now()`); the group's timer fires at the nearest deadline; a rule's deadline is preserved when other rules are added/removed (removing a 5 s rule must not postpone a 30 s rule that has already waited 25 s). A tick captures once and evaluates every rule whose deadline ≤ now, then re-arms to the next nearest deadline. Tests with fake clock for 5 s + 7 s mix (7 s rule runs at 7, 14, 21… not 10, 20) and the remove-5s case.
3. Do not drop timer events while a pane tick is in flight: record a pending tick and rerun after completion (bounded to one pending), or release pane exclusivity after the shared capture so a slow LLM rule does not starve regex rules. Test: slow evaluation (30 s) on one rule ⇒ the 5 s regex rule on the same pane still gets its ticks after the slow one completes (or concurrently, depending on the design you pick — document it).
Verify: `cd apps/gateway && bun test src/watch`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/G7-result.md
