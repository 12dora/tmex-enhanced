# Task B1-3b — gateway auth storage: schema, migration, challenge / node-session / node-identity stores, cookies (apps/gateway/src/auth/ + db)

## Context

tmex is adding a hub/node mesh (design: `docs/hub/2026082700-hub-node-architecture.md`, read §2 fully — especially "表结构", "令牌与信任矩阵", "登录" step 1 and 3, the 18-hour sliding / 7-day hard-limit session rule, and §5 "配置"). The pure crypto/encoding layer lives in `packages/shared/src/auth/` and is being written by another agent concurrently — **do not import from it and do not touch it**. Your task is the storage layer on the gateway side that needs no crypto beyond what already exists in the repo. A follow-up task will add the key-log store / passkey verification on top of yours.

Also read `prompt-archives/2026082701-hub-multinode-design/sub/e0-3-result.md` §6 (DB and drizzle migration facts) before touching schema.

Repo facts:
- Schema: `apps/gateway/src/db/schema.ts`; migrations `apps/gateway/drizzle/0000–0017`; generate with `cd apps/gateway && bun run db:generate` (drizzle-kit, produces `0018_<name>.sql` + updates `drizzle/meta`). **You must also append the new file name to the hard-coded list in `apps/gateway/src/db/managed-migrations.ts`.** Look at how existing tests create an in-memory DB with migrations applied (search for `runMigrations` / `createTestDb` / `:memory:` in `apps/gateway/src/**/*.test.ts`) and reuse that helper.
- Encryption at rest already exists: `apps/gateway/src/crypto/` (uses `TMEX_MASTER_KEY` from `apps/gateway/src/config.ts`). Read its API and reuse it for the node private keys; do not write a new cipher.
- `apps/gateway/src/api/` route context and cookie handling: check whether any cookie parsing utility exists (search `cookie`); if not, write one.

## Deliverables

