# Task G3
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

## G3 — Gateway mesh/hub: pre-encode node.list broadcast, O(1) peer lookup, deadline timers instead of polling
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/X3-report.md` items 4, 5, 6 (authoritative; verify in code).
### Scope
apps/gateway/src/hub/uplink-server.ts (+ tests), apps/gateway/src/mesh/peer-manager.ts (+ tests), apps/gateway/src/auth/user-store.ts (add `getPeer(nodeId)` only), packages/shared/src/uplink/codec.ts ONLY if a byte-level send helper needs an exported encode function that already exists (do not change wire format).
### Items
1. `broadcastNodeList()`: encode once, send bytes to every link; keep per-link error handling. Also skip the broadcast when the projected list is deep-equal to the last broadcast (cheap: compare the encoded bytes/string). Test: N links → encode called once; unchanged list → no send.
2. `handlePeerCtl` node.status: replace `listPeers().find()` with `getPeer(nodeId)` (primary key); only upsert the projection when normalized endpoint/inventory/capability fields changed; keep `lastSeenAt` semantics (if lastSeenAt must be persisted each time, do it with a narrow update). Tests for changed vs unchanged.
3. Idle / parked / retiring peer polling (1 s × 300, 250 ms × 120): replace with one-shot deadline timers re-armed on the relevant events (stream activity change, stream close, quiesce ack) while preserving the 2 s quiet / 5 s min / 30 s max rules exactly. Existing peer-manager tests are authoritative; add tests with fake timers for the three lifecycles. If a lifecycle genuinely cannot be made event-driven without a large rewrite, keep the poll but raise its interval and explain in the result.
Measure item 1 with 100 links (ms before/after). Verify: `cd apps/gateway && bun test src/hub src/mesh src/auth` (rerun peer-manager alone on EADDRINUSE), tsc ≤ 21.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/G3-result.md
