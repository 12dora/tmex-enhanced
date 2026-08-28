# hub join rejoin (UNIQUE username)

## What changed

`hub join` no longer aborts with `UNIQUE constraint failed: users.username` when the local DB already has that username under a different uid (hub rebuilt / `reset-root`). After the token chain verifies, `UserKeyService.persistJoinReplay` atomically:

- If a **different uid** owns the username: wipe that user’s `user_key_log`, `user_keys`, `node_sessions`, `node_certs`, `nodes`, `enrollment_tokens`, delete the `users` row, and clear `peer_cache`.
- If the **same uid** is already present: wipe derived rows and replay the incoming chain (idempotent upsert, no duplicate log/cert rows).
- Keep the local node identity keypair (`nodeId` stable) via `ensureNodeIdentity` + identity upsert.

`hub leave` is not required; joining from role `node` to a different hub works. On a stale-username replace, CLI prints `hub.join.replacedStale` (en + zh-CN; no ja locale in this pack).

Ops doc `docs/hub/2026082800-hub-node-operations.md` §加入 / §灾难恢复 updated.

## Files

- `apps/gateway/src/auth/user-key-service.ts` (+ tests)
- `apps/gateway/src/auth/user-store.ts` (+ tests)
- `packages/app/src/commands/hub.ts`, `join.test.ts`
- `packages/app/src/i18n/index.ts`
- `docs/hub/2026082800-hub-node-operations.md`

## Verified

- `packages/app` `bun test src`: **243 pass, 0 fail** (baseline 240 + 3 join tests)
- `apps/gateway` `bun test`: **2339 pass, 0 fail** (baseline 2336 + 3 store/service tests)
- `tsc --noEmit`: app **1**, gateway **21** (at baseline)
- `biome check` on changed source files: clean

## Open issues

None. Mesh integration still copies chains via `verifyChainForJoin` (now upserts instead of `not_empty`); CLI `runHubJoin` rebuilt-hub path is covered in `join.test.ts`.
