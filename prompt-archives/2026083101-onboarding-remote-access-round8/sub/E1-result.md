I could not write `/Users/konata/code/tmex-enhanced-wt-r8/prompt-archives/2026083101-onboarding-remote-access-round8/sub/E1-result.md`: the environment is read-only and `apply_patch` rejected the write. No project files were modified. The report is reproduced below.

# Remote Access Onboarding Report

## 1. Files and components

- Entry/lazy loading: `apps/fe/src/pages/SettingsPage.tsx:48-67,78-96,220`
- Page composition and local state: `apps/fe/src/pages/settings/remote-access/remote-access-tab.tsx:24-28,46-147`
- Wizard orchestration: `apps/fe/src/pages/settings/remote-access/wizard.tsx:34-125`
- Step dispatch: `wizard.tsx:159-242`
- Install and mode chooser: `wizard.tsx:244-402`
- Quick/proxy steps: `wizard.tsx:404-541`
- Named flow: `named-step.tsx:22-346`
- Direct flow: `direct-step.tsx:32-266`, `direct-model.ts:14-69`
- Access flow: `access-step.tsx:43-90`, `access-model.ts:52-121`
- External tunnel UI: `external-card.tsx:19-172`
- Tunnel status/removal/log UI: `status-card.tsx:51-350`
- Exposure warnings: `exposure.tsx:1-180`
- Step shell: `step-shell.tsx:10-80`

The client-side extension is:

- `apps/fe/src/pages/settings/remote-access/tunnel-model.ts:92-108`
- `WizardMode = TunnelMode | 'direct'`

The step-list definitions are:

- `tunnel-model.ts:120-132`
  - `NAMED_STEPS`
  - `QUICK_STEPS`
  - `DIRECT_STEPS`
  - `UNDECIDED_STEPS`

The mode-selection UI is:

- `wizard.tsx:317-360`
- Cards are rendered at `wizard.tsx:337-357`; direct is the third card.

Hooks/actions:

- Tunnel status query: `use-tunnel-status.ts:12-42`
- Protected query/cache: `use-protected-status-query.ts:15-126`
- Tunnel action controller: `tunnel-actions.ts:20-185`
- Shared auth-mode store: `apps/fe/src/node/mesh-nodes.ts:194-283`

There is no dedicated persisted front-end wizard store. Wizard selection and drafts are React state in `remote-access-tab.tsx:50-56`; tunnel status is stored in React Query.

## 2. Current-step derivation

`wizardSteps(ctx)` is implemented at `tunnel-model.ts:134-141`. It first computes `effectiveMode` at `143-153`:

1. Persisted server tunnel mode wins.
2. Otherwise, local `chosenMode` is used.
3. If neither exists, mode is `off`.

Step states are calculated by `wizardStepState` at `tunnel-model.ts:155-197`.

| Mode | Current sequence |
|---|---|
| Undecided / `off` | `install → mode → tunnel → proxy` |
| Quick | `install → mode → quick → proxy` |
| Named | `install → mode → login → hostname → access → create → proxy` |
| Direct | `mode → direct` |

Install readiness is `binary.installed || config.externallyManaged` (`tunnel-model.ts:155-159`). Direct itself is not gated by cloudflared installation:

- Direct uses `DIRECT_STEPS = ['mode', 'direct']`.
- Direct mode remains selectable regardless of binary state (`tunnel-model.ts:199-209`).
- Existing test confirms direct remains enabled without cloudflared: `remote-access-tab.test.tsx:891-897`.

The current misleading behavior comes from the undecided default sequence showing `install` first. The direct branch itself does not require installation.

## 3. API and server shape

There is no `/api/remote-access/*` API.

Tunnel APIs:

- Contract and `TunnelMode`: `packages/shared/src/contracts/tunnel.ts:4,41-68,146-227`
- Client calls:
  - `packages/api-client/src/local/tunnel-api.ts:40-58`
  - `GET /api/tunnel/status`
  - `POST /api/tunnel/actions`
- Gateway routes: `apps/gateway/src/api/tunnel-routes.ts:48-200`
- Route registration: `apps/gateway/src/api/index.ts:23-44`
- Persisted tunnel configuration: `apps/gateway/src/tunnel/config-store.ts:8-37,83-127`
- Tunnel process/adoption behavior: `apps/gateway/src/tunnel/manager.ts:1110-1160`
- Named-tunnel access semantics: `apps/gateway/src/tunnel/access-store.ts:51-112`

Server `TunnelMode` remains only:

```ts
'off' | 'quick' | 'named'
```

Direct uses existing local-auth APIs:

- Front-end wrapper: `local-auth-api.ts:38-51`
- Gateway routes: `apps/gateway/src/mesh/auth-routes.ts:99-122,157-203`
- Database/auth implementation: `apps/gateway/src/db/local-auth-http.ts:33-43,85-121`

Therefore, the restructure is front-end-only with respect to tunnel mode, tunnel contracts, and tunnel routes. The direct branch may still call existing auth endpoints when enabling protection, but it does not create or modify a server `TunnelMode`.

## 4. Existing tests

Front-end model tests:

