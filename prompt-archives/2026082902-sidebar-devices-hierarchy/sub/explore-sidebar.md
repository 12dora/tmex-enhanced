You are exploring a Bun + React monorepo (tmex). Read-only. Produce a concise code map (file paths + line refs) in English for a follow-up implementation agent.

Scope: the left sidebar device list: `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`, `packages/panels/src/device-tree/*` (esp. `sidebar-device-list.tsx`, `device-row-header.tsx`, `device-tree-row-shell.tsx`, `device-connection-control.tsx`, `device-actions-menu.tsx`, `node-badge.tsx`), `packages/stores/src/sidebar-device-visibility.ts`.

Questions:
1. When a runtime node has no devices selected for sidebar display (`sidebarDeviceVisibility`), what does the sidebar render — is there a placeholder/empty-state box? Identify exactly which component renders it and the condition.
2. Device name duplication: the node/device name is shown outside the box (a section heading, probably in `sidebar-node-section.tsx` or node-badge) AND again inside the box header (`device-row-header.tsx`). Identify both, and which one is the "box header" one to remove. Note the layout: does each device get its own box, or is a node's box containing device rows? Be precise about what's a node label vs a device label.
3. The "power button" in each sidebar device row (`device-connection-control.tsx`?): what does it do, what icon, and what tests reference it (`device-connection-control.test.ts`, `use-row-action-items.ts`). List everything that would need to change/delete to remove it cleanly (including tests and i18n keys that become unused).
4. The top-left 3 tabs "Panes / Agent / Files" — find where they are rendered and their labels (search apps/fe/src and packages for `Panes`), and whether they use i18n `t()` already. List locale JSON files and the key namespace convention nearby (e.g. `packages/shared/src/i18n/locales/zh_CN.json`).
5. Baselines: run `cd packages/panels && bun test src/ 2>&1 | tail -5`, `bunx tsc --noEmit -p . 2>&1 | tail -3`, and `cd apps/fe && bun test src/ 2>&1 | tail -5`, `bunx tsc --noEmit -p . 2>&1 | tail -3`; report counts.

Output to stdout only; no code changes.
