# G1 — Backend foundation for multi-hub: shared wire contract, config, schema, store

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly.

## Background

tmex has a hub/node mesh (design: `docs/hub/2026082700-hub-node-architecture.md`, operations: `docs/hub/2026082800-hub-node-operations.md`). Today exactly one hub exists: nodes hold one `TMEX_HUB_URL`, the hub broadcasts `node.list` with a singular `hub?: { nodeId, publicUrl, name? }` field (`packages/shared/src/uplink/codec.ts` ~line 172 and the decoder ~line 524), and nodes keep a sentinel `peer_cache` row `node_id='hub'`.

We are adding **phase-1 multi-hub (active/standby, single writer, ordered failover)**. You build the foundation other agents will code against **right after you finish**, so the names below are a contract — implement them exactly.

## Deliverables

### 1. Shared wire contract — `packages/shared/src/uplink/codec.ts` (+ its tests)

Add (exported):

```ts
export type HubMode = 'active' | 'standby';

export interface HubEndpointInfo {
  nodeId: string;        // the hub's node id (hex)
  publicUrl: string;     // https://host[:port]
  name?: string;
  mode: HubMode;
  priority: number;      // lower = preferred among same mode
  writerEpoch: number;   // monotonically increasing; highest active wins
  caFingerprint?: string | null; // SPKI fingerprint of a private CA, if the hub uses one
  online?: boolean;      // as seen by the broadcasting hub
  lastSeenAt?: number | null;
}

/** A node that runs the hub role advertises itself in node.status. */
export interface HubAdvertisement {
  publicUrl: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint?: string | null;
}
```

