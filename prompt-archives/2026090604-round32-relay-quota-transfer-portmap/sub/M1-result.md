# M1 — Mobile keyboard trigger confined to the input area

## What was built

On touch devices the on-screen keyboard is no longer summoned by tapping the terminal canvas. It is
opened/closed only by a dedicated 「显示键盘 / 隐藏键盘」 toggle pinned at the left of the terminal
shortcut bar. Desktop mouse behaviour is unchanged (click still focuses the terminal for typing).

Two code paths used to focus the hidden input (`.xterm-helper-textarea`) on tap:

1. mouse-reporting mode — the gesture machine's `pending` tap branch called `terminal.focus()`;
2. non-reporting mode — the gesture machine let the touch pass, the browser synthesized a full mouse
   sequence and ghostty's `click` handler called `focusIfEnabled`.

The reverse also happened: the synthesized `mousedown`'s default action moved focus **off** the helper
textarea, so tapping the canvas while the keyboard was up made it flicker shut.

Both are fixed by treating "a tap on the canvas" as a gesture the machine consumes: `preventDefault`
on `touchend` + `noteTouchHandled()`, which kills the whole compat mouse sequence. Overlay taps
(selection toolbar, boot placeholder) are explicitly excluded so their buttons keep working, and the
suppression window is only ever armed by touch, so real mouse clicks — including on hybrid
touch+mouse laptops — are untouched.

Implicit refocus paths were also gated on touch (mount autofocus, split focus-pane change, and
copy/paste/dismiss in the selection toolbar, which previously popped the keyboard after a long-press
copy). They now go through one helper, `refocusTerminalInput()`.

## Files touched

New:
- `packages/terminal-ui/src/components/touch/tap-focus.ts` (+ `.test.ts`) — pure decision:
  `shouldSuppressTapSyntheticMouse({ moved, target })`, surface detection via `.xterm`.
- `packages/terminal-ui/src/utils/terminal-input-focus.ts` (+ `.test.ts`) — `isTouchFirstEnvironment`,
  `focusTerminalInput` / `blurTerminalInput` / `isTerminalInputFocused` / `refocusTerminalInput`.
- `packages/panels/src/device-console/terminal-keyboard-button.tsx` (+ `.test.tsx`) — the toggle.
- `packages/ghostty-terminal/src/terminal-pointer-handlers.test.ts` — pointer→focus decision tests.
- `docs/frontend/2026090606-mobile-keyboard-trigger.md`.

Modified:
- `packages/terminal-ui/src/components/touch/gesture-machine.ts` — dropped `terminal.focus()` from the
  reporting tap; added `moved` bookkeeping + `suppressTapSyntheticMouse()` on the scroll/pan/bypass/wheel
  touchend branch.
- `packages/terminal-ui/src/components/touch/types.ts` — removed the now-unused `TerminalScroller.focus`.
- `packages/terminal-ui/src/components/touch/gesture-machine.test.ts` — updated the two tap tests that
  asserted `focus`; added three tap-suppression tests.
