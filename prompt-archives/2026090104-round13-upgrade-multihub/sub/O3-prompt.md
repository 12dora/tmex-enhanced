# O3 — Frontend: restore in-flight upgrade state after a page refresh; Stop button during the download phase

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it. Read `/Users/konata/code/tmex-copy-guidelines.md` before writing copy. Then read `sub/O1-result.md` (the per-node upgrade state machine `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts`, `upgrade-batch.ts`, `types.ts`, `nodes-table.tsx`) and `sub/G7-prompt.md` (the backend cancel API being built concurrently — code against this contract; `sub/G7-result.md` will confirm the final shapes if it appears while you work).

## User report

"在下载中状态，刷新页面又变成待升级；应该在刷新后保留当前状态，并在升级中提供停止按钮，以便用户打断。" Today the upgrade state lives only in React memory; after a refresh the row shows the idle Upgrade button while the backend is still downloading/installing.

## Backend contract (G7)

- `GET /api/mesh/nodes/:id/upgrade` → `UpgradeStatus { state: 'idle'|'downloading'|'executing', targetVersion, error, startedAt }` (unchanged; the entry overlays its own download/push job as `downloading`).
- `DELETE /api/mesh/nodes/:id/upgrade` → `200 UpgradeStatus` (`state:'idle', error:'UPGRADE_CANCELLED'`) when cancelled; `409 { code: 'UPGRADE_NOT_CANCELLABLE' | 'UPGRADE_NOT_RUNNING', ...status }`; `501 { code: 'UPGRADE_CANCEL_UNSUPPORTED' }` for old targets; plus the usual `NOT_FOUND` / `NODE_LOGIN_REQUIRED` / `NODE_UNREACHABLE`.
- After a cancel, the status is `{ state:'idle', error:'UPGRADE_CANCELLED' }`; a new POST is allowed immediately. The FE must treat `error === 'UPGRADE_CANCELLED'` as「已取消」(info), never as a failure toast.

## Requirements

1. **Restore on mount**: when the Nodes page mounts (and again whenever the node list gains a node), query `GET /api/mesh/nodes/:id/upgrade` for every online row that is self or logged in (bounded concurrency 3, all on the hook's AbortSignal). For a row whose status is non-idle: set the entry to `{ phase: status.state, targetVersion: status.targetVersion ?? latest }` and **resume** the watcher (`watchUpgrade` with `sawActive: true`, `unconfirmedStart: false`) so the row keeps updating and the usual done/failed/timeout handling applies. Idle rows with `error === 'UPGRADE_CANCELLED'` stay idle (no toast). Idle rows with any other error: leave idle (do not resurrect old failures on refresh). Unit-test with an injected `UpgradeIo` (extend `UpgradeIo` with `status(nodeId, signal)` if you need a non-polling read, or reuse `poll`).
2. **Per-node cancellation**: replace the single hook-level `AbortController` with per-node controllers (still all aborted on unmount). Add `cancel(row)` to `NodeUpgradeController`: `DELETE /api/mesh/nodes/:id/upgrade`; on 200 → abort the row's watcher, patch `{ phase: 'idle', error: null }`, `toast.info(「已取消升级」)`, refresh nodes; on 409 `UPGRADE_NOT_CANCELLABLE` → `toast.warning(「正在安装，无法中断」)` and keep watching; on 501 → `toast.warning(「该节点版本不支持中断」)` and keep watching; other errors → `toast.error` with the mapped text and keep watching. Extend `UpgradeIo` with `cancel(nodeId, signal): Promise<{ kind:'cancelled', status } | { kind:'failed', code, httpStatus }>`.
3. **Stop button** in `nodes-table.tsx`: while a row's phase is `pending` or `downloading`, render a small stop button (icon `Square`/`X` from lucide, `data-testid="node-upgrade-cancel-<id>"`, `title`「停止升级」) next to the progress label; while `executing`/`restarting` render it disabled with `title`「正在安装，无法中断」. During a batch, Stop on a row cancels that row only (the batch counts it as failed with reason「已取消」— adjust `upgrade-batch.ts` tally so `cancelled` outcome is counted separately in the summary toast:「成功 X，失败 Y，已取消 Z」, keep the existing keys and add one).
4. **Toolbar during restore**: while restore is in flight (`restoring: boolean` on the controller), the Upgrade-all button is disabled with `title`「正在同步升级状态…」.
5. i18n keys under `translation.nodes.upgrade` in the three locale JSONs (`cancel`, `cancelled`, `cancelNotAllowed`, `cancelUnsupported`, `restoring`, `allDoneWithCancelled`, …), then `bun run build:i18n`.
6. Tests: restore resumes non-idle rows and ignores idle ones; cancel success/409/501 paths; Stop button visibility per phase; batch tally with cancelled; per-node abort does not affect other rows.

## Files you own

`apps/fe/src/pages/settings/nodes/management/{use-node-upgrade.ts,use-node-upgrade.test.ts,upgrade-batch.ts,types.ts,nodes-table.tsx,nodes-management.tsx,nodes-management.test.tsx}`, locale JSONs (`translation.nodes.upgrade` sub-object only). Do NOT touch `apps/gateway/**`, `packages/api-client/**`, other FE files.

Baselines: `cd apps/fe && bun test src/` 1205 pass / 0 fail; `bunx tsc --noEmit -p apps/fe` 0.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/O3-result.md`. Write it, then exit.
