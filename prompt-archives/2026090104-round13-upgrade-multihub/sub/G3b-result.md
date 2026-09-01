# G3b result — RV3 hub-side security fixes (allowlist / persisted fencing / key-log gate)

## Fix mapping

| Item | Status |
|---|---|
| F1 RV3 blocker 1 — only authorized hubs advertise / list / fence | Done |
| F2 RV3 blocker 3 — start-time fencing from store + writer gate on HTTP writes | Done |
| F3 RV3 blocker 5 — standby `key.log.append` identical-replay only | Done |
| F4 RV3 should-fix 2 — own row from config snapshot; ignore source=self | Done |

Threat model held: a compromised ordinary node can authenticate, but its `node.status.hub` is dropped, never enters `mesh_hubs`, never wins `pickWriterHub`, never fences, never broadcasts `caFingerprint`.

## F1 — `TMEX_HUB_PEERS` / `authorizedHubIds`

New config:

```ts
parseHubPeers(raw?: string): string[]
config.hubPeers: string[]  // default []
```

CSV of 32-hex node ids, lowercased, empty parts skipped, de-duplicated (first occurrence wins). Invalid token → throw `TMEX_HUB_PEERS must be comma-separated 32-hex node ids`.

`HubRuntimeConfig.authorizedHubIds?: string[]`. Wired in `mesh-runtime.ts`:

```ts
authorizedHubIds: config.hubPeers ?? gatewayConfig.hubPeers,
```

`UplinkServer` accepts `node.status.hub` only if sender ∈ `authorizedHubIds ∪ {self}`. Otherwise drop + rate-limited warn (once per node / 10 min):

```
[hub] ignored hub advertisement from unauthorized node=<id>
```

`pickWriterHub` and `node.list.hubs` run over **authorized** rows only.

Replication (`applyReplicatedNodeList` → `replaceAll`) filters `list.hubs` to `authorizedHubIds ∪ {self} ∪ {meta.hubNodeId}`. Source hub is trusted because the node authenticated it as the attached hub.

## F2 — persisted fencing + writer gate

Construction reads `MeshHubStore.list()` **before** upserting self. If an authorized active row has `writerEpoch` strictly greater than own config epoch → `currentMode = 'standby'` and:

```
[hub] starting fenced: higher writerEpoch=… from hub=…
```

Own row is then upserted as `standby` (same env epoch stays fenced across restarts as long as the higher-epoch authorized row is still in `mesh_hubs`). Priority stays at the config value.

HTTP writes (`enrollments` / `redeem` / `rename` / `revoke`) require `UplinkServer.isWriter()`:

```
mode() === 'active' && pickWriterHub(authorized rows) === self
```

Otherwise `409` `HubNotWriterError`. If this process has no valid hub node id and no known writer, active still serves (legacy constructors without `hubNodeId`).

## F3 — standby key-log append

Existing ack type is `key.log.ack` (not `key.log.append.ack`). Standby / non-writer:

- identical replay of an already-present record (same seq + same bytes/sig ⇒ same hash) → `ok: true`
- any chain-extending record is **not** applied; ack:

```ts
{
  t: 'key.log.ack',
  id,
  ok: false,
  error: 'HUB_NOT_WRITER',
  writerHubId, writerPublicUrl, writerEpoch  // extra enumerable fields; hub encoder JSON-passthrough
}
```

`key.log.req` serving is unchanged. Active append path unchanged.

Shared codec still only *decodes* `{t,id,ok,error|seq}`; extra writer fields survive on the wire (hub encoder is `encodeJsonBytes(msg)`) but node decoder currently drops them. Node already keys off `error === 'HUB_NOT_WRITER'` (`uplink-key-log-sync.ts` `pushMissingToHub`). Commander: optional additive fields on `KeyLogAckMessage` / `MeshUplinkKeyLogAck` if the node should read writer URL from the ack.

### Key-log origin investigation (do not edit mesh beyond the wiring line)

| Surface | File / function | Local first? | Then hub? |
|---|---|---|---|
| Browser-signed admit/revoke/passkey/TOTP via entry `POST /api/auth/keylog` **without** `?hub=sync`, on `hub,node` or standalone | `MeshAuthRoutes.handleKeyLog` (`apps/gateway/src/mesh/auth-routes.ts`) | **Yes** — `this.deps.keyLogService.apply` persists first | Then `publisher.publish` (`createKeyLogPublisher.publish` → `uplink.sendCtl({t:'key.log.append'})`) best-effort, no ack |
| Same POST with `?hub=sync`, **or** node-only role (`roles.node && !roles.hub`) | `handleKeyLog` → `handleKeyLogHubSync` | **No** — `previewKeyLog` is in-memory only | `publisher.publishAndAck` (`UplinkClient.appendAndAck`) then local `keyLogService.apply` |
| Hub HTTP revoke | `HubRuntime.handleRevoke` | Hub-local `keyLogSource.append` (gated by `isWriter()` now) | N/A (this process is the hub) |
| Node reconnect catch-up when local seq > hub head | `UplinkKeyLogSync.pushMissingToHub` | Records already local | `appendAndAck` each missing seq; already treats `HUB_NOT_WRITER` as defer |
| Hub ctl `key.log.append` | `UplinkServer.handleKeyLogAppend` | Hub apply (now writer-gated) | N/A |
| First user on hub | `UserKeyService.bootstrapUserWithSelfAdmit` | Local genesis + self `admit-node` | No uplink |

