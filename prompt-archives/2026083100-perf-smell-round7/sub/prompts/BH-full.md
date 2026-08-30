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
# Task BH: apply four code-review findings (gateway)

A reviewer flagged these on freshly-landed code. Verify each against the current code; if you conclude one is wrong, say so in your report instead of forcing it. Current gateway baseline: bun test 2842 pass / 0 fail; tsc 21 pre-existing errors. NOTE: another agent is concurrently editing apps/gateway/src/mesh/stream-targets.ts and apps/gateway/src/ws/index.ts — do NOT touch those two files.

## 1. [P1] apps/gateway/src/mesh/mesh-runtime.ts:1129 — node-only `publishAndAck()` triggers the key-log-head status refresh right after the hub ACK, but the LOCAL `keyLogService.apply()` happens later (see auth-routes.ts:456-475). If local verify/persist takes >100ms (the debounce), the broadcast reads the OLD head and there is no second notification — direct peers miss the new key_log_head. Fix: move/also fire the notify after the local apply succeeds (make sure the hub-ack path and local-apply path together produce exactly one up-to-date notification; keep the debounce).

## 2. [P1] apps/gateway/src/db/agent.ts:256 — batch insert returns `.returning().all()` and callers broadcast in that array order, but SQLite does not guarantee RETURNING row order. Fix: sort the returned records by seq ascending (or restore input order via pre-assigned ids) before returning. Add a test asserting ascending seq order of the returned array.

## 3. [P1] apps/gateway/src/agent/ws-hub.ts:97-108 — when sync throws, the catch unconditionally `unsubscribe()`s, which can delete a PREVIOUSLY-valid subscription (e.g. a re-sync of an existing subscription fails, or two concurrent subscribes race) → permanent silent event loss. Fix: only roll back a registration that THIS call newly created (track was-newly-added before sync; on failure remove only if still present AND newly added by this call). Add tests: failing re-sync keeps the existing subscription; concurrent subscribe + one failure keeps the other's registration.

## 4. [P2] apps/gateway/src/db/agent.ts:219-260 — single-message `appendAgentMessage` now pays BEGIN/SELECT max/INSERT/COMMIT. Restore a single-row fast path (the original atomic insert with max(seq)+1 subquery) while batches >1 keep the transaction. Keep seq semantics identical.

## Scope (only these)
apps/gateway/src/mesh/mesh-runtime.ts (+ auth-routes.ts ONLY if the notify hook must live there), apps/gateway/src/db/agent.ts, apps/gateway/src/agent/ws-hub.ts, and their test files. Do NOT touch stream-targets.ts, ws/index.ts, hub/**, tmux-client/**.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BH-result.md
