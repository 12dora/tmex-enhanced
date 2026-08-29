# B2 result — Backend TLS core

Module-only work. Routes are **not mounted**. Commander must wire the entry points below. B1 files were not touched.

`bunx drizzle-kit check` in `apps/gateway`: **Everything's fine**.

## File list

### Gateway
- `apps/gateway/src/db/schema.ts` — `tlsConfig` singleton table (`id` integer pk, check constraints)
- `apps/gateway/drizzle/0021_tls_config.sql`
- `apps/gateway/drizzle/meta/_journal.json` — idx 21 / tag `0021_tls_config`
- `apps/gateway/drizzle/meta/0021_snapshot.json`
- `apps/gateway/src/tls/types.ts`
- `apps/gateway/src/tls/tls-config-store.ts`
- `apps/gateway/src/tls/tls-config-store.test.ts`
- `apps/gateway/src/tls/index.ts`

### App
- `packages/app/src/tls/cert-authority.ts` (+ test)
- `packages/app/src/tls/https-listener.ts` (+ test, real ephemeral port 20000–29999)
- `packages/app/src/tls/acme-challenge.ts`
- `packages/app/src/tls/cloudflare-dns.ts` (+ injected-fetch test)
- `packages/app/src/tls/acme-service.ts` (+ fake ACME client + `RenewalScheduler` tests)
- `packages/app/src/tls/tls-service.ts` (+ test)
- `packages/app/src/tls/errors.ts`
- `packages/app/src/tls/index.ts`
- `packages/app/src/runtime/tls-routes.ts` (+ test)
- `packages/app/package.json` — explicit deps `@peculiar/x509@1.14.3`, `acme-client@^5.4.0`
- root `bun.lock` (via `bun install`)

### Not edited (commander must)
- `apps/gateway/src/db/managed-migrations.ts` — B1 already added `0020_node_identity_user.sql`. **Append `'0021_tls_config.sql'`** after it.
- `packages/app/src/runtime/{assemble.ts,server.ts}`
- `packages/app/resources/gateway-drizzle/**` — copy/bundle happens in `bundle:resources`; re-run that so the installed layout includes `0021_tls_config.sql` + journal.

## Integration (commander)

### 1. Managed migrations

In `apps/gateway/src/db/managed-migrations.ts` `MIGRATIONS`:

```ts
'0020_node_identity_user.sql',
'0021_tls_config.sql',
```

Drizzle journal already has 0021. Dev/test `createMigratedAuthDb()` already applies it from `apps/gateway/drizzle`. Production managed embed will 404 the SQL until this line exists.

### 2. Construct `TlsService` (server.ts / assemble.ts)

B1 already exposes `resolveSetupEnvPath()` (production `app.env`, otherwise `<NODE_ENV>.env.local`) and `assembled.gateway.db`.

Late-bind fetch so the HTTPS listener serves the same app (including ACME challenge + `/api/tls`):

```ts
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
import { AcmeHttp01Challenge } from '../tls/acme-challenge';
import { HttpsListener } from '../tls/https-listener';
import { TlsService } from '../tls/tls-service';
import { createTlsRoutes } from './tls-routes';
import { resolveSetupEnvPath } from './setup-service';
import { isStandaloneRoles } from '../lib/roles';

const assembled = await assembleTmex({ staticRoot });
const challenge = new AcmeHttp01Challenge();
const store = new TlsConfigStore(assembled.gateway.db);

let fetchImpl: typeof assembled.fetch = assembled.fetch;
const listener = new HttpsListener({
  fetch: (req, server) => fetchImpl(req, server),
  websocket: assembled.websocket,
  log: (message) => console.log(`[tmex] ${message}`),
});

const tlsService = new TlsService({
  store,
  listener,
  challenge,
  envPath: resolveSetupEnvPath(),
  trustProxy: gatewayConfig.trustProxy,
});

const tlsHandler = createTlsRoutes({
  service: tlsService,
  authorize: async (req) => {
    if (isStandaloneRoles(assembled.roles)) return null;
    const auth = authenticateRequest(req, {
      roles: assembled.roles,
      nodeSessionStore: /* the same store B1 already uses */,
    });
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'login required' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return null;
  },
});

fetchImpl = async (req, server) => {
  const tlsResp = await tlsHandler(req);
  if (tlsResp) return tlsResp;
  return assembled.fetch(req, server);
};

const plainServer = Bun.serve({
  hostname: host,
  port,
  fetch: fetchImpl,
  websocket: assembled.websocket,
});

await assembled.start();
await tlsService.startup();
```

`authenticateRequest` / `nodeSessionStore` already exist in B1 `assemble.ts` (`routeDeps.authenticate`). Prefer inserting `tlsHandler` at the **start of `dispatch`** (after `seedLocalContext`) so both the plain listener and the HTTPS listener (which reuse `assembled.fetch`) see TLS routes. If you wrap only in `server.ts`, HTTPS `fetch` must be the wrapped function, not the raw `assembled.fetch`.

Shutdown (plain + https):

```ts
tlsService.stop();          // renewal scheduler
await listener.stop();      // HTTPS Bun.serve
await assembled.stop();
plainServer.stop(true);
```

`Bun.serve({ tls })` cannot hot-reload: `HttpsListener.apply()` already `stop(true)`s and re-creates.

### 3. Challenge path and healthz / SPA ordering

`createTlsRoutes` handles:

