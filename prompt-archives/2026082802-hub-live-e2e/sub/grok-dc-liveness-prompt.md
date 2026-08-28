## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: DataChannel liveness — detect a dead direct link in ≤ ~10 s and fall back, instead of waiting ~35 s for ICE

Scope: `apps/gateway/src/mesh/rtc/**` (data-channel-link, data-channel-carrier, fragmenter/protocol if a ping frame type is needed, rtc-peer-manager), `apps/gateway/src/mesh/peer-manager.ts` (+tests), `apps/gateway/src/mesh/link-stream-carrier.ts` only if needed, `docs/hub/2026082800-hub-node-operations.md` (直连 section). Another agent is editing `apps/gateway/src/hub/**` and auth code — don't touch those. Do NOT run docker.

Live measurement today (split harness, node-a ↔ hub over TURN, real `transport=dc`): after dropping all UDP on node-a with iptables, node-datachannel only reported `peer state=disconnected` → `closed` **~35 s** later; until then `/api/mesh/nodes` kept `transport=dc` and streams stayed on the dead channel. For a terminal this is far too long: the design requires "直连断开时切回 primary" promptly and the harness asserts fallback to relay within 30 s.

Implement an application-level liveness check on the node↔node DataChannel link (and, if it shares the same code path, the browser `sess` carrier — check `data-channel-carrier.ts`): a lightweight ping/pong control frame every `RTC_LIVENESS_INTERVAL_MS` (default 3000) when the channel is idle, declare the link dead after `RTC_LIVENESS_TIMEOUT_MS` (default 10000) without any inbound traffic, then close the DataChannel/PeerConnection, mark transport as fallen back (existing carrier-switch / getLink fallback path), and log `[mesh][rtc] liveness timeout peer=… idle_ms=…`. Inbound data of any kind resets the timer (don't add ping load on busy channels). Make the constants env-overridable via the existing config pattern (grep how `PEER_RTC_WAKE_COOLDOWN_MS` or similar constants are defined) and keep unit tests deterministic with the fake scheduler (`rtc/test-fakes.ts`). Verify with an in-process test: two PeerManagers on dc; silence one side's channel (fake transport drops frames); the other side must observe `transportOf(peer) !== 'dc'` within timeout+interval and re-dial/relay per existing logic. Also make sure the reconnect path after liveness close respects the existing wake cooldown so it doesn't storm.

Verification: `cd apps/gateway && bun test src/mesh` 0 fail; full `bun test` 0 fail (baseline 2351+); tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-dc-liveness-result.md`
