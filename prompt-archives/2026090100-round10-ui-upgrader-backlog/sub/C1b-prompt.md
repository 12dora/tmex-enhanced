# C1b: Crash-safe upgrader — gateway Web entry + install.sh

You are the backend coder working in /Users/konata/code/tmex-enhanced-wt-upg (branch feat/crash-safe-upgrade merged with main; tmex monorepo; Bun runtime — use `bun`/`bunx`). Another agent (C1a) works IN PARALLEL in the same worktree on `packages/app/**` (except install-script.test.ts), `apps/gateway/src/runtime.ts`, `apps/gateway/src/api/system-routes.ts` — you MUST NOT touch those. NO git commands. NEVER touch the production tmex install (`~/Library/Application Support/tmex/`, port 9883, launchd service) or the tmux session named `tmex`; never dial 127.0.0.1:39001; tests use temp dirs only.

## File ownership (ONLY these)

- `apps/gateway/src/system/upgrade.ts`
- `apps/gateway/src/system/upgrade.test.ts`
- `install.sh`
- `packages/app/src/lib/install-script.test.ts`

## Context

Read `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/EX3-result.md` sections: "5. serviceMode=none PID ownership 不安全" (Web-entry part), "6. SHA256SUMS 404 仍 fail-open" (Web + install.sh parts), "C. Web upgrade.log FD 泄漏". Follow its fix plans.

## Your items

1. **Blocker 5 (Web entry)** — `assertNoneModePidOwnership()` in `apps/gateway/src/system/upgrade.ts` currently only does `kill(pid, 0)`. It must verify the PID actually belongs to this install: read the process cmdline (macOS: `ps -p <pid> -o command=`; Linux: `/proc/<pid>/cmdline`) and require it to reference `<installDir>/current/runtime/server.js` or legacy `<installDir>/runtime/server.js` (realpath-tolerant). The gateway cannot import from packages/app — implement a minimal local helper (this mirrors the existing pattern where the gateway duplicates minimal checksum logic). On ownership failure: refuse the upgrade (clear error), send no signals. Tests: pid file pointing at a live but foreign process (spawn a `sleep`-like child) ⇒ refused, no spawn; positive case with a fake cmdline provider (inject the cmdline reader as a dependency for testability).
2. **Blocker 6 (Web + install.sh)** — SHA256SUMS policy, identical wording to the CLI side: for target version ≥ 1.1.4, SHA256SUMS must be HTTP 200 with an exact `tmex-cli-<v>.tgz` entry and matching digest — 404 ABORTS; for older target versions the Web path NEVER allows unverified (no flag; abort), and `install.sh` allows skipping only via an explicit `--allow-unverified` argument (strip it before it reaches `tmex init`). Update `stageGithubRelease()` to throw on missing sums; fix the existing test that asserts 404-continues (`upgrade.test.ts` ~line 85) and add 404-aborts + digest-mismatch + missing-entry tests. For install.sh, use its existing http_code classification; add a real download-policy test in `install-script.test.ts` with fake curl/tar (the file already has a `sourceEval()` harness — extend it).
3. **Should-fix C (FD leak)** — `spawnUpgrade()` opens `upgrade.log` before the none-mode PID check; move the open after all precondition checks or wrap with try/finally so every throw path closes the FD. Test: none-mode refusal ⇒ no `upgrade.log` created.

Version comparison: reuse the gateway's existing `compareVersions()` (already in the file/module per EX3).

## Verification (mandatory; record numbers)

- Baselines BEFORE coding: `cd apps/gateway && bun test src/system 2>&1 | tail -3` (strip ANSI via `sed 's/\x1b\[[0-9;]*m//g'`), `bunx tsc --noEmit -p . 2>&1 | wc -l` (~21 pre-existing). `cd packages/app && bun test src/lib/install-script.test.ts`.
- After: 0 fail, tsc not increased, `bunx biome check <changed files>` clean. `bash -n install.sh` passes.
- macOS: no `timeout` command; don't put `grep -c` in `&&` chains.

## Report

Write a per-item report (fixes, tests, numbers, deviations) to the ABSOLUTE path `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/C1b-result.md` as your LAST action before exiting.
