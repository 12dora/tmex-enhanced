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
# Task BG: ws-client silently drops messages past 100 pending during reconnect

NOTE: you are the ONLY agent in packages/ws-client. Line refs may have drifted — locate by symbol.

## [bug] Messages beyond maxPendingMessages=100 are silently lost while the socket is not ready
Evidence (re-verify): packages/ws-client/src/client.ts (previously :131-134) `maxPendingMessages = 100`; the not-ready send path (previously :392-404) buffers up to 100 then returns `false` while a doc comment claims callers need not resend; queue flush previously :445-450. During HELLO/reconnect, a large paste (chunked terminal input) beyond 100 frames is silently dropped mid-stream — corrupting the input sequence.

Fix design (keep the public API source-compatible; you may extend types in packages/ws-client/src/transport-types.ts):
1. Switch the pending buffer to a byte budget (e.g. 2 MiB) + generous frame cap (e.g. 2048) — big enough for real pastes, still bounded.
2. Make overflow explicit: return a distinguishable result (e.g. extend the send return type with an enum/status or add a dedicated method) so callers can tell 'queued' from 'dropped-overflow', and emit a client event/log once per overflow episode.
3. On overflow of ordered input, prefer dropping the WHOLE pending sequence for that logical purpose over silently losing the middle — study what kinds of messages are actually sent while not-ready (grep in-repo callers: packages/stores, apps/fe, terminal input path) and pick the semantics that cannot corrupt an input stream; justify in the report.
4. Fix the misleading comment.
5. Update in-repo callers ONLY where they must react to the new status (keep changes minimal).

Add tests: byte budget enforcement, overflow surfaces status + event, flush order preserved, no regression for the normal small-queue path.

## Scope
packages/ws-client/src/** (+tests); minimal caller adjustments in packages/stores/src or apps/fe/src ONLY if required to consume the new status (list them in the report). Baselines: ws-client bun test 268/0 tsc 0; stores 357/0 tsc 1 pre-existing; fe (bun test src/) 903/0 tsc 0.

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BG-result.md
