# Common rules for every coding agent on this worktree

- Worktree: `/Users/konata/code/tmex-enhanced-wt-r14` (branch `feat/round14-multihub-phase2-nodes-mgmt`). Runtime is **Bun** (`bun`, `bunx`); Node only for `packages/app` CLI. If `bun` is missing from PATH, source `~/.zshrc` PATH.
- **Other agents are editing this same worktree in parallel. Touch ONLY the files listed in your scope. Never run `git add/commit/stash/checkout/reset`.** The commander commits.
- Read `AGENTS.md` at the repo root first and follow it (Chinese comments only where logic is non-obvious; no unnecessary comments; no TODOs, no stubs, no "simple version first").
- **Never touch the production tmex**: do not read/write `~/Library/Application Support/tmex/`, do not curl port 9883, do not kill/restart launchd services, do not touch the tmux session named `tmex` or the default tmux socket. Tests must use temp dirs and free ports.
- Never lint/format generated files (`packages/shared/src/i18n/resources.ts`, `types.ts`, `resources/fe-dist/*`, `dist/*`).
- Look up library APIs in `node_modules` source before using them; do not guess.
- TDD: write/extend tests alongside the implementation. Before finishing run, in the package you changed: `bun test <dir>` (in `apps/fe` use `bun test src/...`, never bare `bun test`), `bunx tsc --noEmit -p .` (error count must not exceed the baseline given in your task), `bunx biome check <changed files>` (fix with `--write`). macOS has no `timeout` command; strip ANSI from bun test output with `sed 's/\x1b\[[0-9;]*m//g'`.
- When done, write a concise result report (what changed, file list, test/tsc numbers, anything left) to the absolute result path given in your task, **then exit**. Write the file only when finished.

# G8 — Complexity gate closure: split what's worth splitting, allowlist the rest with reasons

Result file: `/Users/konata/code/tmex-enhanced-wt-r14/prompt-archives/2026090200-round14-multihub-phase2-nodes-mgmt/sub/G8-result.md`

`bun scripts/complexity/gate.ts` currently reports **73 violations** (it was already failing on main with 42 — this debt spans two rounds; this task ends it: the gate must exit 0). The gate is part of `bun run lint`. Allowlist format: `scripts/complexity/allowlist.json`, key `"relative/path.ts:FunctionName"` (or just the path for file-length entries — read `gate.ts` to confirm the exact key shapes it matches), value `{ lines?/cc?, reason }`; `--tighten` shrinks it. Existing entries show the house style for reasons (terse, with a pointer to the judgment).

Procedure:
1. Run the gate, list all violations.
2. For each, decide **split vs allowlist** with this guidance:
   - **Allowlist** (reason ~one sentence): protocol codec enum switches (`packages/shared/src/uplink/codec.ts` decode/encode functions — inherently one-branch-per-frame-type; splitting hurts), large cohesive orchestration hooks/state machines already judged in past rounds (`use-node-upgrade.ts`, `use-hub-role-switch.ts`, `uplink-server.ts`, `uplink-pool.ts`, `mesh-runtime.ts`, `peer-manager.ts`, `forwarder.ts`, `manager.ts` (tunnel), file-length entries generally), test harnesses (`multi-hub-harness.ts`), CLI arg dispatchers.
   - **Split** only where a factor-out is mechanical, obviously safe and genuinely improves the code — good candidates: `apps/gateway/src/api/system.ts:handleSystemApiRequest` (CC 30: route-table dispatch → split uninstall/upgrade handler groups into helper fns), `packages/app/src/commands/uninstall.ts:runUninstall` (CC 28/123 lines: extract the removal steps), `apps/gateway/src/system/remote-upgrade-job.ts:runJob` (CC 27: extract phase helpers), `apps/gateway/src/hub/hub-runtime.ts:dispatchForwardedWrite` (CC 27: per-route helpers). For each split: behavior-preserving, no exported-API change, run that package's affected tests.
   - When in doubt, allowlist — this is a gate-closure pass, not a refactor round.
3. Never touch generated files. Do not loosen thresholds in `gate.ts` itself.
4. Finish: `bun scripts/complexity/gate.ts` exits 0 with **no stale entries**; run `bun scripts/complexity/gate.ts --tighten` at the very end to normalize. Full `bun test` green in every package you touched (`apps/gateway` ≈3508, `packages/app` 644 src, `apps/fe` only if you touched fe files — you should not need to beyond nothing; fe/codec entries go to allowlist), tsc baselines unchanged (gateway 0, shared 0, app 1 pre-existing).

Scope: `scripts/complexity/allowlist.json` plus the handful of files you choose to split (each split listed in the result with before/after CC). Nothing else. No git.
