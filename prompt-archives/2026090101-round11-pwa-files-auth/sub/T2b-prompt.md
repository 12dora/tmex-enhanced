# T2b — Frontend rendering: pan viewport for oversized (follower) terminal surfaces + touch pan

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo. **Other agents edit other files concurrently — notably T2a in `packages/stores` and `packages/panels/src/device-console`, T1 in `packages/shared/src/ws-borsh` / `packages/ws-client` / gateway; others in `apps/fe/src/auth`, `packages/panels/src/files`. Touch only the files in "Scope". Never run git commands.** Code comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

Read the contract first: `prompt-archives/2026090101-round11-pwa-files-auth/sub/T-contract.md`, then `sub/EX6-result.md` (rendering pipeline: four Canvas-2D layers, canvas CSS size = `cols*cellW × rows*cellH`, root `.xterm` `overflow:hidden` in `packages/ghostty-terminal/src/terminal-dom.ts:22-57`, `CanvasRenderer.resize()` `canvas-renderer.ts:324-383`; touch machine `packages/terminal-ui/src/components/touch/{types,gesture-machine,scroll-gesture,scroll-bypass}.ts`; non-reporting horizontal drags rejected in `terminal-input-bridge.ts:291-316`; hit-testing `terminal-render-coordinator.ts:190-206`, `terminal-input-bridge.ts:239-279`).

## Behaviour to implement

When a terminal is a **follower** (another visible client owns the PTY size), its emulator geometry (`cols×rows`) can exceed what fits in its container. Today the oversized canvas is clipped at the top-left. Required:

1. **Pan viewport**: in `TerminalDomSurface` (`terminal-dom.ts`) introduce a pan viewport element that stays the size of the container and is scrollable on both axes (`overflow: auto`, `overscroll-behavior: contain`, `-webkit-overflow-scrolling: touch`), wrapping a content surface whose CSS size is exactly `cols*cellW × rows*cellH` (updated in `CanvasRenderer.resize()` together with the four canvases). When the surface fits, nothing visible changes (no scrollbars; verify with `scrollWidth <= clientWidth`). Hit-testing must remain correct while panned: pixel→cell conversion must use the canvas/content rect (which moves with the scroll offset), not the container rect — check `getBoundingClientRect()` usage in `terminal-render-coordinator.ts:190-206`, `terminal-input-bridge.ts:239-279`, link hover, cursor/IME placement (`terminal-dom.ts` ~238-240) and fix whichever uses the outer rect. No CSS `transform: scale`.
2. **Enable flag**: `Terminal.tsx` gets a new optional prop `viewportPan?: boolean` (default `false`) threaded to the surface; when `false` the DOM/CSS must behave exactly as today (root clipped) so existing e2e stays green. T2a/the commander will pass `viewportPan={!owner}` from `terminal-stage.tsx` — do not edit that file.
3. **Touch (mobile)**: add a `pan` state to the gesture machine used only when `viewportPan` is on **and** the surface is oversized in the drag axis: horizontal single-finger drag → pan X; vertical drag → pan Y while the pan viewport can still scroll in that direction, otherwise fall through to the existing scrollback behaviour (`scrollLines`) — nested-scroll semantics. Mouse-reporting / alt-scroll (wheel-to-PTY) semantics must not change. Two-finger and long-press/selection paths unchanged. Keep `scroll-bypass.ts` (custom scrollbar fallback) working.
4. **Desktop**: vertical wheel = scrollback (unchanged); horizontal wheel (`deltaX`) / shift+wheel pans X; native scrollbars of the pan viewport are acceptable for Y.
5. Selection overlay/cursor/link layers must pan together with the main canvas (they are siblings inside the content surface).

## Tests

- `packages/ghostty-terminal`: extend `terminal.canvas.test.ts` / dom tests: with `viewportPan` off, DOM identical to before (existing assertions); with it on and an oversized geometry, content surface size equals `cols*cellW × rows*cellH`, pan viewport `scrollWidth > clientWidth`, and a pixel→cell conversion test after setting `scrollLeft/scrollTop`.
- `packages/terminal-ui`: gesture-machine tests for the `pan` state (horizontal → pan, vertical with room → pan, vertical at edge → scrollLines, disabled when not oversized/flag off, reporting mode unchanged).
- Do not run Playwright e2e (commander does). Do run `bunx tsc --noEmit -p apps/fe` to make sure the app compiles.

## Scope

`packages/ghostty-terminal/src/**`, `packages/terminal-ui/src/components/Terminal.tsx`, `packages/terminal-ui/src/components/types.ts` (prop type only), `packages/terminal-ui/src/components/touch/**`, `packages/terminal-ui/src/components/useMobileTouch*.ts*` (if that is where the machine is wired), `packages/terminal-ui/src/components/terminal-input-bridge*.ts` if the wheel/drag rejection lives there (EX6 says `packages/ghostty-terminal/src/terminal-input-bridge.ts`), tests alongside, `packages/terminal-ui/src/**/*.css` if styles live there. Do not edit `packages/terminal-ui/src/components/hooks/**`, `terminal-resize-reporter.ts`, `packages/panels/**`, `packages/stores/**`, `apps/fe/**`.

## Verification (must pass before reporting)

- `cd packages/ghostty-terminal && bun test` (record before/after) and `bunx tsc --noEmit -p .`.
- `cd packages/terminal-ui && bun test` (baseline 344 pass) and `bunx tsc --noEmit -p .`.
- `cd apps/fe && bunx tsc --noEmit -p .` (baseline 0).
- `bunx biome check <each file you touched>` clean.

## Report (final message, < 400 words)

Files changed, DOM structure with `viewportPan` on/off, how hit-testing accounts for the scroll offset, the exact gesture rules, test counts before/after, anything unfinished.
