# G1 result — multi-hub backend foundation

## Legacy-compat finding (critical)

**Neither the current decoder nor v1.1.5 (`585fb498`) rejects unknown keys** on `node.list` / `node.status`.

Both `decodeMeshUplinkCtl` and `decodeHubUplinkCtl` (v1.1.5 and HEAD) pick known fields and ignore extras. `assertCtlBounds` only enforces depth / string length / array length — it does **not** whitelist keys. A new `node.list` with `hubs` / `writerHubId` / `writerEpoch` (and a `node.status` with `hub` advertisement) therefore **decodes on v1.1.5 nodes** as long as the extra values stay within existing bounds (`UPLINK_CTL_MAX_STRING_LEN=4KiB`, `UPLINK_CTL_MAX_ARRAY_LEN=1024`, depth 8). 16 hubs × URL ≤ 512 is well inside those limits.

The singular `hub` field is unchanged and still describes the writer/active hub for old nodes.

`{ legacy: true }` is still implemented on both encoders so G3 can strip the new fields per-node by version if desired. It is **not required** for v1.1.5 decoder survival.

## Exported names / signatures shipped

### `packages/shared/src/uplink/codec.ts` (package export `@tmex/shared/uplink` — there is no `uplink/index.ts` barrel; `package.json` maps `./uplink` → `codec.ts`)

```ts
export type HubMode = 'active' | 'standby';

export interface HubEndpointInfo {
  nodeId: string;
  publicUrl: string;
  name?: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint?: string | null;
  online?: boolean;
  lastSeenAt?: number | null;
}

export interface HubAdvertisement {
  publicUrl: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  caFingerprint?: string | null;
}

export type EncodeUplinkCtlOptions = { legacy?: boolean };

export function encodeMeshUplinkCtl(msg: MeshUplinkCtlMessage, opts?: EncodeUplinkCtlOptions): Uint8Array
export function encodeHubUplinkCtl(msg: HubUplinkCtlMessage, opts?: EncodeUplinkCtlOptions): Uint8Array
```

`MeshUplinkNodeList` / `NodeListMessage` gained optional `hubs?: HubEndpointInfo[]`, `writerHubId?: string`, `writerEpoch?: number` (singular `hub` kept). `node.status` (mesh + hub `NodeStatusMessage`) gained optional `hub?: HubAdvertisement`.

Also exported (helpers / bounds): `UPLINK_CTL_MAX_HUBS = 16`, `UPLINK_CTL_MAX_HUB_URL_LEN = 512`.

### `packages/shared/src/uplink/errors.ts` (re-exported from `codec.ts`)

```ts
export const HUB_NOT_WRITER = 'HUB_NOT_WRITER';
export type HubNotWriterError = {
  code: typeof HUB_NOT_WRITER;
  writerHubId: string | null;
  writerPublicUrl: string | null;
  writerEpoch: number | null;
};
```

### Gateway config — `apps/gateway/src/config.ts`

```ts
export function parseHubMode(raw: string | undefined): HubMode
export function parseHubPriority(raw: string | undefined, mode: HubMode): number
export function parseHubWriterEpoch(raw: string | undefined): number
export function parseHubUrls(seed: string | null, raw: string | undefined): string[]

config.hubMode: HubMode          // TMEX_HUB_MODE; default 'active'; else error
config.hubPriority: number       // TMEX_HUB_PRIORITY; ≥0; default 100 active / 200 standby
config.hubWriterEpoch: number    // TMEX_HUB_WRITER_EPOCH; ≥1; default 1
config.hubUrls: string[]         // TMEX_HUB_URL first, then TMEX_HUB_URLS csv, exact-trim de-dup
config.hubUrl                    // unchanged
```

### Store — `apps/gateway/src/auth/mesh-hub-store.ts` (also re-exported from `apps/gateway/src/auth/index.ts`)

```ts
export interface MeshHubRecord {
  hubNodeId: string; publicUrl: string; name: string | null; mode: HubMode;
  priority: number; writerEpoch: number; caFingerprint: string | null;
  online: boolean; lastSeenAt: number | null; updatedAt: number;
}
export class MeshHubStore {
  constructor(db: AuthDb)
  list(): MeshHubRecord[]
  get(hubNodeId: string): MeshHubRecord | null
  upsert(rec: Omit<MeshHubRecord, 'updatedAt'>, now: number): void
  replaceAll(recs: Array<Omit<MeshHubRecord, 'updatedAt'>>, now: number): void
  remove(hubNodeId: string): void
  orderedEndpoints(): Array<{
    hubNodeId: string; publicUrl: string; mode: HubMode;
    writerEpoch: number; priority: number; caFingerprint: string | null;
  }>
}
export function hubListToRecords(hubs: HubEndpointInfo[]): Array<Omit<MeshHubRecord, 'updatedAt'>>
export function pickWriterHub(
  hubs: Pick<MeshHubRecord, 'hubNodeId' | 'mode' | 'writerEpoch' | 'priority'>[]
): string | null
```