- `node.list` message: keep the existing singular `hub` (it must continue to describe the **writer/active** hub for old nodes) and add optional `hubs?: HubEndpointInfo[]`, `writerHubId?: string`, `writerEpoch?: number`.
- `node.status` message: add optional `hub?: HubAdvertisement`.
- Encoder/decoder: new fields optional; validate shapes (mode enum, finite non-negative integers, publicUrl is http(s) URL string ≤ 512 chars, at most 16 hubs). Decoding must be tolerant: unknown/absent → `undefined`.
- **Backward-compat check (critical)**: verify how the *current* decoder and the **v1.1.5** decoder (`git show v1.1.5:packages/shared/src/uplink/codec.ts`) treat unknown keys in `node.list` / `node.status`. If either rejects unknown keys, say so prominently in your result and implement whatever the encoder side needs so old nodes are not broken (e.g. an `encodeNodeList(msg, { legacy: true })` option that strips the new fields; the hub-side agent will use it per-node based on the node's reported version). Add tests proving a legacy-encoded payload decodes on the old shape and the new one round-trips.
- Also add to the ctl/error vocabulary a constant `HUB_NOT_WRITER = 'HUB_NOT_WRITER'` (export from the codec or a small `packages/shared/src/uplink/errors.ts` and re-export via the existing uplink barrel) with the JSON error body shape `{ code: 'HUB_NOT_WRITER', writerHubId: string | null, writerPublicUrl: string | null, writerEpoch: number | null }` typed as `HubNotWriterError`.

### 2. Gateway config — `apps/gateway/src/config.ts` (+ test)

Add env-driven fields (see how `hubUrl` / `hubPublicUrl` are parsed there):

- `hubMode: HubMode` from `TMEX_HUB_MODE` (`active` default when hub role is enabled; `standby` allowed; anything else → error like other invalid config).
- `hubPriority: number` from `TMEX_HUB_PRIORITY` (integer ≥ 0; default 100 for active, 200 for standby).
- `hubWriterEpoch: number` from `TMEX_HUB_WRITER_EPOCH` (integer ≥ 1; default 1).
- `hubUrls: string[]` from `TMEX_HUB_URLS` (comma-separated, optional) — merged after `TMEX_HUB_URL` (seed first, de-duplicated, each validated like `hubUrl`). Keep `hubUrl` as-is for compatibility.

Document the keys in `docs/hub/2026082800-hub-node-operations.md` "环境变量" table (one line each, 简体中文).

### 3. Schema + migration — `apps/gateway/src/db/schema.ts`, new `apps/gateway/drizzle/00NN_mesh_hubs.sql`

Look at how the latest migration is numbered and registered (check `apps/gateway/drizzle/meta/_journal.json` and how earlier hub migrations like `0022_hub_trust.sql` were added; follow the exact same procedure so migrations apply at startup in tests and prod). New table on **every** node (hub and non-hub):

```sql
CREATE TABLE mesh_hubs (
  hub_node_id TEXT PRIMARY KEY,
  public_url TEXT NOT NULL,
  name TEXT,
  mode TEXT NOT NULL,            -- active | standby
  priority INTEGER NOT NULL,
  writer_epoch INTEGER NOT NULL,
  ca_fingerprint TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  updated_at INTEGER NOT NULL
);
```

### 4. Store — new `apps/gateway/src/auth/mesh-hub-store.ts` (+ test)

Follow the style of `apps/gateway/src/auth/hub-trust-store.ts` / `user-store.ts` (same `AuthDb` type):

```ts
export interface MeshHubRecord { hubNodeId: string; publicUrl: string; name: string | null; mode: HubMode; priority: number; writerEpoch: number; caFingerprint: string | null; online: boolean; lastSeenAt: number | null; updatedAt: number }
export class MeshHubStore {
  constructor(db: AuthDb)
  list(): MeshHubRecord[]                       // ordered: active by writerEpoch desc then priority asc, then standby by priority asc, then publicUrl
  get(hubNodeId: string): MeshHubRecord | null
  upsert(rec: Omit<MeshHubRecord, 'updatedAt'>, now: number): void
  replaceAll(recs: Array<Omit<MeshHubRecord, 'updatedAt'>>, now: number): void   // transactional: delete rows not present, upsert the rest
  remove(hubNodeId: string): void
  /** Ordered failover candidates: same order as list(). */
  orderedEndpoints(): Array<{ hubNodeId: string; publicUrl: string; mode: HubMode; writerEpoch: number; priority: number; caFingerprint: string | null }>
}
export function hubListToRecords(hubs: HubEndpointInfo[]): Array<Omit<MeshHubRecord, 'updatedAt'>>
export function pickWriterHub(hubs: Pick<MeshHubRecord,'hubNodeId'|'mode'|'writerEpoch'|'priority'>[]): string | null  // active with highest writerEpoch, tie → lowest priority, tie → lexicographic id
```

Export the store from wherever sibling stores are exported (check `apps/gateway/src/auth/index.ts` if it exists).

## Files you own

- `packages/shared/src/uplink/codec.ts`, `packages/shared/src/uplink/*.test.ts`, new `packages/shared/src/uplink/errors.ts` (+ the uplink barrel/index if one exists in that dir)
- `apps/gateway/src/config.ts`, `apps/gateway/src/config.test.ts` (or wherever config tests live)
- `apps/gateway/src/db/schema.ts`, new migration under `apps/gateway/drizzle/` + journal/snapshot updates as the repo's procedure requires
- new `apps/gateway/src/auth/mesh-hub-store.ts` + test; `apps/gateway/src/auth/index.ts` only if it is an export barrel
- `docs/hub/2026082800-hub-node-operations.md` (env table lines only)

Do NOT touch `mesh-runtime.ts`, `uplink-client.ts`, `uplink-server.ts`, `hub-runtime.ts`, `packages/app`, `apps/fe` — other agents own those.

## Verification

`cd packages/shared && bun test && bunx tsc --noEmit -p .` (tsc baseline 0), `cd apps/gateway && bun test && bunx tsc --noEmit -p .` (baseline 3134 pass / tsc 0), biome on changed files. The gateway test suite takes ~2.5 min.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G1-result.md` — include the exact exported names/signatures you shipped, the migration file name, the legacy-compat finding, and test/tsc counts. Write it, then exit.
