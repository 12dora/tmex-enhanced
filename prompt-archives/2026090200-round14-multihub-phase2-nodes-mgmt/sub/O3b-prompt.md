# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# O3b — FE fixes for the hub role-switch flow (review round 2)

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/O3b-result.md`

Review findings (RV2, accepted by the commander) against `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts` (read `sub/O3-result.md` and `sub/RV2-result.md` #7 #8 first):

1. **Stop computing writerEpoch in the FE.** The contract (`packages/shared/src/contracts/hub-role.ts`) now lets `mode:'active'` omit `writerEpoch` — the target allocates `max(known)+1` itself (backend lands in parallel as G4b; code against the contract, mock in tests). Remove the FE-side `max(hubs)+1` computation; the confirm dialog no longer promises a specific epoch (drop the `{{epoch}}` interpolation from `nodes.hubs.role.confirmText` / `stepPromote`; adjust the three locales; `bun run build:i18n`). Keep handling `HUB_EPOCH_STALE` (can still happen with an explicit epoch from a resumed old flow — after this change simply retry once without epoch, then surface the error).
2. **Persist the resume record BEFORE any mutating step.** Write the sessionStorage record (add fields: `phase: 'admit'|'demote'|'promote'|'wait'`, `fromHubId`, `targetHubId`, `operationId`) before the demote request goes out and update it at each phase; the resume path must be able to continue from every phase, including the demote→promote window (on resume in phase `demote`/`promote`: check `writerHubId`; if the old writer is already standby and the target is not yet active, re-issue the promote with the same operationId — idempotent on the target).
3. **Failure in the demote→promote window must not strand the mesh writer-less silently**: if the promote request fails definitively (not a restart-window retry), show a persistent error dialog offering 「重试升级目标」 and 「回滚：重新升级原主 Hub」 (re-promote `fromHubId` without epoch — server allocates); toasts alone are not enough. New keys under `nodes.hubs.role.recovery.*`.
4. **UUID fallback** (~L898): generate a valid RFC-4122 v4 UUID via `crypto.getRandomValues` when `crypto.randomUUID` is unavailable (set version/variant bits); keep the backend regex happy. Unit test the fallback shape.

Tests: update/add cases in `use-hub-role-switch.test.ts` for: no epoch sent on promote; resume from each persisted phase; promote-failure recovery paths; UUID fallback. Baselines: `cd apps/fe && bun test src/` 1400 pass / 0 fail (report after), tsc 0, biome clean.

Scope: `apps/fe/src/pages/settings/nodes/management/{use-hub-role-switch.ts,use-hub-role-switch.test.ts,hub-role-dialog.tsx,nodes-table.tsx,nodes-management.test.tsx}`, locales `translation.nodes.hubs.role.*`. No git. Backend agents work in `apps/gateway/**` in parallel.
