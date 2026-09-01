# P2 — Static asset cache policy for the packaged frontend server

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo; use `bun` (`~/.bun/bin/bun` if not on PATH). **Other agents edit other files concurrently (gateway `ws/`, `mesh/auth-routes.ts`, `api/local-auth-http.ts`, frontend packages). Touch only the files in "Scope". Never run git commands.** Comments only where non-obvious, in Simplified Chinese. Write the final report (English, < 300 words) to `/Users/konata/code/tmex-enhanced-wt-r11/prompt-archives/2026090101-round11-pwa-files-auth/sub/P2-result.md` and **only exit after that file is written**.

## Problem

The iOS PWA is slow on every cold launch. The packaged runtime serves the built SPA from `packages/app/src/runtime/serve-frontend.ts` (~lines 26-81: path confinement + content type) with **no `Cache-Control`, no `ETag`/`Last-Modified`**. The default font files total ≈ 2.48 MB and the Ghostty WASM ≈ 0.55 MB; without explicit caching headers Safari re-validates or re-downloads them on each launch. The manifest is deliberately `no-store` (`apps/gateway/src/api/http.ts:11-18`) — leave it.

## Change

1. In `serve-frontend.ts` add a cache policy:
   - Files under the Vite hashed asset dir (`/assets/` — confirm the actual output dir/name pattern from `apps/fe/vite.config.ts` `build.rollupOptions.output` and by listing `resources/fe-dist/` or `apps/fe/dist/` if present; hashed names look like `name-[hash].ext`) → `Cache-Control: public, max-age=31536000, immutable`.
   - Any other static file (`index.html`, `favicon`, icons, non-hashed `*.wasm`/fonts if they exist outside the hashed dir) → `Cache-Control: no-cache` plus a strong `ETag` (e.g. `W/"<size>-<mtimeMs>"` or a sha1 of the content computed once and memoised per path+mtime) and `Last-Modified`; honour `If-None-Match` / `If-Modified-Since` with `304`.
   - `Vary: Accept-Encoding` only if the server already negotiates encodings (check; if not, skip).
   - Keep the existing path-traversal confinement untouched.
2. Also check whether the gateway itself serves `fe-dist` in any mode (`grep -rn "fe-dist\|TMEX_FE_DIST_DIR" apps/gateway/src packages/app/src`), and apply the same policy where a second static handler exists (report it; do not refactor).
3. Unit tests in `packages/app/src/runtime/serve-frontend.test.ts` (extend if it exists): immutable header for hashed asset, `no-cache` + ETag for `index.html`, `304` on matching `If-None-Match`, traversal still rejected.

## Scope

`packages/app/src/runtime/serve-frontend.ts` (+ test), and at most one equivalent gateway static handler if it exists. Add 3–5 lines to `docs/performance/` — create `docs/performance/2026090101-static-cache-policy.md` (Chinese, concise).

## Verification

- `cd packages/app && bun test` (record before/after) and `bunx tsc --noEmit -p .` (record baseline first).
- `bunx biome check <touched files>` clean.

## Report (`P2-result.md`)

Files changed, the exact header matrix, test counts, anything unfinished.
