# Task G2
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

## G2 — Gateway agent: windowed history load per turn
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/X3-report.md` item 2 (authoritative; verify in code).
### Scope
apps/gateway/src/agent/run.ts, apps/gateway/src/agent/build-run-request.ts (+ tests), the agent message DB module under apps/gateway/src/db/ (find the module that `assembleRunRequest` and title generation use to list messages; add a windowed query there), apps/gateway/src/agent/run-deps.ts if the dependency type needs the new query.
### Items
1. Today every turn selects ALL messages of the session and `applyMessageWindow` JSON.stringifies every one of them to fit a 200,000-char budget. Add a windowed load: query messages newest-first with a running length budget (use a stored/derived content length — e.g. `length(content)` in SQL — or page backwards in chunks of e.g. 200 rows) and stop once the budget plus a safety margin is met, then apply the existing `applyMessageWindow` rules on that suffix so the user-message / tool-call pairing boundary semantics stay exactly as today. The existing window tests are authoritative — they must keep passing unchanged; add tests proving the windowed load yields the same result as the full load for (a) short history, (b) history over the budget, (c) boundary landing inside a tool-call/tool-result pair.
2. Title generation must reuse the bounded history (or an even smaller head window if that is what it semantically needs — read it), not re-query everything.
3. Measure: 10k-message synthetic session — turn assembly time before vs after (report ms and rows loaded).
Verify: `cd apps/gateway && bun test src/agent src/db`, tsc ≤ 21.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/G2-result.md
