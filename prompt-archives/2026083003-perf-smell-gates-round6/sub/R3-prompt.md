# Task R3
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

## R3 — Gateway watch + REST: shared pane capture per (device,pane), no-read upsert, N+1 queries
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/Y2-report.md` items 4, 6, 7 (verify in code first).
### Scope
apps/gateway/src/watch/** (+ tests), apps/gateway/src/db/watch.ts, apps/gateway/src/db/devices.ts, apps/gateway/src/api/device-routes.ts, apps/gateway/src/api/tmux-tree.ts (+ tests). Do NOT touch tmux-client/**, files/**, hub/**, mesh/**.
### Items
1. Watch scheduler: group rules by (deviceId, paneId); within a polling tick capture the pane once and evaluate all attached rules against that snapshot; keep per-rule interval/cooldown semantics (a rule with a longer interval simply skips ticks; capture happens at the minimum interval among rules attached to the pane). Test: 100 rules on one pane → 1 capture per tick.
2. `upsertWatchRuleState`: WatchService uses a no-readback variant (or the function returns void when the caller doesn't need the row). Check all callers. Test.
3. `GET /api/devices` and `GET /api/tmux/tree` (and the reorder response): one query with a left join for runtime status, and one batched query (`IN (...)`) for tree-order rows; preserve defaults for missing rows and the response shape byte-for-byte (existing route tests are authoritative). Count queries in a test (wrap the db or count via a spy) — 100 devices ⇒ ≤ 3 queries.
Verify: `cd apps/gateway && bun test src/watch src/api src/db`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/R3-result.md