- `apps/fe/src/pages/settings/remote-access/tunnel-model.test.ts:122-289`
- Cover step lists, state transitions, direct mode, and persisted server-mode precedence.

Wizard/page tests:

- `remote-access-tab.test.tsx:615-751`
  - Named/quick ordering
  - Install states and jobs
  - Configured tunnel lock
  - External management
  - Proxy behavior
- `remote-access-tab.test.tsx:882-977`
  - Direct card selection
  - Direct protection flow
  - Direct does not invoke tunnel actions
- `remote-access-tab.test.tsx:1313-1346`
  - Direct `TunnelWizard` fixture rendering

Supporting tests:

- `direct-model.test.ts:28-116`
- `tunnel-actions.test.ts:132-289`
- `access-model.test.ts:139-236`
- `apps/fe/src/pages/SettingsPage.test.tsx:87-110`

Gateway/API tests:

- `apps/gateway/src/api/tunnel-routes.test.ts:89-270`
- `apps/gateway/src/mesh/auth-routes.test.ts:431-631`
- `packages/api-client/src/auth/auth-api.test.ts:37-43`

No dedicated remote-access E2E spec was found. Existing settings E2E files only cover unrelated settings:

- `apps/fe/tests/settings.spec.ts:131-184`
- `apps/fe/tests/mobile-settings.spec.ts:130-167`

## 5. i18n

The three locale trees are aligned:

- `packages/shared/src/i18n/locales/en_US.json:278-644`
- `packages/shared/src/i18n/locales/zh_CN.json:278-644`
- `packages/shared/src/i18n/locales/ja_JP.json:278-644`

Generated type keys are in `packages/shared/src/i18n/types.ts:280-468`. `resources.ts` is generated and should not be edited manually.

Key groups:

- Page/status shell: `:278-295`
- Existing mode cards: `:297-310`
- Direct protection: `:311-365`
- Actions/logging: `:366-388`
- Wizard steps: `:389-481`
- Jobs/errors/auth: `:483-537`
- External/access UI: `:539-644`

Recommended changes:

- Make `settings.remoteAccess.description` neutral; it is currently Cloudflare-specific (`en_US.json:281-282`).
- Add a top-level group such as:
  - `settings.remoteAccess.connection.title`
  - `settings.remoteAccess.connection.description`
  - `settings.remoteAccess.connection.tunnel.title/description`
  - `settings.remoteAccess.connection.direct.title/description`
  - optional locked/change guidance
- Reuse or move `mode.direct` (`:306-309`) to the top-level selector.
- Keep `mode.quick` and `mode.named` for the Cloudflare submode chooser.
- Rename/rehome `steps.mode.*` (`:402-406`) to tunnel-specific wording.
- Remove or repurpose the placeholder `steps.tunnel.*` (`:407-410`) if the new connection selector becomes the first step.
- Retain `steps.direct.*` for the direct protection step.
- Keep install/login/hostname/access/create/quick/proxy, external, access, job, and error keys for the tunnel branch.

## 6. Recommended minimal-diff restructure

Introduce an explicit front-end path type:

```ts
type ConnectionPath = 'tunnel' | 'direct'
```

This should be separate from `WizardMode`, because the UI needs to distinguish “no top-level choice yet” from “Cloudflare selected, but no quick/named mode selected.”

Split the current wizard into:

- `ConnectionMethodChooser`
- `CloudflareTunnelBranch`
- `DirectBranch`

These may remain internal components in `wizard.tsx` to minimize file churn.

Keep existing tunnel components inside the Cloudflare branch:

- `InstallStep`
- quick tunnel step
- named login/hostname/access/create steps
- `ProxyStep`
- `ExternalTunnelCard`
- tunnel status/actions

Keep `DirectStep` and `direct-model` inside the direct branch. Move tunnel-only auth requirements and exposure warnings into the Cloudflare branch.

Recommended flow:

```text
connection → install → tunnel mode → quick → proxy
connection → install → tunnel mode → login → hostname → access → create → proxy
connection → direct protection
```

The initial undecided state should show only the top-level connection selector. Selecting Cloudflare then reveals install and the quick/named mode selector. Selecting Direct bypasses installation, login, tunnel proxy, and Cloudflare exposure steps.

Configured-state behavior:

- If `status.config.mode !== 'off'`, keep the Cloudflare branch authoritative and locked, using the existing precedence in `tunnel-model.ts:143-153`.
- A running or stopped persisted tunnel remains a Cloudflare selection; it must be removed before Direct can be selected.
- An adopted external tunnel remains in the Cloudflare branch. Installation is skipped/complete, and controls remain check/release (`status-card.tsx:150-217`).
- A detected but not adopted external tunnel has `config.mode === 'off'`; show its warning under the Cloudflare branch without forcing Direct or Cloudflare selection.
- After removal/release returns the persisted mode to `off`, allow the top-level selector again.
- `TunnelStatusCard` is currently unconditional (`remote-access-tab.tsx:130-144`); it should be hidden for an unconfigured Direct path to avoid implying that Direct requires tunnel configuration.

No server `TunnelMode`, API contract, route, or database schema changes are required.