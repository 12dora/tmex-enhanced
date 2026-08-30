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
# Task BA: agent persistence batching + ws-hub subscription leak

## 1. [perf] Agent step boundary writes SQLite one row at a time
Evidence: apps/gateway/src/agent/run.ts:216 (per-message appendAgentMessage), run.ts:319 (persistNewMessages per step), apps/gateway/src/agent/step-persister.ts:6 (per-message loop), apps/gateway/src/db/agent.ts:225 (sync .insert().returning().get() per message) and :230 (a max(seq) subquery per record). bun:sqlite is synchronous — tool-heavy turns produce dozens of messages, each blocking the event loop.

Fix: add a batched `appendAgentMessages(sessionId, messages)` in db/agent.ts that runs ONE transaction: read max(seq) once, assign sequential seqs, batch insert, return records. Use it from step-persister/run so a step boundary persists all new messages in one transaction; broadcast persisted events only after commit. Preserve: message ordering, seq allocation semantics under concurrent sessions, crash-recovery behavior, and the existing single-message API for callers that legitimately append one message. Add tests: batch seq assignment, ordering, empty batch no-op, interleaving with single appends.

## 2. [bug] Subscriptions to nonexistent agent sessions leak forever
Evidence: apps/gateway/src/agent/ws-hub.ts:60 (sessionId -> Set<GatewaySession>), :85 (subscription recorded BEFORE sync), :95 (nonexistent session returns without cleanup), :98 (exception path no cleanup either). Clients can spam random session IDs → unbounded Map/Set growth; disconnect scan at :75 walks all of it.

Fix: validate/sync the session first and only then commit the subscription (or roll back on null/exception). Add a per-client subscription count cap and a sane sessionId length guard (reject absurd ones). Add tests: nonexistent session leaves no entry, exception path leaves no entry, cap enforced.

## Scope (only these)
apps/gateway/src/agent/** and apps/gateway/src/db/agent.ts, plus their test files. Do NOT touch apps/gateway/src/ws/**, mesh/**, hub/**, tmux-client/**.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BA-result.md
