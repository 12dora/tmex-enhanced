## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: RTC round 4 — review-3 blockers + re-dial after a direct link is lost

Scope: `apps/gateway/src/mesh/rtc/**`, `apps/gateway/src/mesh/peer-manager.ts` (+tests), `apps/gateway/src/mesh/integration/rtc-wake.integration.test.ts`. A concurrent agent edits `forwarder.ts`/`mesh-http.ts`/`link-stream-carrier.ts`/`mesh-deps.ts` and `integration/stream-failover.integration.test.ts` — don't touch those. `uplink-client.ts` is also taken.

Read `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/review-rtc3.md`. Fix:
1. **Blocker 1 (dc-handshake ↔ fanout):** frames that arrive while the handshake listener is still attached but after the handshake's last expected message (e.g. the peer's first LinkMux OPEN) must not be swallowed by `stop()`. Make the handshake hand back any non-handshake frames it dequeued (re-inject into the fanout buffer in order) on completion, or make the handshake consume exactly the frames it needs and leave the rest buffered. Test the reviewer's exact race (delayed sig, immediate OPEN from the other side).
2. **Blocker 2 (browser `sess` nonce → carrier):** `waitFirstMessage()`'s one-shot listener must detach after resolving so subsequent frames are buffered until `DataChannelCarrier` attaches. Test: nonce + first carrier frame sent back-to-back → carrier receives the frame.
3. **Should-fix 3:** bounded buffers must not silently drop; on overflow close the channel with a logged reason (`[mesh][rtc] buffer overflow peer=… dropped=…`) so the link falls back instead of corrupting the stream.
4. **Should-fix 4:** cooldown-before-verify must not let a forged wake block a legitimate one: e.g. keep the cheap pre-check but only *commit* the cooldown after successful verification, while bounding verification work per peer with a small token bucket (e.g. 5 verifications / 5 s).
5. **Re-dial after loss:** today after a DC closes (ICE failure or the new liveness timeout in `rtc/liveness.ts`), the node never tries to upgrade again (live observation: last `dial start` then nothing for 90 s+ after connectivity returned). Add a bounded retry schedule for the upgrade after a direct-link loss (e.g. 5 s, 15 s, 30 s, 60 s, then every 120 s while the peer stays `direct_capable` and the relay link is alive), cancelled when dc is established; respect the wake cooldown; log `[mesh][rtc] upgrade retry peer=… attempt=… in_ms=…`. Unit test with the fake scheduler.
6. Nit from review 3 (revoked-case realism) only if cheap.

Verification: `cd apps/gateway && bun test src/mesh` 0 fail; full `bun test` 0 fail; tsc: no new errors in your files (another agent's integration test currently adds 3 — ignore those); biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-rtc4-result.md`
