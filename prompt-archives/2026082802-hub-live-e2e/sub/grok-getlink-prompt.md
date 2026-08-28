## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: new streams must bind to the established link, never to an in-progress DC re-dial

Scope: `apps/gateway/src/mesh/peer-manager.ts` (+ `peer-manager.test.ts`, `peer-manager.upgrade.test.ts`), `apps/gateway/src/mesh/integration/direct-path.integration.test.ts` (extend). Another agent is editing `rtc/dc-handshake.ts`, `rtc/data-channel-link.ts`, `rtc/channel-fanout.ts`, `rtc/rtc-peer-manager.ts` — don't touch `rtc/**`; `forwarder.ts`/`stream-targets.ts` are done, read-only.

Live evidence (docker LAN, commit 92dc21e build, scenario L8): UDP on node-a is dropped; the direct link dies; `/api/mesh/nodes` correctly reports `transport=ws-secure` for node-b within 30 s (L4 PASS) and a terminal stream failover succeeds (L5 PASS). Then an 8 MiB `GET /n/<node-b>/api/files/raw` via the entry dies mid-body with `ECONNRESET` (L8 FAIL) although the ws-secure LAN link is healthy. The upgrade-retry schedule (5/15/30/60/120 s) re-dials DC while UDP is still blocked; each attempt takes ~15 s to fail. Hypothesis: `getLink()` (or the link selection used by `openHttpStream`/`openWsStream`) returns/binds to the pending or freshly-created DC link before its handshake completed (or switches the "current" link at dial start), so the new HTTP stream is opened on a link that then fails; the forwarder's GET retry cannot help after headers were sent. Also check the previous agent's note: "after DC death `getLink()` may spend up to the RTC connect timeout (~15 s) trying DC again before falling back" — that itself is wrong when a healthy relay/ws-secure link exists: `getLink()` must return the currently established link immediately and run upgrades strictly in the background, swapping the current link only after the DC handshake succeeded (and existing streams stay where they are).

Fix with tests: (1) `getLink()` returns the live established link immediately when one exists, regardless of an in-flight upgrade dial; (2) a stream opened during an upgrade attempt that fails is unaffected; (3) `transportOf()` never reports `dc` before handshake completion; (4) after DC loss with relay alive, no new stream is ever bound to a link whose handshake has not completed (assert via fake dial that fails after 5 s). Extend the direct-path integration test: kill DC, keep the relay, open an 8 MiB HTTP-style stream while an upgrade retry is failing → full bytes delivered.

Verification: `cd apps/gateway && bun test src/mesh/peer-manager*.test.ts src/mesh/integration/direct-path.integration.test.ts` then `bun test src/mesh` 0 fail; tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-getlink-result.md`
