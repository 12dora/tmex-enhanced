Baseline: current branch matches `main`; prior round’s explicit rejections are respected. Estimated post-refactor metrics are approximate.

### 1. Table-drive legacy snapshot field application

files: `packages/shared/src/ws-borsh/state-snapshot-diff.ts`, new `packages/shared/src/ws-borsh/state-snapshot-field-appliers.ts`

metric: `applyPaneFields` CC 28 / 30L; `applyWindowFields` CC 14 / 15L; file 266L.

**Why it hurts** — Pane and window fields duplicate type checks, nullable-field handling, and assignment rules in long `if/else` chains. Adding a field requires editing branching code and can silently diverge between entity types. Unknown fields and invalid values are intentionally ignored, so careless simplification could change wire compatibility.

**Concrete refactor** — Add typed per-entity descriptor tables keyed by source field ID. Each descriptor provides its runtime value guard and assignment operation; share `applyTypedFields`. Preserve field order, last-valid-value-wins behavior, unknown-field ignoring, and `null` deletion through `assignOptional`.

**Risk**: Medium.  
**Existing coverage**: `packages/shared/src/ws-borsh/state-snapshot-diff.test.ts` covers basic title/path updates and round trips, but not the complete field matrix. Add focused table tests; no existing test is unmaintainable.

**Expected effect** — `applyPaneFields` CC 28 → ~3; `applyWindowFields` CC 14 → ~3. Main file ~266L → ~215L; descriptor module ~100L.

### 2. Extract the legacy snapshot tree editor

files: `packages/shared/src/ws-borsh/state-snapshot-diff.ts`, new `packages/shared/src/ws-borsh/legacy-snapshot-editor.ts`

metric: `applyLegacyStateSnapshotDiff` CC 24 / 75L; file 266L.

**Why it hurts** — One function performs snapshot cloning, removals, session creation, window creation, pane relocation, pane insertion, and field application. Pane moves depend on preserving object identity, destination order, and removal-before-upsert semantics; changes are therefore easy to make in the wrong phase.

**Concrete refactor** — Move `cloneSnapshot`, removal handling, and entity upsert operations into a `LegacySnapshotEditor`. Use separate `removeEntity`, `upsertSession`, `upsertWindow`, and `upsertPane` operations. Keep `applyLegacyStateSnapshotDiff` as orchestration: clone → removals → ordered upserts. Preserve the existing pane move behavior and insertion order exactly.

**Risk**: Medium-high.  
**Existing coverage**: `packages/shared/src/ws-borsh/state-snapshot-diff.test.ts` covers pane movement and removal, but not all replacement/order cases.

**Expected effect** — `applyLegacyStateSnapshotDiff` CC 24 → ~6 / ~25L. Main file ~215L → ~150L; editor module ~110L.

### 3. Separate render-cell decoding from row iteration

files: `packages/ghostty-terminal/src/render-state.ts`, new `packages/ghostty-terminal/src/render-state-cell.ts`

metric: `readRow` CC below 12 / 73L; file 612L.

**Why it hurts** — `readRow` mixes row iterator control, raw-cell pointer reads, grapheme decoding, width decoding, style decoding, and optional color ABI calls. Pointer ownership and cell semantics are interleaved, making ABI changes difficult to review and leaving no focused seam for cell/attribute regression tests.

**Concrete refactor** — Add `decodeRenderCell(resources, x)` to own raw-cell, grapheme, width, style, foreground, and background decoding. Keep `readRow` responsible only for obtaining the raw row, binding cells, iterating cells, and decoding row flags. Preserve every `try/finally` allocation boundary.

**Risk**: Medium-high.  
**Existing coverage**: `packages/ghostty-terminal/src/terminal.canvas.test.ts` exercises basic render-state integration; `packages/ghostty-terminal/src/render-state.leak.test.ts` covers constructor cleanup. There is NO focused cell/style/color decode matrix.

**Expected effect** — `readRow` ~73L → ~28L, CC below 5. Main file ~612L → ~540L; cell decoder ~90L.

