## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: stream failover resumes the subscription but the pane feed never continues (real docker run)

Scope: `apps/gateway/src/mesh/forwarder.ts`, `apps/gateway/src/mesh/mesh-http.ts`, `apps/gateway/src/mesh/link-stream-carrier.ts`, their tests, `apps/gateway/src/mesh/integration/stream-failover.integration.test.ts`, and READ-ONLY the gateway ws protocol (`apps/gateway/src/ws/**`, `packages/shared/src/ws/**`) and the harness driver `scripts/hub-e2e/driver/terminal.ts` (do not edit the driver). No docker.

Your previous change (commit c5a845b) passes its in-process integration test, but in the real docker LAN run today it does not restore output. Evidence (`/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/evidence-seq-capture-lan.err.txt`, produced by `scripts/hub-e2e/driver/terminal.ts --capture-seq`): the entry-side WS (driver ↔ node-a `/n/<node-b>/ws`) received legacy terminal output frames `kind=0x305` for SEQ_1..SEQ_152 (ws seq up to 155), then on failover node-a logged `[mesh][stream] failover stream=eb59341e from=dc to=ws-secure resumed=1`, the driver saw one `kind=0x208 seq=3` frame and then NOTHING for the remaining ~85 s while the producer on node-b kept printing SEQ_153..SEQ_400. Frame kinds seen over the whole capture: 0x2 ×1, 0x102 ×1, 0x208 ×2, 0x209 ×3, 0x305 ×149. Look up what 0x208/0x209/0x305/0x102 are in the Borsh ws protocol (`packages/shared/src/ws`) and how `terminal.ts` consumes them (it prints `ws kind=… seq=…` per frame and extracts SEQ_ markers from 0x305 payloads; `snapshot pane=%1` lines in the evidence come from it).

Find why, after the replayed HELLO/DEVICE_CONNECT/SUBSCRIBE on the new link, the target node does not stream pane output back — candidates: the replay subscribes with a canonical cursor/mode so output arrives as canonical frames the legacy subscriber never asked for (or vice-versa); the replayed DEVICE_CONNECT is answered with a *new* device session whose pane ids/window ids differ and the old pane subscription no longer matches; the resumed stream's outbound seq numbering resets and the forwarder drops "old" frames; snapshot-only delivery without re-arming the live feed; or the resume runs before the target's tmux control client is attached. Reproduce with a test that mirrors the REAL sequence: a legacy-mode subscriber (exactly what `terminal.ts` sends — read it), a live producer, kill the link mid-stream, and assert 0x305 frames continue after failover with contiguous SEQ markers; then fix. Also make the failover log include what was replayed (`mode=legacy|canonical panes=<ids> cursor=<…>`).

Verification: `cd apps/gateway && bun test src/mesh` and full `bun test` 0 fail (baseline 2386); tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-failover2-result.md`
