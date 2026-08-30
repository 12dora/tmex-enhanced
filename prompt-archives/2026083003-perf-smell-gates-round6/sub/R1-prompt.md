# Task R1
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

## R1 — Gateway files: bounded streaming uploads, no-copy raw reads, bounded rsync list parsing
Read `prompt-archives/2026083003-perf-smell-gates-round6/sub/Y2-report.md` items 1, 5, 9 (verify in code first).
### Scope
apps/gateway/src/api/file-transfer-routes.ts, apps/gateway/src/api/file-browser-routes.ts, apps/gateway/src/files/transfer-session.ts, apps/gateway/src/files/device-storage.ts, apps/gateway/src/files/rsync.ts (+ tests). Do NOT touch tmux-client/**, watch/**, api/device-routes.ts, api/tmux-tree.ts, hub/**, mesh/** (other agents).
### Items
1. Upload chunk: enforce `Content-Length` ≤ advertised chunk size and ≤ remaining declared size BEFORE reading; consume `req.body` incrementally with a hard byte cap (abort + 413 when exceeded); write with an async file handle / `Bun.file().writer()` instead of `appendFileSync`; advance `received` only after the write resolves. Tests: oversize content-length → 413 without reading; body longer than header → rejected and session unchanged; happy path unchanged.
2. Raw remote file read: drop the second `Uint8Array` copy (return the buffer as-is) and, if the existing temp-file streaming helper fits cleanly, stream via it; keep content headers and cleanup on cancel. Test.
3. rsync list-only parsing: stream stdout line by line and retain only the entries that can appear in the returned page (MAX_ENTRIES + 1 under the existing sort: directories first, then name) so memory is proportional to the page; kill the rsync process once the result cannot change if that is simple, otherwise skip. Test with 200k synthetic lines: same output as before, bounded retained entries. Report ms/RSS before/after.
Verify: `cd apps/gateway && bun test src/files src/api`, tsc ≤ 21, biome.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r6/prompt-archives/2026083003-perf-smell-gates-round6/sub/R1-result.md
