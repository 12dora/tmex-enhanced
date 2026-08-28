# late-review should-fixes

## What changed

### 1. Duplicate admit from a lagging entry
Hub now treats “already admitted” as a first-class signal, not something the entry infers from local `node_certs`:

- Redeem JSON already had `already_admitted`; `enroll.redeemed` now includes it too.
- When the node is already admitted, both `enroll.redeemed` and `GET /api/hub/enrollments/:id` return **the admitted certificate** (not the new enrollment cert) plus `already_admitted: true`. Pending GET also carries `already_admitted: false`.
- Enroll CLI skips `admit-node` whenever the hub says `alreadyAdmitted`, even if local `node_certs` has no row. Remote enroll polls `GET /api/hub/enrollments/:id` (falls back to node list if the create response has no id).
- FE/mesh-routes DTO: extra JSON field; mesh uplink decoder ignores `already_admitted`. Sending the admitted cert means a lagging Nodes page will fail `enroll_pk` match (`unknown`) instead of issuing a second admit. FE not edited.

### 2. Bind X25519
Hub re-use/PoP now compares **both** Ed25519 and X25519 public keys from the existing admitted (or stored enrollment) cert against the redeem certificate. Mismatch → 409 `node_exists`.
CLI `assertJoinCertReusable()` does the same against current identity; mismatch → `join identity mismatch: Ed25519/X25519 public keys do not match this node identity`.

### 3. Auth-reject log hygiene
- `auth.response.node_id` must be 32 **lowercase** hex at protocol decode; otherwise the link closes with `protocol_error` and the raw id is never logged.
- Logged client-provided fields are escaped (`\n`/`\r`/`\t`/control bytes).
- Global (and per-remote-address when `accept({ remoteAddress })` is set) cap: 20 lines / 10s, independent of attacker-chosen keys. Next emitted line includes `suppressed=N`. Per-key 10s coalescing kept.

## How verified

- `cd apps/gateway && bun test src/hub src/mesh/integration/mesh.integration.test.ts` — 65 pass, 0 fail
- `cd apps/gateway && bun test` — 2436 pass, 0 fail (baseline 2432 + new tests)
- `cd packages/app && bun test src` — 250 pass, 0 fail (baseline 247 + new tests)
- `bunx tsc --noEmit -p .`: gateway 21, app 1 (baselines)
- `bunx biome check` on all changed files — clean

## Open issues

- Nodes-page FE still does not consume `already_admitted`. With the admitted cert in poll/push it should no longer double-admit (enroll_pk mismatch → ignore), but it will not print “already admitted” until FE is updated.
- Mesh `uplink-protocol` still does not decode `already_admitted` (out of scope). Extra field is ignored; hub→entry CLI path uses HTTP poll, not that decoder.
