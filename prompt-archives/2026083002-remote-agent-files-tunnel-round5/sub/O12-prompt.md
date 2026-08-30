# Task O12 — Sidebar: other nodes are hidden by default; login lives in Device management (frontend)

Read `common-rules.md` first.

## Problem (user report)
After signing in to the entry only, the left sidebar lists the other mesh nodes with a "Sign in" button. Clicking it signs the node in — and the node then DISAPPEARS from the sidebar (its devices are hidden by default via `sidebarDeviceVisibility`, so the section has nothing to show), although it is connected and visible in 管理设备. Confusing.

## Desired behaviour
- The sidebar shows other nodes ONLY when at least one of that node's devices is switched on for the sidebar (terminal switch in the device card; `isSidebarDeviceVisible` with the composite key) — signed-in or not. A signed-out node with no visible devices is not listed at all (no login row). A signed-out node that has visible devices keeps the compact row with the "Sign in" button (so a user who enabled a device can still reach it). Offline nodes follow the same rule (inventory-based rows only if some device is visible).
- Signing in to other nodes happens from 管理设备 (the devices page already has `devices-node-login-<id>`); make sure that page's signed-out group is the obvious place: keep it as is, but if there is any hint text in the sidebar about signing in, remove it.
- The self node section is unchanged.

## Scope (files you own)
apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx, sidebar-device-list.tsx (+ tests), packages/panels/src/device-tree/device-tree-selectors.ts only if you need a selector (`selectSidebarVisibleDevices` exists), i18n keys only if you must add copy. Do NOT touch apps/fe/src/pages/settings/** (another agent) or any gateway files. Update e2e specs under apps/fe/tests that assert the old sidebar behaviour (e.g. sidebar-device-disclosure / mesh specs) — do NOT run e2e.

## Verify
`cd apps/fe && bun test src/ && bunx tsc --noEmit -p .`, panels tests if touched, biome. Write your result to: /Users/konata/code/tmex-enhanced-wt-r5/prompt-archives/2026083002-remote-agent-files-tunnel-round5/sub/O12-result.md