| Path | Auth |
|---|---|
| `GET/HEAD /.well-known/acme-challenge/:token` | none (must be public for http-01) |
| `GET/PUT /api/tls`, `POST /api/tls/renew`, `GET /api/tls/ca.crt` | `authorize` |

Call `tlsHandler` **before SPA fallback** (`serveFrontend`). Otherwise `/.well-known/acme-challenge/*` becomes `index.html`.

`tlsHandler` returns `null` for `/healthz` and every other path. Do **not** intercept healthz. Current B1 dispatch order that should remain:

1. `seedLocalContext`
2. **`tlsHandler`** (new — challenge + `/api/tls*`)
3. `handleLocalRequest` / `handleSetupRequest` (B1)
4. hub / mesh (mesh `localUiGuard` for `/api/` is after TLS so Let's Encrypt can reach the challenge from the internet)
5. `gateway.handleRequest` (`/healthz`, core `/api/*`)
6. SPA fallback last

If `tlsHandler` is placed *after* `gateway.handleRequest`, `/api/tls` 404s from the core API table.

### 4. Authorize policy

Contract: standalone → open; mesh → valid `self` session. `createTlsRoutes` does not implement that; it short-circuits on a 401 `Response` from `authorize`, or proceeds on `null`. Challenge is answered **before** `authorize`.

## Behaviour recap (for reviewers)

- `tls_config` singleton `id=1`. Encrypted at rest with `encrypt` / `decryptWithContext`, scope `tls_config`, entityId `'1'`, fields `ca_key` | `key` | `acme_cf_token` | `acme_account_key`. `get()` never returns private material; `getPrivateMaterial()` is explicit.
- Self-signed: EC P-256 CA (10y, created once) + leaf (398d, SAN DNS/IP auto-classified). HTTPS listener on `tls_port`/`bind_host`.
- ACME: account key reuse, staging vs production Let's Encrypt directory, http-01 in-memory responder or Cloudflare dns-01 TXT `_acme-challenge.<domain>`, CSR EC P-256, `acme_status` pending → ok/error. PUT/renew is async (returns GET shape immediately). Renewal every 12h, due when `now >= nextRenewAt` (`notAfter − 30d`), backoff 1h → 2h → … max 24h.
- `mode=none` stops the listener and keeps stored material. `mode=external` stops the listener and writes `TMEX_TRUST_PROXY=true|false` via `readEnvFile`/`writeEnvFile` (`restartRequired: true`).
- Bind failure is stored in `listener.error` (not thrown by `HttpsListener`); `applyMode` maps it to `409 port_in_use` after saving the mode.
- Errors: `{ "error": { "code", "message" } }`.

## Verification

| Check | Baseline | After |
|---|---|---|
| `apps/gateway` `bun test` | 2441 pass / 0 fail | **2445 pass / 0 fail** (4 new store tests) |
| `apps/gateway` `bunx tsc --noEmit -p .` | 21 | **21** |
| `packages/app` `bun test` | 254 pass / 0 fail | **308 pass / 0 fail** (15 new TLS tests here; remainder is concurrent B1) |
| `packages/app` `bunx tsc --noEmit -p .` | 1 | **1** (`Cannot find type definition file for 'node'` — pre-existing) |
| `bunx biome check` on B2 sources | — | clean |
| `apps/gateway` `bunx drizzle-kit check` | — | Everything's fine |

New app tests: `src/tls/*.test.ts` + `src/runtime/tls-routes.test.ts` → 15 pass.

Live ACME against Let's Encrypt was **not** run. ACME tests inject a fake client. Cloudflare tests inject `fetch`.

## Manual smoke (commander, scratch instance)

Do **not** touch production tmex (9883 / `~/Library/Application Support/tmex/`) or tmux session `tmex`.

1. Scratch `DATABASE_URL`, `GATEWAY_PORT`/`FE_PORT` in 20000–29999, explicit `TMEX_FE_DIST_DIR`.
2. After wiring, `PUT /api/tls` `{ "mode": "selfsigned", "sans": ["localhost", "127.0.0.1"], "tlsPort": 29443, "bindHost": "127.0.0.1" }`.
3. `GET /api/tls` → `listener.running`, `caFingerprint` 64 hex, `certificate.sans`.
4. `GET /api/tls/ca.crt` → `application/x-x509-ca-cert`, save as `tmex-ca.crt`.
5. `curl --cacert tmex-ca.crt https://127.0.0.1:29443/healthz` (or Bun `fetch` with `tls: { ca }`).
6. `PUT { "mode": "none" }` stops HTTPS; material remains so switching back is instant.
7. ACME: only staging, and only when the commander has a public HTTP-01 path or Cloudflare token. Do not hit production LE from tests.

## Open issues / follow-ups

- Commander must append `'0021_tls_config.sql'` to `managed-migrations.ts` and re-bundle `packages/app/resources/gateway-drizzle`.
- `GET /api/local/status` (B1) does not yet include TLS; add later if the UI needs it.
- Join-token v2 / hub CA pin is B3, not this module.
- `acme-client` loads `node:assert` and prints a `NO_COLOR`/`FORCE_COLOR` warning under Bun tests; harmless.
- Linux user-level systemd still cannot bind 80/443; unchanged, UI/docs only.
- `schema.migration.test.ts` was out of scope; 0021 coverage lives in `tls-config-store.test.ts`.
