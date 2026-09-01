# P2 result — static asset cache policy

## Files changed

- `packages/app/src/runtime/serve-frontend.ts`
- `packages/app/src/runtime/serve-frontend.test.ts` (3 → 7 tests)
- `docs/performance/2026090101-static-cache-policy.md`

No gateway static handler. `TMEX_FE_DIST_DIR` / `fe-dist` in `apps/gateway` are install-path lookups only; SPA files are served solely by packaged runtime `serveFrontend` (assemble.ts last-dispatch). Manifest `Cache-Control: no-store` in `apps/gateway/src/api/http.ts` left untouched. No `Accept-Encoding` negotiation → no `Vary`.

Vite (`apps/fe/vite.config.ts`): no `build.rollupOptions.output`; default `assets/[name]-[hash].ext`. This worktree has no `apps/fe/dist` or `resources/fe-dist`.

## Header matrix

| Served file | Cache-Control | Validators | Conditional |
| --- | --- | --- | --- |
| `assets/*-[hash].ext` (8+ alnum hash) | `public, max-age=31536000, immutable` | none | always 200 body |
| Other (`index.html`, icons, `/fonts/*.woff2`, unhashed wasm) | `no-cache` | `ETag: W/"<size>-<mtimeMs>"`, `Last-Modified` | matching `If-None-Match` or `If-Modified-Since` → 304 empty |
| Path confinement | unchanged | | traversal still `null` / 403 |

## Verification

| Check | Before | After |
| --- | --- | --- |
| `cd packages/app && bun test` | 596 pass / 1 fail / 597 tests | 600 pass / 1 fail / 601 tests |
| `serve-frontend.test.ts` | 3 pass | 7 pass / 0 fail |
| `bunx tsc --noEmit -p .` | TS2688 missing `@types/node` | same, no new errors |
| `bunx biome check` on touched `.ts` | — | clean |

The 1 remaining fail is pre-existing: `scripts/build-runtime.test.ts` expects `packages/app/dist/runtime/server.js` (not built in this worktree). Unrelated to P2.

## Unfinished

None for this task.