1. **Schema + migration** — add to `schema.ts` exactly the tables in design §2 "表结构": `users`, `user_keys`, `user_key_log`, `node_sessions`, `node_certs`, `nodes`, `enrollment_tokens`, `node_identity`, `peer_cache`, with the listed columns (binary columns as `blob`, timestamps as integer ms like the rest of the schema, JSON columns as text with `_json` suffix as listed). Add sensible unique indexes: `users.username`, `user_keys.credential_id`, `user_key_log (user_id, seq)`, `node_certs (node_id)`, `nodes (id)`, `peer_cache (node_id)`, `node_sessions (sid)` and an index on `node_sessions (user_id, via_node_id)`. `user_key_log` stores `record_bytes blob`, `sig blob`, `hash blob(32)`, `prev_hash blob(32)`, `root_epoch int`, `type text`, `payload_json text`. Generate the migration; commit nothing.
2. **`apps/gateway/src/auth/challenge-store.ts`** — `ChallengeStore` backed by the DB or in-memory (decide: challenges are 60 s, single node, in-memory `Map` is acceptable and simpler — but must be safe against unbounded growth: sweep expired entries). API: `create({uid, entryNodeId, kind: 'login' | 'passkey-register' | 'passkey-login' | 'rtc-authorize', ttlMs, payload?}) → {challengeId, nonce(32 bytes)}`, `consume(challengeId) → entry | null` (atomic: second call returns null; expired returns null). Include the entry node id so login can check `login.entry` against it.
3. **`apps/gateway/src/auth/node-session-store.ts`** — `NodeSessionStore` over drizzle: `issue({userId, viaNodeId, sessPublicKey, delegationMethod, credentialId?, now}) → {sid (32 random bytes, base64url), expiresAt, hardExpiresAt}` with `expiresAt = now + 18h`, `hardExpiresAt = now + 7d`; `verify(sid, {viaNodeId, now}) → {ok:true, session, renewedExpiresAt?: number} | {ok:false, reason: 'unknown' | 'expired' | 'revoked' | 'via_mismatch'}` implementing the throttled sliding renewal: if `now - renewedAt > 5 min` then `expiresAt = min(now + 18h, hardExpiresAt)`, persist, and return `renewedExpiresAt` (caller sets `x-tmex-session-renewed`); `revoke(sid)`, `revokeAllForUser(userId)`, `revokeByCredential(credentialId)`, `revokeVia(viaNodeId)`, `sweepExpired(now)`.
4. **`apps/gateway/src/auth/cookies.ts`** — `parseCookies(header) → Map`, `nodeSessionCookieName(nodeId) = 'tmex_s_' + nodeId` (`self` for the local node), `buildSetCookie(name, value, {maxAgeSec, secure}) → 'Path=/; HttpOnly; SameSite=Lax; Max-Age=…' (+ `; Secure`)`, `buildClearCookie(name)`.
5. **`apps/gateway/src/auth/node-identity-store.ts`** — single-row `node_identity`: `load() → {nodeId, hubUrl, edPrivateKey, x25519PrivateKey, certificateJson, certSig} | null` (decrypting private keys with the existing crypto module), `save({...})` (encrypting), `clear()`. Key bytes in/out as `Uint8Array`. No key generation here (that's in shared auth).
6. **`apps/gateway/src/auth/user-store.ts`** — CRUD for `users` (`getByUsername`, `getById`, `create`, `updateRoot({rootPublicKey, rootEpoch, kdfParamsJson})`, `setKeyLogHead({seq, hash})`, `setTotpRecordSeq`), `user_keys` (`listByUser`, `getByCredentialId`, `insert`, `updateCounter`, `delete`), `node_certs` (`list`, `get`, `upsert`, `markRevoked`), `peer_cache` (`list`, `upsert`, `delete`), and hub-side `nodes` / `enrollment_tokens` (`create`, `getByEnrollPublicKey`, `markUsed`, `sweepExpired`). Thin, typed, no business rules.
7. **`apps/gateway/src/auth/index.ts`** barrel.
8. **Config**: add to `apps/gateway/src/config.ts` (and the env loader schema/docs if `packages/shared/src/env/load-env.ts` enumerates keys — check; if it does, add there too, minimal) the new variables: `TMEX_ROLES` (`standalone|node|hub,node`, default `standalone`), `TMEX_HUB_URL`, `TMEX_HUB_PUBLIC_URL`, `TMEX_PEER_PORT` (default 39001), `TMEX_STUN_SERVERS`, `TMEX_TURN_URL`, `TMEX_TURN_USERNAME`, `TMEX_TURN_CREDENTIAL`. Parse `TMEX_ROLES` into a typed `roles: {hub: boolean; node: boolean}`, reject anything else.

## Tests

`*.test.ts` next to each file using the in-memory migrated DB: migration applies cleanly on top of 0017 and again is idempotent; challenge single consumption + expiry + sweep; node-session issue/verify/`via_mismatch`/expired/hard-limit (renewal cannot exceed `hardExpiresAt`; a session used every hour still dies at 7 d)/throttle (two verifies within 5 min renew once)/revoke variants; cookies parse & format (with and without `Secure`); node identity round-trip through encryption (use whatever the existing crypto tests do to set `TMEX_MASTER_KEY`); user-store basic CRUD; config role parsing.

## Your file scope

`apps/gateway/src/auth/**` (new), `apps/gateway/src/db/schema.ts`, `apps/gateway/src/db/managed-migrations.ts`, `apps/gateway/drizzle/**` (generated), `apps/gateway/src/config.ts` (+ its test), and `packages/shared/src/env/load-env.ts` only if it enumerates variable names (+ its test). Nothing else: another agent is refactoring `apps/gateway/src/ws/**`, `runtime.ts`, `managed-entry.ts`, `agent/ws-hub.ts` right now — never open those for editing.

## Acceptance

`cd apps/gateway && bun test` all pass — note the ws refactor agent may have transient failures in `src/ws/**`; if failures are only in files outside your scope, say so in the report with the file names; `bunx tsc --noEmit -p apps/gateway` errors ≤ 27 excluding errors located in `src/ws/**`/`runtime.ts`/`managed-entry.ts`/`agent/ws-hub.ts` (report the list); biome clean on your files.

## Result file

`prompt-archives/2026082701-hub-multinode-design/sub/b1-3b-result.md` — include the exported API signatures (the key-log store task is written from your report and the shared-auth report alone).
