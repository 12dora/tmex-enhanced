# Review report

## Findings

- **should-fix — `apps/fe/src/components/global-device-provider.tsx:250`**  
  `setSnapshot()` mutates the external store during render, while subscribers are notified only by a passive effect at line 251. A status update can therefore commit and paint with memoized rows still showing the old value even though the store getter already returns the new value; an interrupted concurrent render can also expose a snapshot that never committed. Move snapshot publication and keyed notifications outside React render—ideally subscribe the keyed store directly to the underlying stores—and add a lifecycle test covering commit ordering and an abandoned/suspended render.

- **should-fix — `apps/fe/src/pages/SettingsPage.tsx:55`**  
  The Terminal lazy loader imports the full `@tmex/panels/settings` barrel, and the other lazy tab modules do the same. Consequently, loading one tab still loads unrelated settings modules: the current generated Terminal chunk imports device/files, AI, notification, version, and QR-code dependencies; even the default General tab depends on the QR-code chunk. Add narrow package exports for individual settings panels and update every tab module to use those paths.

- **nit — `packages/panels/src/device-folders/device-folder-tree.tsx:437`**  
  Removing the whole `props` object from the context does not prevent subtree renders. Every `DeviceFolderTree` render recreates `DndContext`, `TreeRoot`, `FolderNode`, `NodeList`, and `NodeItem`, none of which are memoized, so stable context identity cannot produce the intended bailout when the parent rerenders with equivalent props. Memoize the tree boundary or the relevant consumers, or split the frequently changing drag state from stable tree data.

- **nit — `packages/panels/src/device-management/device-card.test.tsx:119`**  
  The new test checks only that `DeviceCard` is wrapped in `memo`, not that the memo can ever bail out. `DeviceCardHost` creates fresh `onEdit` and `onDelete` callbacks on every render (`device-card-host.tsx:52-53`), so opening or closing a host-owned dialog rerenders the entire card while this test remains green. Stabilize those callbacks and replace the symbol assertion with a render-count test that rerenders the host using unchanged semantic props.

## Verified OK

- Device-status unsubscribe removes the per-device entry after its last listener; no permanent device-ID retention was found.
- Per-device row/card/console hooks use stable subscription functions and preserve the undefined-adapter SSR fallback.
- Pending navigation tracks target changes, device disappearance/reappearance, clear, TTL expiry, and cancels its timer on unmount.
- DeviceGrid’s memoized `cardProps` and outer `SortableDeviceCard` boundary are stable after the initial stagger period.
- Folder-context field extraction preserves all previously consumed callbacks and values.
- Settings `?tab=` deep links and invalid-tab fallback remain correct across lazy loading.
- Markdown Suspense placement and CodeViewer escaping/size thresholds are correct.
- The new `@tmex/panels/settings/events` import keeps the full settings barrel out of initial application startup.
- Focused verification passed: Panels 68/68 tests; FE 19/19 tests when run individually.