# r3-session-commands — split `session-commands.ts`

Scope: `apps/gateway/src/tmux-client/external/session-commands.ts` plus new siblings. No git. Pure move-and-re-export; original module path still exports `SessionCommandHost`, the five argv builders, and `SessionCommands`. Existing test cases kept (still import the original path). Did not touch `ssh-external-connection.ts`, `local-external-connection.ts`, or `external-tmux-core.ts`.

## Verdict vs prior exploration

The file is a command facade with small methods, but it is **not** a flat bag of wrappers. Three real seams exist; the fourth group (window/pane mutation + `fire` + stacked-layout queue) does not.

| Group | Inbound from other groups | Why it is / is not a seam |
|---|---|---|
| Argv builders | none (pure) | Already free functions; zero `host` |
| Session lifecycle + `setWindowStyle` | none | Only `host.runTmuxAllowFailure` / `configureWindowStyle`; `ensureSession` is the sole user of `runTmux` |
| Pane query / capture | **one**: `selectPaneInternal` → `capturePaneHistory` | Otherwise only `host` + `runTmux` |
| Mutation + `fire` + `applyStackedLayout` | N/A (stayed) | Shared private `stackedLayoutTransition`, `runAndRefresh`, `noteCreatedPane`; internals call each other |

`runTmux` / `recoverFromTargetMissingError` are the shared I/O kernel used by lifecycle, query, and mutation, so they moved to a runner module rather than being copied.

## Files

**Added**

- `session-command-host.ts` (33L) — `SessionCommandHost` (shared contract; avoids a value cycle)
- `session-command-argv.ts` (67L)
- `session-command-runner.ts` (52L)
- `session-lifecycle-commands.ts` (165L)
- `session-pane-query.ts` (171L)

**Changed**

- `session-commands.ts` (742L → **380L**) — class keeps mutation/layout + 1-line delegates; re-exports host type and argv builders
- `session-commands.test.ts` — **unchanged** (12 cases, still import `./session-commands`)

## What moved

### `session-command-argv.ts`

`buildCreateWindowArgv`, `buildMovePaneArgv`, `buildSplitPaneArgv`, `buildBreakPaneArgv`, `buildResizePaneByIdArgv`. Bodies unchanged. Re-exported from `session-commands.ts`.

### `session-command-runner.ts`

`runTmux(host, argv, allowTargetMissing, timeoutMs)` and `recoverFromTargetMissingError(host, message)`. Class methods delegate so tests / `external-tmux-core` still call `commands.runTmux(...)`.

### `session-lifecycle-commands.ts`

Free functions taking `host`: `ensureSession`, `configureSessionOptions`, `configureWindowStyleDefault`, `createParkingWindow`, `removeParkingWindow`, `setWindowStyle`. `configureSessionFlags` / `configureTermEnvironment` stay unexported in that file. The `focus-events off` comment moved with the flags body.

### `session-pane-query.ts`

`requestPaneHistory`, `capturePaneText`, `getPaneInfo`, `getPaneHistoryCaptureInfo`, `capturePaneHistoryRange`, `capturePaneFrameAtBarrier`, `fetchPaneHistory`, `capturePaneHistory`.

`selectPaneInternal` now calls `capturePaneHistory(host, paneId)` directly (same function the class method delegates to). No subclass of `SessionCommands` exists.

### Left in the entry class

Fire-and-forget mutation API, `applyStackedLayout` (only private field), `runAndRefresh`, close/resize/split/focus/select/break internals, `findPaneWindowId`, `fire`, `noteCreatedPane`.

## Metrics

McCabe = 1 + `if` / `for` / `while` / `&&` / `||` / `?:` / `??` / `catch`. Length is function span. Implementation CC is unchanged (move only); class methods for moved work are now CC 1 delegates.

| Symbol | Before | After |
|---|---|---|
| `session-commands.ts` | 742L | **380L** |
| `SessionCommands.runTmux` | CC 10 / 35L | CC 1 / 6L (body → `runTmux` in runner, still CC 10 / 35L) |
| `recoverFromTargetMissingError` | CC 3 / 10L | CC 1 / 3L (body → runner, still CC 3 / 10L) |
| `ensureSession` | CC 2 / 20L | class CC 1 / 3L; impl CC 2 / 16L |
| `configureSessionOptions` | CC 1 / 12L | class CC 1 / 3L; impl CC 1 / 12L |
| `configureWindowStyleDefault` | CC 5 / 37L | class CC 1 / 3L; impl CC 5 / 40L |
| `createParkingWindow` | CC 3 / 20L | class CC 1 / 3L; impl CC 3 / 20L |
| `setWindowStyle` | CC 4 / 12L | class CC 1 / 3L; impl CC 4 / 12L |
| `fetchPaneHistory` | CC 5 / 37L | class CC 1 / 4L; impl CC 5 / 40L |
| `capturePaneHistoryRange` | CC 5 / 28L | class CC 1 / 7L; impl CC 5 / 29L |
| `applyStackedLayout` | CC 6 / 22L | CC 6 / 22L (stayed) |
| argv builders (5) | 65L in entry | 67L sibling; CC unchanged |

Totals: 742L → 868L across six files (+126 of imports / re-exports / delegates). Entry is under 400.

## Verification

- Scoped: `session-commands.test.ts` → **12 pass / 0 fail**
- `bun test` (`apps/gateway`): **1672 pass / 3 fail / 3 errors**. The 3 fail + 3 errors are another agent’s in-flight WS split (`src/ws/client-lifecycle.test.ts`, `client-send.test.ts`, `hello-negotiation.test.ts` — missing `./client-lifecycle`, `./client-send`, `./hello-negotiation`). None involve this slice. Baseline was 1669 pass / 0 fail; extra passes are other agents’ new cases.
- `bunx tsc --noEmit -p .`: **26 errors** (baseline 20). **None** in scoped files. Extra errors are other-agent (`ws/client-*`, `hello-negotiation`, plus pre-existing `ssh-*`, `telegram`, `issue45`, …).
- `bunx biome check` on the six scoped files: **clean**

Did not run Playwright e2e (`apps/fe/tests`).

## Skipped

- **Window/pane mutation + `fire` + `applyStackedLayout`.** One state machine (`stackedLayoutTransition`, `noteCreatedPane`, `runAndRefresh`). Splitting it would only relocate wrappers that still call each other.
- **New test cases.** Existing 12 still cover builders, lifecycle, parking, `closeWindowInternal`, `runTmux` recovery, `splitPaneInternal`, missing-window `selectWindow`, and `resizePane` via the original import path. Did not delete any.
- **Changing `external-tmux-core.ts` call sites.** Re-exports make that unnecessary.

## Bugs found (pre-existing, not fixed)

1. **`setWindowStyle(style)` gates on `config.tmuxWindowStyle`, not `style`.** If the configured default does not resolve, a caller-supplied style is silently ignored. `configureWindowStyleDefault(styleValue)` correctly resolves the argument it was given.
2. **`fetchPaneHistory` does not check `host.connected`**, unlike `capturePaneText` / `getPaneInfo` / the other query helpers. A disconnected host still hits `runTmux` (and then `runTmuxAllowFailure`). Same as before the move.
