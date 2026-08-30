# Task O2a — Device card sidebar switches (terminal / files) + files sidebar visibility & offline behaviour (frontend)

Read `common-rules.md` in this directory first (ground rules, baselines, fixed contracts).

Read prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/explore-devices-report.md sections 2, 3, 5.

## Scope (files you own)
- packages/stores/src/ui.ts, packages/stores/src/sidebar-device-visibility.ts (+ tests), packages/stores/src/index.ts (append exports only)
- packages/panels/src/device-management/device-card.tsx (+ test) — NOTE: another agent (O2b) creates `packages/panels/src/settings/device-files-modal.tsx` exporting `DeviceFilesModal` with props `{ device: DeviceDto; nodeId: string; open: boolean; onOpenChange: (open: boolean) => void }` (an in-modal single-device version of the Devices & files settings). You add the 3-dot menu item "文件" that opens it (import from `../settings/device-files-modal`). Until that file exists your tsc will fail on that import — that is expected; keep going, and when you finish check whether it exists; if not, create a minimal placeholder ONLY in your report's note, do not create the file yourself.
- packages/panels/src/files/files-tab.tsx (+ tests), packages/panels/src/device-tree/** only if the terminal-sidebar selector needs renaming
- apps/fe/src/components/page-layouts/components/app-sidebar.tsx (files tab part only), sidebar-node-section.tsx (+ tests) — another agent (O1) edits the agent parts of app-sidebar.tsx / sidebar-agent-sessions; keep to the files tab lines.
- i18n: only the `device.sidebar` sub-object (create it if it is nested differently — find where `device.sidebar.show/hint` lives) and `files` sub-object keys you add.

## Requirements
1. Device card: replace the single "显示在侧栏" switch with a grouped control: a group label "侧栏显示" on the left, and two labelled switches "终端" and "文件" on the right (clear hierarchy: label → two toggles, e.g. `侧栏显示   终端 [●]   文件 [○]`; compact, one row on wide cards, wraps gracefully). Tooltips: terminal — "在侧栏的终端页显示该设备"; files — "在侧栏的文件页显示该设备的目录". The files switch is disabled (muted) with tooltip "尚未为该设备配置目录" when the device has no file roots.
2. Store: add `sidebarFilesVisibility: Record<string, boolean>` to the UI store (persisted like `sidebarDeviceVisibility`, same composite key helper), with default rule `isSidebarFilesVisible(map, nodeId, deviceId, hasRoots)` = stored value ?? hasRoots (i.e. once a device has roots the switch is ON by default, for self and remote nodes alike). Keep `sidebarDeviceVisibility` semantics for the terminal switch.
3. Device card needs to know whether the device has roots: use the existing roots query for that runtime (`fetchFileRoots` via `['files','settings','roots']`/`['files','roots']` — reuse the query key that `settings-events-init` invalidates on `file-roots` events so it updates live after configuring roots in the modal).
4. Files sidebar (packages/panels/src/files/files-tab.tsx): filter roots by (a) `enabled`, (b) `isSidebarFilesVisible` for (route nodeId, root.deviceId), (c) device connection state: hide roots whose device is not connected (use the tmux store `deviceConnected`/device list of the route runtime; local devices count as connected), and (d) route node online (mesh node state; when the route node is offline render nothing but a muted one-line notice "节点离线" — no error/retry UI, no stale roots). Roots must disappear automatically on disconnect/offline and reappear on reconnect without a manual refresh (React Query data may remain cached; the filter is what hides them).
5. Cross-node files sidebar: check `app-sidebar.tsx` files tab — if it only shows the route node's roots that is fine; keep behaviour but make sure the offline/visibility filter applies.
6. Tests: store defaults/persistence, card renders two switches with disabled state, files-tab filtering (hidden by switch, hidden by disconnected device, offline node notice).

Verify: stores, panels, fe tests + tsc + biome as in the common rules.

Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O2a-result.md
