# B-fix-B result — TLS serialization, ACME lifecycle, listener stop, DNS-01, cert validity, challenge path

All ten review items in this task’s ownership are implemented. Parallel B-fix-A files were not touched; `withEnvLock` is imported read-only from `packages/app/src/lib/env-mutation.ts`.

## What changed

### Gateway
- `apps/gateway/src/db/schema.ts` — `tls_config.acme_account_directory` (nullable text)
- `apps/gateway/drizzle/0023_acme_account_directory.sql` — `ALTER TABLE tls_config ADD acme_account_directory`
- `apps/gateway/drizzle/meta/_journal.json` + `0023_snapshot.json` (drizzle-kit generate)
- `apps/gateway/src/db/managed-migrations.ts` — append `'0023_acme_account_directory.sql'`
- `apps/gateway/src/tls/types.ts` — `acmeAccountDirectory` on public row + patch
- `apps/gateway/src/tls/tls-config-store.ts` — persist/merge the new column
- `apps/gateway/src/tls/tls-config-store.test.ts` — column list, directory round-trip, URL clear keeps directory + account key

### App TLS
- `packages/app/src/tls/tls-service.ts` — in-process mutex; epoch incremented on every `applyMode`; abort controller on mode change/shutdown; `issue()` material committed only if epoch + (mode, domain, challenge, staging) still match; single-flight `runAcme(reason)` for PUT / renew / scheduler / startup; listener bind is part of ACME completion; 1h→24h backoff via `nextRenewAt` (never null on pending/error); startup resumes `pending` / `error` / missing cert; external mode writes env under `withEnvLock` first; CA rotated when remaining validity < 30 days
- `packages/app/src/tls/acme-service.ts` — `issue()` returns `AcmeIssuedMaterial` and does not commit cert/status; account URL reused only when `acme_account_directory` matches the current directory; DNS-01 waits for exact TXT via injected/system resolver (auth NS from Cloudflare, 2s / 120s); outstanding TXT ids deleted in an outer `finally`; cleanup failures become `cleanupWarning`
- `packages/app/src/tls/cloudflare-dns.ts` — `getNameServers(token, zoneId)` (`GET /zones/{id}` → `name_servers`)
- `packages/app/src/tls/https-listener.ts` — `await server.stop(true)`
- `packages/app/src/tls/cert-authority.ts` — `notBefore` backdated 5 minutes; leaf `notAfter` capped to CA `notAfter`; optional `days`/`now` on `createCa`
- `packages/app/src/tls/acme-challenge.ts` — `decodeURIComponent` failures and tokens outside `[A-Za-z0-9_-]{1,256}` → 404
- `packages/app/src/runtime/server.ts` — `await server.stop(true)` on the plain listener
- Tests: `tls-service.test.ts`, `acme-service.test.ts`, `cert-authority.test.ts`, `https-listener.test.ts`, `cloudflare-dns.test.ts`, `acme-challenge.test.ts` (new)

## Behaviour notes

1. **Serialization + generation guard.** `applyMode` / `renew` / `startup` take a promise mutex. Each `applyMode` increments `epoch` and aborts the previous `AbortSignal`. ACME jobs capture epoch + tuple; commit is skipped on mismatch (stale cert cannot overwrite self-signed / `none`). Concurrent first-time self-signed applies serialize and share one CA.
2. **Listener stop.** HTTPS and plain `Bun.serve` shutdown both `await stop(true)`. Same-port `apply()` reapply no longer races `EADDRINUSE`.
3. **Listener activation is ACME completion.** After a successful issue, a bind failure stores `acme_status=error` + `lastError` (listener message) **without dropping the cert**. Scheduler/startup retry activation only (`reason=scheduler|startup` and cert not due) and set `ok` when bind succeeds.
4. **Single-flight retry.** PUT, manual renew, scheduler, and startup all call `runAcme`. Failures persist `nextRenewAt = now + backoff` (1h→24h) and arm the scheduler. Pending PUT also sets a safety `nextRenewAt`. Startup immediately resumes `pending` / `error` / no-certificate rows.
5. **Staging ↔ production.** Account URL is stored with `acme_account_directory`. A directory change clears the URL and keeps the encrypted account key. `issue()` ignores a URL whose directory does not match. Tested both directions.
6. **DNS-01.** After Cloudflare accepts the TXT, poll `resolveTxt` until the exact value is visible (auth NS from the zone, fallback to the system resolver). Record ids live outside `acme-client` callbacks and are deleted in `finally`. Cleanup failure after a successful issue is returned as `cleanupWarning` and persisted into `acme_last_error` while status stays `ok`.
7. **External mode.** Env write (under `withEnvLock`) happens first. On write failure the mode and listener are unchanged.
8. **Certificate validity.** CA and leaf `notBefore` are now − 5 minutes. Leaf `notAfter` is `min(now + days, CA.notAfter)`. Issuing a leaf requires CA remaining validity ≥ 30 days; otherwise a new CA is created (**new fingerprint — joined nodes must re-join**).
9. **Challenge path.** Malformed percent-encoding and non-base64url tokens return 404.