### 4. Centralize WASM two-pass UTF-8 output marshalling

files: `packages/ghostty-terminal/src/ghostty-wasm.ts`, new `packages/ghostty-terminal/src/wasm-output-marshalling.ts`

metric: `encodeKeyHandle` 43L and `encodePaste` 49L, both below the supplied CC-12 threshold; `ghostty-wasm.ts` 1496L.

**Why it hurts** — Key and paste encoding independently implement required-size allocation, output allocation, written-length reading, UTF-8 decoding, and nested cleanup. A future change to the two-pass ABI protocol can fix one path while leaking or mis-handling the other.

**Concrete refactor** — Add `encodeOwnedUtf8Output` accepting allocation/read/free callbacks plus size/body encoder callbacks. Preserve accepted `OUT_OF_SPACE`/`SUCCESS` size results, zero-length return behavior, error labels, and cleanup order. Keep input/event lifecycle in `GhosttyBindings`; only share output-buffer ownership.

**Risk**: Medium.  
**Existing coverage**: `packages/ghostty-terminal/src/ghostty-wasm.alloc.test.ts` covers theme and formatter allocation failures, and `ghostty-wasm.retry.test.ts` covers loader caching. There is NO direct key/paste output-allocation failure coverage.

**Expected effect** — Each caller ~10–20L; `ghostty-wasm.ts` ~1496L → ~1450L; helper ~70L.

### 5. Make canvas foreground painting table-driven and composable

files: `packages/ghostty-terminal/src/canvas-renderer.ts`, new `packages/ghostty-terminal/src/block-elements.ts`, new `packages/ghostty-terminal/src/cell-decorations.ts`

metric: `drawRowForeground` CC 16 / 71L; `drawBlockElement` CC 15 / 61L; file 670L.

**Why it hurts** — Foreground iteration, glyph selection, block-element classification, font setup, and three decoration geometries are coupled. The block-element routine contains several independent codepoint ranges and quadrant branches whose mappings can drift or overlap.

**Concrete refactor** — Move block rendering into `drawBlockElement(context, codepoint, geometry)` backed by explicit range/exact-codepoint painter descriptors. Preserve 1/8 rounding, shade alpha, quadrant bit order, and unknown-codepoint no-op behavior. Move underline/strike/overline geometry into `drawCellDecorations`. Keep `drawRowForeground` responsible for skip rules, colors, font selection, and painter dispatch.

**Risk**: Low-medium.  
**Existing coverage**: `packages/ghostty-terminal/src/terminal.canvas.test.ts` covers only selected block characters; `packages/ghostty-terminal/src/canvas-renderer.vcenter.test.ts` covers decorations and dirty-row behavior. Add focused full-range block geometry tests.

**Expected effect** — `drawRowForeground` CC 16 → ~5 / ~35L; block dispatch CC 15 → ~3 / ~20L. Main file ~670L → ~560L; helpers ~110L.

### 6. Extract cursor shape painting from cursor lifecycle

files: `packages/ghostty-terminal/src/canvas-renderer.ts`, new `packages/ghostty-terminal/src/cursor-painter.ts`

metric: `drawCursor` CC 15 / 72L; file 670L.

**Why it hurts** — Canvas clearing, invisible-cursor handling, cursor geometry, blink timer management, and previous-cursor invalidation are in one routine. Shape geometry changes can accidentally affect timers or dirty-row invalidation.

**Concrete refactor** — Add `drawCursorShape(context, shape, geometry, color)` for bar, underline, hollow-block, and block painting. Keep `drawCursor` responsible for clear/visibility checks, blink start/stop, `lastCursor`, and invalidation. Preserve alpha and wide-tail dimensions.

**Risk**: Low.  
**Existing coverage**: `packages/ghostty-terminal/src/canvas-renderer.cursor.test.ts` is strong: all shapes, blinking, wide tails, invisible cursors, color fallback, and previous-row invalidation.

