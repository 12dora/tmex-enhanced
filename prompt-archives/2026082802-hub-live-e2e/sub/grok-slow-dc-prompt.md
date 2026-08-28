## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: 8 MiB HTTP forward over a slow DataChannel (TURN, ~1 MiB/s) stalls after one stream window and the link is then killed by liveness

Scope: `packages/shared/src/link/mux.ts` (+tests), `apps/gateway/src/mesh/rtc/liveness.ts`, `apps/gateway/src/mesh/rtc/data-channel-link.ts`, `apps/gateway/src/mesh/rtc/fragmenter.ts` (+tests), `apps/gateway/src/mesh/integration/dc-http-bulk.integration.test.ts`. Another agent edits `apps/gateway/src/mesh/peer-manager.ts`, `hub/**`, `auth/**` — don't touch; `forwarder.ts`/`stream-targets.ts` read-only.

Live evidence (`/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/evidence-i1-wan.txt`, run 8 on a real WAN TURN path): DC opens 17:08:52; hub (sender) pushes the 8 MiB file; node-a (receiver) logs `[mesh][http] forward aborted status=200 sent=1048508 expected=- reason=http stream aborted` at 17:09:09 — i.e. exactly one `INITIAL_STREAM_WINDOW` (1 MiB) was delivered, then the receiver's mux stream was aborted; hub logs `[mesh][rtc] liveness timeout … idle_ms=10000` at 17:09:19 (no inbound at the hub for 10 s → node-a's WINDOW credits / pongs never arrived), then the DC closes. On the fast LAN the same transfer passed (L7). So on a slow path the receiver stops sending anything back after the first window: WINDOW frames (and liveness pongs) from the receiver are not getting out — suspect the receiver's DC send path is blocked/starved (e.g. `flush` waiting on `bufferedAmount`/`onBufferedAmountLow` that never fires for tiny control frames, or control frames queued behind a paused sender, or window updates only emitted after N bytes are *consumed* while the consumer is paused waiting for the entry-side HTTP writer, creating a deadlock with the HTTP backpressure). And why did node-a abort at 1 MiB (`http stream aborted`) *before* any liveness timeout on its side? Find the abort source (mux RST from a local limit? `LINK_STREAM_BACKPRESSURE_BYTES`? receiver overflow?) and fix.

Reproduce in-process with a rate-limited fake DC (e.g. 64 KiB per 50 ms, 80 ms one-way delay) and a consumer that reads at ~500 KiB/s: (1) window credits must flow back promptly regardless of payload backpressure (control frames bypass data backpressure), (2) liveness pings/pongs must be sent even while the data path is saturated (prioritized), (3) the full 8 MiB arrives with correct hash, (4) nothing is aborted. Add the scenario as an integration test.

Verification: `cd packages/shared && bun test src/link`; `cd apps/gateway && bun test src/mesh/rtc src/mesh/integration/dc-http-bulk.integration.test.ts` then `bun test src/mesh` 0 fail; tsc ≤ baselines; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-slow-dc-result.md`
