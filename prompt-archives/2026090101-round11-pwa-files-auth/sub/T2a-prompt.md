# T2a — Frontend store/panels: viewport claims + follower sizing mode

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo. **Other agents edit other files concurrently — notably: a backend agent (T1) is adding the Borsh kinds, the ws-client command `terminal-viewport` / builder `buildTermViewportMessage` and the decoded event `TerminalViewportPolicyEvent` (`kind: 'terminal-viewport-policy'`) in `packages/shared/src/ws-borsh` and `packages/ws-client`; another frontend agent (T2b) is adding the pan viewport in `packages/ghostty-terminal` and the touch pan state in `packages/terminal-ui/src/components/touch/*`, `terminal-input-bridge.ts`, and `Terminal.tsx`; other agents are in `apps/fe/src/auth`, `packages/panels/src/files`, `packages/stores/src/sidebar-device-visibility.ts`, `app-sidebar.tsx`. Touch only the files in "Scope". Never run git commands.** Code comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

Read the contract first: `prompt-archives/2026090101-round11-pwa-files-auth/sub/T-contract.md`. Also read `sub/EX2-result.md` and `sub/EX6-result.md` for the code map (resize path, `sizingMode` semantics `'report' | 'follow' | 'local'`, `usePaneSizeSync`, `terminal-stage.tsx` keep-alive pool).

## Deliverables

1. **Store** (`packages/stores`):
   - `packages/stores/src/viewport-policy.ts` (new, pure): state `Record<paneKey, { owner: boolean; cols: number; rows: number; windowId: string }>` with `paneKey = \`${deviceId}:${paneId}\``; `applyViewportPolicy(event)`, `clearViewportPolicyForDevice(deviceId)` (on device disconnect / connection reset), selector `selectPaneViewportOwner(state, deviceId, paneId)` → `true` when no policy is known (default owner). Add it to the tmux store (`packages/stores/src/tmux.ts`) next to `resizePane`/`syncPaneSize` (~235-245), plus an action `setPaneViewport(deviceId, paneId, { cols, rows, visible })` that sends the `terminal-viewport` command via the message builder `buildTermViewportMessage` from `@tmex/ws-client`.
   - Route the event: `packages/stores/src/tmux-event-router.ts` — `case 'terminal-viewport-policy'` → `applyViewportPolicy`. **T1 is adding the ws-client types concurrently**: implement everything else first; before wiring, check that `packages/ws-client/src/message-builder.ts` exports `buildTermViewportMessage` and the event type exists (`grep -rn "terminal-viewport" packages/ws-client/src`). If they are still missing when you get there, wait (poll every 60 s up to 20 min: `until grep -q buildTermViewportMessage packages/ws-client/src/message-builder.ts; do sleep 60; done`); if still missing after that, add a minimal local type in stores that matches the contract exactly and note it in the report.
   - Unit tests for the pure module and the router case.
2. **Panels** (`packages/panels/src/device-console`):
   - `terminal-stage.tsx` (~297-312): the visible keep-alive instance uses `sizingMode = owner ? 'report' : 'follow'` from the store selector; hidden instances stay `'local'`. When a pane switches from follower to owner, force one report (see how `TerminalResizeReporter` exposes a forced `sync`/`report` via `TerminalRef` — e.g. call the existing `fit`/`syncSize` ref method after the mode flips).
   - Visibility claims: send `setPaneViewport(..., visible: true, cols, rows)` when a pane becomes the visible surface (with its last measured geometry — hook into the point where the visible pane is chosen / the reporter's last measured size) and `visible: false` when it stops being visible or unmounts; `document.visibilitychange` → hidden/visible for the currently visible pane. De-duplicate (do not spam identical claims). Keep it in a small hook `use-viewport-claims.ts` (new) with tests.
   - `use-pane-size-sync.ts` (~91-129): must keep working in follow mode — when the authoritative pane size changes for a follower, resize the local emulator to it and rebuild history as today; ensure the authoritative-size ref used by `convergeSnapshotSize()` is updated (EX6 §4: `useTerminalBootSurface.ts:210-225`, `useTerminalHandle.ts:48-51` — those files belong to `packages/terminal-ui`; you may edit **only** `useTerminalBootSurface.ts` and `useTerminalHandle.ts` there if strictly required, and tell the commander).
3. **Docs**: nothing (T1 writes the doc); add a short section to `docs/terminal/2026090101-viewport-policy.md` only if it already exists when you finish (append "前端行为" subsection); otherwise put the notes in your report.

## Scope

`packages/stores/src/**` (except `sidebar-device-visibility.ts`, `ui.ts`), `packages/panels/src/device-console/**`, `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts` and `useTerminalHandle.ts` (only if strictly required), tests alongside. Do not edit `Terminal.tsx`, `touch/*`, `terminal-input-bridge.ts`, `packages/ghostty-terminal/**`, `packages/ws-client/**`, `packages/shared/**`, `apps/fe/**`.

## Verification (must pass before reporting)

- `cd packages/stores && bun test` (baseline 398 pass), `bunx tsc --noEmit -p .`.
- `cd packages/panels && bun test` (record before/after), `bunx tsc --noEmit -p .`.
- `cd packages/terminal-ui && bun test` (baseline 344 pass) if you touched it.
- `cd apps/fe && bunx tsc --noEmit -p .` (baseline 0) — the app must still compile.
- `bunx biome check <each file you touched>` clean.

## Report (final message, < 400 words)

Files changed, store API, where claims are sent, how follow→owner transition forces a report, whether you had to edit terminal-ui hooks, test counts before/after, anything unfinished.
