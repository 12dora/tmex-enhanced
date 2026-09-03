# Task F2 — operator-side "中继" settings tab + admin api-client + i18n (Opus 子代理，Agent 工具 model: opus)

Read /Users/konata/code/tmex-r23/prompt-archives/2026090304-round23-relay-legacy-removal/sub/_common-rules.md FIRST (rules), then /Users/konata/code/tmex-r23/prompt-archives/2026090304-round23-relay-legacy-removal/plan-00.md §1.1, §1.7, §1.11, §1.12 — the operator-side web UI is your task. Copy guidelines: /Users/konata/code/tmex-copy-guidelines.md before writing UI text.

Result file (absolute): /Users/konata/code/tmex-r23/prompt-archives/2026090304-round23-relay-legacy-removal/sub/F2-result.md

Context: new gateway role `relay`. On a `relay,node` machine the logged-in user gets a Settings tab "中继". Backend HTTP contract is FIXED in plan-00 §1.7 (admin: GET /api/relay/status, POST /api/relay/password, PATCH /api/relay/config, PATCH /api/relay/tenants/:id, POST /api/relay/tenants/:id/kick, DELETE /api/relay/tenants/:id; public GET /api/relay/health). Backend may not exist yet: unit-test with mocked fetch. Role absent → `/api/relay/status` 404 → tab hidden.

## Scope
- NEW packages/api-client/src/relay/admin-api.ts (+test), export from packages/api-client/src/index.ts (one line). F1 owns relay/tenant-api.ts — do not create it.
- NEW apps/fe/src/pages/settings/relay/** (tab, tenant table, password dialog kick/keep + "清除口令", default-quota form, per-tenant quota/label editor, kick/delete confirms, 30 s polling hook like apps/fe/src/node/mesh-hubs.ts).
- apps/fe/src/pages/SettingsPage.tsx: register the tab gated on role presence (inspect how `nodes` tab is registered ~69-120 and how role/mode reaches the FE via /api/auth/mode etc.; if no signal, probe GET /api/relay/status once, hide on 404).
- i18n: new `relay.admin.*`-style keys in packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json via targeted edits (F1 adds `relay.tenant.*` concurrently), then `bun run build:i18n`.
- Reuse packages/ui primitives and the round-22 shared settings form primitives / danger-confirm dialog (grep apps/fe/src/pages/settings). Do NOT edit packages/ui or packages/panels.

## UI
- Header cards: health (ok/version/uptime), totals (tenants, nodes online, streams, bytes), password state (set/not set, epoch, minTokenEpoch).
- Tenant table: short monospace id (copy), inline-editable label, created/last seen (relative), nodes/online, streams, bytes in/out, effective quota ("默认" badge when inheriting), token epoch, kicked badge; actions: edit quota/label, kick (confirm), delete (danger confirm typing id).
- Password dialog: new password or "清除口令" switch; radio kick ("作废旧令牌，所有租户需重新输入口令") vs keep ("保留现有租户，新口令只对新接入生效"), default keep.
- Default quota form: maxNodes, maxStreams, bandwidth KB/s or unlimited; per-tenant same + "跟随默认" (quota: null).
- Loading/empty/error states; mobile layout per existing tabs.

Verify: `cd apps/fe && bun test src/` (baseline 1783), `cd packages/api-client && bun test` (175), tsc for both, biome, `bun run lint`.
Result file: files, i18n keys, gating method, per-state description.
