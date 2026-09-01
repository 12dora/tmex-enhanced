# EX3 Report: Files Sidebar Visibility and Horizontal Scrolling

## Bug A — “Show in files sidebar” is not respected

### Toggle location and storage model

The toggle is a per-device UI preference on the Devices page:

- Settings routes `devicesAndFiles` to `DevicesAndFilesTab` in `apps/fe/src/pages/SettingsPage.tsx:109` and `apps/fe/src/pages/SettingsPage.tsx:197`.
- `DevicesAndFilesTab` renders the device cards in `apps/fe/src/pages/settings/devices-and-files-tab.tsx:1`.
- The actual switch is rendered by `SidebarVisibilityToggle` in `packages/panels/src/device-management/device-card.tsx:213`.
- The Files switch uses the i18n key `device.sidebar.files` and test ID `device-card-sidebar-files-${device.id}` at `packages/panels/src/device-management/device-card.tsx:388`.
- The Chinese label and semantics are defined in `packages/shared/src/i18n/locales/zh_CN.json:245`, especially `files` and `filesHint` at lines `248-251`. The hint says the device’s directories are shown in the Files sidebar.

This preference is not stored in the device API or database:

- The shared `Device` contract has no visibility field in `packages/shared/src/contracts/devices.ts:6`.
- The device database schema has no visibility column in `apps/gateway/src/db/schema.ts:97`.
- Device creation, listing, and update only persist device identity/configuration fields in `apps/gateway/src/db/devices.ts:112`, `apps/gateway/src/db/devices.ts:166`, and `apps/gateway/src/db/devices.ts:203`.
- The device API client only sends device configuration fields in `packages/api-client/src/devices.ts:21`.
- No migration adds such a field; the migration registry ends at the existing schema migrations in `apps/gateway/src/db/managed-migrations.ts:7`.

The preference is held in the browser UI store:

- Visibility keys are composite `${runtimeNodeId}:${deviceId}` keys in `packages/stores/src/sidebar-device-visibility.ts:1`.
- Files visibility is separate from terminal visibility in `packages/stores/src/sidebar-device-visibility.ts:22`.
- The UI store persists the Files map in `packages/stores/src/ui.ts:95` and `packages/stores/src/ui.ts:232`.
- Device cards use `sidebarDeviceVisibilityKey(nodeId, device.id)` at `packages/panels/src/device-management/device-card.tsx:254`.
- The Files sidebar uses the same key through `isSidebarFilesVisible(...)` at `packages/panels/src/files/files-node-roots.tsx:120`.

Therefore, the toggle is local to the browser/profile. It is not a server-side device property and cannot currently synchronize across browsers or nodes through the gateway.

### How the Files sidebar renders roots

The sidebar renders file roots, not raw devices:

1. `MeshFilesTab` obtains mesh node entries and mounts a `FilesNodeSection` for every node in `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:83`.
2. Each online/logged-in section renders `FilesNodeRoots` in `packages/panels/src/files/files-node-section.tsx:110`.
3. `FilesNodeRoots` queries `/api/files/roots` through the current node runtime client in `packages/panels/src/files/files-node-roots.tsx:91`.
4. The query is node-specific because each section is rendered under its own runtime scope; the runtime mapping is established in `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:57`.
5. The returned roots are filtered by `selectVisibleFileRoots(...)` at `packages/panels/src/files/files-node-roots.tsx:120`.
6. Only the filtered roots are passed to the sortable list at `packages/panels/src/files/files-node-roots.tsx:151`.

The filter is explicit and applies to local and remote roots alike:

```ts
root.enabled &&
isSidebarFilesVisible(visibility, runtimeNodeId, root.deviceId, true) &&
isFileRootDeviceReachable(root, deviceConnected)
```

This logic is in `packages/panels/src/files/root-visibility.ts:29`.

Reachability is separate:

- Local roots are always considered reachable.
- SSH roots require `deviceConnected[deviceId] === true`.
- Unknown/null device types are rejected.