**Expected effect** — `drawCursor` CC 15 → ~6 / ~32L; helper ~35L. Main file ~670L → ~615L.

### 7. Isolate deferred select effects and replay ordering

files: `packages/ws-client/src/state-machine.ts`, new `packages/ws-client/src/deferred-select-effects.ts`

metric: `handleLiveResume` CC 13 / 50L; `replayDeferred` CC 13 / 38L; file 662L.

**Why it hurts** — Reset, history, flush, and output callbacks are stored in four maps, replayed in a strict order, and conditionally blocked until replacement effects are available. The same ordering logic is entangled with transaction completion and output-gate shutdown.

**Concrete refactor** — Add `DeferredSelectEffects` owning the four queues and exposing `defer*`, `hasReplacement`, `deviceIds`, `clear`, and `replay`. Preserve the exact order: reset → history reset/apply → stop if replacement remains → buffered flush → deferred outputs. Make `setCallbacks` replay the union of queued device IDs instead of iterating five maps.

**Risk**: Medium-high.  
**Existing coverage**: `packages/ws-client/src/state-machine.test.ts` covers deferred history, sibling output, flushes, timeouts, and stale timer callbacks. Add one explicit all-queue ordering test.

**Expected effect** — `replayDeferred` CC 13 → ~2; `handleLiveResume` CC 13 → ~8. Main file ~662L → ~555L; helper ~130L.

### 8. Share the vertical and horizontal gesture accumulator

files: `packages/ghostty-terminal/src/terminal-input-bridge.ts`, new `packages/ghostty-terminal/src/gesture-delta-accumulator.ts`

metric: `gestureToLines`/`gestureToColumns` CC ~12 / ~30–32L each; file 420L.

**Why it hurts** — Both methods duplicate source checks, line/page-mode resets, signed rounding, pixel remainder accumulation, and viewport scaling. Fixes to wheel rounding can diverge between axes.

**Concrete refactor** — Add a stateful `GestureDeltaAccumulator.consume({ source, delta, deltaMode, cellSize, pageSize })`. Keep separate vertical and horizontal instances. Preserve non-wheel rounding, line/page reset semantics, signed remainder handling, fallback cell dimensions, and zero-delta behavior.

**Risk**: Low-medium.  
**Existing coverage**: `packages/ghostty-terminal/src/terminal.canvas.test.ts` covers horizontal wheel and touch integration. There is NO direct accumulator test.

**Expected effect** — Both bridge methods disappear; helper CC ~7. Main file ~420L → ~350L; helper ~70L.

### 9. Separate history-page validation from cache mutation

files: `packages/terminal-ui/src/components/TerminalSurface.ts`, new `packages/terminal-ui/src/components/terminal-history-page.ts`

metric: `applyHistoryPage` CC 18 / 43L; file 238L.

**Why it hurts** — The method combines lifecycle guards, epoch/device/line validation, cursor validation, history limits, byte ownership, sorting, snapshot writes, and recovery signaling. The distinction between `cache_evicted` recovery and silent history-limit exhaustion is subtle and easy to break.

**Concrete refactor** — Add pure `validateHistoryPage` returning `invalid`, `limit`, or `accepted`, including all epoch/cursor/line checks. Keep `applyHistoryPage` responsible for recovery requests and delegate accepted pages to a cache commit helper that copies bytes, sorts pages, updates counters/cursor, and writes the snapshot.

**Risk**: Medium-high.  
**Existing coverage**: NO direct `TerminalSurface.applyHistoryPage` coverage. `packages/terminal-ui/src/components/terminal-snapshot.test.ts` tests snapshot writing only.

**Expected effect** — `applyHistoryPage` CC 18 → ~5 / ~18L. Main file ~238L → ~195L; helper ~70L.

### 10. Extract the resize-report decision policy

files: `packages/terminal-ui/src/components/useTerminalResize.ts`, new `packages/terminal-ui/src/components/resize-report-policy.ts`

metric: inner `reportSize` CC 16 / 50L; hook 319L; file 350L.

