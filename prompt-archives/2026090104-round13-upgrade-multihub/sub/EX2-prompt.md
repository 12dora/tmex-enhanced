# EX2 — Explore: Nodes management UI (frontend, read-only)

You are a read-only code explorer. Do NOT modify files. Output the complete report as your FINAL MESSAGE (you cannot write files in this sandbox).

Repo: tmex monorepo (Bun runtime). Frontend is `apps/fe` (React + TS, zustand stores in `packages/stores`, API client in `packages/api-client`, i18n resources generated from `packages/shared/src/i18n/locales/*.json` via `bun run build:i18n` — never edit `resources.ts`/`types.ts` by hand).

## Goal

Settings → "Nodes" (多设备互联 → 节点管理) has a table of mesh nodes with an "Add" button at the top right and a per-row "Upgrade" action. We plan to:

1. Add an "Upgrade all" button to the LEFT of the "Add" button. It upgrades every upgradable node (excluding those already at latest, and handling self/hub ordering) and, when everything finished, shows one toast: "成功 X，失败 Y".
2. Grey out (disable) a row's Upgrade button when the node is already at the latest version.
3. Make the per-node upgrade status machine robust (it exists already: version readback confirm, POST lost-response → unconfirmed, AbortController cancel, error levels).

## Please report

1. File map: the Nodes page/table component(s), the row Upgrade button + its status machine/hook, the "Add" button, the toolbar layout, the toast/notification primitive used in this app (name, import path, API), and confirm dialog primitive if any.
2. Data flow: which store/hook provides the node list, the per-node version, the "latest version" (from `/api/mesh/upgrade/latest`?), how `isSelf`/`isHub`/roles are represented, and how "latest" vs "current" comparison is done today (is there a semver compare util in `@tmex/shared`? e.g. `compareSemver`).
3. Existing upgrade hook/state machine: exact file, its states, its public API, how many nodes it can drive at once (per-row instance? global?), how it handles hub restart (the hub relays requests — if the hub itself is being upgraded, other requests fail).
4. i18n: which locale JSON sub-object holds node-management strings; list the existing keys for upgrade texts; the exact command to rebuild i18n resources; test commands (`bun test src/` in apps/fe; tsc command) and the current baseline numbers if easily obtainable by running them (you may run read-only commands like `bunx tsc --noEmit -p apps/fe` and `cd apps/fe && bun test src/ 2>&1 | tail -5`).
5. Any existing e2e/Playwright spec covering the Nodes page (paths), and the mesh e2e project config.
6. Proposed implementation sketch for "Upgrade all" + disabled-when-latest, with the minimal set of files to touch and any risks (e.g. upgrading the hub node kills relay for the others → recommended ordering: upgrade non-hub nodes first, hub last, self last).

Output as a Markdown report with file:line citations. Do not speculate — mark anything unverified.
