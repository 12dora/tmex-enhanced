## Code map

1. Empty state when no sidebar-visible devices

- Visibility rule: `packages/stores/src/sidebar-device-visibility.ts:9-20`
  - Explicit map value wins.
  - Unconfigured `self` devices are visible by default; remote-node devices are hidden.
- Filtering: `packages/panels/src/device-tree/sidebar-device-list.tsx:162-173`
  - `selectSidebarVisibleDevices()` is defined at `packages/panels/src/device-tree/device-tree-selectors.ts:60-69`.
  - The currently selected device bypasses visibility filtering.
- Empty state: `packages/panels/src/device-tree/sidebar-device-list.tsx:286-315`
  - When `sortedDevices.length === 0` and `devices.length > 0`, it renders:
    - `data-testid="sidebar-devices-all-hidden"`
    - `hiddenEmptyLabel ?? emptyLabel ?? t('sidebar.noDevices')`
  - In the mesh node path, `hiddenEmptyLabel` is supplied by `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:191-205`.
- This is a plain text `<div>` with padding; it is not a bordered/rounded device-box placeholder. The node heading remains visible.
- Offline nodes have a separate message at `sidebar-node-section.tsx:149-183`, specifically `:163-169`.

2. Node/device name duplication and layout

- Outer node label:
  - `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:72-89`
  - `SectionHeader` renders `<NodeBadge info={badgeOf(node)} />`.
  - `badgeOf()` maps `node.name` at `:72-78`.
- `NodeBadge` displays `info.name` at `packages/panels/src/device-tree/node-badge.tsx:24-48`.
- Inner device-box header:
  - Each device owns its own card: `packages/panels/src/device-tree/device-row.tsx:25-37`
    - `rounded-xl border ...`
  - `DeviceRowHeader` displays the device name at `packages/panels/src/device-tree/device-row-header.tsx:47-50`.
  - It also displays the node badge at `device-row-header.tsx:50`.
- Strictly, the duplicated text in aggregate mode is the node name, not the device name:
  - Outside: node `NodeBadge`.
  - Inside each device card: repeated `NodeBadge`.
  - `device.name` at `device-row-header.tsx:48` is the device label and should remain.
- To remove the duplicated box-header node label, remove the inner `NodeBadge` at `device-row-header.tsx:50` and its `nodeBadge` prop plumbing. Do not remove the device-name span.
- There is no node-level bordered box containing multiple device rows. Each device has its own box; windows/panes are nested inside that device box.

3. Power button

- Component: `packages/panels/src/device-tree/device-connection-control.tsx:21-95`
- Status mapping:
  - `connected`, `connecting`, `reconnecting` → disconnect.
  - `disconnected`, `error` → connect.
- Button:
  - Rendered only when `connection` exists at `:70-95`.
  - Uses the Lucide `Power` icon at `:88-93`.
  - Test IDs are `device-connect-${id}` or `device-disconnect-${id}`.
- Handler chain:
  - `device-row-header.tsx:52-60`
    - Connect calls `onExpandedChange(deviceId, true)`.
    - Disconnect calls `connection.disconnect(deviceId)` and collapses the row.
  - `sidebar-device-list.tsx:177-188`
    - Expanding with a connection calls `connection.connect(deviceId)`.
    - Normal collapse does not disconnect; see comment at `:180`.
  - Intent persistence is implemented in `apps/fe/src/components/global-device-provider.tsx:158-183`.

Clean-removal impact:

- `device-row-header.tsx:6,52-60`: remove the control import and button wiring.
- If keeping the online status dot:
  - Keep `status` calculation in `device-row.tsx:16-22`.
  - Refactor/extract the dot from `DeviceConnectionControl`; remove `Power`, action selection, connect/disconnect callbacks, and action-label translations.
- If removing the entire control including the dot:
  - Remove `useDeviceOnline` and status calculation from `device-row.tsx:16-22`.
  - Update the E2E assertions for `device-online-status-*`.
- `packages/panels/src/device-tree/device-connection-control.test.ts:1-44`
  - `deviceStatusDotClass` tests can remain if the dot remains.
  - `deviceConnectionAction` tests at `:35-45` should be deleted.
  - There is no DOM click test for the button.
- E2E references:
  - `apps/fe/tests/sidebar-device-disclosure.spec.ts:77-95` checks the status dot.
  - `apps/fe/tests/sidebar-device-disclosure.spec.ts:148-206` tests connect/disconnect buttons, persistence, tree hiding, and placeholders; this test must be rewritten or removed.
- `packages/panels/src/device-tree/use-row-action-items.ts:1-66` has no power-button reference. It only builds window/pane menu actions and needs no change for this removal.
- Do not remove `DeviceConnectionAdapter` globally without also changing the terminal connection behavior:
  - It is still used by the device console and global provider (`apps/fe/src/pages/DevicePage.tsx:20-29`, `packages/panels/src/device-console/*`).
- i18n:
  - `device.disconnect`: only used by the power control; becomes unused after removing the button.
  - `device.connect`: still used by `packages/panels/src/device-management/device-card.tsx:85-90`; keep it.
  - `device.connected` and `device.connecting`: only used by the control; become unused only if the status dot/control is removed entirely.
  - `device.disconnected` remains used by `packages/panels/src/device-console/terminal-stage.tsx:37-46`.
  - Source keys are in `packages/shared/src/i18n/types.ts:108-113` and locale files around `packages/shared/src/i18n/locales/en_US.json:95-100` (same lines in `zh_CN.json` and `ja_JP.json`).
  - `packages/shared/src/i18n/resources.ts` is generated and should be rebuilt, not edited manually.

4. Top-left `Panes / Agent / Files` tabs

- Rendered only in `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:26-84`.
- Tab values and labels:
  - `panes`: `:42-49`
  - `agent`: `:50-57`
  - `files`: `:58-65`
- They already use i18n via `useTranslation()` at `:3,27` and `t('sidebar.tab.*')` at `:48,56,64`.
- Locale source files:
  - `packages/shared/src/i18n/locales/en_US.json:697-701`
    - `Panes`, `Agent`, `Files`
  - `packages/shared/src/i18n/locales/zh_CN.json:697-701`
    - currently `终端`, `智能体`, `文件`
  - `packages/shared/src/i18n/locales/ja_JP.json:697-701`
    - currently `端末`, `エージェント`, `ファイル`
- Namespace/type convention:
  - Typed keys: `packages/shared/src/i18n/types.ts:681-684`
  - Runtime access uses dot notation: `sidebar.tab.panes`, `sidebar.tab.agent`, `sidebar.tab.files`.
  - Locale availability is listed in `packages/shared/src/i18n/locales/manifest.json:2-25`.
- The generated `resources.ts` currently still shows English for the zh/ja tab entries (`:2284-2286`, `:3864-3866`), indicating generated resources are stale relative to those locale sources.

5. Baselines

- `packages/panels`
  - `bun test src/`: 388 passed, 0 failed, 639 expects, 29 files.
  - `bunx tsc --noEmit -p .`: exit 0, no diagnostics.
- `apps/fe`
  - `bun test src/`: 577 passed, 0 failed, 1,501 expects, 45 files.
  - `bunx tsc --noEmit -p .`: exit 0, no diagnostics.

Read-only note: I made no file edits. Final worktree status also showed modified `packages/shared/src/i18n/locales/ja_JP.json`, `zh_CN.json`, and the untracked prompt archive; their origin was not changed or reverted.