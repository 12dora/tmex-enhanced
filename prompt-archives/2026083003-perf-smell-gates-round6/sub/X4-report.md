# Exploration X4 — Frontend performance audit

Read-only audit completed. No repository files or production tmex assets were modified.

The normal Vite command was blocked when it tried to create `.vite-temp` under the read-only worktree. I reran the production build in memory with `write:false`: 5,339 modules transformed successfully.

## Ranked findings

### 1. HIGH — `CodeViewer` can freeze the main thread on unknown languages

**Location:** [`code-viewer.tsx:101`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/code-viewer/code-viewer.tsx:101>), [`code-viewer.tsx:119`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/code-viewer/code-viewer.tsx:119>), [`FilePage.tsx:216`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/FilePage.tsx:216>)

**Hot path / cost:** Unknown or unsupported languages call synchronous `hljs.highlightAuto(code)`. The entire file is then converted into highlighted HTML and rendered without virtualization.

**Evidence:**

- Synthetic 1 MiB unknown text: `highlightAuto` took approximately **7.71 seconds**.
- Synthetic 2 MiB unknown text: approximately **14.89 seconds**, producing **3.51 MiB** of HTML.
- Explicit TypeScript highlighting of 2 MiB took approximately **33 ms**.
- The gateway permits text files up to 2 MiB at [`categorize.ts:4`](</Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/categorize.ts:4>) and [`device-storage.ts:255`](</Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/device-storage.ts:255>), so this worst case is reachable.

**Proposed fix:** Avoid automatic language detection above a small size threshold; render escaped plain text or use an explicit language mapping instead. For large files, move highlighting off the main thread or virtualize lines.

**Expected gain:** Eliminates multi-second UI freezes and the associated highlighted-HTML memory spike.

**Risk:** Large unknown files lose syntax colors unless a worker or explicit language selection is added.

**Net LOC:** Approximately `+15–30` for a safe size guard; more for full virtualization.

---

### 2. HIGH — Markdown preview code is pulled into unrelated File and Settings routes

**Location:** [`FilePage.tsx:19`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/FilePage.tsx:19>), [`SettingsPage.tsx:18`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/pages/SettingsPage.tsx:18>), [`version-tab-sections.tsx:20`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/settings/version-tab-sections.tsx:20>)

**Hot path / cost:** `FilePage` statically imports both `CodeViewer` and `MarkdownPreview`, even though only Markdown files need the latter. `SettingsPage` statically imports every tab, and the version tab statically imports Markdown rendering.

Relevant in-memory production chunks:

| Chunk | Raw | Gzip |
|---|---:|---:|
| Entry `index-BCZWrRlh.js` | 1,351,924 B | 425,686 B |
| `FilePage` | 149,480 B | 49,072 B |
| `markdown-preview` | 452,106 B | 139,396 B |
| `SettingsPage` | 118,184 B | 25,260 B |
| `nodes-tab` | 92,566 B | 25,776 B |
| `DevicePage` | 64,640 B | 19,375 B |
| `DevicesPage` | 62,307 B | 17,956 B |
| Mermaid core, dynamic | 620,844 B | 152,417 B |
| Cytoscape, dynamic | 443,722 B | 143,379 B |

The `FilePage` and `SettingsPage` chunks both statically import the **139 KiB gzip** Markdown chunk. Additionally, [`main.tsx:25`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/main.tsx:25>) imports the broad settings barrel at [`settings/index.ts:3`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/settings/index.ts:3>), which causes `qrcode.react`—used only by Weixin account login—to contribute **44.6 KiB raw** to the entry module graph.

**Proposed fix:** Lazy-load Markdown preview only for Markdown/changelog views and split settings tabs individually. Give `SettingsEventsInit` a narrow import path so Weixin and QR-code UI are not included in startup code.

**Expected gain:** Opening a code file or general Settings can avoid approximately **139 KiB gzip** of Markdown machinery; startup can also shed the QR-code dependency.

**Risk:** One additional loading boundary and possible loading-state flicker.

**Net LOC:** Approximately `+15–35`.

---

### 3. HIGH — Global device connection updates invalidate every visible device row

**Location:** [`global-device-provider.tsx:133`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/global-device-provider.tsx:133>), [`global-device-provider.tsx:237`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/global-device-provider.tsx:237>), [`tmux-event-router.ts:51`](</Users/konata/code/tmex-enhanced-wt-r6/packages/stores/src/tmux-event-router.ts:51>), [`device-row.tsx:12`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/device-row.tsx:12>)

**Hot path / cost:** The global provider subscribes to whole connection maps and creates a new adapter object whenever any device status changes. The event router clones whole maps for individual device events. That new adapter is passed to every visible `DeviceRow`, defeating `React.memo` shallow equality.

**Evidence:** A single device connection event causes:

- a new whole-map snapshot,
- a new connection adapter,
- traversal of every visible sidebar row at [`sidebar-device-list.tsx:250`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/sidebar-device-list.tsx:250>).

The device-management grid has a similar issue: [`device-grid.tsx:114`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-management/device-grid.tsx:114>) passes fresh card objects, while the card component is not memoized.

**Proposed fix:** Separate stable connection commands from per-device status selectors, or provide memoized per-device adapters. Keep status subscriptions local to each row/card and memoize the card components.

**Expected gain:** Status updates become proportional to the changed device instead of all visible rows/cards.

