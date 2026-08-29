# Task B2b — Integrate the TLS module into the production runtime

Read first:
- prompt-archives/2026082900-hub-ui-tls/sub/b2-result.md (the module you are integrating; its "Integration (commander)" section is your spec — implement it)
- prompt-archives/2026082900-hub-ui-tls/sub/b1-result.md (current assemble.ts dispatch order, setup/local routes, `resolveSetupEnvPath`, shutdown hook)
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch2.md and api-contract-batch1.md

Another grok task (B3) is concurrently editing `packages/shared/src/auth/enrollment.ts`, `packages/app/src/lib/hub-client.ts`, `packages/app/src/commands/{hub.ts,enroll.ts}`, `apps/gateway/src/mesh/{uplink-client.ts,mesh-runtime.ts,auth-routes.ts}`, `apps/gateway/src/hub/hub-runtime.ts`, `apps/gateway/src/db/schema.ts` (adding a `hub_trust` table + migration 0022) and `apps/fe/src/node/enrollment.ts`. Do NOT touch those files. If you need `managed-migrations.ts`, append only `'0021_tls_config.sql'` — B3 will append `'0022_hub_trust.sql'` after you; to avoid an edit race, B3 has been told to do its append at the very end of its task and to re-read the file first.

## Deliverables
1. `apps/gateway/src/db/managed-migrations.ts`: append `'0021_tls_config.sql'`. Run `bun run --filter tmex-cli bundle:resources` (or whatever script `packages/app/package.json` names for copying `apps/gateway/drizzle` into `packages/app/resources/gateway-drizzle`) so the bundled resources include 0021 — check the script and confirm the copied files in your result. If the bundle dir is git-ignored/generated, say so.
2. `packages/app/src/runtime/assemble.ts` + `server.ts`: construct `TlsConfigStore`, `AcmeHttp01Challenge`, `HttpsListener`, `TlsService`, `createTlsRoutes` exactly as b2-result.md describes; mount `tlsHandler` at the start of `dispatch` right after `seedLocalContext` (so both plain and https listeners see it); `authorize` = standalone open / mesh `authenticateRequest` with the same store B1 uses (401 body `{error:{code:'UNAUTHORIZED',message}}`); `await tlsService.startup()` after `assembled.start()`; shutdown order `tlsService.stop()` → `listener.stop()` → `assembled.stop()` → plain `stop(true)` (then the existing exit). The https listener must serve the same `fetch` (wrapped with tls routes) and the same `websocket` handler as the plain listener. Expose `assembled.tls` (service) for local-routes.
3. `packages/app/src/runtime/local-routes.ts`: `GET /api/local/status` → `tls` becomes `{ mode, listenerRunning, tlsPort }` derived from `tlsService.status()` (keep `mode` first; contract batch 1 only promised `mode`, the extra fields are additive).
4. Tests: `assemble.test.ts` — tls routes reachable through `assembled.fetch` in standalone (GET /api/tls returns mode none), 401 in mesh without session, acme challenge path returns 404 for an unknown token (not index.html); startup with a stored selfsigned config starts the https listener on an ephemeral port (20000–29999) and `fetch(https, { tls: { ca } })` returns healthz; shutdown stops it.

## Scope (files you may touch)
- apps/gateway/src/db/managed-migrations.ts (append one line only)
- packages/app/src/runtime/{assemble.ts,assemble.test.ts,server.ts,local-routes.ts,local-routes.test.ts}
- packages/app/resources/gateway-drizzle/** (via the bundle script only)
- packages/app/src/tls/** and packages/app/src/runtime/tls-routes.ts only for bug fixes you find while integrating (state each in the result)

## Baselines (current)
packages/app 308 pass / 0 fail, tsc 1 (pre-existing); apps/gateway 2445 pass / 0 fail, tsc 21 (pre-existing).

## Result
`prompt-archives/2026082900-hub-ui-tls/sub/b2b-result.md`.
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
