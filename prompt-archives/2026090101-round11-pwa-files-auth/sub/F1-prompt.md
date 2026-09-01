# F1 — Files sidebar: visibility default + drag-sort horizontal scroll

## Context

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo. **Other agents are editing other files in this worktree in parallel (auth code under `apps/fe/src/auth`, `apps/fe/src/pages/devices/node-device-group.tsx`, gateway auth routes). Only touch the files listed under "Scope". Never run git commands.** The commander commits. Code comments (only where non-obvious) in Simplified Chinese like the surrounding code; report in English.

Read first: `packages/stores/src/sidebar-device-visibility.ts`, `packages/panels/src/files/root-visibility.ts` (+ test), `packages/panels/src/files/files-node-roots.tsx`, `packages/panels/src/files/files-node-section.tsx`, `packages/panels/src/files/files-tab.tsx`, `apps/fe/src/components/page-layouts/components/app-sidebar.tsx` (`MeshFilesTab`, `SortableFilesNodeSection`), `packages/panels/src/device-management/device-card.tsx` (Files toggle, ~line 380), `packages/panels/src/device-tree/device-tree-dnd.tsx`, `packages/ui/src/components/scroll-area.tsx`, `docs/device-tree/2026061400-reorder.md`.

## Bug A — devices appear in the Files sidebar although the user never enabled "show in Files sidebar"

Root cause (verified): `isSidebarFilesVisible()` defaults to `stored ?? hasRoots`, i.e. **every device that has a configured file root is shown by default, including devices of remote mesh nodes**, whereas the terminal sidebar (`isSidebarDeviceVisible`) defaults remote-node devices to hidden. With a hub and several nodes this floods the Files sidebar with devices the user never opted in. Also, node sections are rendered even when they end up with zero visible roots.

Fix:
1. Change the Files default to match the terminal sidebar: default visible only when `runtimeNodeId === SELF_NODE_ID && hasRoots`; remote-node devices default hidden; an explicitly stored value always wins. Update the doc comment in `sidebar-device-visibility.ts` (the current comment explains the old rationale — rewrite it) and the unit tests (`packages/stores/src/*.test.ts`, `packages/panels/src/files/root-visibility.test.ts`, `packages/panels/src/device-management/device-card.test.tsx`, `packages/panels/src/files/files-tab.test.tsx` / `files-node-section.test.tsx` as affected).
2. The device card's Files toggle must reflect exactly the same computed value as the sidebar (it already calls `isSidebarFilesVisible` with the same key; just make sure tests cover a remote-node device defaulting to unchecked while enabled when it has roots).
3. In `MeshFilesTab` / `FilesNodeSection`: when a node section is mounted (online + logged in), its roots query has loaded, and the visible-root list is empty, do not render the section at all (no header). Keep sections for offline / not-logged-in nodes as they are (they carry the login entry). Make sure the loading state does not flash the header (render nothing until loaded, or keep current skeleton if there is one). Check `FilesNodeSectionShell` and the existing tests for the exact contract, and adjust them.
4. Check the `filesHint` / `filesDisabledHint` i18n copy (`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`, keys under `device.sidebar.*`) still describes the behaviour; if you change copy, follow `/Users/konata/code/tmex-copy-guidelines.md` (read it first), edit all three locales, and do **not** run `build:i18n` or edit `packages/shared/src/i18n/resources.ts`/`types.ts` — report the key changes.

## Bug B — drag-sorting in the Files sidebar scrolls the sidebar horizontally

Root cause (verified): `SortableVerticalList` in `packages/panels/src/device-tree/device-tree-dnd.tsx` (shared by Files roots, Files node sections, terminal sidebar devices/windows/panes) has no dnd-kit `modifiers`; `useSortableRow` applies the full `CSS.Translate` transform including `x`, so horizontal pointer movement translates the row sideways; the Files tab's Base UI `ScrollArea` viewport (`packages/ui/src/components/scroll-area.tsx`, inline `overflow: scroll`) is horizontally scrollable, and dnd-kit's default auto-scroll scrolls it on the X axis.

