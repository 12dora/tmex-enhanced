# F1 result — devices page menu, file-transfer dialog, port-mapping dialog

Branch worktree: `/Users/konata/code/tmex-r32`. No git operations were performed.

## 1. What was built

### 1.1 Devices page header (`apps/fe/src/pages/DevicesPage.tsx`)

- `PageActions` now renders: 新建分组 button (unchanged, `devices-new-folder`, still gated on the page-commands
  registry) → `AddDeviceMenu` / `DeviceManagementActions` (unchanged) → **new ellipsis menu** (`devices-more`).
- The standalone 恢复布局 icon button is gone; the item moved into the menu.
- New file `apps/fe/src/pages/devices/devices-actions-menu.tsx`:
  - `DevicesActionsMenuList` — pure dropdown content (no hooks), exported for structural unit tests
    (Base UI menus render nothing under SSR). Items in order: `devices-open-transfer` (文件传输),
    `devices-open-portmap` (端口映射), separator, `devices-reset-layout` (恢复默认布局).
  - Transfer/portmap items are always enabled (they don't need the commands registry);
    `devices-reset-layout` is `disabled` when commands are absent or `layoutBusy`.
  - No `DropdownMenuLabel` is used, so the `DropdownMenuGroup` wrapper rule does not apply here.
  - The reset confirm is now the shared `ConfirmDialog` and keeps `data-testid="devices-reset-layout-confirm"`
    on the confirm button (container test id is `devices-reset-layout-dialog`).
  - Both dialogs are `lazyChunk`-loaded and only mounted while open (verified: separate
    `transfer-dialog-*.js` / `portmap-dialog-*.js` chunks in the vite build).

**Test impact**: `apps/fe/src/pages/DevicesPage.test.tsx` had three `PageActions` tests asserting
`devices-reset-layout` in static markup. Since the item is now inside a portal-rendered menu, those were
updated (order assertion is now 新建分组 → 更多; the disabled-state assertion moved to the new
`devices-actions-menu.test.tsx`). No e2e spec referenced these ids (grepped `apps/fe/tests`).

### 1.2 File transfer dialog — `apps/fe/src/pages/devices/transfer/`

| file | purpose |
|---|---|
| `transfer-dialog.tsx` | shell (`sm:max-w-5xl`, `max-h-[calc(100dvh-2rem)]`, `grid-cols-1 lg:grid-cols-2` body), default export |
| `transfer-pane.tsx` | one pane's markup |
| `use-transfer-pane.ts` | pane data layer (roots + list queries, entry filtering, keyboard, highlight-follows-focus) |
| `pane-state.ts` | pure reducer + selection helpers + `sendBlock` guard |
| `pane-toolbar.tsx` | breadcrumbs / root select / up + editable path / hidden-files switch |
| `entry-list.tsx` | multi-select files+dirs list (checkbox, shift-range, double-click to enter, content-visibility over 200 rows) |
| `transfer-queries.ts` | react-query options (`['devices-transfer','roots'\|'list', nodeId, …]`) |
| `send-transfer.ts` | grant → job → store + subscribe; `transferErrorKey` / `transferErrorKeyOf` |
| `use-send.ts` | submit controller (which side is in flight, error key) |
| `transfer-list.tsx` | the transfer list below the panes (`endpointLabel` exported) |
| `use-transfer-jobs-sync.ts` | on open: snapshot both selected nodes + subscribe running jobs; stop streams on close/unmount |

Behaviour details:
- Node picker: `useMeshNodes` + `useSharedAuthMode` → `toDialogNodeOptions` (self first via `sortNodes`);
  offline / not-logged-in nodes are listed but `disabled` with a reason tag
  (`devices.nodes.status.offline` / `.signedOut`). Standalone (empty node list) degrades to a single 本机 option.
- Each pane builds its own `createNodeApiClient(nodeId)`. No `NodeRuntimeScope`.
- Roots come from `fetchFileRoots(client)`, filtered to `enabled`; first root auto-selected once.
- Entries come from `fetchFileList(rootId, path, client)`; the response's `path` is synced back into the
  breadcrumb / path input. **`/api/files/list` has no `hidden` parameter**, so the hidden-files switch filters
  `name.startsWith('.')` client-side (dirs first, then case-insensitive numeric name sort).
- Send button is blocked with a title hint when: either side lacks node/root or the destination path is not yet
  absolute (`pickNodes`), the source has no selection (`pickSource`), or both sides are the same node + root +
  path (`sameTarget`).
- Send = `POST /n/<B>/api/transfer/grants` → `POST /n/<A>/api/transfer/jobs` → `upsertTransferJobSnapshot` →
  `subscribeTransferJob`. Errors are mapped by contract code to `devices.transfer.errors.*`.

### 1.3 Transfer jobs store — `packages/panels/src/files/`

| file | purpose |
|---|---|
| `transfer-jobs-store.ts` | the store: `Map<key, TransferJobView>` + pure reducers + browser-local entries |
| `transfer-job-stream.ts` | NDJSON subscription with reconnect/backoff and dedupe per `(nodeId, jobId)` |
| `transfers.ts` | **new package subpath** `@tmex/panels/files/transfers` re-exporting both |

- Keys: node jobs `${nodeId}:${jobId}`; browser jobs `local:${upload|download}:${id}` (a separate namespace so a
  browser upload can never collide with a node job).
- `subscribeTransferJob` loops: stream events → on end/drop re-fetch `GET /api/transfer/jobs/:id` → stop when the
  state is terminal or the job is gone (404) → otherwise back off `[500,1000,2000,4000,8000] ms` and reconnect.
  It also registers the row's cancel handler (`DELETE /api/transfer/jobs/:id`).
- Rate/ETA for node jobs come straight from the server payload (`ratePerSec` / `etaSec`); browser entries use the
  shared `createRateEstimator()` (3 s sliding window) when the total size is known.
- `transfer-toast.tsx` is now a renderer over a store row: `startTransferToast(name, direction, onCancel, entry?)`
  where the new optional 4th argument is `{ nodeId, totalBytes? }`. `use-directory-upload.ts` passes
  `{ nodeId: runtime.nodeId, totalBytes: file.size }`; `file-node-actions.tsx` passes
  `{ nodeId: runtime.nodeId, totalBytes: entry.size ?? undefined }`. The two legs are folded into one bar via
  `combineLegPct` (each leg counts half).
- `apps/fe/src/pages/FilePage.tsx` still calls the 3-arg form (it is outside F1's scope), so downloads started from
  the file viewer show only a toast and no list row. One-line change if the commander wants it included.

### 1.4 Port mapping dialog — `apps/fe/src/pages/devices/portmap/`

| file | purpose |
|---|---|
| `portmap-dialog.tsx` | shell (`sm:max-w-4xl`), default export |
| `use-portmap-list.ts` | `useQueries` aggregation over online+loggedIn nodes, 2 s `refetchInterval` while open; `flattenPortMaps` exported |
| `portmap-table.tsx` | the table + `targetNodeName` helper |
| `portmap-create-form.tsx` | form shell (runs both probes, computes the submit block) |
| `portmap-form-fields.tsx` | field grid + hints row |
| `portmap-form-state.ts` | pure: `parsePort`, `validatePortMapForm`, `listenProbeBlock`, `targetProbeHint`, `portMapSubmitBlock` |
| `use-port-probe.ts` | 500 ms debounced probes, aborted on change/unmount |
| `portmap-actions.ts` | create (B export → A map, rollback on failure), delete (A map → B export best-effort), `portMapErrorKey` |
| `use-portmap-mutations.ts` | submitting / busy-row / error-key state machine |

Columns: 名称 / 本机(`节点名:监听端口`, plus the listen host when it is not `127.0.0.1`) / 目标(`节点名:端口`) /
状态 / 连接数 `active / total` / 流量 `↓ in · ↑ out` / 操作(暂停·继续, 删除).
Delete goes through `ConfirmDialog` (`portmap-delete-confirm`, confirm button `portmap-delete-confirm-ok`).

Form: 监听节点 select, 监听地址 (`仅本机` 127.0.0.1 default / `所有地址` 0.0.0.0 with a one-line warning),
监听端口 (1–65535 validation + debounced probe; `端口已被占用` / `保留端口` disable submit), 目标节点,
目标地址 (127.0.0.1 default), 目标端口 (target-probe; `目标端口暂无服务` is a non-blocking hint), 名称 (optional).
A === B is rejected client-side (`监听节点与目标节点不能相同`).

### 1.5 api-client modules

- `packages/api-client/src/transfer.ts` + `transfer.test.ts`
- `packages/api-client/src/portmap.ts` + `portmap.test.ts`
- `packages/api-client/src/index.ts`: two added `export *` lines.

### 1.6 shared

- `packages/shared/src/format-bytes.ts`: added `formatEta(seconds | null)` → `m:ss` / `h:mm:ss`, `--` when unknown,
  capped at `99:59:59`. Re-exported from `packages/shared/src/index.ts` and `packages/api-client/src/format.ts`;
  `packages/shared/src/index.test.ts`'s export snapshot updated.

### 1.7 i18n

`devices.menu.*`, `devices.transfer.*`, `devices.portmap.*` added to
`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` (zh_CN authored first, en/ja synced, identical key
sets) and `bun run build:i18n` was run from the repo root. `devices.*` is a rest-bundle prefix, so none of this
lands in the first-screen bundle. The path badge reuses the existing `files.transfer.pathDirect` /
`files.transfer.pathRelay`; `local` uses the new `devices.transfer.pathLocal`.

> Note: the generated files also contain R1's `relay.*` additions, since R1 was editing the same locale JSONs
> concurrently. The commander should re-run `bun run build:i18n` once at the end.

---

## 2. Contract surface this code depends on (cross-check with T1 / T2)

### 2.1 Transfer (T1)

| method | path (relative to the node's client, i.e. prefixed with `/n/<id>` for remote nodes) | request | response |
|---|---|---|---|
| POST | `/api/transfer/grants` (on **B**) | `TransferGrantRequest` `{fromNodeId, destRootId, destPath}` — `fromNodeId` is A's **real mesh node id**, never `self` | `TransferGrantResponse` `{grantId, token, expiresAt}` (bare, no envelope) |
| POST | `/api/transfer/jobs` (on **A**) | `CreateTransferJobRequest` `{toNodeId, items:[{rootId,path}], destRootId, destPath, grant:{grantId,token}, onConflict}` — `onConflict` is always sent (`'skip'` by default); `toNodeId` is B's real mesh id | `{ job: TransferJobSnapshot }` |
| GET | `/api/transfer/jobs` (on A) | — | `{ jobs: TransferJobSnapshot[] }` |
| GET | `/api/transfer/jobs/:id` (on A) | — | `{ job: TransferJobSnapshot }` |
| GET | `/api/transfer/jobs/:id/events` (on A) | — | NDJSON of `TransferJobEvent`; must have a body |
| DELETE | `/api/transfer/jobs/:id` (on A) | — | any 2xx (204 fine) |

`TransferJobSnapshot` fields actually read by the UI: `jobId, state, fromNodeId, toNodeId, items[].relPath,
items[].state ('done'/'skipped' count as finished), currentIndex, progress{transferredBytes,totalBytes,
ratePerSec,etaSec}, path, error, errorDetail, createdAt, updatedAt, finishedAt`. `expanding`, `streams`,
`destRootId`, `destPath`, `items[].size`, `items[].transferredBytes` are accepted but not displayed yet.

`TransferJobEvent` handling: `snapshot` replaces the row; `progress` updates bytes/rate/eta and `updatedAt`;
`item` updates the current title and the done/total counters (uses `index` and `item.relPath`/`item.state`);
`state` sets the terminal state + `error`/`errorDetail`; `end` is a no-op. **An event stream that starts with
something other than `snapshot` for a job the browser has never seen is dropped** — please always emit
`snapshot` first (the plan already says so).

**Error bodies**: `ApiError.code` is read from the **top-level** `{code}` field, i.e. what
`jsonError(code, status)` in `apps/gateway/src/mesh/session-middleware.ts` produces. If transfer routes return
`{error:{code}}` instead, the UI will fall back to the generic "传输失败" copy. Codes with dedicated copy:
`node_unreachable, grant_invalid, grant_expired, peer_mismatch, offset_mismatch, incomplete, checksum_mismatch,
dest_exists, quota_file_size, cancelled, not_found, outside_roots, permission_denied, too_large,
connection_failed, timeout`.

### 2.2 Port mapping (T2)

| method | path | request | response |
|---|---|---|---|
| GET | `/api/portmap` (on A) | — | `{ maps: PortMapDto[] }` |
| POST | `/api/portmap` (on A) | `CreatePortMapRequest` `{name?, listenHost, listenPort, targetNodeId (B's real mesh id), targetHost, targetPort, mapId}` — `mapId` is the id returned by B's export; `name` omitted when blank | `{ map: PortMapDto }` |
| PATCH | `/api/portmap/:id` (on A) | `{paused: boolean}` (only the changed field is sent) | `{ map: PortMapDto }` |
| DELETE | `/api/portmap/:id` (on A) | — | any 2xx |
| GET | `/api/portmap/probe?host=&port=` (on A) | — | `PortProbeResponse` `{host, port, free, reserved, usedByMapId}` (bare) |
| GET | `/api/portmap/exports` (on B) | — | `{ exports: PortMapExportDto[] }` |
| POST | `/api/portmap/exports` (on B) | `CreatePortMapExportRequest` `{fromNodeId (A's real mesh id), host, port}` — the UI does **not** send `mapId`, it expects B to mint it | `{ export: PortMapExportDto }` (needs `mapId`) |
| DELETE | `/api/portmap/exports/:mapId` (on B) | — | any 2xx |
| GET | `/api/portmap/target-probe?host=&port=` (on B) | — | `TargetPortProbeResponse` `{host, port, listening}` (bare) |

`PortMapDto` fields read: `id, name, listenHost, listenPort, targetNodeId, targetPort, paused, state, error,
activeConnections, totalConnections, bytesIn, bytesOut`. The UI shows `paused ? 'paused' : state`.
Error codes with dedicated copy: `invalid_request, port_in_use, port_reserved, bind_failed, not_found,
target_unreachable, export_missing, limit_reached` — again read from a top-level `{code}`.

Ordering the UI enforces: **create** = POST export on B → POST map on A (DELETE the export if A fails);
**delete** = DELETE map on A → DELETE export on B (best effort, failures swallowed).

### 2.3 Reused existing endpoints

`GET /api/files/roots` (`fetchFileRoots`), `GET /api/files/list?rootId=&path=` (`fetchFileList`),
`GET /api/mesh/nodes` + `GET /api/auth/mode` via `useMeshNodes` / `useSharedAuthMode`.

---

## 3. Deviations from the task text

1. **The store is not zustand.** `@tmex/panels` has no `zustand` dependency (only `@tmex/stores` does, and
   node_modules are isolated per workspace), and adding one would have required a `bun install` + lockfile change
   while three other agents edit the tree. The store is a module-level `Map` + `useSyncExternalStore`, the same
   pattern `packages/panels/src/files/selected-file.tsx` already uses. The exported API (`useTransferJobs`,
   pure reducers, `subscribeTransferJob`, `startLocalTransfer`) is what the task asked for.
2. **New package subpath `@tmex/panels/files/transfers`** (one added line in `packages/panels/package.json`).
   Needed because `apps/fe/src/pages/FilePage.test.tsx` does `mock.module('@tmex/panels/files', …)` with only
   `startTransferToast`, which nukes any other export of that specifier for the whole `bun test src/` run.
   The store lives on its own subpath so it is immune to that replacement.
3. **Two shared files under `apps/fe/src/pages/devices/`** rather than inside `transfer/`+`portmap/`:
   `dialog-nodes.ts` (node option mapping) and `node-select.tsx` (the node dropdown), because both dialogs need
   them. `devices-actions-menu.tsx` also sits there. Nobody else touches this directory.
4. **Hidden-files toggle is client-side** — `/api/files/list` has no `hidden` parameter (only
   `/api/files/browse` does, and that endpoint is directories-only).
5. **`formatEta` returns a locale-free `m:ss` / `h:mm:ss`** so it needs no i18n key.
6. **`A === B` is rejected in the port-map form.** A self-to-self TCP map has no meaning and would open a stream
   to the node itself; the copy is `监听节点与目标节点不能相同`. If T2 supports it, drop the `sameNode` branch
   in `portMapSubmitBlock`.
7. **Progress streams stop when the transfer dialog closes** (`stopAllTransferSubscriptions` on unmount). Jobs
   keep running on the node; reopening the dialog re-fetches snapshots and re-subscribes.

---

## 4. Verification

Run from `/Users/konata/code/tmex-r32`.

| gate | result |
|---|---|
| `bunx tsc --noEmit -p packages/api-client` | 0 errors |
| `bunx tsc --noEmit -p packages/panels` | 0 errors |
| `bunx tsc --noEmit -p packages/shared` | 0 errors |
| `bunx tsc --noEmit -p apps/fe` | 1 error, **not mine**: `packages/api-client/src/download-transfer.ts(52,18): TS6133 'signal' is declared but its value is never read` — T1's in-flight edit |
| `apps/fe` `bun test src/` | **2758 pass / 0 fail** (baseline 2693) |
| `packages/panels` `bun test` | **1063 pass / 0 fail** (baseline 1039) |
| `packages/api-client` `bun test` | **276 pass / 0 fail** (baseline 252) |
| `packages/shared` `bun test` | **799 pass / 0 fail** (baseline 795) |
| `bunx biome check` over every file I touched | clean |
| `bun scripts/complexity/gate.ts` | no violations in F1 files; the 2 remaining are T1's (`packages/transfer/src/push-driver.ts` runPush CC 17, `packages/api-client/src/download-transfer.ts` drainContent CC 22). No allowlist entries added. |
| `bunx vite build` in `apps/fe` | succeeds; `transfer-dialog-*.js`, `portmap-dialog-*.js`, `transfer-jobs-store-*.js` are separate chunks |
| `bun run budget` in `apps/fe` | `entry js gzip=286993 / 300000`, `entry css 24273 / 30000` — passes, but headroom is now ~4 %. Worth a re-check after R1 lands. |

No e2e was run (backends not ready), as instructed. `bun run build:i18n` was run and the locale-consistency tests pass.

## 5. Things the commander must wire up / watch

1. **Re-run `bun run build:i18n`** after R1/T1/T2 finish, since three agents touched the locale JSONs.
2. **Error-body shape**: confirm T1/T2 use `jsonError(code, status)` (top-level `{code}`), otherwise the dialogs
   fall back to generic copy. Easy fix on either side if not.
3. **`POST /api/portmap/exports` must mint and return `mapId`** — the UI does not generate one.
4. **`GET /api/transfer/jobs/:id/events` must emit `snapshot` first**, and the response must have a body
   (a 204 makes the client throw and reconnect).
5. `apps/fe/src/pages/FilePage.tsx` was intentionally left on the 3-argument `startTransferToast` (out of scope);
   add `{ nodeId: runtime.nodeId, totalBytes: … }` there if downloads from the file viewer should show in the list.
6. Entry-bundle budget is at 95.7 % — check `bun run budget` once R1's settings changes land.
7. **Standalone / entry-node-id-unknown caveat**: when `/api/auth/mode` reports no mesh, the only node option is
   本机 and its `meshId` degrades to `'self'`. Port mapping cannot be created there (A === B is blocked), but a
   same-node transfer (本机 root A → 本机 root B) *is* allowed and would POST `fromNodeId: 'self'` /
   `toNodeId: 'self'`. T1 should treat `fromNodeId === toNodeId` as the local-copy path and not require a
   32-hex peer id, or the commander should decide to block same-node transfers entirely in the dialog.

### Cross-check against T2-result.md (already landed)

T2's port-mapping surface matches this client exactly: envelopes `{maps}` / `{map}` / `{exports}` / `{export}`,
unwrapped `PortProbeResponse` / `TargetPortProbeResponse`, `{ok:true}` on both DELETEs (any 2xx is accepted),
201 on both POSTs (accepted), and error bodies that duplicate `code` at the top level — which is exactly what
`toApiError` reads. `POST /api/portmap/exports` mints the `mapId` when the request omits it, which is what the
form does. The only constraint worth re-verifying at live-test time is T2's `fromNodeId` / `targetNodeId`
"32 lowercase hex" validation versus the standalone `'self'` fallback described above (not reachable for port
maps, since A === B is blocked client-side).
