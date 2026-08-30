# Task P1a
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

## P1a — Agent chat: stop reparsing history per delta, memoize rows, bounded history window, rAF auto-scroll
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/X1-report.md` items 1, 2, 5 (authoritative; verify in code).
### Scope
packages/stores/src/agent-thread.ts (+ test), packages/panels/src/agent/use-agent-tab-model.ts, packages/panels/src/agent/chat-thread.tsx (+ test), packages/panels/src/agent/messages/* ONLY to wrap the exported row components in `React.memo` (no logic changes there — another agent owns streaming-markdown and the composer), i18n locale JSONs `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` only inside the `agent` sub-object if you add a "show earlier messages" label (all three, same key; the commander runs `bun run build:i18n` — you may run it yourself to typecheck).
### Items
1. `buildThreadBlocks()`: cache the parsed persisted-history blocks by the `messages` array reference (module-level WeakMap or a `useMemo` keyed on `messages`), and build the live tail as a separate overlay; live tool-result updates must patch only the affected cached block (immutably) instead of rebuilding the whole list. Historical block object identities must stay stable across flushes (test with `toBe`).
2. `ChatThread`: every block row rendered via a `React.memo` component with a stable key (message id / block id, not index); prove with a render-count test that streaming 50 deltas re-renders only the tail row.
3. Bounded window: render only the last 200 blocks by default with a small "show earlier messages" control at the top that expands by 200 each click (keeps scroll position anchored: record scrollHeight before, adjust scrollTop after commit). No virtualization library.
4. Auto-scroll: coalesce into one `requestAnimationFrame` per frame; when pinned to bottom, avoid the scrollHeight read+write on every commit (use a bottom sentinel + `scrollIntoView({block:'end'})` or a single rAF-scheduled write). Keep the existing "user scrolled up ⇒ unpin" behaviour and its tests.
Measure: extend/create a bench in packages/stores (2,000 messages × 500 flushes: ms before/after). Verify: `cd packages/stores && bun test`, `cd packages/panels && bun test`, tsc baselines.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/P1a-result.md
