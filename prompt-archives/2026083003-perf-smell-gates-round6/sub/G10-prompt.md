# Task G10
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

Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/review-be3-report.md` (verify each finding in code before changing).
## G10 — Fix be3 findings: rsync tie-breaker & test premise, UTF-8 trailing trim, strengthened tests
### Scope
apps/gateway/src/files/rsync.ts (+ test), apps/gateway/src/tmux-client/local-external-connection.ts (+ test) and ssh-external-connection.ts if the shared decoder lives there / reconnect-control-channel.ts NOT in scope, apps/gateway/src/mesh/uplink-key-log-sync.test.ts, apps/gateway/src/mesh/forwarder.test.ts, apps/gateway/src/mesh/peer-handshake-timeout.test.ts (or .ts if a seam is needed). Nothing else.
### Items
1. rsync bounded collector: add an input-sequence number as the FINAL comparator tie-breaker so collator-equal names (`file1`/`File1`/`FILE1`) keep input order at truncation boundaries; test. Also: the truncation semantics intentionally changed from "first MAX_ENTRIES rsync entries then sort" to "globally sorted first MAX_ENTRIES" — keep the new semantics, but rewrite the test name/comment at rsync.test.ts:217 to state explicitly this is the NEW intended contract (not old-behaviour compatibility), in Chinese per repo comment style.
2. UTF-8 tail decode (`decodeRollingTail`): also trim an incomplete TRAILING sequence (overflow can cut after a lead byte) — a retained tail ending in a dangling lead/continuation prefix must not decode to U+FFFD; use byte-level scan back ≤3 bytes (or a streaming TextDecoder with {stream:true} semantics). Extend tests: cut after lead byte, cut mid-3-byte, cut mid-4-byte, both head and tail cases; SSH path shares the helper.
3. `uplink-key-log-sync.test.ts` stale-generation test: block inside `applyMany()` (not `head()`), reset + advance generation while blocked, then resolve with a fork result; assert no fork callback and no teardown fire.
4. `forwarder.test.ts` TTL test: assert the stream SURVIVES past the old 15 s boundary and EXPIRES after the configured TTL (scaled/fake timers), so a regression to the old constant or an ignored setter fails.
5. `peer-handshake-timeout`: inject/spy clearTimeout (a `timers` seam parameter with default) and assert cleanup on both resolve and reject paths.
Verify: `cd apps/gateway && bun test src/files src/tmux-client src/mesh`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/G10-result.md
