# Managed Standalone Gateway Spike Result

> Date: 2026-07-16
>
> Status: host target passed; remaining target matrix entries defined but not executed

## Result

The Gateway now has an explicit managed standalone entry and build target while the default entry remains self-managed. The managed build locks `managementMode=companion-cli` and `updateOwner=companion`, excludes the update implementation from its import graph, embeds Drizzle migrations, and compiles a single host executable with no source, package tree, frontend distribution, or Bun sidecar.

The managed system API keeps `/api/system/info` and returns a stable `403 managed_externally` response from both update-check and upgrade. Environment variables cannot override the locked managed identity after entry initialization.

## Host evidence

| Item | Result |
|---|---|
| Target | `bun-darwin-arm64` |
| Artifact size | 67,970,402 bytes |
| SHA-256 | `f43d2999edb41f0d937e5bdd26d6a1ea8f71ba6f92de8e83d1ffe82572de5503` |
| Clean-working-directory health | PASS |
| Embedded SQLite migration | PASS |
| WebSocket upgrade | PASS |
| Managed update rejection | PASS |
| Artifact scanner | PASS |
| Default Gateway tests | 910 pass, 0 fail |
| Default Gateway build | PASS |
| Managed/scanner focused tests | 11 pass, 0 fail |

The scanner also has negative fixtures for an npm registry self-update signature and an adjacent `node_modules` directory. It rejects runtime sidecars, source/package layouts, CLI/frontend artifacts, and concrete self-update implementation signatures.

## Target matrix

- `bun-darwin-arm64`: compiled and executed.
- `bun-darwin-x64`: defined, not executed on this host.
- `bun-linux-arm64`: defined, not executed on this host.
- `bun-linux-x64`: defined, not executed on this host.

No unexecuted target is reported as passing.

## Reproduction

```bash
bun run --cwd apps/gateway build:managed -- --out-dir <temporary-directory>
bun run --cwd apps/gateway scan:managed -- <artifact>
bun run --cwd apps/gateway smoke:managed -- <artifact>
NODE_ENV=test bun test apps/gateway/src/system/managed.test.ts \
  apps/gateway/src/api/system-managed.test.ts \
  apps/gateway/scripts/scan-managed-artifact.test.ts
bun run --cwd apps/gateway test
bun run --cwd apps/gateway build
```

`ssh2` treats `cpu-features` as an optional, guarded optimization. Both build paths externalize it so a failed optional native install does not turn a supported fallback into a bundle-time error.

The package-wide `tsc --noEmit` command still exits non-zero on the existing tmux/SSH test typing baseline. Its diagnostics contain no managed entry, managed API, migration materialization, runtime, or build-script file changed by this spike; runtime tests and both build paths are green.

## Boundaries

- No service manager, installed application directory, or default tmux socket was used.
- No frontend distribution is embedded or required.
- No update-check, package registry fetch, upgrade executor, or CLI installation layout is present in the managed entry graph.
- Cross-platform execution remains a CI responsibility; this host result does not replace that matrix.
