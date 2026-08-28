## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: fix review round-2 findings on the RTC wake / fanout change (commit 93a09db)

Scope: `apps/gateway/src/mesh/peer-manager.ts` (+test), `apps/gateway/src/mesh/rtc/**`, `apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts`. Another agent is concurrently editing `packages/app/src/commands/hub.ts` and gateway auth/user-store files — do not touch those, nor `mesh-runtime.ts`/`mesh-routes.ts`/`scripts/**`.

Read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-rtc2.md` fully. Fix findings 1–5 and, if cheap, 6:
1. **Blocker – fanout handoff race.** Between `handshakeDataChannel()` finishing on one side and `DataChannelLink` being constructed, incoming messages must be buffered (not dropped, not fed to the stopped handshake parser) and a close/error that occurs in that window must be delivered to the later-registered link listener (or the link must be constructed already-closed and `getLink()` must fail/retry rather than hand out a dead link). Implement a proper handoff: the handshake listener detaches itself on completion; the fanout keeps buffering messages while no data listener is attached and replays them in order to the first attached listener; it records terminal close/error and replays it to late subscribers. Add tests reproducing the reviewer's scenario (peer A finishes handshake and immediately sends a LinkMux frame before B attaches its link; and close during the window) — the reviewer's repro gave `{linkMessages:0, linkClosed:0, isOpen:false}`.
2. Receiver-side cost/cooldown: apply the per-peer cooldown BEFORE signature verification (cheap check first), and do not clear the incoming cooldown on `dropPeer()` (keep a short minimum interval after a DC churn); bound the work a compromised hub can force per peer per second.
3. Replay cache per peer, keyed by (from, nonce), entries retained for the full validity window (issued_at ± 60s) and pruned by time, not a global 256-entry FIFO; bound per-peer entries too.
4. Nonce must be canonical base64url of exactly 16 bytes; reject otherwise before caching.
5. `maskIceAddress`: expand `::` correctly before taking the first three hextets (fix `[2001:db8::dead:beef]:3478 → [2001:db8::]:3478`, `2001:db8::1 → 2001:db8::`, `::1 → ::` semantics — define expected outputs in tests and make them consistent: mask to the /48 with zeroed remainder).
6. (nit) Route the revoked-node case of the integration test through the real hub path if feasible.

Verification: `cd apps/gateway && bun test src/mesh` 0 fail; full `bun test` 0 fail (baseline 2336+); tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-rtc3-result.md`
