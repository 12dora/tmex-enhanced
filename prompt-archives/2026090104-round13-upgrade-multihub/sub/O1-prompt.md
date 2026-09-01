# O1 — Frontend: "Upgrade all" + disabled-when-latest on the Nodes management table

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it. Also read `/Users/konata/code/tmex-copy-guidelines.md` (UI copy guidelines) before writing any user-facing text.

## Background

Settings → Nodes (`/settings?tab=nodes`) renders `NodesManagement` (`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`) with a `CardAction` toolbar (Refresh, Add) and `NodesTable` (`nodes-table.tsx`). Per-row "Upgrade" is driven by `useNodeUpgrade` (`use-node-upgrade.ts`), a robust per-node state machine (POST `/api/mesh/nodes/:id/upgrade` → poll GET → confirm by version readback via `refreshMeshNodes()`; `unconfirmed` handling; all requests on one `AbortController`). `latest` comes from `GET /api/mesh/upgrade/latest` (`{latestVersion, changelog, publishedAt}`). Rows are `NodeRow` (`apps/fe/src/node/mesh-nodes.ts`, fields incl. `id, name, version, online, loggedIn, isSelf, isHub`). `@tmex/shared` exports `compareSemver(a, b): -1|0|1|null` (`packages/shared/src/semver.ts`; `null` when unparsable). Toasts: `sonner` `toast.success/info/warning/error`. Existing tests: `nodes-management.test.tsx` (bun test, happy-dom/RTL style — follow the existing patterns there).

Baselines (must not regress): `cd apps/fe && bun test src/` → 1140 pass / 0 fail; `bunx tsc --noEmit -p apps/fe` → 0 errors.

## Requirements

1. **Disable the row Upgrade button when the node is already at latest**: `latest` loaded and `compareSemver(row.version, latest.latestVersion) >= 0` → button disabled with a tooltip/`title` "已是最新版本"-style copy (i18n key). If `latest` is not loaded or the version is unparsable, keep current behaviour (button enabled; backend is the authority).
2. **Disable + explain when remote upgrade is impossible**: nodes whose version is older than `MIN_REMOTE_UPGRADE_VERSION` (export a single constant in `use-node-upgrade.ts`, value `'1.1.0'` — the first version whose gateway exposes `/api/system/upgrade` and `/api/system/info`; the commander may adjust this value later) cannot be upgraded from the UI. For such rows: disable the button and show a `title` tooltip explaining "该节点版本过旧，不支持远程升级，请在该机器上执行 `npx tmex-cli upgrade`" (i18n; interpolate the version). Also map the existing `UPGRADE_UNSUPPORTED` error text to that same wording (with the manual command) and make `UPGRADE_NOT_ALLOWED` text say the node's install cannot self-update (e.g. no service manager / container) and must be upgraded manually — update the `nodes.upgrade.unsupported` / `nodes.upgrade.notAllowed` values in all locale JSONs (`en_US`, `zh_CN`, `ja_JP`).
3. **"Upgrade all" toolbar button** placed immediately LEFT of the "Add" button (`data-testid="nodes-upgrade-all"`), icon + label. Behaviour:
   - Disabled while `latest` is unknown, while a batch is running, or when there is no eligible node. Eligible = online, (isSelf or loggedIn), version parsable and `< latestVersion`, and `>= MIN_REMOTE_UPGRADE_VERSION`.
   - One confirm (`globalThis.confirm`, like the existing per-row confirm) listing the count and target version.
   - Ordering (hub restarts kill relay for the others; self restart kills this page's entry): **non-hub non-self nodes first**, then the **remote hub** (if not self), then **self** last. Run the first group with bounded concurrency (3 at a time) using the existing `runNodeUpgrade` machinery; hub and self strictly after the previous group has fully settled.
   - During a batch, suppress the per-node toasts (inject a silent `UpgradeToasts`), but keep per-row phase/error patching so rows still show progress. Ineligible-but-attempted nodes never happen (filter upfront); nodes that were skipped because they are already latest are neither success nor failure.
   - Results: `done` → success; `failed`/`timeout` → failure; `alreadyLatest` (race) → count as success. When everything finished (or the signal aborted → no toast), show exactly one toast: success → `toast.success`, any failure → `toast.warning`, text "全部升级完成：成功 X，失败 Y"（i18n with counts；failed names appended when Y > 0, e.g. "失败：a、b"）.
   - Refactor so `runNodeUpgrade` (or a wrapper) **returns** an outcome instead of `void`; keep the existing single-node path behaviour identical.
   - Extend `NodeUpgradeController` in `types.ts` with what the toolbar needs (e.g. `startAll(rows)`, `batch: { running: boolean; total; completed }`, `eligibleCount(rows)`), and render a small progress hint on the button while running ("升级中 2/5").
4. **Tests** (extend `nodes-management.test.tsx` and/or add `use-node-upgrade.test.ts` with injected `UpgradeIo`, fake timers not required — the `wait` in `UpgradeIo` is injectable): disabled-when-latest; disabled-when-too-old with tooltip; upgrade-all eligibility + ordering (non-hub → hub → self; assert the order of `start` calls and that hub/self only start after earlier ones settle); batch summary counts and single toast; per-node toasts suppressed during batch.
5. i18n: add new keys only under `translation.nodes.upgrade` in `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`, then run `bun run build:i18n` from the repo root (generated files are regenerated; never edit them by hand). Keep copy consistent with the guidelines file.

## Files you own

- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx`
- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx`
- `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`
- `apps/fe/src/pages/settings/nodes/management/types.ts`
- `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`
- new files under `apps/fe/src/pages/settings/nodes/management/` (e.g. `use-node-upgrade.test.ts`, `upgrade-batch.ts`)
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` — ONLY the `translation.nodes.upgrade` sub-object (other agents may edit other sub-objects concurrently; edit surgically, never reformat the whole file)

Do not touch `apps/fe/src/node/mesh-nodes.ts`, `packages/api-client`, or anything in `apps/gateway`. If you need data the row doesn't have, note it in the result file.

## Verification

`cd apps/fe && bun test src/` (all green, count ≥ 1140 + your new tests), `bunx tsc --noEmit -p apps/fe` → 0, `bunx biome check <your files>` clean. Do not run Playwright e2e.

## Result file

Write the report to `/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/O1-result.md` and exit.
