# Task B2 — Backend TLS core: tls_config table + store, self-signed CA/leaf issuance, HTTPS listener, ACME (http-01 + Cloudflare dns-01) with renewal, TLS routes (module only, not yet mounted)

Read first:
- prompt-archives/2026082900-hub-ui-tls/sub/api-contract-batch2.md (implement exactly)
- prompt-archives/2026082900-hub-ui-tls/sub/explore-backend.md (sections 1, 2, 6 especially: server.ts listener, install dir, schema/migrations, crypto helper)
- prompt-archives/2026082900-hub-ui-tls/plan-00.md (batch 2/3 design; verified facts: Bun.serve tls cannot be hot-reloaded → stop() and re-create the https server; one Bun.serve is either http or https; acme-client@5 works on Bun; @peculiar/x509 is already in bun.lock as a transitive dep)

Another grok task (B1) is concurrently editing `packages/app/src/runtime/{assemble.ts,server.ts,local-routes.ts,setup-*.ts}`, `packages/app/src/commands/hub.ts`, `packages/app/src/lib/local-auth.ts`, `apps/gateway/src/api/system-routes.ts` and `apps/gateway/src/db/managed-migrations.ts`. You must NOT touch those files. Your module is integrated by the commander afterwards; make integration trivial by exposing clear entry points.

## Deliverables

### Gateway side (`apps/gateway`)
1. `src/db/schema.ts`: add `tlsConfig` table per contract (singleton `id` integer pk, all columns listed). Generate migration `0021_tls_config` with `bun run --filter @tmex/gateway db:generate` (or hand-write SQL + `meta/_journal.json` entry + `meta/0021_snapshot.json` consistent with drizzle-kit; then run `bunx drizzle-kit check` in apps/gateway → must say everything is fine). Do NOT edit `managed-migrations.ts` — state in your result that `'0021_tls_config.sql'` must be appended there.
2. `src/tls/tls-config-store.ts` (+ test): `TlsConfigStore(db)` with `get()`, `upsert(partial)`, encrypted fields via `encrypt`/`decryptWithContext` from `src/crypto/index.ts` using scope `tls_config`, entityId `'1'`, fields `ca_key`, `key`, `acme_cf_token`, `acme_account_key`. Expose typed record with decrypted material only through explicit methods (`getPrivateMaterial()`), never in the plain `get()` result.

### App side (`packages/app`) — new directory `src/tls/`
3. `cert-authority.ts` (+ test): using `@peculiar/x509` (add as explicit dependency of packages/app; also add `acme-client` — run `bun install` at the repo root) — `createCa({ name })` (EC P-256, 10 years, CA basic constraints, keyUsage keyCertSign|cRLSign), `issueLeaf({ ca, sans, days })` (SAN DNS/IP entries auto-classified, keyUsage digitalSignature|keyEncipherment, EKU serverAuth), `spkiFingerprint(certPem)` (sha256 hex lowercase of SubjectPublicKeyInfo DER), `parseCertificate(pem)` → `{ subject, issuer, sans, notBefore, notAfter }`. Test: issue CA+leaf, verify with `node:crypto` `X509Certificate.verify(caPublicKey)` and `checkHost`.
4. `https-listener.ts` (+ test): `class HttpsListener { constructor(opts: { fetch, websocket, log }) ; async apply(cfg: { port, host, certPem, keyPem } | null): Promise<void> — stops the current Bun.serve (if any) and, when cfg is non-null, starts a new one with `tls: { cert, key }`; state(): { running, port, error } ; stop() }`. Bind failure is captured into `error` (not thrown). Test with a real ephemeral port (20000–29999) using self-signed material from cert-authority and `fetch(..., { tls: { ca } })`.
5. `acme-challenge.ts`: in-memory http-01 responder: `set(token, keyAuth)`, `clear(token)`, `handle(req): Response | null` for `/.well-known/acme-challenge/:token`.
6. `cloudflare-dns.ts` (+ test with injected fetch): `findZoneId(token, domain)` (walk up labels: `GET /zones?name=<candidate>`), `createTxt(token, zoneId, name, content)`, `deleteRecord(token, zoneId, id)`; API base `https://api.cloudflare.com/client/v4`, `Authorization: Bearer`.
7. `acme-service.ts` (+ test with a fake acme client injected): `issue({ config, store, challenge, dns, fetch, log })` — account key create/reuse (store encrypted), directory = staging or production Let's Encrypt, order for `[domain]`, `challengeCreateFn`/`challengeRemoveFn` dispatching to http-01 responder or Cloudflare TXT (`_acme-challenge.<domain>`), CSR with a fresh EC P-256 key, finalize, persist cert/key/dates, `acme_status` transitions and errors per contract. `RenewalScheduler` (`start(check every 12 h)`, `stop()`, `runNow()`), backoff 1h→24h on failure; injectable clock/timers for tests.
8. `tls-service.ts` (+ test): orchestration used by routes and by process startup: `load()` reads config, `applyMode(input)` per contract PUT semantics (external writes `TMEX_TRUST_PROXY` via `readEnvFile`/`writeEnvFile` from `src/lib/env-file.ts` to the env path passed in), `renew()`, `status()` (GET shape), `caPem()`. Owns the `HttpsListener` and the `RenewalScheduler`. `startup()` = load + apply stored mode (start listener if material present; kick renewal scheduler for acme).
9. `src/runtime/tls-routes.ts` (+ test): `createTlsRoutes(deps: { service: TlsService; authorize: (req) => Promise<Response | null> })` returning `(req: Request) => Promise<Response | null>` handling `GET /api/tls`, `PUT /api/tls`, `POST /api/tls/renew`, `GET /api/tls/ca.crt`, and the acme challenge path. `authorize` returns a 401 Response to short-circuit or null to proceed (the commander wires it to standalone-open / mesh-session).

## Scope (files you may touch)
- apps/gateway/src/db/schema.ts, apps/gateway/drizzle/** (new 0021 files + journal), apps/gateway/src/tls/**
- packages/app/src/tls/**, packages/app/src/runtime/tls-routes.ts (+ test), packages/app/package.json, root bun.lock (via bun install)
Forbidden: everything listed above as B1's files; apps/fe; packages/shared; locale files.

## Baselines
apps/gateway 2441 pass / 0 fail, tsc 21; packages/app 254 pass / 0 fail, tsc 1. Counts must not regress. Live ACME against Let's Encrypt is NOT to be run in tests (use fakes); you may hit the staging *directory* URL read-only if needed for a manual check, nothing more.

## Result
Write `prompt-archives/2026082900-hub-ui-tls/sub/b2-result.md`: file list, exact integration steps for the commander (managed-migrations line, how to construct TlsService in assemble.ts, where to route the challenge path, how healthz/SPA fallback ordering must be), verification numbers, manual smoke instructions.
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
