## Ground rules (read fully)

- Repo: Bun + TypeScript monorepo `tmex` (gateway `apps/gateway`, frontend `apps/fe`, shared packages under `packages/*`). Work ONLY inside the worktree `/Users/konata/code/tmex-enhanced-wt-r9` (branch `feat/round9-relay-files-perf`). `bun` is at `~/.bun/bin/bun` (add to PATH if missing). Everything runs on Bun, never Node.
- Several other agents are editing this same worktree concurrently. Touch ONLY the files listed in your "Owned files" section (plus new test files next to them). If you believe you must edit a file outside your scope, do NOT edit it — describe the needed change in your result file instead.
- Do NOT run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (log/blame/diff) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, `~/Library/Application Support/tmex/`) and NEVER run tmux commands on the default socket or against a session named `tmex`. Any tmux you need for tests must use an isolated socket (`tmux -L tmex-r9-<yourid>`).
- Do not run the dev server (`bun run dev`) and do not run Playwright e2e. Unit tests only: inside the package dir run `bun test` (for `apps/fe` use `bun test src/`). Before editing, record the baseline pass/fail counts of the packages you touch and `bunx tsc --noEmit -p .` error count; after editing, counts must not regress. Bun test summary lines carry ANSI colors — strip with `sed 's/\x1b\[[0-9;]*m//g'`. macOS has no `timeout` command.
- Run `bunx biome check <changed files>` (no `--write` on files you don't own; never lint generated files such as `packages/shared/src/i18n/resources.ts`, `types.ts`, `dist/*`).
- i18n: locale files are `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`. Edit only the sub-object assigned to you, keep all three languages in sync, then run `bun run build:i18n` at the repo root to regenerate `resources.ts`/`types.ts`. Copy rules for zh_CN (from `/Users/konata/code/tmex-copy-guidelines.md`, read it before writing copy): say 「本机」 not 「这台机器」, avoid 「你」, one short sentence per line, state before static explanation, qualifiers in parentheses, English buttons in Title Case.
- No unnecessary code comments. No TODOs, no "simplified version", no leaving work for later — finish the whole task. Do not widen scope.
- When finished, write a concise report (what changed, file list, test/tsc before→after numbers, anything out of scope the commander must do) to the absolute path given in "Result file", then exit. The commander polls for that file.

# Task G2 — remove the fixed 450ms LIVE_RESUME delay after TERM_HISTORY (gateway)

Owned files: `apps/gateway/src/ws/borsh/switch-barrier.ts` (+ its tests), and only if strictly required `apps/gateway/src/ws/legacy-feed-broadcaster.ts`, `apps/gateway/src/ws/tmux-command-handlers.ts` (+ tests). Nothing else.
Result file: `/Users/konata/code/tmex-enhanced/prompt-archives/2026083102-relay-files-switch-lan-round9/sub/G2-result.md`

## Context
When the browser selects a pane (legacy transport: `TMUX_SELECT` → `SWITCH_ACK` → `TERM_HISTORY` chunks → `LIVE_RESUME`), the gateway currently does, after sending TERM_HISTORY:
```ts
setTimeout(() => { this.sendLiveResume(session, deviceId, expectedToken); }, LIVE_RESUME_DELAY_MS); // 450
```
(`apps/gateway/src/ws/borsh/switch-barrier.ts:18` and `:236`). Live output for the device is held back until LIVE_RESUME. This is a fixed +450ms on every terminal switch and is the largest single contributor to "switching terminals feels slow". ACK/history timeouts are 1500ms each (`:16`).

## Deliverable
1. Use `git log -S LIVE_RESUME_DELAY_MS -- apps/gateway/src/ws/borsh/switch-barrier.ts` and `git blame` to find why 450ms was introduced (look at the commit message and any test that encodes the reason). Summarize in the result file.
2. Replace the fixed delay: send `LIVE_RESUME` as soon as the last TERM_HISTORY chunk has been handed to the socket (WebSocket frames are ordered, so the client processes history before resume). If the socket reports backpressure / the history send is chunked asynchronously, resume right after the final chunk's send completes — not before. Keep: the switch token gating (a stale token must never resume), the timeout fallbacks, and the behaviour when history fails (resume must still happen so the pane does not stall). If you find a genuine ordering reason that requires a delay (e.g. output buffered in a different queue than history), keep the minimum that the reason justifies and explain — do not keep 450ms out of caution.
3. Also document (in the result file) exactly what the gateway does when `select-pane` arrives with `wantHistory: false` (does the switch barrier still hold output? is LIVE_RESUME sent? is `resize-window`/`capture-pane` executed?). The frontend agent will use this to implement "warm" pane switching that skips history. If `wantHistory:false` currently still goes through the barrier with a history wait/timeout, fix it so that it ACKs and resumes immediately without capture.
4. Update/add tests in `switch-barrier.test.ts` (and handlers tests if touched): resume fires immediately after last chunk; stale token ignored; failure path still resumes; wantHistory:false path.

Run `bun test` in `apps/gateway` before and after; report counts.
