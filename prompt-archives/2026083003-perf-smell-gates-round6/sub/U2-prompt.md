# Task U2
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

## U2 — fe: markdown highlightAuto guard, lazy-chunk error boundary, TunnelStatusCard evaluation
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/Z1-report.md` findings HIGH + MEDIUM (lazy chunk) and the S2 allowlist note on remote-access.
### Scope
packages/panels/src/markdown/markdown-preview.tsx (+ test); apps/fe/src/pages/SettingsPage.tsx, apps/fe/src/pages/FilePage.tsx, apps/fe/src/use-page-module.ts / page-wrapper.tsx / PageLoadFallback.tsx (read how page-level lazy failures are already handled and REUSE that mechanism), apps/fe/src/pages/settings/remote-access/status-card.tsx + tunnel-model.ts (+ tests).
### Items
1. `MarkdownPreview`: `rehype-highlight` `detect` must not run on large untyped code blocks — gate detection so blocks above 64 KiB (or a whole document above e.g. 256 KiB) render explicit-language highlighting only; explicit fenced languages keep working. Test: 1 MiB untyped block renders in < 100 ms; small untyped block still auto-highlights.
2. Lazy chunk failures for settings tabs / markdown preview: reuse the existing page-module error/retry mechanism if there is one (use-page-module); otherwise add ONE small shared boundary component (retry button, capped) in apps/fe/src. Test with a rejected import.
3. `TunnelStatusCard` (CC 34, 216 lines) and `wizardStepState` (CC 27): decide honestly. If a pure `deriveTunnelStatusView(model)` returning a small discriminated object lets the JSX become flat with NO net line growth and CC < 15 for both pieces, do it; otherwise leave it and write in your result why it should be allowlisted. Do not add abstraction for its own sake.
Verify: panels `bun test` + tsc 0, fe `bun test src/` + tsc 0, biome on changed files. Do NOT run Playwright.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/U2-result.md
