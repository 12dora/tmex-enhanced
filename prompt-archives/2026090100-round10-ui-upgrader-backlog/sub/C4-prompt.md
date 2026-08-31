# C4: Mesh remote-upgrade backend review follow-ups (worktree /Users/konata/code/tmex-enhanced-wt-r10)

You are the backend coder in /Users/konata/code/tmex-enhanced-wt-r10 (Bun runtime; use bun/bunx). NO git commands. Another agent works on FRONTEND files (`apps/fe/**`) and one on `packages/panels/src/agent/**` in this worktree — do not touch those. Never touch production tmex or tmux session `tmex`.

Reviewer findings to fix: `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/RV2-result.md` (4 Should-fix + 1 Nit; no blockers). Apply all:

1. Local mesh-upgrade path ordering: check `canSelfUpdate` (403 UPGRADE_NOT_ALLOWED) and controller busy state (409 UPGRADE_IN_PROGRESS) BEFORE resolving the GitHub latest release, so those errors win over 502/UPGRADE_ALREADY_LATEST; keep the atomic concurrency check inside `start()`.
2. Prerelease-aware version comparison in `apps/gateway/src/system/semver.ts` (`compareVersions`): implement SemVer-correct prerelease segment comparison (numeric identifiers compare numerically; a prerelease is lower than its release). Add tests (`1.2.3-beta.2` < `1.2.3-beta.10` < `1.2.3`).
3. 409 body passthrough whitelist: when propagating a remote 409 into `UPGRADE_IN_PROGRESS`, copy ONLY `state/targetVersion/error/startedAt`; never let the upstream override local `code`/`nodeId`.
4. Bounded and fail-closed remote body handling in `apps/gateway/src/system/upgrade-service.ts`: read remote JSON bodies with a size cap (e.g. 64KB — implement a small bounded reader instead of bare `Response.json()`); explicitly cancel the upstream body when substituting a local response (403/404 mapping); if `/api/system/info` returns 200 but the body is over-limit, truncated, unparsable, or not an object, respond `503 NODE_UNREACHABLE` instead of proceeding to the destructive POST.
5. Nit: add `NOT_FOUND` to `MeshUpgradeErrorCode` in `packages/shared/src/contracts/system.ts`.

## File ownership

`apps/gateway/src/system/upgrade-service.ts` (+test), `apps/gateway/src/system/semver.ts` (+test), `apps/gateway/src/mesh/mesh-routes.ts`/`mesh-routes.test.ts` if needed, `packages/shared/src/contracts/system.ts`. Nothing else (do NOT touch `apps/gateway/src/mesh/forwarder.ts` unless the body-cancel fix truly requires it — if so, keep the change minimal and run its tests).

## Verification (record numbers)

`cd apps/gateway && bun test src/mesh src/system src/api` all pass (baseline 1025+ pass/0 fail); `bunx tsc --noEmit -p .` stays at 21 errors; `bunx biome check <changed files>` clean; repo root `bun scripts/complexity/gate.ts` ok.

## Report

Write per-item report to `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/C4-result.md` as your LAST action.
