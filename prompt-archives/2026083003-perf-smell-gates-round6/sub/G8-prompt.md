# Task G8
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
## G8 — tmux-client: empty capture ≠ missing target, in-flight capture keyed by connection generation, quiet-wait upgrade (findings 8, 9, 10)
### Scope
apps/gateway/src/tmux-client/external/session-commands.ts (+ test), apps/gateway/src/tmux-client/snapshot-refresh-coordinator.ts (+ test), apps/gateway/src/tmux-client/external-tmux-core.ts / local-external-connection.ts / ssh-external-connection.ts only if the reconnect generation must be threaded through. Nothing under files/ or watch/.
### Items
1. `fetchPaneHistory`: a successful but empty capture must return an empty history payload (with cursor/mode metadata as the non-empty path does) so the legacy pane switch emits TERM_HISTORY immediately; return `null` only when the target is actually missing. Test both.
2. In-flight capture coalescing keyed by pane id survives control-channel reconnects: include a connection/transport generation in the key or clear the pending map when the transport reconnects (find the reconnect hook in external-tmux-core / *-external-connection). Test: capture in flight → reconnect → new request does not reuse the old promise.
3. `snapshot-refresh-coordinator`: `requestImmediate()` during a quiet wait should upgrade that pending refresh to immediate (cancel the wait, run once) without also scheduling a trailing refresh; keep the trailing-run semantics for requests that arrive while a refresh is actually running. Test: structure request (quiet wait) then immediate ⇒ exactly one refresh.
Verify: `cd apps/gateway && bun test src/tmux-client`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/G8-result.md
