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
# Task BD: mesh — forwarder queue bound, duplicate persist, key_log_head staleness, ignored send promises

## 1. [perf] Forwarder failover queue is unbounded
Evidence: apps/gateway/src/mesh/forwarder.ts:156-167 pushes `bytes.slice()` per frame while failingOver/no-stream (queue defined :72-90); failover can retry for seconds (forwarder.ts:296-320, 377-415; backoff config mesh/mesh-deps.ts:14-18). Large pastes during an outage can accumulate many MiB.

Fix: add byte + frame caps to the pump queue. On overflow, fail cleanly (close the logical connection / surface an error to the browser side) rather than silently dropping arbitrary frames — decide the policy from how the pump's consumer handles stream close today, and document it. Add tests: cap enforced, overflow policy, normal failover replay unaffected under the cap.

## 2. [perf] node.list catch-up persists all peers twice
Evidence: apps/gateway/src/mesh/uplink-key-log-sync.ts:158-183 calls persistList then emitNodeList after catch-up; both callbacks in apps/gateway/src/mesh/uplink-client.ts:555-589 run persistAdmittedPeers → every accepted node.list does cert queries + DB upserts twice.

Fix: make it one persist + one publish per accepted list (e.g. emitNodeList only notifies). Check consumers for reliance on persisted state before catch-up completes. Add/adjust tests counting persist calls.

## 3. [bug] Local key-log appends never trigger a key_log_head status broadcast
Evidence: apps/gateway/src/mesh/peer-manager.ts:403-409, 615-619 periodic refresh; :1838-1865 compares statusProvider() JSON and returns early when unchanged, and only attaches key_log_head when it decides to send; UplinkStatus (mesh/types.ts:15-21) has no key-log head. So new key-log records don't propagate until reconnect/other change.

Fix: include the key-log head (seq/hash) in the change-detection key, or trigger a status send on key-log append — with debouncing so append bursts don't spam broadcasts. Add tests: append → broadcast with new head; burst coalesced; unchanged status still skipped.

## 4. [bug] send() promises ignored → unhandled rejections and silent frame loss on close
Evidence: mesh/mesh-deps.ts:97-103 declares send as void-returning; the real impl returns stream.write's promise (mesh/stream-targets.ts:554-583) which can reject (packages/shared/src/link/mux.ts:135-145); mesh/mesh-runtime.ts:415-450 does `void opened.send(bytes)`; forwarder.ts:156-167, 377-415 also ignore results.

Fix: make the send contract Promise<void> end-to-end within mesh/**, catch rejections centrally in the forward pump, and route failures into the existing failover/close state machine (careful: no double-close or races with the current failover logic — read it first). Add tests: rejected write triggers failover once, no unhandled rejection.

## Scope (only these)
apps/gateway/src/mesh/** and its tests. Do NOT touch apps/gateway/src/ws/**, hub/**, agent/**, tmux-client/**, packages/shared/** (if the mux typing in packages/shared/src/link/mux.ts needs a comment/typing tweak, report it instead of editing). Do not change exported interfaces consumed outside mesh/** without noting it prominently in your report.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BD-result.md
