# F3 — Devices "+" menu: add remote node entry

## What changed

### `apps/fe/src/pages/devices/add-device-menu.tsx`
- `AddDeviceMenuList` now returns a fragment: **remote-node item → `DropdownMenuSeparator` → existing `DropdownMenuGroup`** (label + one item per ready node, unchanged).
- New first item: `data-testid="devices-add-remote-node"`, `Network` icon (lucide), label `t('device.addTo.remoteNode')`, rendered as a link via Base UI's `render` prop: `render={<Link to={remoteNodeHref} />}` (`Link` from `react-router`).
- New exported constant `ADD_REMOTE_NODE_PATH = '/settings?tab=nodes'` (verified `SettingsPage.tsx` accepts tab value `nodes`; the same query is already used by `settings/nodes/setup/browser-location.ts` and the remote-access wizard links).
- Host-aware path: `AddDeviceMenu` reads `useOptionalRuntime()` (from `@tmex/stores/react`) and passes the href through `hostAppPath(runtime.host, ADD_REMOTE_NODE_PATH)` — the same helper `components/page-layouts/components/nav-link.tsx` uses.
  - `NavLink` itself was **not** reusable here: it calls `useSidebar()`, and the devices top bar (`PageActions`) is static-rendered in tests without a `SidebarProvider`.
  - `useOptionalRuntime` (not `useRuntime`) because `PageActions` is also rendered outside a `RuntimeProvider` in the existing `DevicesPage.test.tsx` static renders; the real shell mounts it inside `AppRoot`'s self runtime, whose `appPath` is identity, so the href is `/settings?tab=nodes` for the entry host.
- New props on `AddDeviceMenuListProps`: `remoteNodeLabel`, `remoteNodeHref`.

### `apps/fe/src/pages/DevicesPage.tsx`
- `PageActions`: `targets.length > 1 ? menu : DeviceManagementActions(onAddDevice=targets[0]?.open)` → `targets.length > 0 ? menu : DeviceManagementActions()`. The single-ready-node shortcut is gone; the dropdown always opens when at least one target is registered. The zero-target fallback (standalone / single-panel host dispatching `OPEN_ADD_DEVICE_EVENT`) is unchanged.
- Updated the block comment above `PageActions` accordingly.

### i18n (`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`)
Targeted edits inside `device.addTo` only:
- `label`: 「添加设备到」→「添加设备到已有节点」 / "Add device to" → "Add device to existing node" / 「デバイスの追加先」→「既存ノードにデバイスを追加」
- new `remoteNode`: 「添加远程节点」 / "Add remote node" / 「リモートノードを追加」
Regenerated with `bun run --filter @tmex/shared build:i18n` (3 locales, exit 0).

### Tests
- `apps/fe/src/pages/devices/add-device-menu.test.tsx`: kept the two Base-UI `GroupLabel`-inside-`Group` regression tests; added `topLevel()` helper and three assertions — remote item is first with the right testid, `render` is a `Link` whose `to` is `/settings?tab=nodes`, second child is `DropdownMenuSeparator`, third is `DropdownMenuGroup`; remote item still present with a single target; per-target item count now asserted on the group child.
- `apps/fe/src/pages/DevicesPage.test.tsx`: the "single ready node = direct button" test became "single ready node also renders the dropdown" (asserts `devices-add` present, mocked `device-actions` absent); renamed the multi-node test title.

## Verification

| Check | Result |
| --- | --- |
| `cd apps/fe && bun test src/pages/devices src/pages/DevicesPage.test.tsx` | **50 pass, 0 fail** (5 files, 144 expects) |
| `cd apps/fe && bunx tsc --noEmit -p .` | **0 `error TS`** (baseline 0) |
| `bunx biome check` on the 4 source files + 3 locale JSONs | Checked 7 files, **no diagnostics** |
| `bun run --filter @tmex/shared build:i18n` | exit 0, 3 locales |
| `cd packages/shared && bun test src/i18n` | 2 pass, 0 fail |

Wider `bun test src/pages` in apps/fe shows 18 failures, **all** in `src/pages/settings/remote-access/{tunnel-model,remote-access-tab}.test.tsx` — another agent's in-flight scope, untouched by this task. No devices-related failures.

## Out of scope, needs a follow-up

`apps/fe/tests/devices.spec.ts` (Playwright, lines 9 and 38) does `page.getByTestId('devices-add').click()` and then immediately expects `device-dialog` to be visible. In a standalone single-node setup the entry group registers itself, so `targets.length === 1` and the "+" now opens the dropdown instead of the dialog. Those two spots need one extra click inserted after the trigger:

```ts
await page.getByTestId('devices-add').click();
await page.getByTestId('devices-add-to-self').click();   // new
await expect(page.getByTestId('device-dialog')).toBeVisible();
```

I did not edit that file because it is outside the assigned scope. No other `devices-add` call sites exist in the repo (`packages/panels`'s `devices-add` button is the zero-target fallback, unchanged; `devices-add-empty` in the empty-state panel is a different testid and unaffected).
