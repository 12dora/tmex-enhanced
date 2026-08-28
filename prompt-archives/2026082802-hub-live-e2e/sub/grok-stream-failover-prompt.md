## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: node↔node streams must fail over to another link when their DataChannel link dies (no lost terminal output)

Scope: `apps/gateway/src/mesh/forwarder.ts`, `apps/gateway/src/mesh/link-stream-carrier.ts`, `apps/gateway/src/mesh/mesh-http.ts`, `apps/gateway/src/mesh/stream-targets.ts`, `apps/gateway/src/mesh/mesh-deps.ts`, their tests, `apps/gateway/src/mesh/integration/**` (new test), `docs/hub/2026082800-hub-node-operations.md` (直连 section). `apps/gateway/src/mesh/peer-manager.ts` and `rtc/**` are being edited concurrently by another agent (DC liveness ping): if you need a "link closed / transport changed" notification from PeerManager, first check what already exists (`waitForTransport`, transport-change events, `onLinkClosed`…) and prefer consuming an existing hook; if you must add one, keep it to a few lines, re-read the file right before editing, and do not reformat. Do NOT touch `apps/gateway/src/hub/**`, `scripts/**`, `apps/fe/**`.

Live measurement today (split harness scenario H, node-a entry ↔ hub node over a real DataChannel): a producer on the remote pane printed SEQ_1..SEQ_400 (20 ms apart); UDP was dropped on node-a mid-way. The entry-side WS stream (what the browser sees) received SEQ_1..SEQ_162 and then nothing for 90 s, even though the hub relay uplink and the peer link's fallback were available; `/api/mesh/nodes` later showed transport back on relay. So open streams bound to the DC link are simply lost when the link closes. The design (`docs/hub/2026082700-hub-node-architecture.md`, §直连) requires: when the direct path breaks, switch back to the primary path and resume subscribed panes without losing output (at worst the most recent *input* may be lost, and the UI shows "直连已断开").

Implement stream failover for forwarded WS streams (terminal/pane subscriptions and any other `/n/:id/ws` streams) and for in-flight HTTP forwards where feasible:
1. Track, per open forwarded stream, which link (transport) it is bound to.
2. When PeerManager reports that link closed/retired (or `transportOf` changes away from it) while a better/other link is available, re-open the stream over the current best link with the same logical target, replay the subscription state (pane ids / resume cursors — study how the gateway terminal protocol resumes: grep `resume`, `snapshot`, `cursor`/`seq` in `apps/gateway/src/ws/**` and `packages/shared/src/ws/**`; the terminal feed has a canonical snapshot/resume mechanism — use it so no output is dropped), and keep the entry-side WS to the browser open throughout (the browser must not see a disconnect).
3. If no alternative link exists yet, retry with backoff (bounded) and keep the browser-side WS alive; if the retry budget is exhausted, close the browser WS with the existing code that triggers reconnect.
4. Emit a log line `[mesh][stream] failover stream=… from=dc to=relay|ws-secure resumed=<n panes>`.
5. Tests: unit tests in the forwarder/carrier test files with fakes; an in-process integration test (see `apps/gateway/src/mesh/integration/direct-path.integration.test.ts` for how a dc link is set up) that opens a pane stream over dc, kills the dc link, and asserts the sequence of output frames observed at the entry-side WS is contiguous across the switch.

Verification: `cd apps/gateway && bun test src/mesh` 0 fail; full `bun test` 0 fail; tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-stream-failover-result.md`