## CA rotation (operators)

When the local CA has fewer than 30 days of remaining validity, `TlsService` replaces it and re-issues the leaf. The SPKI fingerprint in v2 join tokens / `hub_trust` will not match the new CA. **Every joined node must re-join the hub** after that rotation.

## How to verify

```bash
cd packages/app && bun test src/tls src/runtime/tls-routes.test.ts src/runtime/assemble.test.ts
cd packages/app && bun test
cd packages/app && bunx tsc --noEmit -p .
cd apps/gateway && bun test src/tls
cd apps/gateway && bun test
cd apps/gateway && bunx tsc --noEmit -p .
cd apps/gateway && bunx drizzle-kit check
bunx biome check packages/app/src/tls packages/app/src/runtime/server.ts \
  packages/app/src/runtime/tls-routes.ts packages/app/src/runtime/tls-routes.test.ts \
  apps/gateway/src/tls apps/gateway/src/db/schema.ts apps/gateway/src/db/managed-migrations.ts
```

## Verification numbers

| Check | Baseline | After |
|---|---|---|
| `packages/app` `bun test` (full) | 334 pass / 0 fail | **381 pass / 0 fail** (this task’s TLS files: 33 pass; the rest of the delta is concurrent B-fix-A work in this worktree) |
| `packages/app` `bunx tsc --noEmit -p .` | 1 | **1** (`Cannot find type definition file for 'node'` — pre-existing) |
| `apps/gateway` `bun test` (full) | 2450 pass / 0 fail | **2453 pass / 0 fail** (TLS store still 4 tests; +3 from concurrent B-fix-A) |
| `apps/gateway` `bunx tsc --noEmit -p .` | 21 | **21** (same pre-existing ssh/tmux/ws errors) |
| `bunx biome check` on owned sources | — | clean |
| `apps/gateway` `bunx drizzle-kit check` | — | Everything's fine |

New/extended TLS coverage:
- stale ACME result discarded after mode change
- two concurrent first-time self-signed applies → one CA
- same-port HTTPS reapply does not report `EADDRINUSE`
- ACME bind failure → `error` + stored cert; startup retries activation without reissuing
- issuance failure sets `nextRenewAt`; pending PUT never leaves it null
- startup resumes `pending` with no certificate
- staging→production and production→staging clear account URL, keep account key
- DNS-01 injected resolver/fetch: wait for TXT, nameserver lookup, cleanup warning
- `notBefore` skew, leaf capped to CA, CA rotation below 30 days
- malformed percent-encoding on `/.well-known/acme-challenge/` → 404
- external env write failure leaves mode/listener unchanged

Live ACME against Let’s Encrypt was not run.

## Open issues

- `acme-client` still has no native `AbortSignal`. Mode change/shutdown abort is honoured in our callbacks, DNS poll, and the post-`auto()` commit guard; an in-flight HTTP round-trip inside `acme-client` cannot be cancelled.
- Production managed embed will 404 `0023_acme_account_directory.sql` until `bundle:resources` is re-run (same as 0021/0022). Out of this task’s file list.
- Dummy ACME certs in `TlsService` unit tests are not valid x509; `status().certificate` is null there. Listener/status/commit behaviour is still asserted.

## Out-of-scope changes needed from others

- Commander: re-run `bun run --filter tmex-cli bundle:resources` so the installed layout includes `0023_acme_account_directory.sql` + journal.
- After CA rotation, joining/joined nodes need a UX/docs note that they must re-join (fingerprint change). No FE/i18n edits in this task.
