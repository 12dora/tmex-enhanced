# F9 result — Devices management page grouped by node with node status

## What changed

### New

- `apps/fe/src/pages/devices/node-device-group.tsx`
  - `NodeDeviceGroupEntry` — one mesh node as the devices page sees it (`id`, `runtimeNodeId`,
    `name`, `online`, `loggedIn`, `isSelf`, `isHub`, `version`, `inventory`).
  - `toNodeDeviceGroups(nodes, entryNodeId)` — maps `useMeshNodes().nodes` to entries; the entry
    node becomes `runtimeNodeId: 'self'` and is always treated as signed in (local UI already
    passed `localUiGuard`); sorted **self first, then by name** (locale-aware, numeric).
  - `nodeDeviceGroupState(node)` — `'offline' | 'signedOut' | 'ready'` (offline wins over the
    login state, same precedence as the sidebar).
  - `NodeDeviceGroup` — header (`NodeBadge` + status chip + optional `Hub` chip + version) plus
    one of three bodies:
    - offline: read-only greyed list built from `inventoryDevices(node.inventory)` (imported from
      the sidebar, which was **not** modified), with an empty state; no runtime, no request;
    - online + not signed in: hint text + the existing `NodeLoginButton` (no auto-login);
    - online + signed in: `<NodeRuntimeScope nodeId>` wrapping `DeviceManagementPanel`, plus a
      per-group "Add device" button wired to the panel's `openAddDevice()` through a ref.
  - `listenOpenAddDeviceEvent={node.isSelf}`: only the self panel keeps the global-event listener
    so the shell's `PageActions` "+" applies to `self`; every remote group gets `false`, so one
    event can no longer pop every panel's dialog at once.
- `apps/fe/src/pages/DevicesPage.test.tsx` — 11 tests (mesh store injected with
  `setMeshNodesStateForTest`, static render via `react-dom/server`, the device-management module
  mocked with a probe, exactly as `sidebar-device-list.test.tsx` does).
- `packages/panels/src/device-management/device-management-events.test.ts` — 6 tests.
- `prompt-archives/2026082900-hub-ui-tls/sub/f9-i18n-keys.json` — the `devices.nodes.*` fragment
  for the three locales (**not** merged into the locale JSON, per the prompt; the commander
  merges and runs `bun run build:i18n`).

### Modified

- `apps/fe/src/pages/DevicesPage.tsx` — reads `useSharedAuthMode()`: spinner while the mode is
  unknown, today's single `DeviceManagementPanel` when `mode.mode !== 'mesh'`, and the grouped
  view otherwise. If the mesh list has not arrived yet (`groups.length === 0`) it falls back to
  the single panel so the first paint is not blank (same trick as the sidebar).
- `packages/panels/src/device-management/device-management-panel.tsx` — extracted the global
  listener into the exported `subscribeOpenAddDevice(enabled, onOpen)` and reduced the effect to
  a one-liner. Behaviour is unchanged; the point is that `enabled === false` is now testable in a
  DOM-less runner.
- `packages/panels/src/device-management/device-management-actions.tsx` — extracted the
  callback-vs-global-event decision into the exported `requestAddDevice(onAddDevice?)`.

`packages/panels/src/device-management/index.ts` was deliberately left untouched (out of scope);
the two new helpers are imported from their modules directly by the sibling test.

## i18n keys added (fragment only)

`devices.nodes.status.{online,offline,signedOut,hub}`, `devices.nodes.version` (`{{version}}`),
`devices.nodes.signInToManage`, `devices.nodes.lastKnownDevices`, `devices.nodes.noKnownDevices`,
`devices.nodes.addDevice` (`{{name}}`) — en_US / zh_CN / ja_JP.

## Discrepancies with the exploration report / prompt

- The prompt asked to *add* `listenOpenAddDeviceEvent` and the `openAddDevice()` ref to the panel.
  Both already existed in the worktree (`DeviceManagementPanelHandle`, `ref`, the prop with a
  `true` default) — so did `DeviceManagementActionsProps.onAddDevice`. Only the refactor into
  testable helpers was needed. The report's line numbers for these two files are stale.

## Verify

```
cd apps/fe        && bun test src/pages/DevicesPage.test.tsx
cd packages/panels && bun test src/device-management
cd packages/panels && bunx tsc --noEmit -p .
bunx biome check apps/fe/src/pages/DevicesPage.tsx apps/fe/src/pages/DevicesPage.test.tsx \
  apps/fe/src/pages/devices/node-device-group.tsx \
  packages/panels/src/device-management/device-management-{panel,actions}.tsx \
  packages/panels/src/device-management/device-management-events.test.ts
```

## Numbers

| | before | after |
|---|---|---|
| `packages/panels` `bun test` | 368 pass / 0 fail | **372 pass / 0 fail** |
| `packages/panels` tsc | 0 | **0** |
| `apps/fe` `bun test src/` | 470 pass / 0 fail | 453 pass / 8 fail (see below) |
| `apps/fe` tsc | 0 | 11 (see below) |
| `apps/fe` DevicesPage.test.tsx | — | **11 pass / 0 fail** |

The `apps/fe` totals are polluted by other agents editing this worktree at the same moment
(the numbers moved between consecutive runs while files were half-written). Every remaining
failure and tsc error is in a file outside my scope:

- `src/auth/session-key-store.{ts,test.ts}`, `src/auth/use-session-key.ts`, `src/pages/LoginPage.tsx`
  — F7's lazy-login work (`loginToAllReachable` / `getLoginProgress` / `useLoginProgress` not yet
  exported).
- `src/components/brand.{tsx,test.tsx}`, `src/components/page-layouts/components/sidebar-title.*`,
  `src/page-wrapper.*` — the branding task (`BrandProps` missing `size`/`linkTo`/`showName`).

`bunx tsc --noEmit -p .` in `apps/fe` reports **zero** errors in `src/pages/DevicesPage*.tsx` or
`src/pages/devices/**`; biome is clean on all six changed/added files.

## Open issues / needed from others

1. **i18n merge (commander).** `f9-i18n-keys.json` must be merged into the three locale JSONs
   under `translation.devices.nodes` and `bun run build:i18n` re-run. Until then the page renders
   raw keys. `t()` takes arbitrary keys, so tsc stays clean either way.
2. **Duplicate `data-testid="devices-page"` in mesh mode.** `DeviceManagementPanel` stamps that
   testid on its own root, so in mesh mode there is one per signed-in group. Any Playwright
   selector on `devices-page` needs `.first()` or should switch to the new
   `devices-node-group-<runtimeNodeId>` / `devices-node-panel-<runtimeNodeId>` testids. Changing
   the panel's testid was out of scope; flagging it for whoever owns the e2e specs.
3. **DevicesPage is mounted twice in the route table** (`/devices` and `/n/:nodeId/devices`, see
   `apps/fe/src/main.tsx` `pageRoutes()`). The grouped view therefore also renders inside a
   `/n/:nodeId` shell. Each group carries its own `NodeRuntimeScope`, so the data is still
   correct, but if the product decision is "the grouped page only exists at the entry route",
   that gate belongs in `main.tsx` (outside my scope).
4. **F7 interaction.** `NodeLoginButton` is used as-is; if F7 changes its props or moves it, the
   `SignedOutBody` call site in `node-device-group.tsx` is the only place to update.
