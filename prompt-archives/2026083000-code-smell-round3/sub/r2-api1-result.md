# r2-api1 — gateway API route complexity (round 2)

Scope: `llm.ts` `handleUpdateSettings`, `device-routes.ts` `shouldReconnectPushSupervisor` + `handleUpdateDevice`, `tree-order.ts` `handlePutTreeOrder`, `terminal-shortcuts.ts` item-mapping callback. Behaviour-preserving. No git.

## Files

**Changed**
- `apps/gateway/src/api/llm.ts` (364L → 387L)
- `apps/gateway/src/api/device-routes.ts` (206L → 248L)
- `apps/gateway/src/api/tree-order.ts` (165L → 193L)
- `apps/gateway/src/api/terminal-shortcuts.ts` (73L → 88L)
- `apps/gateway/src/api/llm.test.ts` (extended)
- `apps/gateway/src/api/tree-order.test.ts` (extended)
- `apps/gateway/src/api/terminal-shortcuts.test.ts` (extended)

**Added**
- `apps/gateway/src/api/device-routes.test.ts` (PATCH characterization; 6 cases)

## What moved

All listed functions were restructured. None skipped: each was a nested validation / copy / decision nest, not a flat dispatch.

### `handleUpdateSettings`

Same pattern as provider PATCH: `SETTINGS_UPDATE_FIELDS` + `applyConfigFields`. Parsers preserve error strings (`llmSearchProviderInvalid`, `llmDefaultProviderNotFound`, `invalidRequest`) and field order. Encrypt stays async after parse (`omit` → `undefined` skip; empty/whitespace trim → `null` clear). Handler is now parse → encrypt secrets → `updateAgentSettings` → `broadcastSettingsUpdate('llm')`.

### `shouldReconnectPushSupervisor` / `handleUpdateDevice`

Reconnect decision is two field lists (`RECONNECT_IF_CHANGED` vs `RECONNECT_IF_PRESENT`) instead of ten `if`s. Partial copy uses `DEVICE_UPDATE_FIELDS` + `applyConfigFields` (identity `takePresent`; `defaultWorkingDir` still `trim() || undefined`). Secrets still encrypt after parse. `applyDevicePushSideEffects` keeps reconnect-over-working-dir precedence. No new 400s — device PATCH still does not type-check fields.

### `handlePutTreeOrder`

`TREE_ORDER_FIELDS` (`windows` via `parseStringArrayField`, `panes` via `isPaneOrderMap`) + at-least-one-present check. Same 400/503/404 and the same `req.json()` try/catch (not `readJsonObjectBody`, which would turn JSON `null` into 400). Apply path still `reorderWindows` then per-window `reorderPanes`.

### terminal-shortcuts map callback

Callback is now `normalizeShortcutItem`. Send/action branches are `normalizeSendShortcut` / `normalizeActionShortcut`; shared invalid throw is `invalidShortcut()`. Same messages and limits.

## Metrics

CC = 1 + `if` / `&&` / `||` / `?:` / `for` / `catch` (same style as the round baseline; lizard not installed). Length is function span.

| Symbol | Before | After |
|---|---|---|
| `handleUpdateSettings` | CC 18 / 53L | CC 3 / 18L |
| `parseUpdateSettingsFields` | — | CC 2 / 6L |
| `shouldReconnectPushSupervisor` | CC 18 / 15L | CC 2 / 7L |
| `handleUpdateDevice` | CC 17 / 39L | CC 2 / 16L |
| `buildDeviceUpdates` | — | CC 5 / 12L |
| `applyDevicePushSideEffects` | — | CC 4 / 15L |
| `handlePutTreeOrder` | CC 16 / 47L | CC 8 / 32L |
| `parseTreeOrderPatch` | — | CC 4 / 10L |
| `<arg of body.items.map>` | CC 15 / 34L | CC 1 / 1L |
| `normalizeShortcutItem` | — | CC 10 / 23L |
| `normalizeSendShortcut` | — | CC 4 / 7L |
| `normalizeActionShortcut` | — | CC 3 / 10L |

## Verification

- Scoped tests: **55 pass / 0 fail** (`llm` + `tree-order` + `terminal-shortcuts` + new `device-routes`)
- `bun test` in `apps/gateway`: **1669 pass / 0 fail** (baseline 1559; extras are this scope + other in-flight agents)
- `bunx tsc --noEmit -p .`: **25 errors** (baseline 27). **None in scoped files.** Remaining errors are other agents / pre-existing (`push/supervisor.test.ts`, `tmux-client/*`, `ws/issue45-cross-bug.test.ts`, …)
- `bunx biome check` on the 8 scoped files: **clean**
- Did not run Playwright e2e (`apps/fe/tests`)

## Skipped

- Did not add type validation to device PATCH (would change behaviour; original copies untyped JSON).
- Did not switch tree-order JSON parse to `readJsonObjectBody` (would change JSON `null` from throw to 400).
- Did not fix the blank-`defaultWorkingDir` bug below.

## Bugs found (not fixed)

PATCH `/api/devices/:id` with blank/whitespace `defaultWorkingDir` sets `updates.defaultWorkingDir = trim() || undefined`. Both `updateDevice` and the supervisor branch gate on `!== undefined`, so the column is **not** cleared and `updateDefaultWorkingDir` is **not** called. DB `updateDevice({ defaultWorkingDir: '' })` can clear; the HTTP path cannot. Characterization test documents current behaviour.
