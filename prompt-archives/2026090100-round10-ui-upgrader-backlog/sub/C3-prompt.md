# C3: Upgrader review follow-ups (worktree /Users/konata/code/tmex-enhanced-wt-upg)

You are the backend coder in /Users/konata/code/tmex-enhanced-wt-upg (Bun runtime; use bun/bunx). NO git commands. Never touch the production tmex (`~/Library/Application Support/tmex/`, port 9883, launchd) or tmux session `tmex`; never dial 127.0.0.1:39001; tests use temp dirs.

A reviewer verified the upgrader fixes; read the findings: `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/RV1-result.md`. Fix these items (Blocker 4 is ALREADY FIXED by the commander — `repairVerifyOrRollback` now guards with `isRunning()`; do not rework it):

1. **Blocker 1** — `packages/app/src/lib/upgrade-verify.ts`: `--allow-unverified` must only bypass a TRUE 404 (`sums.unpublished === true`). HTTP 200 with sums present but no entry for the exact tarball, and digest mismatches, must ALWAYS abort regardless of the flag and target version. Add the missing test combination (200-missing-entry + allowUnverified:true ⇒ throws).
2. **Blocker 2** — `install.sh`: never feed the remote SHA256SUMS line to `shasum -c` (a manifest line like `H  /tmp/evil.tgz` makes it verify a different file). Instead: parse the line whose filename field is EXACTLY `tmex-cli-<v>.tgz` (reject path-qualified entries), extract the hex, compute `shasum -a 256` of the downloaded `$tgz` yourself, and string-compare. Add tests in `packages/app/src/lib/install-script.test.ts` covering a path-qualified manifest line (absolute path and `../`) being rejected.
3. **Blocker 3** — PID ownership hardening in BOTH `packages/app/src/lib/upgrade-process.ts` and `apps/gateway/src/system/upgrade.ts` (you own both here; no other agent is active in this worktree):
   a. Substring `cmdline.includes(runtimePath)` also matches `vim .../server.js`. For pid records WITHOUT a stored identity (legacy plain-number `tmex.pid`), require BOTH: the command's executable token (first token, or its basename) is `bun` or `node`, AND some argv token equals the runtime path (realpath-tolerant) — not a bare substring. Records WITH identity keep the identity check as primary.
   b. TOCTOU: `killPidAndWait()` must re-verify ownership (cmdline/identity) immediately before sending SIGTERM and again before escalating to SIGKILL; if the check fails at either point, stop signaling and raise the ownership error. Cover with tests (a process that exits between verify and signal is fine to simulate via injected probes; follow the existing DI style).
4. **Should-fix 2** — the delegated-apply "end-to-end" test bypasses production wiring: add a test that goes through the real production entry (`runUpgrade` with parsed flags, or spawning the actual built `bin/tmex.js` like the rehearsal does) so a future regression in `runLockedUpgrade`'s `activeTxnId` threading is caught.
5. **Docs**: in `docs/release/2026083101-upgrade-crash-safety.md`, add a short "已知限制" paragraph: (a) preflight still executes import-time module init (files transfer-session GC interval; tunnel manager constructor opens the copied DB) — explicit start of external services is skipped; (b) prerelease versions compare inconsistently across CLI/install.sh (numeric-only) vs Web (lexicographic prerelease) for the 1.1.4 checksum threshold — irrelevant while no prerelease is ever published, Web is fail-closed regardless.

## Verification (record numbers)

- `cd packages/app && bun test` (baseline: 1 pre-existing fail in scripts/build-runtime.test.ts when dist not built — ignore only that one), `bunx tsc --noEmit -p .` (1 pre-existing error), `bunx biome check <changed files>`, `bun run build:cli` succeeds, `bash -n install.sh`.
- `cd apps/gateway && bun test src/system` all pass; tsc not increased (~21).
- Repo root `bun scripts/complexity/gate.ts` stays ok.

## Report

Write per-item report to `/Users/konata/code/tmex-enhanced-wt-r10/prompt-archives/2026090100-round10-ui-upgrader-backlog/sub/C3-result.md` as your LAST action.