Fix:
1. In `device-tree-dnd.tsx`, add a local vertical-axis modifier (`@dnd-kit/modifiers` is not a dependency — do not add one; write a small `Modifier` that zeroes `transform.x`) and pass `modifiers={[restrictToVerticalAxis]}` to the `DndContext` of `SortableVerticalList`. Do not touch the device-grid or device-folder DnD contexts.
2. Make the sidebar scroll viewport non-scrollable horizontally: extend the `ScrollArea` wrapper in `packages/ui/src/components/scroll-area.tsx` with an option (e.g. `viewportClassName`/`viewportStyle` or an `axis="vertical"` prop) that wins over Base UI's inline `overflow: scroll` (verify by reading `node_modules/.bun/@base-ui+react@*/node_modules/@base-ui/react/scroll-area/viewport/ScrollAreaViewport.js` — an inline style override is needed if a class loses), and apply it in `packages/panels/src/files/files-tab.tsx` **and** in the terminal sidebar's scroll area (find where the terminal tab list is wrapped — likely also `ScrollArea` in `packages/panels/src/device-tree/*` or `app-sidebar.tsx`) so both tabs are vertical-only, plus `overscroll-behavior-x: none`. Keep `min-w-0` on the inner wrapper so long names truncate instead of widening the viewport.
3. Keep vertical auto-scroll working (do not set `autoScroll={false}`).

## Tests

- Unit tests as listed above; add a test for the modifier (transform.x zeroed, y preserved) in `packages/panels/src/device-tree/device-tree-dnd.test.ts`.
- Add a Playwright spec `apps/fe/tests/files-sidebar-drag.spec.ts` (flat `apps/fe/tests` dir; copy the root setup pattern from `apps/fe/tests/files-context-menu.spec.ts`): create two file roots, open the Files tab, record the viewport's `scrollLeft` and `scrollWidth`, drag a root handle 200 px to the right and 60 px down with the mouse, assert `scrollLeft === 0` and `scrollWidth <= clientWidth`, and assert the reorder persisted (vertical part). **Do not run the e2e suite yourself** (it takes >10 min and conflicts with other agents' vite HMR); the commander runs it — but do run `bunx tsc --noEmit -p apps/fe` to make sure the spec compiles if it is covered by the tsconfig (check `apps/fe/tsconfig*.json`).

## Scope (files you may edit)

- `packages/stores/src/sidebar-device-visibility.ts` + its tests; `packages/stores/src/ui.ts` only if a default helper lives there
- `packages/panels/src/files/**`
- `packages/panels/src/device-tree/device-tree-dnd.tsx` + test
- `packages/panels/src/device-management/device-card.tsx` + test (only the Files toggle/test)
- `packages/ui/src/components/scroll-area.tsx`
- `apps/fe/src/components/page-layouts/components/app-sidebar.tsx` (+ its tests)
- `packages/shared/src/i18n/locales/*.json` (only `device.sidebar.*` keys)
- `apps/fe/tests/files-sidebar-drag.spec.ts` (new)
- `docs/files/` — add a short doc `docs/files/2026090101-files-sidebar-visibility-default.md` (Chinese, per `docs` conventions in AGENTS.md: background, change, acceptance) describing the new default and the vertical-only DnD.

## Verification (must pass before reporting)

- `cd packages/stores && bun test` (baseline 398 pass), `cd packages/panels && bun test` (record before/after), `cd packages/ui && bun test` if tests exist, `cd apps/fe && bun test src/` (baseline 1098 pass / 0 fail).
- `bunx tsc --noEmit -p .` in `apps/fe` (baseline 0 errors), `packages/panels`, `packages/stores`, `packages/ui` (record baselines first if non-zero).
- `bunx biome check <each file you touched>` clean (no `--write` on files you did not touch).

## Report (final message, < 400 words)

Files changed, the new default rule, how empty sections are suppressed, the ScrollArea API change, i18n keys changed (if any), test counts before/after, anything unfinished.
