# Result: mesh node names no longer degrade to raw ids

## Root cause

`GET /api/mesh/nodes` built `name` as `peer?.name ?? (isSelf ? 'self' : id)` from `peer_cache` only.

On a node entry:

- Hub `node.list` already carried enrolled-node names (`nodes.name`), and `UplinkClient.persistAdmittedPeers` wrote them into `peer_cache` when a cert existed.
- The **hub’s own row is not in the hub `nodes` registry** (self-admit writes a cert, not a `nodes` row). `buildNodeList` therefore omitted the hub from `nodes[]`, and `hub_meta` was `{ nodeId, publicUrl }` with no display name, stored under sentinel id `hub` rather than the real hub nodeId. `collectNodes` looks up by real id → name fell back to the hex id.
- Self was hardcoded to `'self'` even though `node.list` includes the entry’s registered name. Self is never upserted into `peer_cache` (peer-manager would try to dial it).
- LAN `peer-manager.applyPeerStatus` (out of scope) can later overwrite `peer_cache.name` with the raw id when status has no name.

On a hub entry the same DTO ignored `nodes` registry names, so names were missing until uplink catch-up filled `peer_cache`.

## Frontend `'self'` (report only, no FE edits)

| Location | Usage |
|---|---|
| `apps/fe` | `nodeId === 'self'` / `SELF_NODE_ID` is a **runtime/route** sentinel, never `name === 'self'`. `isSelf` is `node.id === entryNodeId`. Sidebar/NodesPage render `row.name` and a separate self tag. |
| `packages/panels` | `node-badge.test` uses `nodeId: 'self'` as a label fallback for blank names, not the mesh DTO. |
| `packages/stores` | no `name === 'self'`. |

Safe to emit the registered name on the self row. `isSelf` stays `id === mode.nodeId`. No `displayName` field added.

## What changed

- **Hub `node.list`**: advertise hub display name (`HubRuntimeConfig.siteName` / `TMEX_SITE_NAME` / `os.hostname()`, preferring a non-id `nodes.name`) in `hub_meta.name` **and** as a `nodes[]` entry so clients persist it.
- **Protocol**: optional `hub.name` on mesh + hub uplink codecs (backward compatible).
- **Uplink client**: persist hub under the real hub nodeId when a matching cert exists; update on later lists.
- **mesh-routes**: name priority `node.list` → `nodes` registry → `peer_cache` (skip raw id / `'self'`) → selfName. Self last-resort remains `'self'`.
- **mesh-runtime**: wires `listedNames` from last `node.list` (beats peer-manager clobber) and `selfName` from listed/registry/site name. Does not persist self into `peer_cache`.
- **onNodeList**: do not delete the hub peer; emit `NODE_EVENT` with name (including hub-only-in-`hub_meta`).

## Tests

- `mesh-routes.test.ts`: registry names with empty `peer_cache`; listed names beat id-as-name in cache; self uses registered name.
- `mesh-runtime.test.ts`: after `node.list`, `/api/auth/nodes` shows peer/hub/self names; `peer_cache` keeps peers/hub (not self); rename emits `NODE_EVENT` and updates DTO.
- `uplink-client.test.ts`: hub name persist + rename.
- `uplink-server.test.ts`: `hub_meta.name` + hub row in `nodes[]`.

## Verification

- `cd apps/gateway && bun test` → **2326 pass, 0 fail** (was 2321; +5).
- `bunx tsc --noEmit -p .` → **21 errors** (baseline).
- `bunx biome check <changed files>` → clean.

## Open issues

- `peer-manager.ts` still overwrites `peer_cache.name` with the node id when LAN status omits `name` (read-only in this task). Live GET is protected by `listedNames` from the current `node.list`. After a node restart, a LAN handshake can clobber cache until the next `node.list`.
- `upsertHubMeta` still stores `name: nodeId` on the `'hub'` sentinel (user-store out of scope). Display name lives on the real hub nodeId `peer_cache` row.
- Old hubs that do not send `hub.name` / hub `nodes[]` entry still show the hub as an id until upgraded.