`list()` / `orderedEndpoints()` order: active by `writerEpoch` desc then `priority` asc, then standby by `priority` asc, then `publicUrl`. `pickWriterHub`: highest-epoch active, tie → lowest priority, tie → lexicographic `hubNodeId`.

Schema table `meshHubs` + type `MeshHubRow` in `apps/gateway/src/db/schema.ts`.

## Migration

- SQL: `apps/gateway/drizzle/0032_mesh_hubs.sql`
- Journal tag: `0032_mesh_hubs` (idx 32)
- Snapshot: `apps/gateway/drizzle/meta/0032_snapshot.json` (`prevId` = 0031)

Generated with `bunx drizzle-kit generate`, then renamed from `0032_special_sentinel` → `0032_mesh_hubs` (journal tag updated to match).

## Files touched

- `packages/shared/src/uplink/codec.ts`
- `packages/shared/src/uplink/codec.test.ts`
- `packages/shared/src/uplink/errors.ts` (new)
- `apps/gateway/src/config.ts`
- `apps/gateway/src/config.test.ts`
- `apps/gateway/src/db/schema.ts`
- `apps/gateway/drizzle/0032_mesh_hubs.sql` (new)
- `apps/gateway/drizzle/meta/_journal.json`
- `apps/gateway/drizzle/meta/0032_snapshot.json` (new)
- `apps/gateway/src/auth/mesh-hub-store.ts` (new)
- `apps/gateway/src/auth/mesh-hub-store.test.ts` (new)
- `apps/gateway/src/auth/index.ts` (re-exports only)
- `docs/hub/2026082800-hub-node-operations.md` (env table: `TMEX_HUB_MODE` / `PRIORITY` / `WRITER_EPOCH` / `URLS`)

Did **not** touch `mesh-runtime.ts`, `uplink-client.ts`, `uplink-server.ts`, `hub-runtime.ts`, `packages/app`, `apps/fe`. Did **not** change `packages/shared/package.json` (uplink still points at `codec.ts`).

## Verification

| Check | Result |
|---|---|
| `packages/shared && bun test` | **409 pass / 0 fail** (40 files) |
| `packages/shared && bunx tsc --noEmit -p .` | **0 errors** |
| `apps/gateway` owned tests (`config.test.ts` + `mesh-hub-store.test.ts`) | **35 pass / 0 fail** |
| `apps/gateway && bun test` (full) | **3103 pass / 8 fail / 4 errors** — all failures are G4 in-progress (`src/system/{upgrade,upgrade-service,release-download,remote-upgrade-job}.test.ts`, `src/api/system.test.ts` staged-package). None in G1 files. Baseline was 3134; delta is G4 incomplete tests, not this change. |
| `apps/gateway && bunx tsc --noEmit -p .` | errors **only** in G4 files (`system.test.ts` / `release-download.test.ts` / `upgrade.test.ts`). G1 files: **0**. |
| `bunx biome check` on G1 source files | **clean** (9 files) |

## Commander / later agents

- G3: encode `node.list` with `encodeHubUplinkCtl(msg)` (new fields included). Optional `encodeHubUplinkCtl(msg, { legacy: true })` strips `hubs` / `writerHubId` / `writerEpoch` (and `hub` on `node.status`). Not required for v1.1.5.
- G2: persist `node.list.hubs` via `hubListToRecords` + `MeshHubStore.replaceAll`; failover order is `orderedEndpoints()`.
- G5: CLI can write `TMEX_HUB_MODE` / `PRIORITY` / `WRITER_EPOCH` / `URLS`; they are documented as hand-written env until CLI lands.
- If another agent also `drizzle-kit generate`s, they must start from **0033** — 0032 is taken.

## Open risks

- Concurrent G4 has incomplete upgrade tests/modules; full gateway suite/tsc is not green until G4 finishes. G1-owned tests are green.
- `hubUrls` de-dup is exact trimmed string, not `canonicalHubUrl` — matches existing `hubUrl` (no URL parse in config).
- `writerHubId` on the wire is 32-hex (`mNodeId`); invalid hex is rejected, absent/null → `undefined`.
