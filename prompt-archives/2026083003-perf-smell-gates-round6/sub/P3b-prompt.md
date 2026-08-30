# Task P3b
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

## P3b — Device rows/cards: per-device connection selectors instead of a recreated global adapter; device-tree navigation + folder-tree context selectors
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/X4-report.md` items 3, 6, 7 (authoritative; verify in code).
### Scope
apps/fe/src/components/global-device-provider.tsx (+ tests), packages/stores/src/tmux-event-router.ts (+ tests) ONLY if per-device map cloning must change, packages/panels/src/device-tree/device-row.tsx, sidebar-device-list.tsx (only the adapter plumbing), device-tree-navigation.ts (+ tests), packages/panels/src/device-management/device-grid.tsx and device-card.tsx (memo + stable props only), packages/panels/src/device-folders/device-folder-tree.tsx (context value only). Do NOT touch sidebar-agent-sessions / files-tab (another agent).
### Items
1. Global device provider: split the context into (a) stable commands (connect/disconnect/…; identity never changes) and (b) per-device status read through a selector hook (`useDeviceConnectionStatus(deviceId)` subscribing only to that device's entry). `DeviceRow`/`DeviceCard` must re-render only when their own device's status changes — prove with a render-count test: 20 devices mounted, one device status event ⇒ exactly one row re-render.
2. `device-grid.tsx` / `device-card.tsx`: memoize the card and pass stable per-card props (useMemo keyed on the device record) so unrelated device updates do not re-render every card.
3. `device-tree-navigation.ts`: subscribe only to the pending target device's snapshot (or a small derived selector), not the whole `snapshots` map; keep the route-invalidation behaviour and its tests.
4. `device-folder-tree.tsx`: build the context value from the individual callbacks/values (useMemo on those deps), not the whole `props` object.
Verify: `cd apps/fe && bun test src/`, `cd packages/panels && bun test`, `cd packages/stores && bun test`, tsc baselines, biome. Do NOT run Playwright e2e.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/P3b-result.md
