# Task B4 — Backend: direct add-on `enabled` flag separate from installation

Read: prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch3.md (implement exactly), sub/b1-fix-result.md (setup-service direct helpers, env lock), plan-00-result.md.

Implement:
1. Env key `TMEX_DIRECT_ENABLED` (absent → true). `packages/app/src/runtime/assemble.ts`: when `TMEX_DIRECT_ENABLED` is `false`, `loadNative` resolves `null` (skip addon load) — keep everything else. Add to the CLI `init` env template only if trivially safe (`packages/app/src/lib/install.ts` `buildAppEnvValues`), otherwise leave absent (= true).
2. `packages/app/src/runtime/setup-service.ts` + `local-routes.ts`: `getLocalStatus().direct.enabled`; `POST /api/local/direct` with `{ action }` per contract (writes env via `patchOwnedEnvKeys` under `withEnvLock`); remove the legacy `{ enable }` body (400 `invalid_action`). Setup wizard `directEnable` → install + enable.
3. Tests: setup-service / local-routes for all four actions, `direct_not_installed`, invalid body, status `enabled` false when env says false; assemble test that `TMEX_DIRECT_ENABLED=false` skips native load.
4. Update `packages/api-client/src/local/types.ts` (`LocalDirectStatus.enabled`, `LocalDirectAction`, `LocalDirectResponse.enabled`) and `local-api.ts` (`setDirect(action)`), keep `local-api.test.ts` green — a frontend agent is concurrently editing `apps/fe/**` only; api-client is yours.

Scope: packages/app/src/runtime/{assemble.ts,assemble.test.ts,setup-service.ts,setup-service.test.ts,local-routes.ts,local-routes.test.ts}, packages/app/src/lib/install.ts (+ test) optional, packages/api-client/src/local/{types.ts,local-api.ts,local-api.test.ts}. Nothing else.

Baselines: packages/app 383/0 tsc 1; api-client 128/0 tsc 5.
Result: prompt-archives/2026082900-hub-ui-tls/sub/b4-result.md
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