That logic is in `packages/panels/src/files/root-visibility.ts:18`.

The existing unit tests confirm that an explicit Files visibility value of `false` hides both local and remote roots:

- `packages/panels/src/files/root-visibility.test.ts:54`
- Explicit-off coverage is at `packages/panels/src/files/root-visibility.test.ts:64`.
- SSH disconnect/reconnect behavior is covered at `packages/panels/src/files/root-visibility.test.ts:75`.

### Precise cause of the reported behavior

The current source does not contain a remote-root bypass. A root with an explicit `false` visibility value and the correct `(runtimeNodeId, deviceId)` key should be filtered out for both local and remote nodes.

There is, however, a separate rendering issue that can look like disabled devices appearing: node sections are rendered unconditionally.

- `MeshFilesTab` maps every mesh node to a section in `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:87`.
- `FilesNodeSectionShell` always renders its section header in `packages/panels/src/files/files-node-section.tsx:68`.
- The nested root list may be empty, but the node section itself remains visible.

Thus, if the reported “devices” are actually node headers or empty node sections, the cause is that section visibility is independent of device Files visibility. The Files switch only filters root rows; it does not remove the surrounding node section.

There are two additional sources of confusion:

- Files visibility defaults to `true` when a root exists, via `stored ?? hasRoots`, in `packages/stores/src/sidebar-device-visibility.ts:22`.
- File roots themselves default to `enabled: true` when created in `apps/gateway/src/db/file-roots.ts:31`.

If a user disabled the terminal sidebar switch instead of the separate Files switch, the Files root remains visible. The two switches are distinct in `packages/panels/src/device-management/device-card.tsx:254` and `packages/panels/src/device-management/device-card.tsx:388`.

If an actual root row remains after the exact Files switch was explicitly turned off, the current code provides no normal rendering path for that result. The likely investigation targets are stale frontend assets, a different browser storage profile, or a mismatch between the device card’s runtime-node key and the Files section’s runtime-node key. Those are diagnostic hypotheses, not proven causes from this source audit.

### Connected state and Files visibility are different concepts

The code separates three concepts:

1. Files sidebar preference: browser-local `sidebarFilesVisibility`, defined in `packages/stores/src/sidebar-device-visibility.ts:22`.
2. Root enabled state: server-side `file_roots.enabled`, represented by `FileRootDto.enabled` in `packages/shared/src/contracts/files.ts:41`.
3. Device connectivity: runtime/tmux state, represented by `deviceConnected` in `packages/panels/src/files/root-visibility.ts:9` and updated from tmux events in `packages/stores/src/tmux-event-router.ts:112`.

The device connect switch is a separate component in `packages/panels/src/device-management/device-card-connect-toggle.tsx:55`. The runtime status database table contains operational state, not sidebar preference, in `apps/gateway/src/db/schema.ts:126`.

The available documentation describes device-tree ordering and file transfer, but does not define a server-side Files-sidebar preference:

- Device/window/pane ordering is documented in `docs/device-tree/2026061400-reorder.md:5`.
- File transfer behavior is documented in `docs/files/2026061500-transfer-progress-chunked.md:5`.

### Minimal fix and tests

The minimal fix is client-side:

- Do not add a database/API visibility field.
- Keep the existing root filter in `packages/panels/src/files/root-visibility.ts:29`.
- If the intended behavior is to hide node sections when they contain no visible roots, add a visible-root count/gate at the `FilesNodeSection` or `MeshFilesTab` boundary, around `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:87`. This must be designed carefully because the current implementation intentionally preserves login/offline node sections at `packages/panels/src/files/files-node-section.tsx:120`.

Recommended tests:

- Existing pure filter tests: `packages/panels/src/files/root-visibility.test.ts:54`.
- Existing Files rendering tests: `packages/panels/src/files/files-tab.test.tsx:88`.
- Existing device-card visibility tests: `packages/panels/src/device-management/device-card.test.tsx:320`.
- Add a Playwright test under the flat `apps/fe/tests` directory, since this repository does not use `apps/fe/tests/e2e`. The existing root setup pattern is in `apps/fe/tests/files-context-menu.spec.ts:27`.
- The new test should create a device/root, click `device-card-sidebar-files-${id}`, switch to Files, and assert the root row is absent; then re-enable it and assert the row returns.
- Add a mesh case if remote visibility is a supported user workflow. `apps/fe/tests/mesh-login.spec.ts:22` currently tests terminal visibility only, not Files visibility.

Gateway root tests should remain unchanged for this bug: `apps/gateway/src/api/file-root-routes.test.ts:59` and `apps/gateway/src/db/file-roots.test.ts:53` test root CRUD/order behavior, not the browser-local sidebar preference.

---

## Bug B — Files drag-sort causes horizontal scrolling

### DnD implementation

The Files sidebar uses dnd-kit:

- Dependencies are declared in `packages/panels/package.json:33`.
- Shared DnD primitives are implemented in `packages/panels/src/device-tree/device-tree-dnd.tsx:1`.
- `SortableVerticalList` creates a `DndContext` and vertical `SortableContext` at `packages/panels/src/device-tree/device-tree-dnd.tsx:70`.
- Files node sections use it from `apps/fe/src/components/page-layouts/components/app-sidebar.tsx:116`.
- File roots use it from `packages/panels/src/files/files-node-roots.tsx:151`.
- Individual file-root rows apply `useSortableRow` in `packages/panels/src/files/directory-node-view.tsx:67`.

The same `SortableVerticalList` is used by terminal/device-tree lists:

- Device rows: `packages/panels/src/device-tree/sidebar-device-list.tsx:244`.
- Window rows: `packages/panels/src/device-tree/device-window-list.tsx:77`.
- Pane rows: `packages/panels/src/device-tree/window-pane-list.tsx:54`.

The device card grid and device-folder tree use separate DnD contexts:

- Device cards use a rectangle strategy in `packages/panels/src/device-management/device-grid.tsx:120`.
- Device folders use their own context and `DragOverlay` in `packages/panels/src/device-folders/device-folder-tree.tsx:480` and `packages/panels/src/device-folders/device-folder-tree.tsx:524`.

### Root cause

`SortableVerticalList` is vertical by strategy, but it does not constrain the drag transform:

- Its `DndContext` has no `modifiers` or `autoScroll` override at `packages/panels/src/device-tree/device-tree-dnd.tsx:70`.
- `useSortableRow` applies the complete dnd-kit transform through `CSS.Translate.toString(transform)` at `packages/panels/src/device-tree/device-tree-dnd.tsx:96`.
- Consequently, horizontal pointer movement can produce a non-zero `transform.x`, even though the list is vertically sortable.

The Files content is inside a Base UI ScrollArea:

- `FilesTab` creates the scroll area at `packages/panels/src/files/files-tab.tsx:82`.
- Its inner wrapper has no horizontal clipping or `min-w-0` constraint at `packages/panels/src/files/files-tab.tsx:83`.
- The local ScrollArea wrapper supplies a Base UI viewport at `packages/ui/src/components/scroll-area.tsx:12`.
- Base UI’s viewport uses `overflow: scroll`, and tracks both `scrollLeft` and `scrollTop`, in `node_modules/.bun/@base-ui+react@1.2.0+ca9c98c9db1b76d1/node_modules/@base-ui/react/scroll-area/viewport/ScrollAreaViewport.js:304`.
- Its scrollbar-hiding styles only hide the scrollbar visuals; they do not disable horizontal scrolling, in `node_modules/.bun/@base-ui+react@1.2.0+ca9c98c9db1b76d1/node_modules/@base-ui/react/scroll-area/utils/styles.js:8`.

dnd-kit enables auto-scroll by default:

