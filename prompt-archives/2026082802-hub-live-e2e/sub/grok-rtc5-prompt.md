## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: RTC round 5 — complete the handshake → Link handoff (final-review blocker)

Scope: `apps/gateway/src/mesh/rtc/dc-handshake.ts`, `apps/gateway/src/mesh/rtc/data-channel-link.ts`, `apps/gateway/src/mesh/rtc/channel-fanout.ts`, `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts`, their tests, `apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts`. Others are editing `forwarder.ts`/`mesh-http.ts`, `hub/**`, `peer-manager.ts`, `mesh-routes.ts` — don't touch.

Read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-final.md` §7 (two deterministic failures reproduced by the reviewer):
(a) one side finishes the handshake and installs `DataChannelLink`; the other side is still retransmitting JSON `hello` every 40 ms; the late `hello` reaches the Link's reassembler, is treated as a fragment → `fragment-protocol` → healthy DC closed.
(b) one side finishes and immediately sends a normal LinkMux DATA > 4 KiB; the other side, still in handshake, rejects it with `dc handshake message too large` (and the handshake queue cap of 8 rejects normal bursts).

Design a clean handoff and implement it: e.g. tag handshake messages unambiguously (JSON text frames vs binary link frames is already a distinguishing property — make the Link ignore/route text/handshake-typed messages to a tolerant handler until both sides have confirmed completion), add an explicit final `done` ack so neither side sends LinkMux frames before the peer has acknowledged, stop `hello` retransmission on first `sig`, and remove the size/count limits for non-handshake frames during the window (buffer them byte-bounded like the fanout does, never reject). Add tests for exactly (a) and (b), plus the earlier "delayed sig then immediate OPEN" case; keep the reviewer's reproductions as tests (`linkClosedReason`/`channelOpen` assertions). Also (nit) make the revoked integration case use a third node that was online then revoked while its uplink is still alive, if it can be done in < 1 h; otherwise skip and say so.

Verification: `cd apps/gateway && bun test src/mesh/rtc src/mesh/integration/rtc-wake.integration.test.ts` then `bun test src/mesh` 0 fail; tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-rtc5-result.md`