**Why it hurts** — `reportSize` mixes connection validity, follow/report mode, selection exceptions, suppression windows, measurement, duplicate-size handling, local resize, and callback selection. These rules are important but currently only exercised through hook integration.

**Concrete refactor** — Add pure `decideResizeReport` returning `skip`, `localOnly`, or `report` with size and callback kind. Preserve the special `sync + isSelectionInvalid` rule, follow mode, suppression timing, same-size local application, and `onResizeSettled` only after actual reporting.

**Risk**: Medium.  
**Existing coverage**: `packages/terminal-ui/src/utils/resizeSyncGuards.test.ts` covers adjacent policies, but there is NO direct hook/report-policy coverage. Add a decision-table test.

**Expected effect** — `reportSize` CC 16 → ~5 / ~25L. Hook file ~350L → ~305L; policy helper ~80L.

### 11. Make pointer mousedown policy pure

files: `packages/ghostty-terminal/src/terminal-pointer.ts`, new `packages/ghostty-terminal/src/terminal-pointer-policy.ts`

metric: `mousedownListener` CC 14 / 60L; file 292L.

**Why it hurts** — The listener encodes an order-sensitive policy: synthetic-event suppression, focus, Shift bypass, reporting precedence, link activation, and local selection. Moving one condition can make Cmd-click activate a link during mouse reporting or allow a synthetic event to clear selection.

**Concrete refactor** — Add pure `classifyMouseDown({ reporting, shiftBypass, button, platformModifier, hasLink })`. Keep DOM guards, focus, state mutation, and event effects in the listener. Preserve reporting-before-link precedence and the `reportBypassed` state transition.

**Risk**: Medium.  
**Existing coverage**: `packages/ghostty-terminal/src/terminal.canvas.test.ts` provides integration coverage for mouse reporting, links, and selection. There is NO focused pointer-policy test.

**Expected effect** — `mousedownListener` CC 14 → ~4 / ~25L. Main file ~292L → ~255L; policy helper ~50L.

## Not worth doing

- `packages/ghostty-terminal/src/ghostty-wasm.ts:encodeMouseEvent` — CC 33, but protocol priority and rejection rules are already explicit; a dispatch table would obscure ordering.
- `emitOsc` — flat protocol dispatch with no simpler proven table-driven form.
- `packages/ghostty-terminal/src/ghostty-wasm.ts:mouseButtonCode` — CC 12 but only a tiny mapping switch; extraction adds indirection.
- `packages/ghostty-terminal/src/canvas-renderer.ts:render` and `resize` — coherent render-pipeline and canvas-resource lifecycle routines; splitting would mostly relocate lines.
- `packages/ghostty-terminal/src/terminal.ts` — public controller facade with straightforward delegation and important lifecycle ordering.
- `packages/terminal-ui/src/components/touch/gesture-machine.ts` — already an explicit state machine with child gesture objects and substantial transition tests.
- `packages/terminal-ui/src/components/Terminal.tsx` and `SplitTerminalArea.tsx` — JSX composition/wiring is readable; line count does not indicate branching complexity.
- `packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts` — async creation, cancellation, diagnostics, and cleanup form one lifecycle; no direct hook coverage makes the risk disproportionate.
- `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts` — DOM orchestration is already separated from tested viewport policy helpers.
- `packages/ws-client/src/client.ts` — lifecycle facade over heartbeat, reconnect, and protocol components; further splitting would redistribute responsibilities.
- `packages/shared/src/ws-borsh/schema.ts` — declarative wire schemas whose order is protocol-sensitive; file length is inventory, not control-flow complexity.
- `packages/shared/src/ws-borsh/state-snapshot-diff.ts:decodeLegacyStateSnapshotDiff` — short boundary validation; extracting it adds little, while stricter validation would change accepted wire data.
- `packages/api-client/src/upload-transfer.ts` and download transfer — linear transport workflows with existing cleanup tests; no meaningful branching reduction.
- `packages/notifications/**` and `packages/theme/**` — no comparable high-risk complexity seam in the inspected code.