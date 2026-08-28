## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: large HTTP forward over a DataChannel link truncates at ~2 MiB (status 200, short body, no error)

Scope: `apps/gateway/src/mesh/rtc/**` (data-channel-link, fragmenter, carrier), `packages/shared/src/link/**` (mux / windows / websocket-link) + tests, `apps/gateway/src/mesh/integration/**` (new test). `apps/gateway/src/mesh/forwarder.ts` / `mesh-http.ts` / `link-stream-carrier.ts` are being edited by another agent — READ them but do not edit; if the root cause is there, describe the exact change needed in your result instead of editing.

Live evidence (docker LAN run, node-a entry → node-b over `transport=dc`, commit 02a9ef8 build): `GET /n/<node-b>/api/files/raw?…` for an 8 MiB random file returned HTTP 200 with a body of exactly **2,113,536 bytes** (= 2 MiB + 16 KiB) and a wrong sha256; no error/warn lines on either node. Over relay/ws-secure earlier runs the same read completed (the harness's REST fallback assertion passed before). Constants of interest: `MAX_FRAME_PAYLOAD=1 MiB`, `INITIAL_STREAM_WINDOW=1 MiB`, `MAX_LINK_UNACKED=32 MiB` (`packages/shared/src/link/types.ts`), `LINK_STREAM_BACKPRESSURE_BYTES=1 MiB`, DC `BULK_FRAME_SIZE=64 KiB`, node-datachannel bufferedAmount / `onBufferedAmountLow` plumbing in `data-channel-link.ts` and the new fanout/buffer-overflow logic from today's commits (`channel-fanout.ts`, overflow closes channel at 32 pending — check whether a 2 MiB burst of 64 KiB fragments (=32 frames!) trips exactly that cap while the consumer is momentarily detached or slow, which would explain the number), and the fragmenter's reassembly limits.

Reproduce in-process: two PeerManagers over the fake DC (use realistic 64 KiB fragments and a consumer that is slower than the producer), open an HTTP-style stream and push 8 MiB; assert all bytes arrive in order and that flow control (window updates over DC) actually throttles instead of dropping/closing. Then fix the root cause (likely: buffering caps must be byte-based and tied to the mux window, not a fixed 32-message cap; or DC send must respect bufferedAmount and wait for onBufferedAmountLow; or window credits are not returned on the DC path). Make sure a stalled/closed DC stream produces an error to the forwarder (so the HTTP response is aborted/5xx, never a silent short 200) — if that part lives in forwarder.ts, document it precisely for the other agent.

Verification: `cd apps/gateway && bun test src/mesh`, `cd packages/shared && bun test src/link` 0 fail; full gateway `bun test` 0 fail; tsc ≤ baselines (gateway 21, shared 0); biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-dc-truncation-result.md`
