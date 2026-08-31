# B2 result — CLI distribution via GitHub Releases + install.sh + tmex shim

## What changed

### New
- `install.sh` — POSIX bash installer (`curl … | bash` or `bash install.sh [init flags…]`). Parses GitHub latest `tag_name` without jq; pin with `TMEX_VERSION`. Re-attaches `/dev/tty` when piped, else `--no-interactive`. Executable.
- `.github/workflows/release.yml` — on `v*` tags and `workflow_dispatch` (tag input): bun + node 20, `bun run build`, version==tag check, `npm pack`, `gh release create` or `upload --clobber` of `tmex-cli-<version>.tgz` + `SHA256SUMS`. Notes from `packages/app/CHANGELOG.md`.
- `packages/app/src/lib/cli-shim.ts` (+ tests) — copy `package.json` / `bin/` / `dist/cli-node.js` to `<installDir>/cli/`, write `~/.local/bin/tmex` (node then baked-in bun), symlink into `~/.bun/bin` when that dir exists, PATH hint via CLI i18n.
- `packages/app/src/lib/release-fetch.ts` (+ tests) — resolve latest via `RELEASE_API_LATEST_URL`, download `releaseTarballUrl(version)`, 404 / network errors.
- `packages/app/src/lib/install-script.test.ts` — sources `install.sh` and tests `tmex_parse_tag_name` / `tmex_version_from_tag` / `tmex_version_ge`.

### Modified
- `packages/app/package.json` — version `1.1.0`, `repository` → `https://github.com/12dora/tmex-enhanced.git`, `release: npm publish` replaced with `pack: npm pack`, `build:cli` adds `--packages bundle`.
- `packages/app/CHANGELOG.md` — 1.1.0 bilingual entry (GitHub Releases, install.sh, tmex shim, remote-access wizard, Connect more devices, header mesh icon removed).
- `packages/app/README.md`, root `README.md` + `README.zh-CN.md` (install/upgrade sections only), `scripts/release.ts` (tag + GitHub Release instead of `publish:tmex`).
- `packages/app/src/commands/upgrade.ts` — `delegateUpgrade` downloads the release tarball, `tar -xzf`, re-execs `process.execPath package/bin/tmex.js upgrade --apply-current-package` (no `npx`). Apply branch also deploys CLI + shim.
- `packages/app/src/commands/init.ts` / `uninstall.ts` — deploy/remove CLI + shims; `cliDir` on `InstallLayout`; backup/restore includes `cli/`.
- Join strings `npx tmex-cli hub join` → `tmex hub join` in `packages/app/src/commands/enroll.ts` (+ test), `apps/fe/src/node/enrollment.ts` (+ test), `docs/hub/2026082800-hub-node-operations.md` (command strings only).
- CLI i18n en / zh-CN: upgrade 404/network/extract errors, PATH hint (no 你).

Relative import of `packages/shared/src/release/source.ts` (not `@tmex/shared`). Did not touch `apps/gateway` or `~/Library/Application Support/tmex`.

## Self-contained CLI check

`cd packages/app && bun run build:cli` → bundled 47 modules, `dist/cli-node.js` 129.58 KB, only `node:*` imports (no `require` of npm packages).

`npm pack` extracted under `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/f515c2a8-84b8-4c01-964f-1e2b06d4abc4/scratchpad` **without node_modules**:

| Runtime | Command | Result |
|---|---|---|
| node | `node bin/tmex.js help` | exit 0, prints CLI usage |
| bun | `bun bin/tmex.js help` | exit 0, same usage |

Note: pack-after-`build:cli` only is CLI files (5 files, 33.9 kB). The release workflow runs full `bun run build` first so `dist/runtime` + `resources` are included.

## Test / tsc / lint

| Check | Result |
|---|---|
| `cd packages/app && bun test` | **453 pass / 1 fail** (baseline 430/1). Fail is pre-existing `scripts/build-runtime.test.ts` (`dist/runtime/server.js` missing without a full runtime build). |
| `cd packages/app && bunx tsc --noEmit -p .` | **1 `error TS`** (baseline 1): `TS2688 Cannot find type definition file for 'node'`. Unchanged. |
| `cd apps/fe && bunx tsc --noEmit -p .` | **0** `error TS` (baseline 0). |
| `cd apps/fe && bun test src/node/enrollment.test.ts` | 47 pass / 0 fail. |
| `bunx biome check` on changed TS/JSON | 20 files, clean (6 auto-fixed then re-checked). |
| `bash -n install.sh` | ok; `install.sh` is `+x`. |
| install.sh parse unit tests | 4 pass (sample GitHub JSON, no live release). |

## Out of scope (noticed, not edited)

- Root `package.json` `publish:tmex` still runs `bun run --filter tmex-cli release`, but the `release` script was removed (now `pack`). That root script will fail until updated.
- `apps/gateway` update-check still uses `registry.npmjs.org/tmex-cli`.
- `packages/shared` i18n `terminalHint` still says `npx tmex-cli@<version> upgrade`.
- Root README **Quick Start** and **Highlights** still mention `npx tmex-cli` (this task limited edits to the Install & Upgrade section).
- Other docs (`docs/update`, `docs/product`, `docs/2026021000-tmex-bootstrap`, `apps/fe` restart hint) still print `npx tmex-cli`.