**Node-side gate needed:** `MeshAuthRoutes.handleKeyLog` local-first branch (`keyLogService.apply` then `publisher.publish`) on a dual-role / standalone entry that is attached to a non-writer hub. Gate on “attached hub is writer” before `apply`. `handleKeyLogHubSync` is already hub-first and will see `HUB_NOT_WRITER` from this change (today mapped to generic 409).

## F4 — own row snapshot

`HubRuntime.applyReplicatedNodeList` no longer `meshHubs.get(ownId)`. It always re-inserts `UplinkServer.ownHubSnapshot()` (`mode` / `priority` / `writerEpoch` / `publicUrl` / cached `caFingerprint`). Lists whose `meta.hubNodeId === self` are still ignored (node side should pass the authenticated attached hub id).

## New config / API

```ts
// config.ts
export function parseHubPeers(raw: string | undefined): string[]
config.hubPeers: string[]

// HubRuntimeConfig
authorizedHubIds?: string[]

// UplinkServer
isWriter(): boolean
ownHubSnapshot(): OwnHubRow | null
notWriterError()  // pickWriterHub over authorized rows

// applyReplicatedNodeList self
{ hubNodeId, record, authorizedHubIds?: string[] }
```

Env table: one line `TMEX_HUB_PEERS` in `docs/hub/2026082800-hub-node-operations.md`.

`MeshRuntimeConfig.hubPeers?: string[]` was added so the mandated wiring line typechecks (G2b owns the rest of that file).

## Tests

TDD: flipped the two insecure assertions first (unauthorized high-epoch ad used to fence; standby used to accept extending append). Watched 8 RED, then implemented.

| Suite | Result |
|---|---|
| `bun test src/hub` | **90 pass / 0 fail** (7 files, 854 expects). Was 85 / 817. **+5** tests |
| `bun test src/config.test.ts` | **32 pass / 0 fail** (94 expects). **+2** (`TMEX_HUB_PEERS`) |
| combined `src/hub src/config.test.ts` | **122 pass / 0 fail** |

New / flipped coverage:

- Unauthorized high-epoch ad: no demote, not in `hubs[]`, not writer, warn once
- Authorized high-epoch ad: fencing unchanged
- Restart with authorized higher-epoch active in store: starts standby + log
- Active-but-not-writer HTTP writes: 409
- Standby extending append: `key.log.ack ok:false error=HUB_NOT_WRITER` + writer fields on the wire; identical replay ok; `key.log.req` still served
- Replication: own row restored from snapshot after delete; stranger hub filtered; source + authorized kept

## Verification

| Check | Result |
|---|---|
| `bun test src/hub src/config.test.ts` | 122 pass / 0 fail |
| `bunx tsc --noEmit -p .` (apps/gateway) | **0 errors in owned files**. Remaining: `src/mesh/uplink-pool.test.ts` (G2b: duplicate `implementation`, fetch `preconnect`) |
| `bunx biome check` on changed files | **clean** (23 files) |
| `bun test src/mesh/integration/multi-hub.integration.test.ts` | **0 pass / 10 fail / 1 skip** — see harness note |

## Commander / harness (do not edit)

Integration fails because the harness never sets `authorizedHubIds`.

**Option to set:** `createMeshRuntime({ config: { hubPeers: string[] } })` → `HubRuntimeConfig.authorizedHubIds`. Add the same field on `EnrollOpts` / `bootHubA` config in `multi-hub-harness.ts` and pass it through (around the `createMeshRuntime` `config: { hubMode, hubPriority, hubWriterEpoch, ... }` block).

Concrete:

1. `bootAbcdTopology` waits for B’s row in A’s `mesh_hubs`. A’s `hubPeers` **must include B’s `mesh.nodeId`**, otherwise B’s advertisement is ignored and that wait times out.
2. Epoch-fencing E: **A’s `hubPeers` must include E’s node id before E advertises.** A starts first, so generate E’s identity (or enroll then reconstruct A — no runtime setter) and pass the id into A’s `config.hubPeers` at HubRuntime construction.
3. **F2 trap:** `enrollAndStart` seeds parent A into the new hub’s store at `writerEpoch: 99`. If E (`writerEpoch: 2`, `mode: 'active'`) also has A in `hubPeers`, construction fences E to standby and E will never fence A. For E: either omit A from E’s `hubPeers`, or seed parent epoch ≤ E’s epoch. B is already `standby`, so authorizing A is fine.
4. Isolated `bootHubA` `waitOnline` 5s timeouts look like G2b uplink-attach work (A does not need peers). Not chased.

## Files touched

- `apps/gateway/src/config.ts` / `config.test.ts`
- `apps/gateway/src/hub/types.ts`
- `apps/gateway/src/hub/uplink-server.ts` / `uplink-server.test.ts`
- `apps/gateway/src/hub/hub-runtime.ts` / `hub-runtime.test.ts`
- `apps/gateway/src/hub/hub-replication.ts` / `hub-replication.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` — `authorizedHubIds` line + `MeshRuntimeConfig.hubPeers?: string[]`
- `docs/hub/2026082800-hub-node-operations.md` — one env line

## Open risks

- `authorizedHubIds` is static at construction; no runtime `tmex hub allow` hook in this agent (G5b).
- Node decoder still strips writer fields on `key.log.ack`; error string is enough for current node code.
- Dual-role `POST /api/auth/keylog` still applies locally first (`handleKeyLog`); hub-side gate does not stop an entry node from forking its own DB until the node-side agent gates that function.
