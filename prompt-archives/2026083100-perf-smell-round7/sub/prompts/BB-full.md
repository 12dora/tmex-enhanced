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
# Task BB: canonical feed — zero-copy segments, chunking cost, attach race

## 1. [perf] PaneData/screen/history segments are copied with .slice() before Borsh serialization copies them again
Evidence: apps/gateway/src/ws/canonical/pane-stream.ts:177 (segment.data.slice per chunk), apps/gateway/src/ws/canonical/transaction-sender.ts:55,59 (same for screen/history), then ws/index.ts:341 → ws/borsh/codec-borsh.ts:69 serializes the payload into the final frame (packages/shared/src/ws-borsh/canonical-state.ts:338). Frame cap is 32 KiB (canonical-state.ts:13) so large segments become many chunks, each double-copied.

Fix: use subarray views instead of slice, AFTER verifying the underlying buffer is not mutated/reused before the synchronous sendEvent/serialize completes (trace the producer of segment.data). If any consumer holds bytes asynchronously, keep a copy only there. Add/adjust tests proving payload bytes are correct and that a mutation of the source after send does not corrupt already-serialized frames (or document why the buffer is never reused).

## 2. [perf] Metadata snapshot chunking: candidate-array copy + full size rescan per record, recomputed on every congested resend
Evidence: apps/gateway/src/ws/canonical/transaction-sender.ts:148 (full metadata snapshot per send), :184 (candidate = [...current, record] per record), :196 (eventFits recomputes full size), apps/gateway/src/ws/canonical/encoded-size.ts:52,198 (full vector walks); oversized-patch and drain-retry paths resend snapshots (apps/gateway/src/ws/canonical-feed-session.ts:177,189,258). ~1000 records ≈ 23ms, 5000 ≈ 100ms per attempt.

Fix: (a) accumulate record byte sizes incrementally (add a per-record size helper next to encoded-size) instead of copying candidate arrays and re-measuring; (b) cache the chunking result keyed by (metadataEpoch/revision, maxFrameBytes) so congested resends reuse it; (c) coalesce duplicate rebase requests while metadataNeedsRebase is already set. Preserve exact frame-size semantics (chunk must still fit), snapshot ID and chunk-count behavior. Add tests: chunk boundaries identical to old algorithm on varied record sizes; cache invalidated on revision change; duplicate rebase coalesced.

## 3. [bug] Concurrent canonical attachDevice leaks the losing consumer/listener
Evidence: apps/gateway/src/ws/index.ts:279 dispatches inbound frames without per-session serialization; canonical-kind-handlers.ts:13 awaits the command; canonical-feed-session.ts:161 checks existing device then :164 awaits resolveRuntime — two concurrent attaches for the same deviceId both pass the check, both create lease+listener, and :206 overwrites this.devices, leaking the loser (double PaneData fan-out until disconnect).

Fix: per-deviceId in-flight attach promise (second caller awaits the first) plus a re-check after await; a losing racer must close its lease and remove its listener. Handle attach failure and session close during attach. Add tests: concurrent attach same device → one consumer; failure path cleans up.

## Scope (only these)
apps/gateway/src/ws/** (canonical/**, canonical-feed-session.ts, canonical-kind-handlers.ts, index.ts, borsh/**) and packages/shared/src/ws-borsh/** if a view-based serializer entry is needed; plus test files. Do NOT touch apps/gateway/src/mesh/**, hub/**, agent/**, tmux-client/**. NOTE: another agent owns apps/gateway/src/mesh/stream-targets.ts which calls into ws/index.ts attachExternal handlers — do not change any exported signature of ws/index.ts used by mesh code.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BB-result.md
