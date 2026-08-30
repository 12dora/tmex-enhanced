# Task U1
## Ground rules (read carefully)
- Repo: tmex monorepo, Bun-only runtime (`bun`, `bunx`; never node/npm/npx for running). Worktree root: /Users/konata/code/tmex-enhanced-wt-r6. Work ONLY inside this worktree.
- Several other agents are editing this same worktree in parallel. Touch ONLY the files/directories listed in your scope (plus new files you create inside those directories, and the matching `*.test.ts(x)` / `bench/*` files for them). Do NOT run `git add/commit/stash/checkout/reset`. Do NOT run formatters over the whole repo; `bunx biome check --write <your files>` only.
- Never edit generated files: `packages/shared/src/i18n/resources.ts`, `packages/shared/src/i18n/types.ts`, anything under `resources/`, `dist/`. Do not add npm dependencies.
- Do not touch anything about the production tmex install (`~/Library/Application Support/tmex`, port 9883) or any tmux session named `tmex`. Tests must use isolated tmux sockets / test env only.
- Comments in code: only when the logic is genuinely non-obvious; existing comments are in Simplified Chinese — follow that.
- This is a CODE-SMELL round: the goal is real structural improvement with NET NEGATIVE or neutral line count — remove duplication, dead code, split functions that do two jobs. Never "move 300 lines to satisfy a number"; never turn sequential security/protocol logic into a table. Behaviour must stay identical (existing tests are authoritative — do not weaken them). Run `bun scripts/complexity/gate.ts --report` before and after and report the CC / line numbers for the functions you touched.
- Every fix must come with (a) a regression/behaviour test where behaviour could drift and (b) a quick before/after measurement where the task asks for one (put throwaway bench scripts in /private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/, or extend an existing `bench/` file in the package). Report the numbers.
- Never leave TODOs, stubs, or "simplified versions". Finish the whole scope. If an item is genuinely wrong or not worth it after reading the code, say so in the result with the reason instead of doing it half-way.
- Verify before finishing: `cd <pkg> && bun test` (for apps/fe use `bun test src/`), `bunx tsc --noEmit -p .` in each package you touched (error count must not exceed baseline), `bunx biome check <changed files>`.
  Baseline (this round start): shared 365/0 tsc 0; ws-client 262/0 tsc 0; stores 321/0 tsc 1; panels 580/0 tsc 0; ui 47/0; terminal-ui 318/0; ghostty-terminal 189/0; api-client 132/0 tsc 5; app 414/1(pre-existing cpu-features stub) tsc 1; gateway 2671/0 tsc 21 (pre-existing); fe 866/0 tsc 0. `peer-manager.test.ts` can fail with EADDRINUSE when run concurrently with other agents' test runs — rerun it alone if so.
- When done, write a concise result report (what changed and why, file list, measurements, test/tsc/biome numbers, anything left or risky) to the absolute path given in your task, then exit.

## U1 — panels/stores/fe small smells (S2 findings 2, 3, 4, 5)
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/S2-report.md` findings 2–5 (verify in code).
### Scope
packages/panels/src/device-folders/device-folder-tree.tsx, folder-tree-model.ts (+ tests); packages/panels/src/device-management/use-device-management-state.ts, packages/panels/src/device-tree/sidebar-device-list.tsx and a new small helper under packages/panels/src/device-tree/ (+ test); packages/stores/src/tmux.ts (+ tmux-reorder.test.ts); apps/fe/src/pages/LoginPage.tsx (remove dead `loginRoute` only).
### Items
1. Folder tree: pass the memoized `containers` into `resolveDrop` / `previewPlaceholder` (default param for existing callers), replace per-node `placements.some` with a memoized Set. Keep `resolveDrop` logic untouched.
2. Device reorder: one shared `reorderDevicesOptimistically` (Set-based, preserves unknown-id filtering, remainder order, sortOrder assignment) used by both mutation handlers; helper test for unknown ids / remainder ordering.
3. `createTmuxStore`: generic `reorderById` used for windows and panes.
4. Remove dead `loginRoute` export + its comment.
Verify: panels `bun test` + tsc 0, stores `bun test` + tsc 1 (pre-existing), fe `bun test src/` + tsc 0, biome on changed files.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/U1-result.md
