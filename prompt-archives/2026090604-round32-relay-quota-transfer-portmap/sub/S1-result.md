# S1 — Settings → Sharing → Active list now aggregates across mesh nodes

## Bug and root cause (confirmed live)

A share record lives on the node that owns the shared terminal (the share dialog in
`packages/panels/src/share/share-dialog.tsx` posts to that terminal's node). The settings tab
queried `listShares(apiClient)` on the **current route node only**, so a share of a remote node's
terminal was invisible from the entry node's `/settings?tab=share` (and vice versa).

Reproduced on the live mesh harness: after creating a share on the remote node,
`GET /api/share` on the hub returned `active: []` while
`GET /n/<remoteNodeId>/api/share` returned the share. The new aggregated UI shows it.

## What was built

**Active list is now aggregated per node** (same shape as the port-mapping dialog):
one react-query query **per node**, fanned out with `useQueries` over every online + logged-in mesh
node from `toDialogNodeOptions` (`apps/fe/src/pages/devices/dialog-nodes.ts` +
`useMeshNodes`/`sortNodes`), each using `createNodeApiClient(node.id)`. A node that fails does not
blank the table — its rows are simply absent and a one-line hint above the table names it.

**Every row carries its node** (`ShareRow = ShareRecord & { nodeId, nodeName }`) and all row actions
(终止 / 查看密码 / 修改密码 / 复制带密码的链接 / 复制链接) go through that row's client.
Row identity is `shareRowKey(row) = "<nodeId>:<id>"`, so the "busy" marker and the change-password
dialog can no longer cross-disable two rows that share an id on different nodes.

**Per-node query keys and invalidation**: new `shareNodeQueryKey(nodeId, filter?)` in
`packages/api-client/src/share.ts` appends the node id to the existing `shareQueryKey()`
(`['share', deviceId, windowId, nodeId]`). The prefix is unchanged, so `refresh()` still invalidates
everything with `['share']`, while a write invalidates only `shareNodeQueryKey(row.nodeId)`.
`shareQueryKey()` itself is untouched, so the terminal toolbar badge / share dialog
(`packages/panels/src/share/use-share-status.ts`) are unaffected.

**History and Share Settings stay node-local** (they are node-local records/config). History rows are
tagged with the route node so the row model is uniform, and a one-line hint
「仅显示本节点的记录。」 appears above the history table when the mesh has more than one node.

**Node column** in the active table, right after 名称, shown only when the mesh has >1 node
(standalone/single-node keeps the old 7 columns). Device names for the 终端 column are now fetched
per node (`['devices', nodeId]`), so a remote row still renders `<device> · <window>`.

### Deviation from the brief

The brief suggested one aggregated query keyed `['shares-all', nodeIds]` with `Promise.allSettled`.
I used per-node `useQueries` instead (the portmap pattern the brief also pointed at): it satisfies
"query keys must be per node" and per-node invalidation directly, isolates failures natively, and
lets the route node's own list be a plain `useQuery` on the *same* key — so history/active share one
request and the existing hover prefetch still warms it. Shared query options
(`shareListQueryOptions`) are used by both observers so the two never disagree on options.

### Requirement 3

The share dialog has no "manage shares" link (grepped `packages/panels/src/share/**`), and its badge
/ toolbar indicator use `shareQueryKey(filter)` on the terminal's own node — untouched. Verified live
that `/settings?tab=share` (entry node) and `/n/<remote>/settings?tab=share` both show the share.

## Files

New (`apps/fe/src/pages/settings/share/`):
- `share-rows.ts` — `ShareRow`, `shareRowKey`, `toShareRows`, `flattenActiveShares`, `failedShareNodeNames` (pure)
- `share-rows.test.ts`
- `use-share-sources.ts` — `useShareNodes`, `shareListQueryOptions`, `useActiveShares`, `useNodeShareList`, `useShareDeviceNames`
- `share-actions.ts` — `createShareRowApi(clientFor)`: revoke / remove / password / changePassword, each via `clientFor(row.nodeId)`
- `share-actions.test.ts`
- `use-share-row-actions.ts` — busy-row + error state machine (split out to keep `useShareTab` under the 120-line gate)

Modified:
- `apps/fe/src/pages/settings/share/{use-share-tab.ts, share-tab.tsx, active-shares-table.tsx, history-table.tsx, share-confirms.tsx, share-password-dialogs.tsx, share-api.ts}`
- `apps/fe/src/pages/settings/share/{share-tables.test.tsx, share-password-dialogs.test.tsx}`
- `apps/fe/src/pages/settings/{data-prefetch.ts, data-prefetch.test.ts}` — share prefetch key is now per node; `tabPrefetchSpecs`/`prefetchTabData` take an optional `nodeId` (default `self`)
- `apps/fe/src/pages/SettingsPage.tsx` — passes `routeNodeId` to `prefetchTabData`
- `apps/fe/tests/mesh-share.spec.ts` — new regression test (below)
- `packages/api-client/src/share.ts` + `share.test.ts` — `shareNodeQueryKey`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` + `bun run build:i18n`

### New i18n keys (zh source, en/ja synced)

- `settings.share.active.columns.node` — 节点 / Node / ノード
- `settings.share.active.nodeUnavailable` — 「{{names}} 的分享未能加载。」
- `settings.share.history.localOnly` — 「仅显示本节点的记录。」

## Tests

Unit (new/updated):
- aggregation merges two nodes and tags rows with node names; a failing node does not hide the others; pending nodes are neither rows nor failures (`share-rows.test.ts`)
- revoke / remove / password / change-password on a **remote** row hit that node's client and path, local rows still hit the local client (`share-actions.test.ts`)
- node column appears only in multi-node mode; the busy row is keyed by (node, share) so two same-id rows don't cross-disable (`share-tables.test.tsx`)
- change-password carries the row's node down to the mutation (`share-password-dialogs.test.tsx`)
- share prefetch key is per node (`data-prefetch.test.ts`), `shareNodeQueryKey` shape (`api-client/share.test.ts`)

E2E (`apps/fe/tests/mesh-share.spec.ts`), new test
`mesh: a share on a remote node shows up in the entry node settings and can be stopped there`:
creates a share on the remote node through the UI, asserts the entry node's `/api/share` does **not**
contain it, then asserts the entry node's settings page shows the row with `share-node-<id>` ==
`state.remoteNodeName`, the history scope hint is present, and 终止 from that row ends the share on
the remote node (`endReason: revoked`).

### Gate results

| gate | result |
|---|---|
| `bunx tsc --noEmit -p apps/fe` | 0 errors |
| `bunx tsc --noEmit -p packages/api-client` | 0 errors |
| `bun test src/pages/settings/share` (apps/fe) | 109 pass / 0 fail |
| `bun test src/` (apps/fe) | 2882 pass / 0 fail |
| `bun test` (packages/api-client) | 283 pass / 0 fail |
| `bun test` (packages/shared) | 851 pass / 0 fail (i18n consistency green) |
| `bun test` (packages/panels) | 1072 pass / 0 fail |
| `bunx biome check` (apps/fe/src, apps/fe/tests, packages/api-client/src) | clean |
| `bun scripts/complexity/gate.ts` | ok (no new allowlist entries) |
| `TMEX_E2E_MESH=1 TMEX_E2E_MESH_ONLY=1 bunx playwright test --project mesh --grep share` | 7 passed (3 consecutive green runs) |

## Live verification

Harness: `NODE_ENV=test bun apps/fe/tests/helpers/mesh-boot.ts --state /tmp/tmex-s1-state.json`
(hub 19771 / node 19772, tmux sockets `tmex-mesh-e2e-hub|node`), cookies from
`scratchpad/live/hub-login.ts`, driven with local Chrome via Playwright. Harness stopped afterwards
(SIGTERM to the supervisor pid; both tmux sockets and ports confirmed released).

Console output of the run:

```
share created, password len 8
hub /api/share active = []                      <- the bug
remote /api/share active = ["WoXEH5wL9XwPY_BqQuzPfg"]
node column = "mesh-node-b"                     <- aggregated UI shows it
history hint = Records on this node only.
after stop: remote active = []
after stop: remote history = [["WoXEH5wL9XwPY_BqQuzPfg","revoked"]]   <- 终止 hit the remote node
```

Screenshots:
- `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/7f158cc0-e928-457c-bae4-127b7ce448a1/scratchpad/live/shots/s1-settings-share-aggregated.png`
  — entry node `/settings?tab=share` with the remote share row, Node = `mesh-node-b`, terminal =
  `tmex-s1-share · bash`, and the history scope hint
- `.../shots/s1-settings-share-after-stop.png` — after 终止 from that row
- `.../shots/s1-remote-settings-share.png` — `/n/<remote>/settings?tab=share`: history correctly
  shows that node's own record (1 row)

## Notes for the commander

- `packages/api-client/src/share.ts` gained one exported function (`shareNodeQueryKey`); it is picked
  up by the existing `export * from './share'` in `index.ts`, so no index edit was needed.
- `tabPrefetchSpecs` / `prefetchTabData` gained a trailing optional `nodeId` parameter (defaults to
  `self`); the only caller is `SettingsPage.tsx`.
- One flake was seen on the very first `--grep share` run immediately after tearing down my manual
  harness; the new test's "entry list is empty" assertion was rewritten to the order-independent
  "entry list does not contain this share id", and three subsequent full runs were green.
