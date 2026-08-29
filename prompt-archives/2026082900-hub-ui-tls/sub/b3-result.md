# B3 result — Join-token v2 with CA fingerprint

Join tokens may now carry a CA pin. Hub enrollment-created and `/api/auth/mode` expose the fingerprint (and PEM on create). Joining nodes fetch `/api/tls/ca.crt` once with `rejectUnauthorized: false`, verify SPKI sha256, persist `hub_trust`, and pin `tls.ca` on later hub-client HTTP and the uplink WebSocket.

## Assemble.ts wiring (B2b / commander)

`packages/app/src/runtime/assemble.ts` was not touched. Once `tlsService` is in scope at `createMeshRuntime({ ... })`, add this field:

```ts
tlsInfo: async () => ({ caFingerprint: (await tlsService.status()).caFingerprint, caPem: await tlsService.caPem() }),
```

`CreateMeshRuntimeOptions.tlsInfo` is optional. Until that line lands, enrollment-created and `/api/auth/mode` return `ca_fingerprint` / `caFingerprint` as `null`.

If `TlsService` is constructed *after* `createMeshRuntime`, late-bind:

```ts
let tlsServiceRef: TlsService | null = null;
// createMeshRuntime({ tlsInfo: async () => tlsServiceRef
//   ? { caFingerprint: (await tlsServiceRef.status()).caFingerprint, caPem: await tlsServiceRef.caPem() }
//   : { caFingerprint: null, caPem: null } })
// tlsServiceRef = tlsService;
```

`mesh-http.ts` was out of scope. Mesh still gets the provider via `http.auth.setTlsInfo(opts.tlsInfo)` after `new MeshHttpRuntime(...)`. Optional cleanup later: add `tlsInfo` to `MeshHttpRuntimeOptions` and pass it into `new AuthRoutes({ ... })`, then drop the setter.

Production managed embed: after this commit, `bundle:resources` must copy `apps/gateway/drizzle/0022_hub_trust.sql` + journal/snapshot (same as 0021).

## File list

### Shared
- `packages/shared/src/auth/enrollment.ts` — `JoinToken.caFingerprint?`; `encodeJoinToken(..., caFingerprint?)` v1/v2; `decodeJoinToken` strict hex
- `packages/shared/src/auth/enrollment.test.ts`

### Frontend (parameter plumbing only)
- `apps/fe/src/node/enrollment.ts` — `encodeJoinTokenZeroing` optional fingerprint; `createEnrollmentOnHub` reads `created.ca_fingerprint`
- `apps/fe/src/node/enrollment.test.ts`
- `apps/fe/src/node/hub-api.ts` — `HubEnrollmentCreated.ca_fingerprint` / `ca_cert_pem`
- `apps/fe/src/pages/nodes/{enrollment-section,nodes-management}.tsx` — **not edited**; token is built in `createEnrollmentOnHub`

### Hub / mesh
- `apps/gateway/src/hub/hub-runtime.ts` (+ test) — optional `tlsInfo`; enrollment-created `{ ca_fingerprint, ca_cert_pem }`
- `apps/gateway/src/mesh/auth-routes.ts` (+ test) — `/api/auth/mode.caFingerprint`; `setTlsInfo`
- `apps/gateway/src/mesh/mesh-deps.ts` — `HubTlsInfo` / `HubTlsInfoProvider`
- `apps/gateway/src/mesh/mesh-runtime.ts` — `CreateMeshRuntimeOptions.tlsInfo` → HubRuntime + `http.auth.setTlsInfo`; uplink `tlsCa` from `hub_trust`
- `apps/gateway/src/mesh/uplink-client.ts` (+ test) — default `wsFactory` uses `new WebSocket(url, { tls: { ca } })` when `tlsCa` is set