- `packages/ghostty-terminal/src/terminal-pointer-handlers.ts` — `click` now honours the synthetic
  suppression window (it previously didn't); a suppressed `mousedown` additionally calls
  `preventDefault()` so the browser cannot steal focus off the textarea.
- `packages/terminal-ui/src/components/hooks/useTerminalInput.ts`,
  `.../hooks/useTerminalClipboard.ts`, `.../split/useSplitPaneTerminals.ts` — route implicit refocus
  through `refocusTerminalInput`; the two inline `innerWidth < 768 || 'ontouchstart'` copies collapsed
  into `isTouchFirstEnvironment()`.
- `packages/terminal-ui/src/index.ts` — export the new focus helpers.
- `packages/panels/src/device-console/terminal-shortcuts-slot.tsx` — `ShortcutsBar` takes an optional
  `keyboardToggle` (a stable `RefObject`, so the `memo` is not busted); with it the strip renders even
  when zero shortcuts are configured, which keeps the keyboard-avoidance lift measurement
  (`.terminal-shortcuts-strip` height) correct.
- `packages/panels/src/device-console/terminal-stage.tsx` — passes `keyboardToggle={isMobile ? terminalRef : undefined}`.
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` — `terminal.showKeyboard` /
  `terminal.hideKeyboard`; `bun run build:i18n` regenerated the generated subtree.
- `apps/fe/tests/mobile-terminal-interactions.spec.ts` — new spec (below).

## Deviations from the brief

- The brief suggested the hidden textarea lives in a "mobile input bar". It does not — it is an
  absolutely positioned contenteditable inside the ghostty DOM, pinned to the cursor cell, with
  `pointer-events: none`. There is therefore no tappable input area in direct mode, so I added the
  「显示键盘」 affordance to the existing shortcut bar as the brief's fallback allows.
- Made it a **toggle** rather than focus-only: with canvas taps no longer touching focus, there would
  otherwise be no in-app way to dismiss the keyboard on iOS. `aria-pressed` reflects the live focus
  state (document `focusin`/`focusout`).
- Also gated the selection-toolbar copy/paste/dismiss refocus (not mentioned in the brief) — it is the
  same class of bug and would have been an obvious inconsistency (long-press → copy → keyboard pops).
- No new methods were added to `GhosttyTerminal`/`TerminalDomSurface`: the commander flagged that
  `terminal.ts` and `terminal-dom.ts` are at their allowlisted line caps. Blur is done via the already
  exposed `CompatibleTerminalLike.textarea`, so both files are byte-for-byte unchanged.

## Test results

- Unit: terminal-ui **410 pass / 0 fail** (was 394), ghostty-terminal **333 / 0** (was 329), panels
  **1072 / 0**, apps/fe `bun test src/` **2868 / 0**.
  `packages/shared` is **849 pass / 1 fail** — `src/index.test.ts` "运行时导出面与快照一致" fails on a
  new `releaseSumsFileName` export, which is G2's release work, not mine (my change there is i18n only).
- tsc `--noEmit`: 0 errors in packages/terminal-ui, packages/ghostty-terminal, packages/panels,
  packages/shared, apps/fe.
- biome: clean on every file I touched (generated i18n files not linted).
- `bun scripts/complexity/gate.ts`: **ok** (no allowlist entries added or bumped).
- Playwright (each run picks free ports; production 9883 and tmux session `tmex` untouched):
  - `mobile-terminal-interactions.spec.ts` — 6 passed (incl. the new case)
  - `mobile-keyboard-avoidance.spec.ts`, `mobile-mouse-reporting.spec.ts`, `split-screen-mobile.spec.ts` — 8 passed
  - regression sweep `terminal-focus.spec.ts` (desktop), `terminal-ui.spec.ts`, `ws-borsh-resize.spec.ts`,
    `keyboard-behavior-settings.spec.ts` — 9 passed

New e2e case (`mobile: tapping the canvas never toggles the keyboard, the toggle button does`):
mount does not focus → tap canvas does not focus → tap the toggle focuses (`aria-pressed=true`) → tap
canvas again keeps focus (no flicker-shut) → tap the toggle again blurs. Verified it is a real
regression test by short-circuiting the suppression branch: it then fails at "tap canvas does not focus".

## For the commander

- Nothing to wire up. Locale keys are already regenerated (`packages/shared/src/i18n/**` generated
  files are in the diff — do not lint them).
- Verified visually on a 390×844 emulated device: the toggle renders as the first pill of the shortcut
  bar and swaps to the `KeyboardOff` icon when the keyboard is up.
- Note there are now two keyboard-ish icons on a mobile terminal page: the top toolbar's
  `terminal-input-mode-toggle` (direct ↔ editor) and the new bottom `terminal-keyboard-toggle`
  (show/hide keyboard). They are on different rows and have distinct labels; flagging in case the
  user wants one of them renamed.

---

## Revision (user decision): cursor-row tap opens the keyboard; the bar button is hide-only

The toggle-button design above was replaced per the user's decision. Behaviour now:

- Tapping the terminal's **input row** — the row the cursor is on, ±1 row of tolerance — focuses the
  hidden input and pops the keyboard.
- Tapping anywhere else on the canvas keeps the behaviour from the first pass: no focus change in
  either direction, scroll / long-press selection / mouse reporting untouched.
- Scrolled back into history (`viewportY !== baseY`) → the cursor row is off-screen, so no tap focuses.
- Mouse-reporting mode behaves the same: the tap still emits press+release, and additionally focuses
  only when it lands on the cursor row.
- The shortcut-bar button is now **hide-only**: 「隐藏键盘」 / "Hide Keyboard" / 「キーボードを隠す」,
  rendered only while the hidden input has focus, blurring on tap. `terminal.showKeyboard` was removed.

### How the gesture layer learns the cursor row

`getCursorViewportRect()` was unusable here — it returns null unless the terminal is already focused,
which is exactly the state we need to decide from. Instead I exposed the existing
`GhosttyTerminal.lastCursor` getter (last rendered snapshot, viewport-relative row; previously read
only by e2e probes) on `CompatibleTerminalLike`, and compute in `tap-focus.ts`:

- row of the tap = `floor((clientY - screenTop) / cellHeight)` where `screenTop` is the
  `.xterm-screen` client rect top and `cellHeight` is `_core._renderService.dimensions.css.cell.height`
  — the same basis as ghostty's own `hitTest`, so it stays correct under the pan viewport (follower);
- cursor row = `lastCursor.y` when visible, else null; null too when `viewportY !== baseY`.

This kept `terminal.ts` (875) and `terminal-dom.ts` (602) **byte-for-byte unchanged**, both under their
allowlisted caps (876 / 603). Only `types.ts` gained the optional `lastCursor` member.

### Files changed in this revision

- `packages/ghostty-terminal/src/types.ts` — optional `lastCursor` on `CompatibleTerminalLike`.
- `packages/terminal-ui/src/components/touch/tap-focus.ts` — added `TERMINAL_SCREEN_SELECTOR`,
  `CURSOR_ROW_TOLERANCE`, `cursorRowFromTerminal()`, `tapHitsCursorRow()`.
- `packages/terminal-ui/src/components/touch/types.ts` — `TerminalScroller` regains `focus?`, gains
  `lastCursor?` and `buffer.active.baseY?`.
- `packages/terminal-ui/src/components/touch/gesture-machine.ts` — `handleCanvasTap()` +
  `focusIfTapHitsInputRow()`; the reporting-mode tap focuses under the same rule.
- `packages/panels/src/device-console/terminal-keyboard-button.tsx` — now
  `TerminalHideKeyboardButton` (renders null unless focused; `useTerminalInputFocused` seeds its
  initial state lazily so SSR/static render is correct), testid `terminal-keyboard-hide`.
- `packages/panels/src/device-console/terminal-shortcuts-slot.tsx` — uses the hide button, no
  `disabled` (dismissing the keyboard must always work).
- i18n: removed `terminal.showKeyboard`; ja `hideKeyboard` → 「キーボードを隠す」; `build:i18n` rerun.
- Tests: `tap-focus.test.ts` (+7 cases for cursor row / tolerance / scrollback), `gesture-machine.test.ts`
  (harness gained `cursorRow` + `setScrolledBack`; +5 cases), `terminal-keyboard-button.test.tsx`
  rewritten, e2e case rewritten.
- `docs/frontend/2026090606-mobile-keyboard-trigger.md` — behaviour matrix, implementation and
  acceptance sections updated.

### Re-run results

- tsc `--noEmit`: 0 errors in terminal-ui, ghostty-terminal, panels, shared, apps/fe.
- Unit: terminal-ui **422 / 0** (was 410), ghostty-terminal **333 / 0**, panels **1072 / 0**,
  apps/fe `bun test src/` **2868 / 0**. (`packages/shared`'s single failure remains G2's
  `releaseSumsFileName` export snapshot, unrelated.)
- biome clean on all touched files; `complexity gate ok`, no allowlist changes.
- Playwright: `mobile-terminal-interactions` **6 passed** (rewritten case included),
  `mobile-keyboard-avoidance` + `mobile-mouse-reporting` + `split-screen-mobile` + `terminal-focus` +
  `terminal-ui` **10 passed**.
- Visual check at 390×844: tapping the prompt row pops the keyboard and the 「隐藏键盘」 pill appears as
  the first item of the shortcut bar; it is absent while the keyboard is down.

The new e2e case computes the cursor row's client Y in-page from `lastCursor` + `.xterm-screen`
metrics rather than hard-coding rows, so it stays valid if the fixture's prompt moves.
