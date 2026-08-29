# Task B1 — Backend: setup wizard API, local status/direct API, healthz startedAt, self-exit restart

Read first (they answer most questions with file:line references — do not re-explore broadly):
- prompt-archives/2026082900-hub-ui-tls/sub/explore-backend.md (backend exploration report)
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch1.md (API contract — the frontend is implemented in parallel strictly against it; implement it exactly, field names included)
- prompt-archives/2026082900-hub-ui-tls/plan-00.md (overall plan; you implement batch 1 item B1)

## Placement decision (already made — follow it)

The production process is `packages/app/src/runtime/server.ts` → `assembleTmex()` in `packages/app/src/runtime/assemble.ts`, and `packages/app` already imports `apps/gateway` (never the reverse). Therefore all new routes live in `packages/app/src/runtime/` and are mounted in `assembleTmex()` **before** mesh/gateway dispatch (next to the existing standalone `/api/auth/mode` shim at assemble.ts:181):

- `packages/app/src/runtime/local-routes.ts` — `GET /api/local/status`, `POST /api/local/direct`
- `packages/app/src/runtime/setup-routes.ts` — `POST /api/setup/precheck`, `POST /api/setup/hub`, `POST /api/setup/join` (standalone only; in mesh respond `404 {error:{code:'not_standalone',…}}`)
- `packages/app/src/runtime/setup-service.ts` — the logic, unit-testable with injected deps (auth context, env path, fetch, direct enable fn, exit fn, clock)

Reuse, do not duplicate:
- user bootstrap: `UserKeyService.bootstrapUserWithSelfAdmit` + `ensureNodeIdentity` (as `runHubUserAdd` does in `packages/app/src/commands/hub.ts:168`).
- join: refactor `runHubJoin` in `packages/app/src/commands/hub.ts` so its core (decode token → validate url → identity → fetchAuthMode → cert/PoP → redeem → verify → `commitVerifiedJoin`) is an exported function `performHubJoin(input, deps)` returning `{ userId, username, hubUrl }` that does NOT touch env or restart; `runHubJoin` (CLI) and the setup API both call it. Keep every existing hub.test.ts / join.test.ts passing. Errors must carry a stable `code` (`invalid_token`, `invalid_url`, `node_revoked`, `node_exists`, `hub_unreachable`, `join_failed`) — introduce a small `JoinError extends Error { code }` (or reuse an existing typed error if there is one) so the route can map to HTTP statuses per contract.
- auth context in-process: build the same stores the CLI's `LocalAuthContext` has (`UserStore`, `KeyLogStore`, `NodeSessionStore`, `NodeIdentityStore`, `UserKeyService`) against the already-open gateway DB (`assembled.gateway.db` or whatever `assembleTmex` holds — check `packages/app/src/lib/local-auth.ts` for how they are constructed and factor a `createAuthContextFromDb(db)` helper there). Never open a second SQLite connection and never close the gateway DB.
- env: `readEnvFile`/`writeEnvFile` from `packages/app/src/lib/env-file.ts`; env path = `join(resolveInstallDir(), 'app.env')` in production (`apps/gateway/src/system/install-info.ts:26`). In non-production (`NODE_ENV !== 'production'`) write to `<repo root>/<NODE_ENV>.env.local` instead (loadEnv reads it) — locate the repo root the same way `load-env.ts` does. Only set/replace the keys you own (`TMEX_ROLES`, `TMEX_HUB_PUBLIC_URL`, `TMEX_HUB_URL`); preserve all other keys.
- direct: `enableDirect` / `disableDirect` from `packages/app/src/commands/direct.ts` with `installDir = resolveInstallDir()`; status from `lookupNativePin` (supported), `<installDir>/native/manifest.json` (installed + version), and runtime `rtc.available` (capable; in standalone there is no MeshRuntime → `capable=false`). Platform string `${process.platform}-${process.arch}`.
- restart: after writing env, respond, then `setTimeout(() => void shutdownAndExit(), 300)` where the shutdown reuses the existing graceful path in `server.ts`/`assemble.ts` (`createProcessShutdown`) so the process exits 0 and the supervisor restarts it. Expose a hook so tests inject an `exit` spy instead of exiting.

Auth policy: standalone → all these routes open (decided; matches the standalone trust model). Mesh → `/api/local/*` require a valid `self` session: reuse `authenticateRequest` from `apps/gateway/src/mesh/session-middleware.ts` through the mesh runtime's deps (see mesh-runtime.ts:620 for how it is called); 401 body `{ error: { code: 'UNAUTHORIZED', message } }`.

`GET /healthz`: add `startedAt` (module-level `Date.now()` captured at process start) in `apps/gateway/src/api/system-routes.ts:68`. If the assembled app runtime serves healthz via a different handler, add it there too — same value.

Precheck: `fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(5000), redirect: 'error' })`; `reachable` = status 200 + JSON `status:'ok'`; `isSelf` = `body.startedAt === startedAt`; `error` = message on failure. Only `https:` URLs (or http localhost when not production) — otherwise `400 invalid_url`.

Also fix the migration registration inconsistency found by the explorer: `apps/gateway/drizzle/0020_node_identity_user.sql` exists in the journal but `apps/gateway/src/db/managed-migrations.ts` stops at `0019_hub_auth.sql` — append `0020`. Verify with the existing `schema.migration.test.ts`.

## Tests (bun:test)
- `setup-service.test.ts`: become-hub happy path (user created, env written with both keys, exit hook called after response), validation errors, user_exists, env_write_failed leaves no exit; join happy path with a stubbed `performHubJoin`; direct outcome mapping.
- `local-routes.test.ts` / `setup-routes.test.ts`: route-level status codes and bodies per contract; standalone vs mesh gating; mesh 401.
- `hub.test.ts`: existing tests still pass after the `performHubJoin` refactor; add a test that the CLI path still writes env and calls restart.

## Scope (files you may touch)
- packages/app/src/runtime/** (assemble.ts mount point, server.ts shutdown hook, new local-routes/setup-routes/setup-service + tests)
- packages/app/src/commands/hub.ts (+ hub.test.ts, join.test.ts) — refactor only, behavior preserved
- packages/app/src/lib/local-auth.ts (factor `createAuthContextFromDb`)
- apps/gateway/src/api/system-routes.ts (startedAt) and apps/gateway/src/db/managed-migrations.ts (0020)
Out of scope: apps/fe, packages/api-client, packages/shared, locale files, anything TLS-related (batch 2).

## Baselines
packages/app: 254 pass / 0 fail, tsc 1 error (pre-existing). apps/gateway: 2441 pass / 0 fail, tsc 21 errors (pre-existing). Run `bun test` in both packages and `bunx tsc --noEmit -p .`; error counts must not rise.

## Result
Write `prompt-archives/2026082900-hub-ui-tls/sub/b1-result.md` when done (file list, verification numbers, how to smoke-test manually with a scratch instance: env vars to set, curl commands).
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
