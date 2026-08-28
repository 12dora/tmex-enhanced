## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: harness driver — count SEQ markers from TERM_HISTORY as well as TERM_OUTPUT

Scope: `scripts/hub-e2e/driver/terminal.ts`, `scripts/hub-e2e/driver/seq.ts` (+tests), `scripts/hub-e2e/build-driver.sh` run at the end. READ-ONLY: `packages/shared/src/ws/**` for frame kinds. Do not touch `run.sh` (the commander runs it) or app code.

Context: commit 2938e83 makes the entry-side failover resume legacy pane subscriptions by replaying `TMUX_SUBSCRIBE_PANES`/`TMUX_SELECT` and then synthesizing `TMUX_FETCH_PANE_HISTORY`; the output produced during the link gap arrives as a `TERM_HISTORY` frame (find its kind in the Borsh ws protocol), followed by live `TERM_OUTPUT` (0x305). `terminal.ts --capture-seq` currently extracts `SEQ_<n>` markers only from 0x305 payloads, so the H2/L5 assertion ("SEQ_1..400 contiguous") would fail even when failover is correct. Change the capture to also parse `TERM_HISTORY` payloads (decode per the shared codec — history may carry the full scrollback, so dedupe by marker number and keep the contiguity/gap logic in `seq.ts`), log `ws kind=… seq=…` for those frames as today, and record in the JSON result how many markers came from history vs live (`fromHistory`, `fromOutput`). Unit-test `seq.ts` merge/dedupe with overlapping history + live sets.

Verification: `bun test scripts/hub-e2e/driver/` 0 fail; biome clean; `scripts/hub-e2e/build-driver.sh` regenerates `driver-dist`.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-driver-history-result.md`
