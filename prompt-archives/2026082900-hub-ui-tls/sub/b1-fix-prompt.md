# Task B1-fix — Backend review fixes for the setup API

Read: prompt-archives/2026082900-hub-ui-tls/sub/review-backend1.md (accepted findings), b1-result.md, api-contract-batch1.md.

Concurrency constraints: task B2b is editing `packages/app/src/runtime/{assemble.ts,server.ts,local-routes.ts}` and task B3 is editing `packages/app/src/commands/{hub.ts,enroll.ts}` and `packages/app/src/lib/hub-client.ts`. Do NOT touch any of those. The exit-code finding (assemble.ts:451) is deferred to the commander — skip it.

Implement:
1. `packages/app/src/commands/direct.ts`: `EnableDirectOptions.signal?: AbortSignal` — pass to `fetch` and abort body reading; download+extract into a staging dir `<installDir>/native.tmp-<pid>-<rand>` and atomically rename to `native/` (remove any previous `native/` first, and clean the staging dir on any failure); return typed failures: `{ ok: false, kind: 'unsupported' | 'download' | 'integrity' | 'install', reason }` (`download` = network/HTTP/timeout/abort, `integrity` = sha mismatch, `install` = extraction/filesystem). Keep the CLI output unchanged. Update `direct.test.ts`.
2. `packages/app/src/runtime/setup-service.ts`: pass an `AbortSignal.timeout(60_000)`-style signal into `enableDirect` and await its settlement (no orphaned promise); map `unsupported` → 409 `direct_unsupported`, `download` → 502 `direct_download_failed`, `integrity`/`install` → 500 `direct_failed` (the local direct route and the setup `direct:'failed'` outcome share the mapping).
3. Process-wide setup transition lock in `setup-service.ts`: a single in-flight latch shared by `becomeHub` and `join`; a second request while one is running → `409 setup_in_progress`; after a transition has committed (restart scheduled) any further request → `409 setup_committed`. Recheck `getByUsername` inside the lock; map a UNIQUE-constraint failure from bootstrap to `409 user_exists`.
4. Join env safety in `setup-service.ts`: before calling `performHubJoin`, write the fully-computed new env content to a staged temp file next to the env path (proves writability, same dir, mode 0600); after the join commits, atomically rename the staged file over the env path; on any failure remove the staged file. If the rename itself fails after commit, respond `500 env_write_failed` with a message stating the node has joined locally and only the env keys `TMEX_ROLES=node`, `TMEX_HUB_URL=<url>` need to be written manually.
5. Tests (`setup-service.test.ts`, `local-routes.test.ts`, `setup-routes.test.ts`): concurrent becomeHub → one 200 + one 409; post-commit request → 409; join with a failing env rename → 500 with the recovery message and no exit; direct timeout → aborted (fetch sees `signal.aborted`) and no `native/` left behind; failure-kind mapping; a route test that constructs a real `NodeSessionStore` for the mesh 401/200 gating instead of a stub (see how B1's tests build the auth context).

Add the two new error codes to `prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch1.md` (append a line under each endpoint's Errors).

## Scope
- packages/app/src/commands/direct.ts, direct.test.ts
- packages/app/src/runtime/{setup-service.ts,setup-service.test.ts,setup-routes.ts,setup-routes.test.ts,local-routes.test.ts,http.ts}
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch1.md (append only)

## Baselines (current)
packages/app 308 pass / 0 fail, tsc 1 (pre-existing).

## Result
`prompt-archives/2026082900-hub-ui-tls/sub/b1-fix-result.md`.
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
