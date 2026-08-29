# B4 result — direct add-on `enabled` flag separate from installation

## What changed

### Env / runtime
- `TMEX_DIRECT_ENABLED` (absent → `true`; only the string `false` disables).
- `packages/app/src/runtime/assemble.ts`: default `loadNative` returns `null` when `TMEX_DIRECT_ENABLED=false` (does not call `loadNodeDatachannel`). Everything else (mesh, `nativeDir`, injected `loadNative`) unchanged.
- `packages/app/src/lib/install.ts` `buildAppEnvValues` writes `TMEX_DIRECT_ENABLED=true` for **new `init` only**. Not added to `hubEnvDefaults` — upgrade merge uses that list, and injecting the key would change existing-install upgrade behaviour / break `env-file.test.ts`. Absent still means enabled.

### Status + POST `/api/local/direct`
- `getLocalStatus().direct.enabled` reads `TMEX_DIRECT_ENABLED` from the env file (`readEnvFile` / `envPath`; missing file or missing key → `true`). `capable` stays the **current runtime** value (`rtcCapable`).
- `setLocalDirect(action)` with `{ install | remove | enable | disable }`:
  - `install`: download addon (60 s, abortable), then `patchOwnedEnvKeys({ TMEX_DIRECT_ENABLED: 'true' })` under `withEnvLock`.
  - `remove`: delete `native/`, then write `TMEX_DIRECT_ENABLED=false`.
  - `enable`: requires installed (`409 direct_not_installed`), writes `true`. Does not download.
  - `disable`: writes `false`. Does not delete `native/`.
- Response: `{ ok, installed, enabled, capable, restartRequired: true }`.
- `POST /api/local/direct`: body `{ action }`. Legacy `{ enable }` and any other body → `400 invalid_action`.
- Setup wizard `directEnable: true` still runs install; on success also writes `TMEX_DIRECT_ENABLED=true` (becomeHub env patch / joinHub follow-up patch). Externally still `direct: 'enabled'|'failed'|'skipped'`.

### api-client
- `LocalDirectStatus.enabled`, `LocalDirectAction`, `LocalDirectResponse.enabled`.
- `LocalApi.setDirect(action: LocalDirectAction)` sends `{ action }`.

## Files

- `packages/app/src/runtime/assemble.ts`
- `packages/app/src/runtime/assemble.test.ts`
- `packages/app/src/runtime/setup-service.ts`
- `packages/app/src/runtime/setup-service.test.ts`
- `packages/app/src/runtime/local-routes.ts`
- `packages/app/src/runtime/local-routes.test.ts`
- `packages/app/src/lib/install.ts`
- `packages/app/src/lib/install.test.ts`
- `packages/api-client/src/local/types.ts`
- `packages/api-client/src/local/local-api.ts`
- `packages/api-client/src/local/local-api.test.ts`

## How to verify

```bash
cd packages/app
bun test src/runtime/assemble.test.ts src/runtime/setup-service.test.ts src/runtime/local-routes.test.ts src/lib/install.test.ts
bun test
bunx tsc --noEmit -p .
bunx biome check src/runtime/assemble.ts src/runtime/assemble.test.ts src/runtime/setup-service.ts src/runtime/setup-service.test.ts src/runtime/local-routes.ts src/runtime/local-routes.test.ts src/lib/install.ts src/lib/install.test.ts

cd ../api-client
bun test src/local/local-api.test.ts
bun test
bunx tsc --noEmit -p .
bunx biome check src/local/types.ts src/local/local-api.ts src/local/local-api.test.ts
```

## Test / tsc numbers

| | Tests | tsc `--noEmit` |
|---|---|---|
| Baseline (given) | app 383/0 ; api-client 128/0 | app 1 ; api-client 5 |
| After | **app 396 pass / 0 fail** (43 files) ; **api-client 128 pass / 0 fail** | **app 1** (`Cannot find type definition file for 'node'`) ; **api-client 5** (same `client.test.ts` / `files-download.test.ts`) |

Targeted files: **83 pass / 0 fail**. Net +13 tests (assemble skip-load; status `enabled`; four actions; `direct_not_installed`; invalid/legacy body; wizard env write). Zero failures.

Biome: clean on all scoped files after `--write`.

## Open issues

None for this contract. `capable` after disable/enable is still the **current process** RTC flag until restart; the UI already treats `restartRequired` as mandatory.

## Out-of-scope changes needed from others

None required. F5 already types against `LocalDirectAction` / `enabled` on `@tmex/api-client/local/types`. Do not add `TMEX_DIRECT_ENABLED` to `hubEnvDefaults` (upgrade merge).

## Discrepancy vs exploration / prompt

- Prompt allowed adding the key to `buildAppEnvValues` “only if trivially safe”. Putting it on `hubEnvDefaults` is **not** safe (upgrade `mergeMissingEnvFileKeys` + `env-file.test.ts` exact key list). Init template only.
- Trusted the live code for `patchOwnedEnvKeys` / `withEnvLock` (B1-fix); did not add a second lock.
