# r2-api2 — gateway watch config, db writes, upload init

Scope: `buildEffectiveWatchRule`, `createWatchRule`, `updateSiteSettings`, `handleUploadInit`. No git. No files outside this list (plus their existing tests).

## Files

- **Changed** `apps/gateway/src/api/watch-rule-config.ts`
- **Changed** `apps/gateway/src/api/watch-rule-config.test.ts` (+2 cases; none deleted)
- **Changed** `apps/gateway/src/db/watch.ts`
- **Changed** `apps/gateway/src/db/agent-watch.test.ts` (+1 case)
- **Changed** `apps/gateway/src/db/site-settings.ts`
- **Changed** `apps/gateway/src/db/site-settings-persist.test.ts` (+2 cases; restore language/`enableBellPush` after assertions)
- **Unchanged** `apps/gateway/src/api/files.ts` (skipped `handleUploadInit`)

## What moved

### `buildEffectiveWatchRule`

`triggerType` is now the first `RULE_FIELD_SPECS` entry, using the existing `config-field.ts` `onAbsent` ctx: create → `'parse'` (undefined fails the enum → `watchTriggerTypeInvalid`); update → `'omit'`. Field-error order is unchanged because this spec is first.

Patch-or-existing-or-fallback merge is a one-line `coalesce` used by `resolveEffective`. The exported function is parse → resolve trigger → merge effective → `validateRuleSemantics` (untouched).

### `createWatchRule`

Optional INSERT columns live in `WATCH_RULE_OPTIONAL_DEFAULTS`. `applyDefaults` overlays only non-nullish input (`??` semantics: `false`/`0`/`''` kept; `null`/`undefined` take the default). Required columns (`id`, `name`, `deviceId`, `paneId`, `triggerType`, timestamps) stay explicit.

### `updateSiteSettings`

`next` is `{ ...current, ...omitNullish(updates), language: truthy ? normalizeLocale : current, updatedAt }`. Language still uses the truthy check (empty string does not clobber). Drizzle `.set(next)` writes the same full column set as before — one listing instead of constructing `next` and repeating every column in `.set({...})`.

## Metrics

McCabe = 1 + `if` / `for` / `&&` / `||` / `?:` / `??` / `catch` (same style as the round baseline). Length is function span.

| Symbol | Before | After |
|---|---|---|
| `buildEffectiveWatchRule` | CC 20 / 56L | CC 5 / 23L |
| `resolveEffective` | — | CC 2 / 18L |
| `coalesce` | — | CC 3 / 3L |
| `createWatchRule` | CC 16 / 34L | CC 2 / 21L |
| `applyDefaults` | — | CC 3 / 10L |
| `updateSiteSettings` | CC 15 / 54L | CC 3 / 22L |
| `omitNullish` | — | CC 3 / 10L |
| `handleUploadInit` | CC 15 / 26L | skipped (unchanged) |

## Verification

Characterization tests were green against the pre-refactor bodies, then stayed green.

- Scoped: `watch-rule-config.test.ts` + `agent-watch.test.ts` + `site-settings-persist.test.ts` + `watch.test.ts` + `site-settings.test.ts` + `theme.test.ts` + `watch/service.test.ts` + `events/` + i18n consumers → **159 pass / 0 fail**
- `bun test` (full package): **Bun segfault** after out-of-scope in-flight failures (`tmux-client/local-external-connection` missing `classifyControlSessionProbe` export; `push/supervisor.ts` syntax errors). Not in this scope.
- `bunx tsc --noEmit -p .`: **34 errors** (baseline 27). **None** in scoped files. Extra vs baseline are other agents (`tmux-client/*`, `push/*`, `telegram/service.ts`, `ws/issue45*`, `system/managed-endpoint.test.ts`, …).
- `bunx biome check` on the six scoped files: **clean**

## Skipped

**`handleUploadInit` (CC 15 / 26L).** Linear validation: JSON parse → coerce four fields → combined missing check → `sanitizeUploadName` → size cap → `statFile` dest-dir → create session. Distinct status/bodies (`invalidRequest` 400 vs `codeError('invalid')` vs `too_large` 413 vs stat codes). Folding into `applyConfigFields` would send a reader through a spec table + `config-field.ts` for a straight-line handler; that only moves the number.

## Bugs found

None. No unrelated fixes.