- `DndContext` defaults `autoScroll = true` in `node_modules/.bun/@dnd-kit+core@6.3.1+bf16f8eded5e12ee/node_modules/@dnd-kit/core/dist/core.cjs.development.js:2852`.
- It discovers ancestors whose computed overflow is `auto`, `scroll`, or `overlay` at `.../core.cjs.development.js:680`.
- The auto-scroller calculates both X and Y directions at `.../core.cjs.development.js:834`.
- It calls `scrollBy(left, top)` for both axes at `.../core.cjs.development.js:1809`.

Therefore the likely chain is:

1. Horizontal pointer movement produces `transform.x`.
2. The Files ScrollArea viewport is considered horizontally scrollable.
3. dnd-kit auto-scroll can call `scrollBy` on that viewport’s X axis.
4. The transformed row may also visually extend beyond the sidebar because the inner Files wrapper has no horizontal clipping.

The page canvas is less likely to be the actual scroll container: `html/body` use `overflow:hidden` in `apps/fe/src/app.css:1`, and `SidebarInset` also uses `overflow-hidden` in `apps/fe/src/main.tsx:218`. The concrete scrollable candidate is the Files ScrollArea viewport.

There is no Files `DragOverlay`; the only relevant overlay is in the separate device-folder implementation at `packages/panels/src/device-folders/device-folder-tree.tsx:524`.

### Minimal fix

Apply a vertical-axis restriction to the shared vertical list:

```ts
modifiers={[restrictToVerticalAxis]}
```

The change belongs in `packages/panels/src/device-tree/device-tree-dnd.tsx:70`, because that wrapper is explicitly a vertical sortable list and is shared by Files, sessions, windows, and panes.

The repository does not declare `@dnd-kit/modifiers` in `packages/panels/package.json:33`, so either:

- Add that dependency and import the official modifier; or
- Define a small local modifier using the existing dnd-kit `Modifier` type that sets `transform.x = 0`.

The local modifier is the smaller dependency change. Do not apply it to the device grid or device-folder DnD contexts, which have different interaction models.

Also constrain the actual Files viewport horizontally. The best implementation is to extend `packages/ui/src/components/scroll-area.tsx:12` with a viewport class/style option, then configure the Files instance with horizontal clipping and horizontal overscroll suppression. Because Base UI applies `overflow: scroll` inline at `ScrollAreaViewport.js:304`, a class-only `overflow-x-hidden` may lose to the inline shorthand; the wrapper should merge an explicit viewport style or otherwise guarantee the X-axis override.

Disabling dnd-kit auto-scroll entirely with `autoScroll={false}` would avoid the symptom but also remove useful vertical auto-scroll. The existing device-tree documentation explicitly expects auto-scroll behavior around `docs/device-tree/2026061400-reorder.md:41`, so axis restriction plus viewport clipping is preferable.

### Tests to add or adjust

Existing tests cover wiring and pure reorder logic, but not pointer movement or scroll position:

- Shared DnD reorder/collision tests: `packages/panels/src/device-tree/device-tree-dnd.test.ts:12`.
- Files root reorder tests: `packages/panels/src/files/root-reorder.test.ts:34`.
- Files node-section rendering and handles: `packages/panels/src/files/files-node-section.test.tsx:91`.
- Sidebar DnD wiring: `apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx:477`.
- Existing Files browser coverage: `apps/fe/tests/files-context-menu.spec.ts:18`.
- Existing sidebar browser coverage is terminal disclosure only: `apps/fe/tests/sidebar-device-disclosure.spec.ts:7`.
- Sidebar resize coverage is unrelated: `apps/fe/tests/sidebar-resize.spec.ts`.

Add a Playwright regression test that:

1. Creates at least two file roots.
2. Records the Files ScrollArea viewport’s `scrollLeft`.
3. Drags a root handle horizontally.
4. Verifies `scrollLeft` remains zero and the document’s horizontal width does not expand.
5. Performs a vertical reorder and verifies the persisted order.

Because the shared wrapper affects terminal/device-tree lists, add a corresponding horizontal-drag assertion for the terminal sidebar. Device-grid and device-folder tests should remain separate and should not inherit the vertical-only modifier implicitly.