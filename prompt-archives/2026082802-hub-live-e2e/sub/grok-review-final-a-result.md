# Review-final batch A result

## What changed

### 1. Hub redeem proof-of-possession (§4)

Binding a **new** enrollment token to an **existing** `nodeId` now requires an Ed25519 PoP from the node key already stored for that node.

- Request field: `pop` (base64url 64-byte signature).
- Signed message (`encodeRedeemPopMessage`): domain `tmex/redeem-pop/v1`, enrollment id (`b64url(enroll_pk)` — the identifier the joiner already has), raw 16-byte `node_id`, `sha256(cert bytes)`.
- Verified against the **stored** `ed_pk` (cert or last redeemed enrollment), not only the cert in the request.
- Missing / malformed / wrong-key proof → `409 { error: "node_exists" }`.
- First-time redeem (no existing node row) does not require `pop`.
- Exact same-token replay is still idempotent (replay path runs before the existing-node check).

CLI `hub join` always attaches `pop` (via a fetch wrapper around `redeemEnrollment`). First-time join stays compatible; re-join of the same node now proves possession.

### 2. Peer-name spoof (§6)

- `applyPeerStatus` no longer writes `msg.name` into `peer_cache`. Name is `existing.name ?? peerNodeId`. Endpoints / inventory / `direct_capable` still update.
- `/api/mesh/nodes` name order is hub `node.list` → local hub `nodes` registry → (self only) local self name → id. `peer_cache.name` is not used.

### 3. Unhandled rejection (§7 should-fix)

`void pending.finally(...)` on the DC upgrade-retry path now has `.catch(() => undefined)` so a rejected upgrade does not become an unhandled rejection.

## Extra file

`apps/gateway/src/mesh/integration/mesh.integration.test.ts` — second enrollment now sends a valid `pop`. Required so the existing “joins twice” path matches the new server rule.

## How verified

- `cd apps/gateway && bun test src/hub src/mesh/peer-manager.test.ts src/mesh/mesh-routes.test.ts` → **119 pass, 0 fail**
- New / updated cases:
  - same key + valid PoP → 200; same key without / with bad PoP → 409; different signing key → 409
  - peer `node.status` name does not change `peer_cache` or `/api/mesh/nodes`
  - rejected DC upgrade retry: `process.on('unhandledRejection')` counter stays 0
- `bun test src/mesh/integration/mesh.integration.test.ts` → **11 pass, 0 fail**
- `packages/app` `bun test src/commands/join.test.ts` → **12 pass, 0 fail**
- `apps/gateway` `bunx tsc --noEmit -p .` → **21 errors** (baseline)
- `packages/app` `bunx tsc --noEmit -p .` → **1 error** (baseline)
- `bunx biome check` on changed files → clean

## Open issues

Full `apps/gateway bun test` still reports failures in `forwarder` / stream-failover (other agents’ files, out of this batch). After the PoP integration tweak, the mesh “joins twice” test passes.
