# Re-join of an already-admitted node (auth_rejected)

## What changed

When a node with an already-admitted identity re-joins the same hub epoch, the operational certificate is reused. Redeem still consumes the new enrollment token (signed with that token’s `enroll_sk`), but:

- Hub keeps the admitted `node_certs` row. Response includes `already_admitted: true` and the original certificate bytes. Hub logs `[hub] already admitted node=<id>`.
- Enroll CLI sees that `node_id` in local `node_certs` and skips a second `admit-node`, printing `already admitted` (never `node admitted`).
- `hub join` persists the admitted cert (verified against our Ed25519 public key), not the newly minted token-bound cert.

Revoked identity re-join is refused: redeem returns HTTP 409 `node_revoked`; `hub join` throws `this node identity was revoked; use a fresh identity (mesh reset / re-init)`. Operator must enroll a new nodeId/keys (`mesh reset-root` / re-init).

Enroll CLI throws `admit-node failed: <error>` when key-log apply rejects (including `node_id_reused` / `bad_cert_sig`) and does not print `node admitted`.

Hub uplink auth failures are logged, rate-limited (10 s per node+reason):

`[hub][uplink] auth rejected node=<id> reason=cert_not_admitted|revoked|bad_sig|bad_cert|timeout|unauthenticated` (repeat window adds `suppressed=`). Close codes (`unknown-cert`, `unauthorized`, …) are unchanged so the node still classifies `auth_rejected`.

Ops doc `docs/hub/2026082800-hub-node-operations.md` updated for re-join reuse, revoked refusal, enroll messages, and hub auth-reject logs.

## Files

- `apps/gateway/src/hub/hub-runtime.ts` (+ tests)
- `apps/gateway/src/hub/uplink-server.ts` (+ tests)
- `packages/app/src/commands/hub.ts`, `enroll.ts` (+ tests)
- `apps/gateway/src/mesh/integration/mesh.integration.test.ts`
- `docs/hub/2026082800-hub-node-operations.md`

`user-key-service` apply already rejected `node_id_reused`; no change there.

## Verified

- `apps/gateway` `bun test src/hub src/mesh/integration/mesh.integration.test.ts` then full `bun test`: **2432 pass, 0 fail**
- `packages/app` `bun test src`: **247 pass, 0 fail**
- `tsc --noEmit`: app **1**, gateway **22** (baseline 21; extra is `src/mesh/integration/dc-http-bulk.integration.test.ts`, outside this scope)
- `biome check` on changed source files: clean

## Open issues

None for this path. First-time join still mints a token-bound cert (required so redeem can locate the enrollment by `enroll_pk`); only an already-admitted same-key identity reuses the admitted cert and skips the second admit.
