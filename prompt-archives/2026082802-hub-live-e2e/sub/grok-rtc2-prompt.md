## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: fix the code-review findings on the RTC wake / transport / diagnostics change (commit e2facea)

Scope: `apps/gateway/src/mesh/peer-manager.ts` (+test), `apps/gateway/src/mesh/rtc/**`, `apps/gateway/src/mesh/uplink-protocol.ts`, `apps/gateway/src/mesh/uplink-client.ts`, `apps/gateway/src/hub/**` (only if needed for the authenticated-uplink test), `apps/gateway/src/mesh/integration/**` (new test ok), `docs/hub/2026082800-hub-node-operations.md`. **`apps/gateway/src/mesh/mesh-runtime.ts` and `mesh-routes.ts` are being edited concurrently by another agent** — avoid them; if a change there is unavoidable keep it to a few lines, re-read the file immediately before editing, and never reformat it.

Read the review `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-rtc.md` (findings 1–8) and the original brief `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-rtc-prompt.md`. Fix ALL eight findings:
1. Authenticate the wake end-to-end: sign `{domain:'tmex-rtc-wake', from, to, rtcSession, nonce, issued_at}` with the sender node's private key (see how node identity signing is done elsewhere: grep `signNode`/`nodeSign`/`node_identity` and `node_certs` verification helpers in `apps/gateway/src/mesh` and `packages/shared/src/link`), verify on the receiver against the trusted `node_certs` entry for `from`, reject on bad signature, skew > 60s, or replayed nonce (small LRU). The hub must stay a pure forwarder. Decide whether the same signing should also cover the existing SDP/candidate `rtc.signal` envelope — check what already binds them (DTLS fingerprint in the login/handshake?) and write one paragraph in the result explaining why wake needed it and whether the rest is already safe; do not widen scope unless it is a clear hole.
2. Receiver-side wake rate limit + cooldown per peer (before any logging), and the receiver must verify it is actually the offerer (smaller id) for that pair; otherwise drop with a rate-limited log.
3. Sender cooldown must not swallow a needed wake: if suppressed by cooldown, schedule a deferred resend at `nextEligibleAt` (cancelled if dc arrives or the pending dial ends); `clearRtcWake()` semantics documented in code by naming, not comments.
4. `stop()` must resolve pending `waitForTransport` with `false` (fix the closure), with a test.
5. Early-resolved waiters must cancel their timeout sleep; revoking/removing a peer resolves its waiters `false` immediately; tests.
6. node-datachannel keeps a single callback per event (verify in `node_modules/node-datachannel` source; cite the file). Register each DataChannel/PeerConnection callback exactly once in one place and fan out to diagnostics + link + open-waiter; make `test-fakes.ts` mimic the single-callback semantics so the test would have caught it; test that diagnostics AND the link both see open/close.
7. `maskIceAddress` for IPv4-mapped IPv6 (`::ffff:a.b.c.d`) and other forms (`[::ffff:a.b.c.d]:port`, bracketed v6 with port); tests.
8. Add an integration-style test that runs two PeerManagers through the REAL authenticated uplink server/hub forwarding path (see `apps/gateway/src/mesh/integration/*.integration.test.ts` and `test-support.ts` for how a hub + two nodes are booted in-process), proving: single-sided `getLink()` from the larger id yields `dc` both sides; a forged wake (wrong signature / from a revoked node / claiming a different `from`) is rejected and does not create a PeerConnection.

Verification: `cd apps/gateway && bun test src/mesh` and full `bun test` 0 fail (baseline 2321 pass, may grow), tsc ≤ 21, biome clean on changed files.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-rtc2-result.md`
