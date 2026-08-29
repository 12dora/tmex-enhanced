# Task F9 — Devices management page grouped by node with node status

Read: prompt-archives/2026082900-hub-ui-tls/sub/explore-login-devices.md section 5 (data sources, sidebar three-state pattern, runtime scope, the global add-device event issue).

User feedback: "已登录后，节点应该出现在管理设备中（这里也应该有节点状态），但是那里依旧只有本地设备。"

Implement:
1. `apps/fe/src/pages/DevicesPage.tsx`: in standalone (`mode.mode==='none'`) keep today's single `DeviceManagementPanel`. In mesh, render one group per `useMeshNodes().nodes` entry (self first, then by name): header = node name + `NodeBadge`-style status (Online / Offline / Not signed in / Hub) + version; body: offline → read-only list from `inventoryDevices(node.inventory)` (grey), online & not signed in → the existing `NodeLoginButton` (do not auto-login; task F7 is changing login to be lazy — the button remains the affordance here), online & signed in → `<NodeRuntimeScope nodeId>` wrapping `DeviceManagementPanel` with `listenOpenAddDeviceEvent={false}` and its own "Add device" button wired to the panel's `openAddDevice()` (add that prop/ref to `packages/panels/src/device-management/device-management-panel.tsx` and `device-management-actions.tsx` minimal changes). The page-level "Add device" action (PageActions) applies to `self`.
2. Extract the group into `apps/fe/src/pages/devices/node-device-group.tsx` (+test). Reuse sidebar's helpers where exported (`inventoryDevices`, badge); do not modify sidebar files.
3. i18n: new keys under `devices.nodes.*` (group labels, statuses, "Sign in to manage devices", empty states). Because task F7 is editing the locale JSON files (auth namespace) concurrently, DO NOT edit the JSON: write `prompt-archives/2026082900-hub-ui-tls/sub/f9-i18n-keys.json` in the same shape as earlier (`{ "en_US": {...}, "zh_CN": {...}, "ja_JP": {...} }`, nested under `devices.nodes`) — the commander merges and rebuilds. `t()` accepts arbitrary keys (no CustomTypeOptions), so tsc stays clean.
4. Tests: DevicesPage static render for standalone vs mesh with three node states (injected mesh store / auth mode as NodesPage.test does); panel prop test for `listenOpenAddDeviceEvent={false}`.

Scope: apps/fe/src/pages/DevicesPage.tsx (+test), apps/fe/src/pages/devices/** (new), packages/panels/src/device-management/{device-management-panel.tsx,device-management-actions.tsx} (+tests), the f9-i18n-keys.json fragment. Nothing else.
Baseline: apps/fe 470/0 tsc 0; packages/panels 368/0 tsc 0.
Result: prompt-archives/2026082900-hub-ui-tls/sub/f9-result.md
## Ground rules (apply to every task)

- Repo: /Users/konata/code/tmex-enhanced-wt-merge (branch chore/merge-hub-tabs). Bun monorepo (Bun 1.3.14); NOT Node-compatible. If `bun` is not on PATH, `source ~/.zshrc`.
- Other agents are editing this same worktree IN PARALLEL. Touch ONLY the files/directories listed in your scope. If you believe you need to change a file outside your scope, do not edit it — describe the needed change in your result file instead.
- NEVER run any git command that changes state (no add/commit/stash/checkout/reset). Read-only git (status/diff/log) is fine. The commander commits.
- NEVER touch the production tmex service (launchd, port 9883, ~/Library/Application Support/tmex/) nor the tmux session named `tmex`. Do not run e2e (Playwright). Any ad-hoc server you start must use a scratch DB and ports in 20000-29999 and must be killed before you finish.
- Never lint/format generated files: packages/shared/src/i18n/resources.ts, types.ts, resources/fe-dist/*, dist/*. i18n: edit the three locale JSON sources, then run `bun run build:i18n` from the repo root.
- Code comments only where logic is non-obvious. Variable names in standard English. No TODOs, no stubs, no "simplified version" — finish the task fully. Do not restructure unrelated code.
- Verify before finishing: inside each package you touched run `bun test` (apps/fe: `bun test src/`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given to you), and `bunx biome check <changed files>`. macOS has no `timeout` command. Strip ANSI when parsing test summaries: `sed 's/\x1b\[[0-9;]*m//g'`.
- Follow the exploration report(s) given to you; if the code differs from the report, trust the code and note the discrepancy.
- Write your final report (English, markdown) to the result path given: what you changed (file list), how to verify, test/tsc numbers before/after, open issues, and any out-of-scope changes you need from others. The result file is the completion signal — write it last.
