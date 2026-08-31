# B6 result — apply R3 code-review findings (settings-latency backend)

Applied all 10 findings from `sub/R3-result.md` within the listed scope. Complexity locks were not raised.

## What changed

- `apps/gateway/src/tunnel/manager.ts` (+test)
  - Finding 1: last-protection ack for an externally managed tunnel no longer trusts stale `lastExternal.running === false`. Waives only after a bounded `detect({ force: true })` that returns a non-probing, non-running result within `ackDetectMs` (~3s, injectable). Timeout / throw / probing / running → `exposure_ack_required`.
  - Finding 6: `jobSyncAccess` aborts with `TunnelError access_api_failed` when `listApps` is truncated.
  - `refreshExternal({ force: true })` rethrows; non-force still falls back to `EMPTY_EXTERNAL`.
- `apps/gateway/src/tunnel/external-detect.ts` (+test)
  - Findings 2–4: per-instance epoch; `force` / `invalidate` bump epoch; only the current epoch commits; stale in-flight scans cannot overwrite; force failures throw.
  - Failures keep the last successful `at` and set `lastAttemptAt` with a ~10s backoff. First-call failure stays `probing: true` (not cached as success). `invalidate()` also clears `lastAttemptAt`.
  - Async IO: `Bun.spawn` + `Response(proc.stdout).text()` with `proc.kill()` deadline; default `readFile`/`readdir` from `node:fs/promises`. Deps remain injectable (sync or async stubs).
- `apps/gateway/src/tunnel/access-client.ts` (+test)
  - Finding 5: wrapped `TunnelError` gets `abortLike: true` when the original is timeout/abort (`TimeoutError`/`AbortError` names, `reason`/`cause`/`signal.reason`, `/aborted|timed?\s*out|timeout/i`).
  - Finding 6: `listApps` always sets `truncated` (deadline, abort after partial pages, **and** 50-page cap). Type is `CloudflareApp[] & { truncated: boolean }`. `upsertBypassApps` refuses truncated lists.
  - Finding 7: reads 3s, POST/PUT/DELETE 15s. Comment only — no POST reconciliation.
- `packages/app/src/tls/tls-service.ts` (+test)
  - Finding 8: mutation counter; invalidate cache before **and** after each mutation; `status()` does not cache while `mutations > 0`.
  - Finding 9b: optional `onStatusChange` after mutations.
- `apps/gateway/src/mesh/auth-mode-cache.ts`, `apps/gateway/src/mesh/auth-routes.ts` (+test)
  - Finding 10: generation is instance-owned; `AuthRoutes.invalidateAuthModeCache()` is a method. Module-level `invalidateAuthModeCache` export removed.
- `apps/gateway/src/auth/user-key-persistence.ts` (+test)
  - Finding 9a: optional `onChange` on `persistApplied` / `AuthStores` / `createTxStores`.
- `apps/gateway/src/mesh/mesh-runtime.ts`
  - Finding 9a: `notifyKeyLogHead` also invalidates auth-mode cache (covers key-log apply / applyMany catch-up). Exposes `MeshRuntime.invalidateAuthModeCache()`.
- `packages/app/src/runtime/assemble.ts` (+test)
  - Finding 9b: TLS `onStatusChange` invalidates auth-routes / mesh auth-mode cache.

`mesh-deps.ts` was not edited; wiring lives in `mesh-runtime.ts` and `assemble.ts`.

## Verification

| Check | Result |
| --- | --- |
| `cd apps/gateway && bun test src/tunnel src/mesh src/auth src/api/tunnel-routes.test.ts` | **745 pass / 0 fail** (later targeted re-run after last edits: 131 pass / 0 fail across detector, manager, access-client, auth-routes, persistence). |
| `cd packages/app && bun test src/tls src/runtime` | **160 pass / 0 fail**. |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **21** `error TS` (baseline 21). |
| `cd packages/app && bunx tsc --noEmit -p .` | **1** `error TS` (baseline 1). |
| `bunx biome check --write` on changed files | clean. |
| `bun scripts/complexity/gate.ts` | **ok** (1085 files, 9002 functions). No allowlist raises. Compacted blanks / `isAbortLike` helper / `assembleTmex` projection to stay under locks (`manager.ts` 1189, `mesh-runtime.ts` 1344, `auth-routes.ts` 924, `external-detect.ts` 900, `assembleTmex` 136, `isAbortLike` CC ≤ 15). |

## Out of scope / remaining notes

- **Hub metadata** (finding 9) still expires on the 5s auth-mode TTL. `uplink-client.ts` / `uplink-server.ts` were out of scope.
- **UserKeyService** was out of scope, so `createTxStores(..., onChange)` is not passed from the service. Production catch-up invalidates via `attachKeyLogHeadNotify` / `createKeyLogApplier` in `mesh-runtime.ts`.
- **Finding 6 shape:** kept `CloudflareApp[] & { truncated }` instead of `{ apps, truncated }` so existing array consumers and test stubs keep working. Completeness is always explicit.
- **Finding 7:** timeout budget split only. Timed-out POSTs are not reconciled by domain/name; IDs are still persisted after the full configure job.
- **`errors.ts`:** `TunnelError` constructor unchanged; abort-likeness is a runtime `abortLike` flag via `Object.assign`.
- One earlier full-suite flake (`login succeeds when cert appears at default ~/.cloudflared/cert.pem`) reproduced as empty dest cert under load; `manager.test.ts` alone and the subsequent full run were green. Unrelated to the ack/detect changes.
