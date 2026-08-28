## Ground rules (read first)
- Repo: Bun monorepo, worktree branch `chore/merge-hub-tabs`. Bun only (no Node APIs assumed unless the file already is a Node CLI). Read `AGENTS.md`.
- Other agents edit other files in this same worktree concurrently. Touch ONLY the files listed in your scope. Do NOT run any git command that changes state (no add/commit/stash/checkout). Do not run lint/format on generated files (`packages/shared/src/i18n/*`, `resources/fe-dist`, `dist`).
- Never touch the production tmex on this Mac (launchd service on 9883, `~/Library/Application Support/tmex/`) nor the tmux session named `tmex`. Tests use their own tmux sockets / temp dirs.
- No credentials in files. No hardcoded passwords.
- No comments in code unless the logic is genuinely non-obvious. Variable names in English.
- Before claiming done: run the package's `bun test` (for `apps/fe` use `bun test src/`) and `bunx tsc --noEmit -p .` — the tsc error count must not exceed the existing baseline (gateway 21, theme 9, api-client 5, stores 1, app 1, others 0); `bunx biome check <changed files>` clean.
- Finish the whole task; no TODOs, no "simplified version".
- Write your final report (what changed, how verified, any open issues) to the result file path given below. Keep it concise, in English.

# Task: forwarded HTTP responses must abort (not end cleanly) when the mesh stream dies mid-body

Scope: `apps/gateway/src/mesh/stream-targets.ts` (+ `stream-targets.test.ts`), `apps/gateway/src/mesh/integration/dc-http-bulk.integration.test.ts` (extend). Others are editing `forwarder.ts`, `mesh-http.ts`, `rtc/**`, `hub/**`, `peer-manager.ts` — don't touch.

Context from the DC-truncation fix (commit 6518a97): `packages/shared/src/link/mux.ts` now rejects the in-flight `reader.read()` when the link/stream is reset. But `openHttpStream` in `stream-targets.ts` (~lines 350–373) still does `if (head.status) { try { controller.close() } catch { controller.error(err) } } else { controller.error(err) }`, i.e. once headers were sent a mid-body failure ends the body cleanly → the entry returns HTTP 200 with a short body (observed live: 2,113,536 of 8 MiB with status 200). Fix: after headers are sent, a stream error must `controller.error(err)` (abort the body so the client sees a network error / incomplete transfer), and when the upstream provided `content-length`, also verify the delivered byte count and error if short. Log `[mesh][http] forward aborted status=… sent=… expected=… reason=…` (rate-limited). Tests: unit (fake stream RST after head → body errors, not closes; short body vs content-length → error) and extend the integration test to assert the entry-side fetch rejects/short-reads with an error instead of a silent short 200.

Verification: `cd apps/gateway && bun test src/mesh/stream-targets.test.ts src/mesh/integration/dc-http-bulk.integration.test.ts`, `bun test src/mesh` 0 fail; tsc ≤ 21; biome clean.

Result file: `/Users/konata/code/tmex-enhanced-wt-merge/prompt-archives/2026082802-hub-live-e2e/sub/grok-http-abort-result.md`
