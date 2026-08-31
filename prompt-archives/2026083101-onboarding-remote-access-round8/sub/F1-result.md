# F1 — Direct connection promoted to a top-level peer of Cloudflare Tunnel

## What changed

### `apps/fe/src/pages/settings/remote-access/tunnel-model.ts`
- New client-only type `ConnectionPath = 'tunnel' | 'direct'`; `WizardMode` is now just `TunnelMode`
  (the tunnel sub-mode), so "nothing chosen" (`chosenPath === null`) is distinct from
  "tunnel chosen, quick/named not picked" (`chosenMode === null`).
- `WizardContext` gained `chosenPath`.
- New step id `path` (first step in every sequence). Step lists:
  - nothing chosen → `['path']`
  - tunnel, no sub-mode → `['path','install','mode','tunnel','proxy']`
  - quick → `['path','install','mode','quick','proxy']`
  - named → `['path','install','mode','login','hostname','access','create','proxy']`
  - direct → `['path','direct']`
- New exported `effectivePath(status, chosenPath)`: returns `'tunnel'` whenever
  `status.config.mode !== 'off'` (persisted/adopted tunnel locks the path), otherwise the local choice.
- `wizardStepState` handles `path` (`current` until a path is chosen, then `done`); the `direct`
  step is now keyed off the path instead of the mode. `quick`/`mode` branches extracted into
  `quickStepState` / `modeStepState` helpers to keep the function under its allowlisted CC (now 26, cap 27).

### `apps/fe/src/pages/settings/remote-access/wizard.tsx`
- `TunnelWizardProps` gained `chosenPath` / `onChoosePath`.
- New `PathChooser` (2 cards, `remote-access-path-chooser`, testids
  `remote-access-path-tunnel` / `remote-access-path-direct` + `-input`): Cloud icon for
  Cloudflare Tunnel, Server icon for Direct connection; locked+preselected on tunnel when
  `status.config.mode !== 'off'`.
- `ModeChooser` is now the tunnel-type chooser: only `quick` / `named` (2 cards, `sm:grid-cols-2`).
  All existing testids (`remote-access-mode-chooser`, `remote-access-mode-quick[-input]`, …) unchanged.
- Both choosers share a new generic `ChoiceCard` (group `'path' | 'mode'` drives testid, radio group
  name and i18n key prefix) — no markup duplication.
- Exposure warning (`remote-access-exposure`) and the auth-required notice
  (`remote-access-auth-required`) stay attached to the `mode` step, which now only exists in the
  tunnel branch. `ExternalTunnelCard` still renders at the top of the wizard regardless of path
  whenever `external.detected && config.mode === 'off'`.

### `apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx`
- `chosenPath` state added; `TunnelStatusCard` is now rendered only when
  `effectivePath(status, chosenPath) === 'tunnel'` — i.e. hidden on a fresh page and on the
  direct path with no tunnel configured, shown whenever a tunnel is configured/adopted.

### i18n (`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`)
- `settings.remoteAccess.description` made neutral in all three languages
  (zh: 「通过 Cloudflare Tunnel 或直接连接远程访问本机 tmex。」).
- New group `settings.remoteAccess.path.{tunnel,direct}.{title,description}`; the old
  `settings.remoteAccess.mode.direct` group was removed and its copy carried into `path.direct`.
- New `settings.remoteAccess.steps.path.{title,description}` ("连接方式 / Connection method / 接続方法").
- `settings.remoteAccess.steps.mode.*` re-worded to tunnel-type ("隧道类型 / Tunnel type / トンネルの種類");
  `steps.tunnel.description` follows.
- **Task 6**: every `settings.remoteAccess.*` string the user hand-edited in zh_CN was re-written in
  en_US and ja_JP to match the new, shorter register (~50 keys each: `loginRequired`,
  `mode.named.description`, the whole `direct.*` subtree, `steps.install/login/access/direct/named`,
  most `errors.*`, `confirmRemove.*`, `externallyManagedNotice`, `exposure.*`,
  `access.credentials.apiTokenHint`, `access.sync.hint`, `access.app.enforceOff`, the whole
  `external.*` block) plus `settings.deviceManagement.description`.
- All edits were targeted string replacements (no whole-file reformat); key sets stay in sync across
  the three locales (only pre-existing en-only `devices.folders.itemCount_one/_other` plural keys differ).
- `bun run --filter @tmex/shared build:i18n` re-run; `resources.ts` / `types.ts` regenerated, not hand-edited.

### Tests
- `tunnel-model.test.ts`: `wizardSteps / effectivePath / effectiveMode` block rewritten (fresh state =
  `['path']` only; tunnel/quick/named/undecided sequences; configured tunnel forces path `tunnel`);
  new `path` step-state test; the 直接连接路径 block now drives `chosenPath: 'direct'`.
- `remote-access-tab.test.tsx`: new `describe('连接方式')` with 4 tests — fresh page shows only the two
  path cards (`stepOrder === ['path']`, no `remote-access-step-install`, no `remote-access-status`);
  picking tunnel reveals install + tunnel-type; picking direct leaves only the protection step and no
  status card; a configured tunnel locks both path cards and keeps the status card.
  Existing blocks updated: step-order expectations gained `path`, install/exposure/tunnel-idle
  assertions moved from `render()` to `renderWizard('off')` (= tunnel path, no sub-mode chosen),
  and the unconfigured-status-card / error-code / log assertions moved to a new `renderStatusCard()`
  helper that mounts `TunnelStatusCard` directly (the tab no longer renders it before a path is picked).
  `renderWizard` now derives `chosenPath` from its `mode` argument, so all existing call sites are unchanged.

## Verification

| Check | Result |
|---|---|
| `cd apps/fe && bun test src/pages/settings/remote-access src/pages/SettingsPage.test.tsx` | 197 pass, 0 fail (6 files) |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 `error TS` (baseline 0) |
| `cd packages/shared && bunx tsc --noEmit -p .` | 0 `error TS` |
| `bunx biome check` on changed files (repo root) | clean (2 formatting fixes applied with `--write`) |
| `bun run --filter @tmex/shared build:i18n` | ok, 3 locales |
| `bun scripts/complexity/gate.ts` | 1 violation, **not mine** — see below |

## Complexity gate

`wizardStepState` briefly went to CC 31 (allowlist 27) after adding the `path` step; it was refactored
(`modeStepState` restored, `quickStepState` extracted) and now measures **CC 26 / 35 lines**, inside its
allowlist entry. No allowlist change is needed for my files.

The remaining gate failure is outside my scope and comes from another agent's work in the same worktree:

```
complexity: packages/app/src/commands/init.ts:215 runInit: CC 19 > 18
```

## Notes / out of scope

- The `steps.tunnel` placeholder step was kept (tunnel branch, before a type is picked) rather than
  removed, since it is what tells the user the branch is not finished yet.
- `settings.remoteAccess.mode.direct.*` was deleted; nothing else referenced it
  (`status-card.tsx` only interpolates `mode.${status.config.mode}`, which is `quick`/`named`).
- `packages/shared/src/i18n/{resources,types}.ts` show up as modified — generated output of
  `build:i18n`, which also picked up other agents' in-flight locale edits in the same worktree.
