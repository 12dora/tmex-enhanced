# B3 result — stale-while-revalidate tunnel detection + Cloudflare timeouts

## What changed

1. **External detector is stale-while-revalidate.** `ExternalTunnelDetector.detect()` serves any cached value immediately (even after the 30s TTL). On expiry it starts **one** in-flight refresh shared by concurrent callers; errors are logged and the last good result is kept (timestamp bumped so retries wait out the TTL). The first call with no cache awaits detection but **caps at 1.5s**: slower runs return `{ detected: false, probing: true }` while the background scan finishes. `detect({ force: true })` always awaits a full run (used by `adopt_external` and `sync_access`).

2. **Startup warm is fire-and-forget.** `TunnelManager.start()` no longer awaits `refreshExternal()`; it kicks `void this.refreshExternal().catch(...)`. Startup is not delayed and does not throw on unsupported platforms.

3. **`external.probing?: boolean`** added on `TunnelExternalStatus` (additive). Set while a refresh is in flight and the served data is stale/absent. `toExternalStatus` copies it; omitted when false/undefined.

4. **Cloudflare client timeouts.** Every `requestEnvelope` call uses `AbortSignal.timeout(CF_REQUEST_TIMEOUT_MS)` (3000). `listApps` has a 6s total deadline (`CF_LIST_APPS_DEADLINE_MS`); remaining budget is applied to later pages. Stopping early returns the pages already fetched with `truncated: true` on the array (existing `CloudflareApp[]` callers still iterate). Access probe treats timeout **and** truncated-without-match as `checked: false` (unknown), never as `checked: true, hostnameMatch: false` (not covered).

5. **`GET /api/tunnel/status` still awaits `refreshExternal()`**, but that await is now cheap (cache hit / stale serve / 1.5s first-wait cap). Route source unchanged.

## Files

- `apps/gateway/src/tunnel/external-detect.ts` (+ test)
- `apps/gateway/src/tunnel/access-client.ts` (+ test)
- `apps/gateway/src/tunnel/manager.ts` (+ test)
- `apps/gateway/src/api/tunnel-routes.test.ts` (route source unchanged)
- `packages/shared/src/contracts/tunnel.ts` (`external.probing?: boolean` only)

Test-only wrappers `parseProcessList` / `parseCloudflaredConfigYml` / `parseTunnelToken` / `hostnamesFromLog` were removed from `external-detect.ts` so the file stays under the 900-line lock (now 885). Tests call `parsePsOutput` / `parseCloudflaredYml` / `parseTokenFileMeta` / `parseIngressFromLog` instead.

## Verification

| Check | Result |
|---|---|
| `cd apps/gateway && bun test src/tunnel src/api/tunnel-routes.test.ts` | **130 pass, 0 fail** (11 files, 467 expects) |
| `bunx tsc --noEmit -p .` in `apps/gateway` | **21** `error TS` (baseline 21, unchanged). None in scoped files. |
| `bunx biome check` on the 8 changed files | clean (`--write` applied once, then re-check clean) |
| `bun scripts/complexity/gate.ts` | **ok** (1085 files, 8982 functions). `listApps` was CC 17; split `pushAppBatch` + `appsPageComplete` rather than raising the lock. `manager.ts` 1188 lines (lock 1189). `external-detect.ts` 885 lines (limit 900). |

## Out of scope (noticed, not changed)

- Front-end does not yet read `external.probing` (explicitly out of scope). The Remote access tab still gates on `useTunnelStatus` pending; after this change the first status response should return within ~1.5s even on a cold cache, and later polls pick up the warmed result.
- `jobCheck` does not call external detection (healthz only); force refresh is wired on `adopt_external` and `sync_access`, which actually consume `lastExternal`.
- `runtime.ts` still calls `tunnelManager.start()` before `Bun.serve`; warm is fire-and-forget at the end of `start()` rather than a post-listen hook (runtime.ts is out of scope).
- Did not touch `packages/app/src/runtime/*` or `apps/gateway/src/mesh/auth-routes.ts`.
