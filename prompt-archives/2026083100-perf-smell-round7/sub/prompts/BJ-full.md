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
# Task BJ: RTC inbound unification + four small cleanups

Verify every claim before changing. Gateway baseline: bun test 2854/0, tsc 21 pre-existing. shared baseline: 387/0, tsc 0.

## 1. [MED] RTC inbound still double-decodes WS envelopes
apps/gateway/src/mesh/mesh-runtime.ts:702-706 `deliverInbound` copies RTC bytes then calls `gateway.wsServer.handleMessage`, which re-does magic check + envelope decode (ws/index.ts:224-261). The mux/WS stream path was just unified via `onDecodedEnvelope`/`handleDecodedEnvelope` (see stream-targets.ts:533-548 and ws/index.ts). Align the RTC path: decode once at the RTC entry (reuse the same validation used by stream-targets) and dispatch through the unified decoded-envelope entry. Preserve the current invalid-frame error behavior of the RTC path exactly (read what happens today on bad frames), and keep payload-ownership rules: if the RTC buffer's lifetime beyond the handler isn't guaranteed, keep a copy at retention points (the owned-buffer heuristic in ws/index.ts may treat a view as owned — check offsets). Add tests: RTC frame decoded exactly once; invalid RTC envelope behaves as before; async-retaining handler sees stable bytes.

## 2. [LOW] stream-replay-state repeats decodeEnvelope try/catch 4×
apps/gateway/src/mesh/stream-replay-state.ts:28-34, 94-100, 166-172, 244-252 — add a private `tryDecodeEnvelope(bytes): Envelope | null` and reuse; keep each call site's distinct fallback behavior (especially `rewriteQueuedFrame` returning original bytes on bad frames — keep a test for that).

## 3. [LOW] external cloudflared detector dead API + duplicated projection
apps/gateway/src/tunnel/external-detect.ts — delete uncalled `detectExternalCloudflared` (:90-95), the module-level cache + `resetExternalDetectCache` (:58-66), and reconcile `toExternalStatus` (:672-682, uncalled) with apps/gateway/src/tunnel/manager.ts:608-620's duplicate `externalStatus` and the duplicated `EMPTY_EXTERNAL` (:106-120): keep exactly ONE projection implementation used by the manager. Verify no other callers (gateway is not a published package). Keep the class's per-instance cache + invalidate tests.

## 4. [LOW] Uncalled shared export `decodeEnvelopeAndPayload`
packages/shared/src/ws-borsh/codec.ts:158-171 + index.ts:254 re-export — verify zero importers in the monorepo (packages/shared is workspace-private, not published) and delete both.

## 5. [LOW] access-rules legacy names only exist as aliases
apps/gateway/src/tunnel/access-rules.ts:54-86 — repo only uses `toCloudflareInclude`/`fromCloudflareInclude`; make the old `rulesToCfInclude`/`rulesFromCfInclude` non-exported (or fold into single exports). Verify no importers first.

## Scope (only these)
apps/gateway/src/mesh/mesh-runtime.ts, apps/gateway/src/ws/index.ts (minimal — reuse the existing decoded entry, don't restructure), apps/gateway/src/mesh/stream-replay-state.ts, apps/gateway/src/tunnel/external-detect.ts, apps/gateway/src/tunnel/manager.ts, apps/gateway/src/tunnel/access-rules.ts, packages/shared/src/ws-borsh/codec.ts + index.ts; plus their tests. Do NOT touch apps/gateway/src/config.ts, mesh/mesh-deps.ts, packages/app/**, packages/shared/src/roles* (another agent owns them).

Report to: /Users/konata/code/tmex-enhanced-wt-r7/prompt-archives/2026083100-perf-smell-round7/sub/BJ-result.md
