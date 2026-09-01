# S1 result — proxy-aware client IP + mesh SSO tests

## Files changed

- `apps/gateway/src/mesh/client-ip.ts` (new) and `client-ip.test.ts`
- `apps/gateway/src/mesh/auth-routes.ts` — login limiter IP bucket uses resolved client IP
- `apps/gateway/src/db/local-auth-http.ts` — bootstrap/toggle loopback uses the same helper (prompt path `apps/gateway/src/api/local-auth-http.ts` does not exist)
- `apps/gateway/src/mesh/auth-routes.test.ts` — CF-Connecting-IP buckets + bootstrap (a)–(d)
- `apps/gateway/src/mesh/integration/mesh.integration.test.ts` — four SSO isolation tests
- `docs/operations/2026090101-public-login-hardening.md`

Not touched: `assemble.ts`, `session-middleware.ts`, `mesh-deps.ts`, `access-guard.ts` (socket IP, headers, and `trustProxy` already reach the decision sites via mesh request context).

## Client-IP precedence

`resolveClientIp({ socketIp, headers, trustProxy })`:

- `trustProxy=false`: always socket IP; forwarded headers ignored.
- `trustProxy=true`: first valid IPv4/IPv6 literal among
  1. `CF-Connecting-IP`
  2. first non-empty `X-Forwarded-For` entry (trim)
  3. `X-Real-IP`
  4. socket IP

Garbage values are skipped; if none parse, socket IP is used. UID bucket and 10/60s limits unchanged.

## Loopback

- `trustProxy=true`: loopback is decided from the resolved client IP.
- `trustProxy=false`: socket IP as before, **except** a present `CF-Connecting-IP` is never loopback.

## Verification

- `cd apps/gateway && bun test`: **3098 pass / 0 fail** (144.7s). Baseline 3080; **+18** (12 helper, 2 auth-routes, 4 mesh SSO).
- `bunx tsc --noEmit -p .`: **21** `error TS` (unchanged).
- `bunx biome check` on touched TS files: clean.

## Unfinished

Nothing.
