# G7 — Backend: cancel an in-flight upgrade (download phase) locally and remotely; make status restorable

Read `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/833abb75-c031-4d78-9f35-3eefbc6cc249/scratchpad/common-rules.md` first and follow it strictly. Then read `sub/G4-result.md`, `sub/G4b-result.md`, `sub/G4c-result.md` (staged-package remote upgrade: `UpgradeController` in `apps/gateway/src/system/upgrade.ts`, entry-side `remote-upgrade-job.ts`, `upgrade-service.ts`, routes in `apps/gateway/src/api/system.ts` and `apps/gateway/src/mesh/mesh-routes.ts` `matchUpgradeNodeRoute`).

## Field evidence

A 1.1.10 target whose own GitHub download stalled stayed in `{state:'downloading'}` forever (no fetch timeout in that version); the user had no way to stop it, and after a page refresh the FE forgot it was upgrading. In 1.1.11 the release download has timeouts, but a user still needs a **Stop** while a download is running (entry-side job or target-side download). Installing (`executing`) must never be interrupted.

## Requirements (TDD)

### Target side
1. `UpgradeController.cancel(): { ok: true, status } | { ok: false, code: 'UPGRADE_NOT_CANCELLABLE' | 'UPGRADE_NOT_RUNNING', status }` — cancellable only in `downloading` (abort the download fetch/stream via an `AbortController`, delete partial files/txn dir, return to `idle` with `error: 'UPGRADE_CANCELLED'` and `targetVersion: null`); `executing` → `UPGRADE_NOT_CANCELLABLE`; `idle` → `UPGRADE_NOT_RUNNING`. Also make the release download in `release-download.ts` accept an `AbortSignal` if it does not already (G4b added timeouts; wire the controller's abort into the same signal).
2. Route `DELETE /api/system/upgrade` (same auth as `POST /api/system/upgrade`): 200 with the idle status on success; 409 `{ code, ...status }` otherwise. Managed build (`system-managed.ts`): 403 like the other upgrade routes.
3. `error: 'UPGRADE_CANCELLED'` must survive as-is in `UpgradeStatus.error` (the FE keys off this exact string). Add the constant to `packages/shared/src/contracts/system.ts` (`UPGRADE_CANCELLED = 'UPGRADE_CANCELLED'`).

### Entry side
4. `DELETE /api/mesh/nodes/:id/upgrade` in `mesh-routes.ts` `matchUpgradeNodeRoute` → new `handleMeshNodeUpgradeCancel` in `upgrade-service.ts`:
   - `NOT_FOUND` / `NODE_LOGIN_REQUIRED` exactly like start/status.
   - Local node: `controller.cancel()` mapping (200 idle / 409).
   - Remote node with an **active entry-side job** (download/push in progress): abort the job (its per-step `AbortController`), mark it `cancelled` (status overlay `{state:'idle', targetVersion:null, error:'UPGRADE_CANCELLED', startedAt}` retained like failed jobs for 10 min), respond 200 with that status. If the job already handed off → fall through to forwarding.
   - Otherwise forward `DELETE /api/system/upgrade` to the target; map upstream 404 → `501 { code: 'UPGRADE_CANCEL_UNSUPPORTED', nodeId }` (old target), 409 → pass through with `UPGRADE_NOT_CANCELLABLE`/`UPGRADE_NOT_RUNNING`, 403 → `UPGRADE_NOT_ALLOWED`.
5. `GET /api/mesh/nodes/:id/upgrade` already overlays the entry job; make sure a cancelled job reports `{state:'idle', error:'UPGRADE_CANCELLED'}` (not a generic failure) and that a subsequent `POST` for the same node is allowed immediately (no 409 from a cancelled job).
6. `RemoteUpgradeJob`: cancellation must stop the push stream promptly (abort the forwarder request, cancel the file stream) and must not leave the entry's download cache in a half-written state (the cache write already uses `.part` + rename; a cancelled download must remove its `.part`).

### Tests
`upgrade.test.ts` (cancel in downloading/executing/idle, partial cleanup, status string), `system.test.ts` (DELETE route + managed 403), `upgrade-service.test.ts` / `mesh-routes.test.ts` (local cancel, job cancel → 200 + overlay, handed-off → forwarded, old target → 501, re-POST allowed), `remote-upgrade-job.test.ts` (abort mid-push), `release-download.test.ts` (abort removes `.part`).

## Files you own

`apps/gateway/src/system/{upgrade,upgrade-service,remote-upgrade-job,release-download}.ts` (+tests), `apps/gateway/src/api/system.ts`, `system-managed.ts` (+tests), `apps/gateway/src/mesh/mesh-routes.ts` ONLY `matchUpgradeNodeRoute` + a new `handleUpgradeCancel` method (+ the remote-upgrade cases in `mesh-routes.test.ts`), `packages/shared/src/contracts/system.ts`. Do NOT touch other mesh files, `src/hub/**`, `apps/fe/**`, `packages/app/**`.

## Verification

`cd apps/gateway && bun test src/system src/api src/mesh/mesh-routes.test.ts && bunx tsc --noEmit -p .` (0 fail / 0 tsc), `cd packages/shared && bunx tsc --noEmit -p .`, biome on changed files.

## Result file

`/Users/konata/code/tmex-enhanced-wt-r13/prompt-archives/2026090104-round13-upgrade-multihub/sub/G7-result.md` — exact request/response shapes for DELETE (local / job / forwarded / old target), status strings, tests. Write it, then exit.
