# Task T5
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

## T5 — tmux-client: shared control-channel reconnect policy (S2 finding 1)
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/S2-report.md` finding 1.
### Scope
apps/gateway/src/tmux-client/local-external-connection.ts, ssh-external-connection.ts, a new small shared module under apps/gateway/src/tmux-client/ (+ tests). Nothing else.
### Items
Extract the common recovery policy (stable-window reset, restart counting, stderr-tail capture, restart delay, connection guards, has-session probe, session-gone handling, control-client restart, snapshot resync, active-pane history capture) into one `reconnectControlChannel(policy, adapter)`; local-only EAGAIN/EMFILE retry and the distinct fatal notifications stay adapter-specific. Behaviour of both paths byte-for-byte identical (their existing tests are authoritative). Net lines negative; local `reconnectControlClient` CC ≤ 6.
Note: the previous round explicitly rejected merging the two connections' reconnect *flows* wholesale — this task is only the shared policy helper with adapter callbacks; if you find the two flows differ in ordering in a way the helper cannot express without flags, STOP, revert, and explain.
Also (from Z2-report.md, LOW): the legacy history rolling tail in local-external-connection.ts `readTextWithByteLimit` trims raw bytes mid UTF-8 sequence (a truncated Euro sign decodes to two U+FFFD). Discard leading continuation bytes from the retained tail before decoding (or keep a streaming TextDecoder); test with a multibyte char at the boundary. Apply the same to the SSH tail buffer.

Verify: `cd apps/gateway && bun test src/tmux-client`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/T5-result.md
