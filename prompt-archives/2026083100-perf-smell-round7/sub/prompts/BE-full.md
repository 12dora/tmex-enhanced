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
# Task BE: hub uplink-server — key-log paging O(n²) + node.list broadcast ordering

## 1. [perf] key-log response paging re-encodes the whole page per shrink step
Evidence: apps/gateway/src/hub/uplink-server.ts:649-679 shrinks the page one record at a time, calling encodeUplinkCtl each iteration; the codec re-Base64s every record each time (packages/shared/src/uplink/codec.ts:453-465; base64 impl packages/shared/src/auth/encoding.ts:398-415). Hundreds of records → hundreds of full encodes, plus a final full encode.

Fix: build wire records once, size them cumulatively (or binary-search the max prefix using cached per-record encoded sizes + framing overhead), serialize exactly once at the end. Byte-size limit semantics and has_more/pagination boundaries must be exactly preserved — add a test that compares chosen prefix vs the old algorithm across varied record sizes (including single oversized record).

## 2. [bug] node.list broadcast can deliver stale topology with a newer version
Evidence: apps/gateway/src/hub/uplink-server.ts:293-317 builds node.list asynchronously, THEN bumps listVersion, updates fingerprint and sends; concurrent triggers (:626, :987) mean an older build can finish after a newer one, overwrite the cache with stale topology under a higher version, and clients suppress subsequent updates via version watermark.

Fix: serialize/coalesce broadcasts per userId (a generation counter bound at build start; discard results whose generation is stale; if a trigger arrives during a build, run one trailing rebuild). Add tests: interleaved slow/fast builds → final state is the newest topology with monotonically increasing version; burst of triggers → bounded rebuilds.

## Scope (only these)
apps/gateway/src/hub/** and its tests; packages/shared/src/uplink/codec.ts ONLY if a per-record size helper must live next to the codec (keep wire format identical; shared baseline: bun test 376/0, tsc 0). Do NOT touch apps/gateway/src/mesh/**, ws/**, agent/**, tmux-client/**.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BE-result.md
