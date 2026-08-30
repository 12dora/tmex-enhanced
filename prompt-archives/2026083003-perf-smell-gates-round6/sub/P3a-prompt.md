# Task P3a
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

## P3a — fe bundle: lazy Markdown preview, split settings tabs, CodeViewer highlightAuto guard
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/X4-report.md` items 1 and 2 (authoritative; verify in code).
### Scope
apps/fe/src/pages/FilePage.tsx, apps/fe/src/pages/SettingsPage.tsx, apps/fe/src/main.tsx (settings init import path only), packages/panels/src/settings/index.ts and version-tab-sections.tsx (+ a narrow entry file for `SettingsEventsInit` if needed), packages/panels/src/code-viewer/code-viewer.tsx (+ tests), packages/panels/src/markdown/index.ts (only to expose a lazy entry). Do NOT touch streaming-markdown.tsx or anything under packages/panels/src/agent.
### Items
1. `CodeViewer`: never call `hljs.highlightAuto` on inputs above a small threshold (e.g. 64 KiB) or when the language is unknown and the file is large — render escaped plain text instead; explicit known languages keep highlighting but above e.g. 512 KiB fall back to plain text too (highlighting 2 MiB TS took 33 ms which is fine; the freeze is highlightAuto at 7.7 s/MiB). Test both branches.
2. Lazy-load `MarkdownPreview` in FilePage only for markdown files (React.lazy + Suspense with the existing PageLoadFallback or a minimal inline fallback), and in the settings version tab. Split SettingsPage tabs into lazy chunks (one `React.lazy` per tab) — keep tab switching instant after first load. Ensure the entry chunk no longer pulls `qrcode.react` (Weixin login) at startup: give `SettingsEventsInit` (or whatever main.tsx needs from the settings barrel) its own narrow import path.
3. Run `bun run --filter @tmex/fe build` and report chunk sizes before/after (entry, FilePage, SettingsPage, markdown-preview). Do not commit build output; revert any generated files that changed (`git status` must only show your source edits).
Verify: `cd apps/fe && bun test src/`, tsc 0; `cd packages/panels && bun test`, tsc 0; biome. Do NOT run Playwright e2e.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/P3a-result.md
