You are a read-only code explorer/designer for the tmex monorepo (Bun + React 19 + Zustand + TanStack Query + Tailwind). Do NOT modify files.

Context: commit `aa69374` ("simplify device sidebar management") removed the user-visible device connect/disconnect UI. The user wants it BACK, on top of the current HEAD architecture (device tree now lives in `packages/panels/src/device-tree/*`, subscription is `ensureDeviceSubscribed` in `apps/fe/src/components/global-device-provider.tsx`, tmux store `packages/stores/src/tmux*.ts` still has `connectedDevices` / `deviceConnected` / `connectDevice` / `disconnectDevice`). Everything else from aa69374 stays as-is: URL-driven `data-active` highlight, persisted per-device tree expansion (`sidebarDeviceExpanded`), no tmux-active highlight.

Note: in parallel, another agent is reverting the sidebar top-level sections back to three mutually exclusive Tabs (store field `sidebarTab: 'panes'|'agent'|'files'`, `setSidebarTab`). Your design must not depend on `sidebarSections`.

Reference material (old code before aa69374):
- prompt-archives/2026082701-sidebar-tabs-restore/sub/old-Sidebar.tsx.txt (the old 867-line Sidebar with connection dot, Power button, click-card-to-connect)
- prompt-archives/2026082701-sidebar-tabs-restore/sub/old-global-device-provider.tsx.txt (persisted connection intent `tmex:connectedDevices`, connect/disconnect/toggle API)
- prompt-archives/2026082701-sidebar-tabs-restore/sub/aa69374-pages.diff (DevicesPage Connect button removal, DevicePage "disconnected / connect to start" placeholder removal)
- `git show aa69374` for the full diff.

Deliverable: a precise implementation spec (markdown, Simplified Chinese, for a frontend engineer who will implement it without further exploration) that restores:
1. Device row in the sidebar tree: connection status dot (green connected / grey disconnected / amber reconnecting or error — reuse existing `DeviceStatusBadge` semantics if suitable), a Connect/Disconnect (Power) button with testids `device-connect-{id}` / `device-disconnect-{id}`, and the old click-to-connect behaviour where it makes sense. Disconnecting must actually unsubscribe (`disconnectDevice`) and collapse/hide the window tree; connecting subscribes. Decide how this coexists with `ensureDeviceSubscribed` (route entry / tree expansion auto-subscribe): recommend a model — e.g. explicit user disconnect sets a "user wants disconnected" flag that suppresses auto-subscribe until user connects again — and whether that intent should be persisted (old code persisted `tmex:connectedDevices` in localStorage; we want the old UX back, so lean towards persisting).
2. `/devices` management page: the per-card `Connect` link (`device-card-connect-{id}`) navigating to `/devices/{id}`.
3. Device page: the "🔌 device.disconnected / device.connectToStart" placeholder when the device is intentionally disconnected (vs loading when connecting). Check whether the i18n keys `device.connect`, `device.disconnect`, `device.connectToStart`, `device.disconnected`, `terminal.connecting` still exist in packages/shared/src/i18n/locales/*.json; list any that must be re-added (all three locales: en_US, zh_CN, ja_JP).
4. Keep the embeddable-panels architecture: the device tree in `@tmex/panels/device-tree` receives host callbacks via props/adapters; propose the minimal prop additions (e.g. `connection?: { isConnected(id), status(id), connect(id), disconnect(id) }`) so `apps/fe` host wires them and other hosts can omit them.

For each change list: file path, exact component/hook to touch, new/changed props, state and store changes (name the fields), i18n keys, testids, and a short note on risks (e.g. e2e specs in apps/fe/tests that assert absence of `device-connect-*` — find them and list them so they can be updated: `grep -rn "device-connect\|device-disconnect\|device-card-connect\|connectToStart" apps/fe/tests`). Also list existing unit tests that would need updating (global-device-provider.test.ts, stores ui.test.ts, device-tree tests).

Keep it tight: no more than ~250 lines. Print the spec as your final answer.
