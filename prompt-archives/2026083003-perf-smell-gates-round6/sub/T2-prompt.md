# Task T2
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

## T2 — mesh-runtime wiring split + IPv6 parser dedupe (S1 findings 4, 6)
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/S1-report.md` findings 4 and 6.
### Scope
apps/gateway/src/mesh/mesh-runtime.ts, apps/gateway/src/mesh/address-class.ts (+ tests, integration/wiring.test.ts if it needs updating). Nothing else in mesh/ (another agent edits forwarder/rtc/uplink-client/peer-manager).
### Items
1. Share one `parseIpv6Words()` in address-class.ts (zone-id normalisation inside), delete the copy in mesh-runtime.ts; split `isAdvertisablePeerAddress` into IPv4/IPv6 predicates (CC ≤ 6 each). Malformed-address semantics unchanged (tests).
2. Split `constructMeshDeps` (201 lines) and `wireMeshEventsAndSessions` (317 lines, `onNodeList` CC 30) into the named functions the report proposes (`createMeshStoresAndServices`, `createSessionBindings`, `createUplinkWiring`, `handleUplinkNodeList`, `pruneStaleListedPeers`, `createPeerWiring`, `createRtcBrowserWiring`), staying in the same file, keeping the mutable holders that break the cycles and the exact initialization order. Every resulting function ≤ 120 lines and CC ≤ 15. Net lines ≤ +10.
Verify: `cd apps/gateway && bun test src/mesh/mesh-runtime.test.ts src/mesh/mesh-runtime-node-presence.test.ts src/mesh/integration src/mesh/address-class.test.ts` then `bun test src/mesh` (rerun individual files on EADDRINUSE), tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/T2-result.md
