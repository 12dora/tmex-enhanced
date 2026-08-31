# F8 — "Use this machine as the relay" steps 3/4/5 now reflect the actual configuration

## What changed

### New

- **`apps/fe/src/components/side-panels/connect-devices/host-status.ts`** — the pure derivation,
  React-free and independent of the remote-access modules.
  - `entryStatus(tunnel, hubPublicUrl) → { kind: 'named' | 'quick' | 'hubUrl' | 'none', url,
    running, hostname }`. `named` covers both a tmex-created and an adopted tunnel
    (`config.mode === 'named' && config.hostname`); `running` follows `tunnelPill` semantics
    (`config.externallyManaged ? external.running : process.state === 'running'`). `quick` needs a
    real `process.publicUrl`; without one there is nothing to show, so it falls through. When no
    tunnel yields an address the `hubPublicUrl` from `/api/auth/mode` is used (`kind: 'hubUrl'`) —
    that is the only marker a *direct-connection* setup leaves behind. Every field access is
    optional-chained, so the partial tunnel stubs that leak across the full-suite run cannot crash
    it (same defensive shape as `access-addresses.ts`).
  - `hubStatus(mode, entry) → { role: 'self' | 'node' | 'standalone', url, mismatch }`.
    `self` requires `mode.mode === 'mesh' && mode.hubNodeId && mode.hubNodeId === mode.nodeId`
    (a mesh mode with a missing `hubNodeId` is deliberately treated as `node`, never as self).
    `mismatch` is only computed against a **named** tunnel hostname (`new URL(hubPublicUrl).hostname
    !== entry.hostname`); with no named tunnel there is nothing to be inconsistent with.

  `tunnel-model.ts` was **not** imported: it pulls in `@tmex/api-client/local/tunnel-api`,
  `access-model` and `direct-model`, i.e. exactly the remote-access chunk the panel must not drag
  in. The derivation is reimplemented in ~10 lines instead. The tunnel query itself reuses
  `TUNNEL_STATUS_QUERY_KEY` / `fetchSelfTunnelStatus` from `@/pages/settings/status-queries` —
  the same thin module `use-access-addresses.ts` already uses, so the query cache is shared with
  the mobile page and no extra request is made.

- **`.../host-status.test.ts`** — 14 tests: named running / stopped, adopted external (running is
  the probe, not the local process, in both directions), quick with and without a public URL,
  hub-URL-only (direct connection), nothing configured, `null`/`undefined`/`{}` inputs, hub self /
  node / standalone, mismatch present and absent, mesh-without-`hubNodeId`.

### Modified

- **`.../guide-step.tsx`** — `GuideStep` gains `state?: 'todo' | 'done'` (default `'todo'`,
  behaviour unchanged). `done` renders a `Check` icon in the marker with the same classes as
  `WizardStepCard`'s `StepMarker` (`bg-primary/15 text-primary`, `size-3` icon) and a subtle
  `ring-primary/30` on the card; `data-step-state` and a `${testId}-marker` testid are exposed for
  tests. `step-shell.tsx` was not imported (it drags `tunnel-model` in through `StepState` /
  `jobStepKey`). New `GuideNote({ tone: 'muted' | 'warning', testId })` — one shared line renderer
  reusing the existing amber block styling that step 4's warning already used.
- **`.../computer-guide.tsx`** — `HostSteps` is now `HostSteps({ onSwitchToJoin })` split into
  `useHostStatus()` + `HostEntryStep` / `HostHubStep` / `HostInviteStep`:
  - **Step 3**: `none` → today's description + link (unchanged). Otherwise `state="done"` with
    `entry.status.named` (`{{url}}` + `{{state}}` from the existing
    `settings.remoteAccess.state.running/stopped`, so no duplicate copy was added) or
    `entry.status.hubUrl`, plus the amber `entry.status.quick` warning for a temporary tunnel.
    The settings link is kept in every branch.
  - **Step 4**: `self` → done + `hub.status.self` (+ amber `hub.status.mismatch` when the Hub URL
    and the tunnel hostname disagree) + the nodes link; `node` → `hub.status.node`, no link, no
    warning; `standalone` → the original description + warning + link, plus `hub.hintUseEntry`
    when step 3 resolved a named hostname.
  - **Step 5**: hub → `invite.ready` + an xs outline `connect-host-goto-join` button; otherwise
    the original description. `ComputerGuide` already owned the `mode` state, so it just passes
    `onSwitchToJoin={() => setMode('join')}`.
  - Loading/error: `useQuery` data is `undefined` until it resolves and `mode` is `null` until
    `/api/auth/mode` lands, both of which derive to the static copy — no spinner, no flicker,
    and a failed query is indistinguishable from "not configured", which is the safe reading.
- **`.../connect-devices-panel.test.tsx`** — the existing `HostSteps` test now passes
  `onSwitchToJoin` and additionally asserts the three steps are all `todo` with no done marker and
  no goto-join button; two new tests: mesh + `hubNodeId === nodeId` + `hubPublicUrl` (2 done
  markers, `entry.status.hubUrl`, `hub.status.self`, no `hub.description`/warning, goto-join button,
  `invite.ready`) and mesh-as-node (`hub.status.node`, no nodes link, no warning, no button).
- **`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`** — 8 new keys under
  `connectDevices.computer.host`, targeted block edit only, nothing else touched:
  `entry.status.{named,quick,hubUrl}`, `hub.status.{self,node,mismatch}`, `hub.hintUseEntry`,
  `invite.{ready,gotoJoin}`. `gotoJoin` (「去生成加入码」) is the button label the brief implied but
  did not name; the 「未知」 fallback for a node's unknown Hub URL reuses the existing
  `common.unknown` instead of a new key. `resources.ts` / `types.ts` regenerated with
  `build:i18n`.

## Verification (from the worktree)

| Check | Result |
| --- | --- |
| `apps/fe$ bun test src/components/side-panels` | 57 pass / 0 fail |
| `apps/fe$ bun test src/` | **1055 pass / 0 fail**, 73 files (baseline 1039/0; +16) |
| `apps/fe$ bunx tsc --noEmit -p .` | **0** `error TS` (baseline 0) |
| `bunx biome check <5 source files + 3 locale JSONs>` | clean (one auto-format on the new test file) |
| `bun run --filter @tmex/shared build:i18n` | ok, 3 locales |
| `bun scripts/complexity/gate.ts` | `complexity gate ok (1092 files, 9076 functions)` — no allowlist entry added, raised or removed |

No dev instance was started (19663/19883 untouched); no state-changing git command was run.

## Notes / out of scope

- A quick tunnel that is configured but has never produced a `publicUrl` degrades to the "nothing
  configured" copy (or to the Hub URL if one exists). That is deliberate: there is no address to
  show and the static copy's advice ("configure a public entry") is the correct next action.
- When this machine is a **node** (not the Hub), step 5 keeps the original description per the
  brief, even though a node cannot generate join tokens. Pointing that out would need a new key
  (something like `invite.nodeOnly`) — worth considering in a follow-up.
- `connectDevices.computer.host.entry.description` still describes both remote-access paths; only
  the `none` branch shows it now, which is where it belongs.
- `GuideNote` and the `state` prop are generic enough that the mobile guide and the join branch
  could adopt them (e.g. step 6's 「已加入」 could become a done marker). Not done — out of scope.
