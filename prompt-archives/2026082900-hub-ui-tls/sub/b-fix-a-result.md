# B-fix-A result — backend review fixes

All accepted findings assigned to this task are implemented. B-fix-B files (`packages/app/src/tls/**`, `tls-routes.ts`, `server.ts`, `apps/gateway/src/tls/**`) were not edited.

## What changed

### 1. CA response hardening (blocker)
- New `packages/app/src/lib/pem.ts`: 64 KiB body cap, strict single-PEM-certificate grammar (exactly one `BEGIN/END CERTIFICATE` block, base64 body, whitespace-only outside it), `@peculiar/x509` parse, require `basicConstraints.cA=true` and `keyUsage.keyCertSign`, persist the canonical re-serialized PEM and its SPKI fingerprint.
- `fetchPinnedHubCa` in `packages/app/src/commands/hub.ts` uses those helpers. Concatenated PEMs, trailing garbage, oversized bodies, and non-CA leaves fail closed with `join_failed` (`ca_invalid` / `ca_response_too_large`). Fingerprint is compared on the canonical PEM only.

### 2. Trust-key canonicalization
- New `packages/shared/src/auth/hub-url.ts` `canonicalHubUrl(raw)`: lowercase scheme/host, strip default ports 443/80, strip trailing slashes, keep non-root path, reject credentials/query/fragment, throw on invalid. Re-exported from `packages/shared/src/auth/index.ts`.
- Used in `assertHubJoinUrl`, `createHubFetcher` lookup, `HubTrustStore` put/get/delete (canonical key; get also matches legacy aliases; put deletes aliases), uplink `tlsCa` lookup, and the env value written by `runHubJoin` / setup join.
- Fail-closed uplink: if `config.hubUrl` is set and no `hub_trust` row exists for the canonical URL, log once at `createMeshRuntime`: `[uplink] no pinned CA for hub=…; using system trust`. When a row exists, it is always used as `tls.ca`.

### 3. Direct promotion with backup
- `promoteNativeDirectory` in `packages/app/src/commands/direct.ts`: rename existing `native/` → `native.bak-<pid>`, rename staging → `native/`, restore the backup on failure, delete the backup on success.

### 4–5. Setup env safety
- Exported `resolveEnvWriteTarget` from `packages/app/src/lib/env-file.ts` (the same symlink walk `writeEnvFile` already used). Join stages a sibling of the resolved target and renames onto it, so an `app.env` symlink is preserved.
- Setup env RMW (`patchOwnedEnvKeys`, join stage + promote) is wrapped in `withEnvLock`. Join does **not** hold the lock during `performHubJoin`. Immediately before promote it re-reads the live env and overlays only `TMEX_ROLES` / `TMEX_HUB_URL`, so a concurrent `TMEX_TRUST_PROXY` write is kept. CLI `writeRolesAndHubUrl` also uses `withEnvLock`.

### 6. CLI join error classification
- Pinned `/api/auth/mode` failures no longer collapse to a generic “unable to resolve hub uid” string. Network errors keep the cause; TLS verify failures on a v2 token advise checking the pinned CA/hostname; TLS verify failures on a v1 token advise generating a v2 token from the hub.

## File list

**New**
- `packages/app/src/lib/pem.ts`, `pem.test.ts`
- `packages/shared/src/auth/hub-url.ts`, `hub-url.test.ts`

**Edited**
- `packages/app/src/commands/{hub.ts,join.test.ts,direct.ts,direct.test.ts}`
- `packages/app/src/lib/{hub-client.ts,hub-client.test.ts,env-file.ts,env-file.test.ts}`
- `packages/app/src/runtime/{setup-service.ts,setup-service.test.ts}`
- `packages/shared/src/auth/index.ts` (re-export)
- `apps/gateway/src/auth/{hub-trust-store.ts,hub-trust-store.test.ts}`
- `apps/gateway/src/mesh/{mesh-runtime.ts,mesh-runtime.test.ts}`

## How to verify

```bash
cd packages/shared && bun test src/auth/hub-url.test.ts && bunx tsc --noEmit -p .
cd packages/app && bun test src/commands/join.test.ts src/commands/direct.test.ts \
  src/lib/pem.test.ts src/lib/hub-client.test.ts src/lib/env-file.test.ts \
  src/runtime/setup-service.test.ts
cd packages/app && bun test src/commands src/lib src/runtime
cd packages/app && bunx tsc --noEmit -p .
cd apps/gateway && bun test src/auth/hub-trust-store.test.ts src/mesh/mesh-runtime.test.ts
cd apps/gateway && bun test && bunx tsc --noEmit -p .
bunx biome check packages/app/src/commands/hub.ts packages/app/src/commands/join.test.ts \
  packages/app/src/commands/direct.ts packages/app/src/commands/direct.test.ts \
  packages/app/src/lib/hub-client.ts packages/app/src/lib/hub-client.test.ts \
  packages/app/src/lib/env-file.ts packages/app/src/lib/env-file.test.ts \
  packages/app/src/lib/pem.ts packages/app/src/lib/pem.test.ts \
  packages/app/src/runtime/setup-service.ts packages/app/src/runtime/setup-service.test.ts \
  packages/shared/src/auth/hub-url.ts packages/shared/src/auth/hub-url.test.ts \
  packages/shared/src/auth/index.ts \
  apps/gateway/src/auth/hub-trust-store.ts apps/gateway/src/auth/hub-trust-store.test.ts \
  apps/gateway/src/mesh/mesh-runtime.ts apps/gateway/src/mesh/mesh-runtime.test.ts
```

## Test / tsc numbers

| Package | Tests before | Tests after | tsc `--noEmit` before | after |
|---|---|---|---|---|
| `packages/shared` | 337/0 | **344/0** | 0 | **0** |
| `packages/app` | 334/0 | **337/0** on `src/commands` + `src/lib` + `src/runtime` (this task’s surface). Full `bun test`: 372 pass / **1 fail** in `src/tls/tls-service.test.ts` (B-fix-B, out of scope) | 1 | **1** (`Cannot find type definition file for 'node'`) |
| `apps/gateway` | 2450/0 | **2453/0** | 21 | **21** |

Biome: clean on all files this task changed (`--write` applied to 4 format/import nits).

## Open issues

1. Full `packages/app bun test` currently fails one case in `src/tls/tls-service.test.ts` (`acme returns pending immediately then ok after background issue` — listener `running` still false). That file is owned by B-fix-B and was not touched here.
2. Node runtimes that have `hubUrl` but no `hub_trust` row now emit `[uplink] no pinned CA for hub=…; using system trust` at construction. Existing gateway tests with `hubUrl: 'http://127.0.0.1:9'` and no pin produce that line; it is the intended fail-closed log, not a failure.
3. There is no SQL rewrite of already-stored non-canonical `hub_trust.hub_url` values. `get` matches aliases; `put` writes the canonical key and deletes aliases.

## Notes vs the review / prompt

- Dangling symlink: the prompt said “falls back to the link path”. The existing `writeEnvFile` walker (now `resolveEnvWriteTarget`) writes the **missing target** of a dangling link and keeps the symlink. Join promotion uses that same behavior; tests cover absolute, relative, and dangling links.
- `packages/shared/src/auth/index.ts` is not in the original scope list but is required to export `canonicalHubUrl` for gateway `@tmex/shared/auth` imports.

## Out-of-scope changes needed from others

None required for this task to land. B-fix-B should keep wrapping TLS env writes in `withEnvLock` so they serialize with setup join/becomeHub.
