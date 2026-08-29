# Task B-fix-B — Backend review fixes: TLS service serialization, ACME lifecycle, listener stop, DNS-01 propagation, certificate validity, challenge path

Read: prompt-archives/2026082900-hub-ui-tls/sub/review-backend2.md (all findings accepted; you own the ones below), b2-result.md, b2b-result.md, api-contract-batch2.md.

Task B-fix-A runs in parallel and owns `packages/app/src/commands/**`, `packages/app/src/lib/**` (except reading), `packages/app/src/runtime/setup-service.ts`, `packages/shared/**`, `apps/gateway/src/auth/**`, `apps/gateway/src/mesh/**`. Do NOT touch those. A shared env lock exists at `packages/app/src/lib/env-mutation.ts` (`withEnvLock(fn)`) — use it (read-only import) around the external-mode env write.

Implement:
1. **Serialize TLS mutations + generation guard** (`packages/app/src/tls/tls-service.ts`, `acme-service.ts`): a single in-process mutex for `applyMode` / `renew` / scheduler runs / startup; every ACME job captures an `epoch` (incremented on each `applyMode`) plus the mode/domain/challenge/staging tuple; `issue()` returns material instead of committing; the service commits atomically only if the epoch and tuple still match, otherwise discards. Shutdown and mode change invalidate active work (abort signal to acme-client where possible). Test: stale job result is discarded; two concurrent first-time self-signed applies produce one CA.
2. **Await listener stop** (`https-listener.ts`, `packages/app/src/runtime/server.ts`): `await server.stop(true)`; same-port reapply test proves no false `EADDRINUSE`.
3. **Listener activation is part of ACME completion**: after a successful issuance, if the listener fails to bind, persist `acme_status='error'` + `lastError` (listener message) and let the scheduler retry activation with backoff **without reissuing** (material already stored); when the bind later succeeds, status → `ok`.
4. **Single-flight issuance path with retry** (`tls-service.ts`): initial PUT, manual renew, scheduler and startup all go through one `runAcme(reason)`; failures arm the 1h→24h backoff (`nextRenewAt`/retry timer) and never leave `nextRenewAt=null` with a pending/failed row; on startup, resume rows that are `pending` or `error` or have no certificate.
5. **Staging/production switch** (`acme-service.ts`, `tls-service.ts`): store the account URL together with its directory (add a column `acme_account_directory` via a new migration `0023` in `apps/gateway/drizzle` + `schema.ts` + `managed-migrations.ts` — you own these three for this task — keep drizzle-kit check green); when the directory changes, clear the account URL, keep the encrypted account key. Test both directions.
6. **DNS-01 propagation + cleanup** (`acme-service.ts`, `cloudflare-dns.ts`): after creating the TXT record, poll `node:dns` `resolveTxt` (use `Resolver` with the zone's authoritative nameservers from Cloudflare (`GET /zones/{id}` → `name_servers`) falling back to system resolver) until the exact value is visible, bounded (e.g. 2 s interval, 120 s max); track created record IDs outside the callbacks and delete them in an outer `finally`, logging failures and persisting a warning into `lastError` when cleanup fails while issuance succeeded. Tests with injected resolver/fetch.
7. **External mode ordering + env lock** (`tls-service.ts`): stage the env change first (under `withEnvLock`), then commit mode and stop the listener; on env failure nothing changes and the error is returned. Test rollback.
8. **Certificate validity** (`cert-authority.ts`): `notBefore` backdated 5 minutes; leaf `notAfter` capped to the CA's `notAfter`; CA validity ≥ 30 days remaining required to issue, otherwise rotate the CA (new CA → new fingerprint; document in the result that joined nodes must re-join after CA rotation).
9. **Challenge path** (`acme-challenge.ts`): catch `decodeURIComponent` failures and accept only `[A-Za-z0-9_-]{1,256}` tokens before lookup → 404 otherwise. Test malformed percent-encoding.
10. Tests as listed; keep everything green; `bunx drizzle-kit check` in apps/gateway must pass.

## Scope
- packages/app/src/tls/** (all), packages/app/src/runtime/{tls-routes.ts,tls-routes.test.ts,server.ts,assemble.test.ts (only if TLS tests there need updates)}
- apps/gateway/src/tls/**, apps/gateway/src/db/schema.ts (tls_config columns only), apps/gateway/drizzle/** (0023), apps/gateway/src/db/managed-migrations.ts (append 0023)
Forbidden: everything owned by B-fix-A, apps/fe, packages/api-client, locale files.

## Baselines (HEAD)
packages/app 334/0 tsc 1; apps/gateway 2450/0 tsc 21.

## Result
`prompt-archives/2026082900-hub-ui-tls/sub/b-fix-b-result.md`.
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
