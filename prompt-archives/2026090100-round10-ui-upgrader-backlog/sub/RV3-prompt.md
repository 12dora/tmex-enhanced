# RV3: Code review — round10 frontend (branch feat/round10-ui-node-upgrade)

You are a code reviewer with read-only access to the worktree at /Users/konata/code/tmex-enhanced-wt-r10. Review the diff at `prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/review-r10-frontend.diff`. Read surrounding code as needed. Output your FULL report as your final message.

The diff contains five independent changes:
1. Sidebar layout: footer button group flush to bottom, tab switcher pill aligned to terminal top (`app-sidebar.tsx`, `nav-main.tsx`).
2. Device-card DnD proximity collision (`device-grid-collision.ts` + wiring) — check the radius logic, keyboard/no-pointer fallback, and that `over=active` far-drag behavior can't break drop handling in `use-device-management-state`'s onDragEnd.
3. Terminal SelectionToolbar dismiss-on-pointerdown (`Terminal.tsx`, `selection-dismiss.ts`) — check the capture-phase handler can't break toolbar buttons, mobile touch, or non-left-button flows; verify `dismissSelection` wiring actually clears the ghostty selection before the subsequent mousedown starts a new one (event ordering pointerdown→mousedown).
4. Node upgrade UI (`apps/fe/src/pages/settings/nodes/management/*`, `use-node-upgrade.ts`, i18n locales) — review the per-node state machine: polling lifecycle leaks (intervals/timeouts cleaned on unmount), restarting-tolerant error handling (fetch failures during target restart must not mark failed), version-confirmation logic, busy-state isolation from rename/revoke, i18n keys present in all three locales (zh_CN/en_US/ja_JP parity).
5. e2e spec updates (5 specs + `helpers/mesh.ts`) and the hub-e2e driver windowId change (`scripts/hub-e2e/driver/terminal.ts`) — check the new assertions are consistent with product behavior referenced in `prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/EX4-result.md`.

Classify Blocker / Should-fix / Nit with file:line and concrete failure scenarios for blockers. Known context: the codebase's `t()` i18n keys are not statically typed; generated i18n files were rebuilt by the commander. No padding.
