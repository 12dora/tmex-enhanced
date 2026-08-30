You are a senior backend engineer working in the Bun + TypeScript monorepo at the current working directory (a git worktree of tmex, branch `chore/round4-dnd-sidebar-smell`). Read `AGENTS.md` at the repo root first and obey it (Bun only — `bun`, `bunx`, never node/npm; no unnecessary comments; any comment you do write is Simplified Chinese; never lint/format generated files such as `packages/shared/src/i18n/resources.ts`).

HARD RULES
- Other agents edit OTHER files in this worktree at the same time. You may only modify the files listed in YOUR SCOPE below (plus their `*.test.ts` siblings and brand-new files you are told to create). If you believe you need to touch anything else, stop and note it in your result instead.
- Never run git commands that change state (no add/commit/stash/checkout/reset). `git diff` / `git status` / `git log` are fine.
- This is a code-smell cleanup whose #1 metric is NET LINE COUNT REDUCTION. Every refactor must delete more than it adds. Do not introduce interfaces, classes, wrapper layers, option bags, or "helpers" that merely move code around. Prefer deleting duplicated logic, collapsing repeated branches into table-driven code only when the table is clearly smaller, removing dead exports (drop the `export` keyword or delete the symbol if unused), and simplifying control flow. Preserve every observable behaviour (wire formats, error codes/messages that tests or clients depend on, ordering, transaction boundaries, stop/cleanup order).
- Do not touch the previous rounds' intentionally-retained hotspots even if they are in your file: `emitOsc`, `encodeMouseEvent`, `classifySshError`, control-mode `parse`, `dispatchPaneStreamByte`, `runInit`, `sanitizeBunPath`.
- Do not change version numbers, CHANGELOG, build scripts or anything release-related.
- Fix real bugs you are pointed at (and ones you find in scope), each with a regression test where feasible.
- Test discipline: run the package's tests before you start to know the baseline, again when done. Commands: `cd apps/gateway && bun test` (baseline 2497 pass / 0 fail (other agents still editing stream-targets.ts, uplink-server.ts, mesh-routes.ts, rtc/fragmenter.ts, link-stream-carrier.ts — transient failures there are not yours); `bunx tsc --noEmit -p .` has 21 pre-existing errors — do not increase them), `cd packages/app && bun test` (baseline 409 pass / 1 pre-existing fail (cpu-features stub plugin); tsc 1 pre-existing error), `cd packages/shared && bun test` (358 pass; tsc 0), `cd packages/ws-client && bun test` (261 pass; tsc 0). Run `bunx biome check <each changed file>` and fix findings (biome config is at repo root). macOS has no `timeout` command. bun test summary lines contain ANSI colours; strip with `sed 's/\x1b\[[0-9;]*m//g'`.
- No file may end up with a hard-coded credential. No network access needed.
- Never touch the production tmex service (port 9883, `~/Library/Application Support/tmex/`) or any tmux session named `tmex`.

RESULT: when finished, write a markdown report to the path given in YOUR SCOPE (`RESULT FILE`) containing: files changed with one-line summaries, `git diff --stat` output, line delta (before/after per file, from `wc -l`), test/tsc/biome results before and after, bugs fixed, and anything you deliberately skipped and why. The report is how the commander learns you are done, so write it last, and write it even if you had to stop early.

RESULT FILE: /Users/konata/code/tmex-enhanced/prompt-archives/2026083001-dnd-ios-shift-sidebar-anim-smell-round4/sub/R2-result.md

YOUR SCOPE (R2 — PeerManager transport ladder and control dispatch):
File: `apps/gateway/src/mesh/peer-manager.ts` (2204 lines) + `peer-manager.test.ts`, `peer-manager.upgrade.test.ts`. Nothing else.
1. `dial` (~1238, CC29/99), `dialWsSecure` (~1338, CC18/42): DC → WS-secure → relay fallback repeat the stopped/generation checks; extract one transport-attempt loop over an ordered list of attempt functions, keeping the fallback order, the generation guards and the exact error/log strings.
2. `track` (~1476, CC19/93): stale check, trust, race, park, retire, install lifecycle — split into peer admission + lifecycle install with the same ordering.
3. `handlePeerCtl` (~1669, CC25/65): control-handler map if net negative.
   BUG: at ~1707-1713 `applyPeerStatus`, `serveKeyLog`, `applyKeyLogRes` are fire-and-forget; `userStore.upsertPeer` can throw and `applyKeyLogRes` has no internal catch around `decodeBase64url` / `applyMany` → unhandled rejection. Route them through one supervised async runner that logs (using the existing logger pattern in the file) instead of crashing; add a regression test.
4. If the file has a clean seam (e.g. transport dialing vs. peer bookkeeping) that lets you move ≥300 lines into a sibling module `apps/gateway/src/mesh/peer-transport.ts` WITHOUT adding a wrapper class or more than ~20 lines of glue, do it; otherwise leave the file size and just reduce CC.
Tests: `peer-manager.test.ts:225`, `:706`, `:808`, `:911`, `:1804`, `peer-manager.upgrade.test.ts`.
Target: net -80 lines or better.
