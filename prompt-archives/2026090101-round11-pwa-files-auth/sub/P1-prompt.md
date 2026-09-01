# P1 — Frontend: stop boot-time / steady-state work for nodes that are not on screen

Worktree: `/Users/konata/code/tmex-enhanced-wt-r11` (branch `feat/round11-pwa-files-auth`). Bun-only monorepo. **Other agents edit other files concurrently (T2a in `packages/stores` + `packages/panels/src/device-console`; T2b in `packages/ghostty-terminal` + `packages/terminal-ui`; T1 in `packages/ws-client` + gateway). Touch only the files in "Scope". Never run git commands.** Comments only where non-obvious, in Simplified Chinese like the surrounding code; report in English.

Read `prompt-archives/2026090101-round11-pwa-files-auth/sub/EX1-result.md` first (full audit with `path:line`). Implement these items; do not implement the "needs design" items #2/#3/#6/#7 of that report.

## Items

### P1-1 Remote node runtimes / direct dialing only for nodes actually in use (EX1 item 1)

Today `SidebarNodeSection` creates a `NodeRuntimeScope` for **every** online+logged-in remote node (`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:318-353`, `sidebar-device-list-runtime.tsx:64-102`), which starts the node runtime (`apps/fe/src/node/node-runtimes.ts:195-235`) and the direct-carrier controller, which immediately issues `GET /api/mesh/connection`, `GET /api/mesh/rtc-config`, `POST /api/rtc/authorize` and sets up a PeerConnection + a 2 s `getStats()` timer (`direct-carrier-controller.ts:444-604`, `packages/ws-client/src/direct/direct-carrier-controller.ts:932-970`). On a phone with several nodes this is the dominant boot/steady-state cost.

Change: a remote node runtime is created only when it is **needed on screen**: (a) the current route targets that node (`/n/:id/*`), or (b) its sidebar section is expanded (disclosure open) in the Terminals tab, or (c) its Files section is mounted and expanded, or (d) something explicitly asks for it (agent panel for that node, device console). Collapsed sections show presence/relay badges from the `/api/mesh/nodes` projection (already gateway-side; verify the sidebar badge does not depend on the browser's own direct carrier — if the badge does read the carrier state, fall back to the projection's `transport` field when no runtime exists). When a section collapses or the route leaves the node, the runtime is released with a short grace period (e.g. 30 s) so quick toggling does not re-dial; find the existing runtime ref-counting/release in `node-runtimes.ts` and reuse it. The entry/self runtime is unaffected. Make sure the login gate (`useNodeLoginGate`) still runs for an expanded section (it needs no runtime).

### P1-2 Single mesh poller + pause while hidden (EX1 items 4/5)

`useMeshNodes()` installs a 30 s timer per consumer (`apps/fe/src/node/mesh-nodes.ts:299-317, 345-386`; consumers `mesh-nodes-resident.tsx`, `sidebar-device-list.tsx:93-95`). Make the resident owner the sole poller (consumers with `enabled` just subscribe to the store), skip the poll while `document.visibilityState === 'hidden'`, and refresh once immediately on `visibilitychange → visible` if the last refresh is older than the interval. Do not touch the gateway WS heartbeat.

### P1-3 Device query gated on node login (EX1 item 9)

`GlobalDeviceProvider` (`apps/fe/src/components/global-device-provider.tsx:297-356`) is mounted outside `NodeRouteGate` (`apps/fe/src/node/node-runtime-boundary.tsx:40-69`), so a remote route fires `/api/devices` before the silent login completes (a guaranteed 401 + retry). Bind the query's `enabled` to gate readiness (or move the provider inside the gate — pick the smaller, safer change; the provider has tests in the same dir).

## Scope

`apps/fe/src/node/**` (except `apps/fe/src/auth/**`), `apps/fe/src/components/page-layouts/components/{sidebar-node-section.tsx,sidebar-device-list.tsx,sidebar-device-list-runtime.tsx,app-sidebar.tsx}` (+ tests), `apps/fe/src/components/global-device-provider*.ts*`, `apps/fe/src/main.tsx` only if the provider must move, `packages/panels/src/files/files-node-section.tsx` only for the "expanded" signal if not already exposed. Do **not** edit `packages/ws-client/**`, `packages/stores/**`, `packages/panels/src/device-console/**`, `packages/terminal-ui/**`, `apps/fe/src/auth/**`.

Note: the Files sidebar files (`packages/panels/src/files/**`, `app-sidebar.tsx`, `sidebar-device-list.tsx`) were just modified by another agent (F1) — read the current content before editing, keep its changes.

## Tests

- Unit tests for: runtime not created for a collapsed remote section; created when expanded/routed; released after grace; single poller with two consumers; poll skipped while hidden and refreshed on visible; device query disabled until gate ready.
- Do not run Playwright e2e (commander does). Run `bunx tsc --noEmit -p apps/fe`.

## Verification (must pass before reporting)

- `cd apps/fe && bun test src/` (baseline now **1114 pass / 0 fail**), `bunx tsc --noEmit -p .` (0 errors).
- `cd packages/panels && bun test` if touched; `bunx biome check <touched files>` clean.

## Report (final message, < 400 words)

Files changed, the exact "needed on screen" rule and grace period, how badges behave without a runtime, test counts before/after, anything unfinished.
