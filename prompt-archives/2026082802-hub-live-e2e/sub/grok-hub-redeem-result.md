# Hub enrollment redeem: same-identity re-join

## What changed

Redeem is idempotent for the **same node identity** (`nodeId` + Ed25519 public key).

Previously `POST /api/hub/enrollments/redeem` returned `409 node_exists` whenever a `nodes` row already existed for that id. That blocked re-join after a partial/failed local write (stable `node_identity`, new enrollment token).

Now:

- **Same `ed_pk`:** consume the new token, detach old tokens’ `node_id`, patch the existing row (new cert snapshot, name if provided, version, `status=enrolled`). Do **not** reset `lastSeenAt` / inventory / endpoints; leave the in-memory registry online. Push `enroll.redeemed` so the new enroller can admit (first admit of a never-admitted node).
- **Different `ed_pk` (or missing stored key):** still `409 node_exists`.
- **`GET /api/hub/nodes`:** prefers the latest enrollment-token cert over `node_certs`, so non-hub enroll pollers see the new enrollment.

Identity is read from `node_certs.ed_pk`, else the previous enrollment token’s stored certificate.

### Revoked nodes

Redeem of a **revoked** row with the same key is accepted (registry → `enrolled`, cert `revokedLogSeq` unchanged). Uplink still refuses while the cert is revoked.

A second `admit-node` for the same `node_id` is rejected by the shared keylog (`node_id_reused`), including after `revoke-node`. That layer is out of this task’s scope. Re-admit after revoke therefore requires a **new node identity** (new nodeId / keys), matching “重装换钥 = 重新 enroll + `revoke-node` 旧证书”.

### CLI

No change. `hub join` already calls `ensureNodeIdentity` before `createNodeCertificate(..., { nodeId })`.

## Files

- `apps/gateway/src/hub/hub-runtime.ts` — idempotent redeem, listNodes cert preference
- `apps/gateway/src/hub/node-persistence.ts` — `detachEnrollmentTokensFromNode`
- `apps/gateway/src/hub/hub-runtime.test.ts` — same-key one row + first admit; different key 409; keep-online; revoked re-redeem
- `apps/gateway/src/mesh/integration/mesh.integration.test.ts` — second enrollment redeem, still reachable
- `docs/hub/2026082800-hub-node-operations.md` — §加入 + 排障 `node_exists`

## Verified

- `cd apps/gateway && bun test`: **2355 pass, 0 fail** (baseline 2351 + 4)
- `bunx tsc --noEmit -p .`: **21** (at baseline)
- `bunx biome check` on changed TS files: **clean**

## Open issues

Keylog `node_id_reused` still blocks a second `admit-node` for an already-admitted (or revoked) nodeId. Partial-join recovery does not need it: the first admit is already in the chain, and join re-fetches `user_key_log` / `node_certs` after redeem. Un-revoking the same identity would need a shared keylog change.
