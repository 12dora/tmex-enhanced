# Backend task (packages/app only): two CLI defects observed in containers

Repo worktree `/Users/konata/code/tmex-enhanced-wt-merge` (branch chore/merge-hub-tabs). Read `AGENTS.md`. Another agent edits `apps/gateway/**` in parallel; you touch ONLY `packages/app/**`. No git operations, no TODOs. Baseline in `packages/app`: `bun test` 232 pass / 0 fail, tsc 1 error (pre-existing TS2688). Keep 0 fail, tsc ≤ 1, biome clean on changed files.

## P2 — `node dist/cli-node.js hub user add|enroll …` swallows the Bun child's stdout when there is no TTY
In a container (`docker exec` without `-t`), `node /opt/tmex-pkg/package/dist/cli-node.js enroll --install-dir /opt/tmex` prints nothing (the join token line never appears), while running `bun /opt/tmex/runtime/cli-auth.js enroll …` directly prints it. The Node CLI delegates auth commands through `packages/app/src/lib/auth-spawn.ts` (~L44–107). Inspect how the child is spawned (`stdio`, `detached`, whether stdout is piped and only forwarded on TTY, whether the parent exits before the child flushes, whether `process.exit` is called while the pipe still has data). Fix so stdout/stderr are forwarded byte-for-byte in both TTY and non-TTY modes and the exit code is propagated (the child may be long-running: `enroll` keeps waiting for redeem, so streaming must be live, not buffered). Add a test with a fake child (see existing `auth-spawn.test.ts` if present, else create it) that asserts non-TTY forwarding.

## P3 — `writeEnvFile` replaces a symlinked `app.env` with a regular file
`packages/app/src/lib/env-file.ts` writes a temp file and `rename()`s it over `app.env`. If `app.env` is a symlink (e.g. `/opt/tmex/app.env -> /var/lib/tmex/app.env` on a volume), the symlink is replaced and the real file on the volume is never updated, so `hub join` state is lost. Fix: resolve the target with `fs.realpath` (fallback to the given path if it doesn't exist) and do the atomic tmp+rename in the target's directory. Keep the atomic semantics. Add a test with a symlinked env file.

Report to `prompt-archives/2026082801-hub-docker-e2e-multi-theme/sub/grok-p2-cli-result.md` (root cause, change, tests, numbers).
