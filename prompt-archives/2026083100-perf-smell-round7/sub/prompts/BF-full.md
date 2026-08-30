# Shared rules (read carefully)

You are a backend engineer in the tmex monorepo worktree /Users/konata/code/tmex-enhanced-wt-r7 (Bun runtime; the gateway runs ONLY on Bun, not Node). Several other agents work in the SAME worktree in parallel — modify ONLY files inside your declared scope; if a fix seems to require touching a file outside your scope, note it in your report instead of editing.

Rules:
- NO git commands whatsoever (no add/commit/stash/checkout). The commander commits.
- Code comments in Simplified Chinese, and only where logic is non-obvious.
- Keep functions under CC 15 / 120 lines, files under 900 lines (a complexity gate runs in `bun run lint`; scripts/complexity/allowlist.json locks current values — if you reduce complexity of an allowlisted file, do NOT edit the allowlist, the commander handles it).
- Verify the exploration claims yourself by reading the code BEFORE changing anything. If a claim is wrong or the fix is not worth the risk, say so in your report with reasons instead of forcing a change.
- Every behavior change needs unit tests (extend existing test files next to the code). No benchmarks unless asked.
- Verification before you finish: `cd apps/gateway && bun test` must be 2800+ pass / 0 fail (baseline 2800). `bunx tsc --noEmit -p .` in apps/gateway has 21 PRE-EXISTING errors — do not add new ones. If you touch packages/shared: `cd packages/shared && bun test` baseline 376 pass / 0 fail, tsc 0 errors. Run `bunx biome check <changed files>`.
- macOS has no `timeout` command. bun test summary lines contain ANSI colors — strip with `sed 's/\x1b\[[0-9;]*m//g'` before grepping. Never put `grep -c` inside a `&&` chain (returns exit 1 on zero matches).
- When done, write a result report in Simplified Chinese (claim verification, what changed, design decisions, risks, test counts before/after) to the absolute path given in your task, then exit. Writing the result file is the LAST thing you do.
# Task BF: eliminate double decode + full copy on the remote mesh WS inbound path

NOTE: you are the ONLY agent running in apps/gateway right now — but line numbers below were taken before recent edits landed; re-locate the code by symbol, not by line.

## [perf] Every browser frame forwarded over mesh is envelope-decoded twice and fully copied once
Evidence (re-verify): apps/gateway/src/mesh/stream-targets.ts (around the attached-stream inbound handler, previously :523-548) calls `wsBorsh.decodeEnvelope` to validate, then hands the RAW bytes to `attached.onMessage`; the WS layer then does `Buffer.from(bytes)` (apps/gateway/src/ws/index.ts, previously :204-209) and calls `decodeEnvelope` AGAIN (previously :216-279). packages/shared/src/ws-borsh/codec.ts already has a view-based decode entry (previously :61-110).

Fix: thread the already-decoded envelope through — e.g. an internal `handleDecodedEnvelope(session, envelope, rawBytes?)` entry in ws/index.ts that the mesh attach path calls with its validated decode result, while the normal browser WS path keeps its current entry. Only copy bytes where something genuinely holds them beyond the synchronous dispatch (trace the consumers: pane input, control messages — check each handler for async retention). Be careful with mux/stream buffer reuse: if the underlying receive buffer is recycled after the handler returns, any handler that retains bytes must copy at that retention point.

Add tests: mesh-forwarded frame decoded exactly once (spy on decodeEnvelope), payload correctness for large frames, an async-retaining handler still sees stable bytes.

## Scope
apps/gateway/src/mesh/stream-targets.ts, apps/gateway/src/ws/index.ts (+ their tests); packages/shared/src/ws-borsh/codec.ts only if a small entry must be added (keep wire format identical; shared baseline bun test 384/0, tsc 0). Current gateway baseline: bun test 2842 pass / 0 fail; tsc 21 pre-existing errors.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BF-result.md