### Trust store
- `apps/gateway/src/db/schema.ts` — `hub_trust`
- `apps/gateway/drizzle/0022_hub_trust.sql` + `drizzle/meta/_journal.json` + `drizzle/meta/0022_snapshot.json`
- `apps/gateway/src/auth/hub-trust-store.ts` (+ test) — `get` / `put` / `delete`, trailing-slash normalized
- `apps/gateway/src/db/managed-migrations.ts` — appended `'0022_hub_trust.sql'` last (0021 was already present)

### Join / CLI / client
- `packages/app/src/commands/hub.ts` — `performHubJoin` CA fetch/pin/persist
- `packages/app/src/commands/join.test.ts` — v1 no `ca.crt`; v2 match; v2 mismatch
- `packages/app/src/commands/enroll.ts` — hub selfsigned via `TlsConfigStore` + `spkiFingerprint`; non-hub via `/api/auth/mode.caFingerprint` + `createHubFetcher`
- `packages/app/src/commands/enroll.test.ts`
- `packages/app/src/lib/hub-client.ts` (+ test) — `createHubFetcher`, `HubAuthMode.caFingerprint`
- `packages/api-client/src/auth/types.ts` — `AuthModeResponse.caFingerprint?: string | null`

### Docs
- `docs/hub/2026082800-hub-node-operations.md` — v1/v2 format, CA pin, `hub_trust` per hub URL

## How to verify

```bash
cd packages/shared && bun test src/auth/enrollment.test.ts
cd apps/fe && bun test src/node/enrollment.test.ts
cd apps/gateway && bun test src/auth/hub-trust-store.test.ts src/hub/hub-runtime.test.ts src/mesh/auth-routes.test.ts src/mesh/uplink-client.test.ts
cd packages/app && bun test src/commands/join.test.ts src/commands/enroll.test.ts src/lib/hub-client.test.ts
cd apps/gateway && bunx drizzle-kit check   # Everything's fine
```

`assertHubJoinUrl` is unchanged. v1 tokens still join without pinning.

## Tests / tsc

| Package | Tests before | Tests after | tsc `--noEmit` before | after |
|---|---|---|---|---|
| `packages/shared` | 335/0 | **337/0** | 0 | **0** |
| `packages/app` | 308/0 | **323/0** (includes B2 tests already in tree) | 1 | **1** (`Cannot find type definition file for 'node'`) |
| `apps/gateway` | 2445/0 | **2450/0** | 21 | **21** |
| `apps/fe` `bun test src/` | 413/0 | enrollment **47/0**; full src 393 pass / 2 fail / 2 errors | 0 | enrollment files clean; full-project **3** errors in `https-section.tsx` |
| `packages/api-client` | 128/0 | **128/0** | 5 | **5** |

FE full-suite failures / tsc errors are in `apps/fe/src/pages/settings/nodes/https/*` (`Cannot find module './use-restart-now'`, `busy` prop) from the parallel frontend TLS agent. Out of this task’s scope.

`bunx biome check` on all files this task changed: clean.

`bunx drizzle-kit check` in `apps/gateway`: **Everything's fine**.

## Open issues

1. **assemble.ts not wired** — `tlsInfo` is optional; hub CA fields stay `null` until B2b adds the one-liner above.
2. **`mesh-http.ts` not updated** — runtime uses `AuthRoutes.setTlsInfo` instead. Optional follow-up to thread `tlsInfo` through `MeshHttpRuntimeOptions`.
3. **Installed layout** — `packages/app/resources/gateway-drizzle/**` is not copied here; `bundle:resources` must pick up 0022.
4. **FE HTTPS pages** — unrelated parallel work is currently failing tests/tsc; do not treat as B3 regressions.

## Notes vs exploration report

- `TlsService.status()` / `caPem()` are async, so `tlsInfo` is `() => HubTlsInfo | Promise<HubTlsInfo>`.
- DOM `WebSocket` typings reject `{ tls: { ca } }` as the second argument; default factory casts `as never` so Bun still receives the options object.
- `enrollment-section.tsx` / `nodes-management.tsx` do not encode the token; no page edits were required.
