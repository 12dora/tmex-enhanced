# Task B2-8 — passkey login options filtered by exact origin; passkey verifier origin binding audit

Context: `sub/f4-fix-review.md` Major 1 and design §2 "用户密钥" (each passkey credential is bound to its registration origin; RP ID = host). Files: `apps/gateway/src/mesh/auth-routes.ts` (`POST /api/auth/passkey/login/options`, `/api/auth/passkey/register/options`, `/api/auth/passkeys`), `apps/gateway/src/auth/passkey.ts`. Concurrent agent B2-7 edits `mesh-routes.ts`, `mesh-runtime.ts`, `peer-manager.ts`, `stream-targets.ts`, `mesh-deps.ts`, `hub/uplink-server.ts`, `ws/index.ts` — do not touch those.

1. `POST /api/auth/passkey/login/options {uid, delegation}`: `allowCredentials` contains only `user_keys` rows whose `origin` equals the request's trusted origin (`TMEX_TRUST_PROXY` rules from `session-middleware.ts`), and `rpId` = that origin's host; empty list → 404 `{code:'NO_PASSKEY_FOR_ORIGIN'}`. Test with two credentials on different origins.
2. `POST /api/auth/passkey/register/options` uses the same trusted origin for `rpId`; verify stores exactly that origin.
3. `GET /api/auth/passkeys` returns `origin` and `rp_id` (already?) plus `usableHere: boolean` (origin match) so the UI can grey out others.
4. Verify `makeVerifyDelegationPasskey` and record assertion verification use the credential's stored `origin`/`rp_id` — never the request's — and reject when the credential's `userId` ≠ delegation uid (already per B2-2b-fix; add a test if missing).

File scope: `apps/gateway/src/mesh/auth-routes.ts` (+test), `apps/gateway/src/auth/passkey.ts` (+test). Acceptance: `cd apps/gateway && bun test src/mesh/auth-routes src/auth` green; tsc unchanged; biome clean. Result: `prompt-archives/2026082701-hub-multinode-design/sub/b2-8-result.md` (contract delta for the frontend).
