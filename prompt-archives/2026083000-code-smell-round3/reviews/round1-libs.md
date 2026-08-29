### BLOCKER

1. [state-machine.ts:146](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/state-machine.ts:146), [deferred-select-effects.ts:116](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/deferred-select-effects.ts:116) — Cross-device replay order changed.

   Old: `setCallbacks()` replayed active transactions in `SELECT_START` insertion order. New: devices are ordered by effect-map type/insertion order. Start `A`, start `B`, receive history for `B` then `A`, then install callbacks: old replays `A → B`; new replays `B → A`. Reproduced current order as `reset:B, history:B, reset:A, history:A`.

2. [terminal-pointer.ts:104](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal-pointer.ts:104) — Link hit-testing now runs before mouse-reporting precedence is resolved.

   Old: reporting without Shift returned before `linkAtClient`. New: Cmd/Ctrl+left-click calls `linkAtClient` first, then reports. With DEC mouse reporting active over a link, this now mutates `LinkMatchCache` and performs link/file resolution before emitting the mouse press; if hit-testing throws, reporting is skipped entirely. The policy-only test does not observe this eager callback.

### MINOR

3. [terminal-input-bridge.ts:307](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal-input-bridge.ts:307), [terminal-input-bridge.ts:357](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal-input-bridge.ts:357) — Zero-axis gestures now invoke host getters.

   Old: a horizontal-only reported gesture (`deltaY=0`) skipped vertical conversion, and `deltaX=0` returned before horizontal getters. New: both accumulator inputs are eagerly constructed, calling `cellDimensions()` and `viewportRows/Cols()` for the zero axis. A throwing or side-effecting getter therefore changes the result; current production getters appear to be cheap state reads.

Verification: 128 scoped tests passed; TypeScript checks passed for all four scoped packages.