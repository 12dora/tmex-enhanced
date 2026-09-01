# EX3 — Files sidebar: visibility flag not respected + drag-sort causes horizontal scroll

Two user reports about the left "Files" sidebar (`apps/fe/src/components/app-sidebar*`, `FilesNodeSection`, files roots API `apps/gateway/src/files`, `PUT /api/files/roots/order`, devices page "show in files sidebar" toggle in Settings → Devices).

**Bug A — devices shown in the Files sidebar although their "show in files sidebar" option is off.** Many devices appear in the files column even though the per-device toggle is disabled on the Settings → Devices tab.

Find:
1. Where the toggle lives (settings devices tab component, i18n key, API endpoint, DB column — `apps/gateway/src/db`, migrations) and what it is called in code.
2. How the Files sidebar decides which roots/devices/nodes to render: the data source (`/api/files/roots`? device list? mesh node list?), the filter logic, and the multi-node sectioning introduced in round 9 (`FilesNodeSection`, per-node roots via peer link). Determine precisely why a device with the flag off is still rendered — e.g. the flag is only applied to local devices, remote-node roots bypass the filter, the flag is stored per device but the sidebar keys by root, the default for new/imported devices is `true`, or the SSH/remote device vs local folder types have different fields.
3. Whether there are two different concepts being conflated (device "connected" state vs "show in files"), and what the intended semantics are per docs (`docs/files`, `docs/device-tree`).
4. Propose the minimal correct fix (server-side filter vs client-side filter) with `path:line`, and which unit tests / e2e specs cover this (`apps/fe/tests/e2e/*files*`, `*sidebar*`, gateway `files/*.test.ts`).

**Bug B — drag-sorting entries in the Files sidebar makes the canvas scroll horizontally.** When the user drags an item to reorder (dnd-kit? custom pointer DnD? — identify the library and the sortable wrapper introduced in rounds 4/9/10: "拖拽退避/避让", `sidebar` drag), the sidebar/page container scrolls sideways, presumably because the drag overlay/ghost or the dragged element is translated beyond the sidebar's width and the container has `overflow-x: auto` (or the dnd auto-scroll feature kicks in horizontally).

Find:
1. The DnD implementation for the files sidebar (and whether the same one is used for the sessions/windows sidebar and device folders — they must not regress).
2. Which scroll container actually moves (sidebar `ScrollArea`, the `SidebarContent`, or the page canvas), and what makes it scrollable horizontally (CSS `overflow`, dnd-kit `autoScroll` config, `restrictToVerticalAxis` modifier missing, `DragOverlay` portal location, `transform` on the dragged item without `restrictToParentElement`).
3. Propose a fix: e.g. dnd-kit `modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}`, `autoScroll={{ layoutShiftCompensation: false, ... }}` or per-axis disable, plus CSS `overflow-x: hidden` / `overscroll-behavior-x: none` on the sidebar container. Give exact file/line and note any e2e specs exercising sidebar drag (`sidebar-*`, `dnd-*`).

Deliverable: for each bug — root cause with evidence, the minimal fix, and the tests to add/adjust.