**Risk:** Medium refactor risk around pending connection, reconnecting, and offline semantics.

**Net LOC:** Approximately `+25–60`.

---

### 4. HIGH — File tree rendering is unvirtualized and recreates per-entry work

**Location:** [`files-tab.tsx:159`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/files/files-tab.tsx:159>), [`files-tab.tsx:265`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/files/files-tab.tsx:265>), [`files-tab.tsx:300`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/files/files-tab.tsx:300>)

**Hot path / cost:** Each expanded directory maps all entries to `DirNode` or `FileLeaf` components. `FileLeaf` is not memoized and mounts context-menu/hooks per item; directory and drag/drop action objects are recreated during parent renders.

**Evidence:** The backend caps each directory at **2,000 entries** at [`directory-browse.ts:50`](</Users/konata/code/tmex-enhanced-wt-r6/apps/gateway/src/files/directory-browse.ts:50>). The frontend has no windowing, so a large directory creates up to 2,000 visible React rows and associated menu/drop behavior.

**Proposed fix:** First stabilize callbacks and memoize directory/file rows. For large flat directories, add virtualization or a deliberate client-side display cap while preserving recursive expansion and drag/drop behavior.

**Expected gain:** Large directories render viewport-sized rows instead of thousands of mounted components; unrelated updates stop traversing stable subtrees.

**Risk:** Recursive variable-height rows, context menus, and DnD make virtualization moderately complex.

**Net LOC:** Approximately `+50–120`.

---

### 5. MEDIUM — Sidebar agent-session context broadcasts updates to every pane

**Location:** [`use-sidebar-agent-sessions.ts:151`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:151>), [`use-sidebar-agent-sessions.ts:212`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:212>), [`sidebar-agent-sessions.tsx:88`](</Users/konata/code/tmex-enhanced-wt-r6/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:88>)

**Hot path / cost:** The provider subscribes to the entire sessions record and session order, derives all pane lists, and places them in one context value. Every mounted pane branch consumes that context; session rows are plain functions rather than memoized components.

**Evidence:** Any session metadata/order update changes the context value and causes all mounted `AgentPaneSessions` branches to render, even when their pane’s session list is unchanged.

This finding concerns the sidebar’s session metadata list only, not the X1 agent-chat message list/store.

**Proposed fix:** Split stable commands/dialog state from per-pane session selectors, and memoize session rows. Select each pane’s list independently from the external store.

**Expected gain:** Unrelated session updates no longer rerender every visible pane and row.

**Risk:** Must preserve ordering, active-session, and orphan-session behavior.

**Net LOC:** Approximately `+20–50`.

---

### 6. MEDIUM — Device-tree navigation subscribes to the entire snapshot map

**Location:** [`device-tree-navigation.ts:230`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/device-tree-navigation.ts:230>), [`device-tree-navigation.ts:275`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-tree/device-tree-navigation.ts:275>)

**Hot path / cost:** Navigation only needs the snapshot for a pending target device, but the hook subscribes to the complete `snapshots` map. The event router clones that map for device metadata updates.

**Evidence:** Any snapshot patch can rerender the root sidebar navigation hook and rerun its pending-navigation effect, even when no pending navigation exists for the changed device.

**Proposed fix:** Select only the pending target device’s snapshot or isolate the navigation resolver into a small subscription. Preserve the existing route invalidation behavior.

**Expected gain:** Removes unnecessary root sidebar renders/effect executions for unrelated device updates.

**Risk:** Must handle pending-navigation races and target-device disappearance correctly.

**Net LOC:** Approximately `+10–30`.

---

### 7. LOW — Device-folder tree context depends on a recreated props object

**Location:** [`device-folder-tree.tsx:333`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-folders/device-folder-tree.tsx:333>), [`device-folder-tree.tsx:439`](</Users/konata/code/tmex-enhanced-wt-r6/packages/panels/src/device-folders/device-folder-tree.tsx:439>)

**Hot path / cost:** The context value includes the complete `props` object. Parent renders create a new props object, invalidating the context and rerendering all `useTree()` consumers.

**Proposed fix:** Destructure only the required callbacks/values and memoize the context from those individual dependencies. This keeps the context identity stable when unrelated parent props change.

**Expected gain:** Smaller improvement limited to folder-tree rerenders.

**Risk:** Low, provided all context consumers retain the same values.

**Net LOC:** Approximately `-5` to `+10`.

## Checked and already in good shape

- Store hooks require selectors; no zero-selector whole-store consumers were found in the audited paths.
- Device/window/pane rows use stable keys and per-device selectors; several row components are already memoized.
- Runtime and sidebar providers use stable/memoized values and callbacks.
- File-tree expanded state is selected per node rather than subscribing every row to the whole expanded map.
- Page modules and Agent/Files sidebar pages are lazy-loaded.
- Mermaid and Cytoscape are dynamically imported; their large chunks are deferred.
- Fonts use `font-display: swap`; runtime font loading is asynchronous and does not block first paint.
- No high-confidence app-level animation/layout-read loop was found; folder-tree `MeasuringStrategy.Always` is confined to drag behavior.
- The lockfile does not show duplicate `highlight.js` versions; the CodeViewer and Markdown paths use separate integrations but not duplicate installed versions.
- Watch/settings list keys are stable and do not subscribe to the whole application store; their current list sizes do not justify ranking them above the issues above.