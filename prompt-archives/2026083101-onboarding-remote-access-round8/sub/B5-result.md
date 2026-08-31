# B5 result — curated review fixes (GitHub Releases distribution)

Applied only the commander-approved items from R2. Did not implement tar path validation, SHA256 verification, or ETag caching.

## What changed

- `packages/app/src/lib/cli-shim.ts` (+test): `lstat` before write; skip foreign files/symlinks; atomic temp+rename; `# tmex-install-dir:` ownership; Node major ≥ 20 in the shim; PATH hint only when neither `~/.local/bin` nor (if created) `~/.bun/bin` is on PATH; `removeTmexShims({ installDir })` only removes matching shims.
- `packages/app/src/commands/uninstall.ts`: passes `installDir` into `removeTmexShims` (required by fix 1; not in the original file list).
- `packages/app/src/i18n/index.ts` (+test): `cli.shim.skipForeign` (en + zh-CN).
- `packages/app/src/lib/release-fetch.ts` (+test): strict semver `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` on explicit `--version` (`latest` still a sentinel).
- `packages/app/src/commands/upgrade.ts` (+test): forward `--bun-path`; `process.exitCode = childCode` before throw; log shim skip warning.
- `packages/app/bin/tmex.js`: keep a non-zero preset `exitCode` instead of always overwriting with 1.
- `packages/app/src/commands/enroll.ts` (+test): quote URL/token with `quotePosixShellArg` only when outside `[A-Za-z0-9._:/@%+=-]`.
- `packages/app/package.json`: removed `publishConfig`; added `"private": true` and `"engines": { "node": ">=20" }`.
- `install.sh` (+ `packages/app/src/lib/install-script.test.ts`): latest tag from `/releases/latest` redirect then API; non-greedy `tag_name` parse; `TMEX_VERSION` semver; TTY via `exec 3</dev/tty`; Node ≥ 20 before preferring node; PATH hint only when neither shim dir is on PATH.
- `apps/gateway/src/api/system.ts` (+ `src/api/system.test.ts`): reject non-semver upgrade versions with 400 (`latest` is not a sentinel here).
- `apps/gateway/src/system/upgrade.ts` (+test): preflight `package.json` (`tmex-cli` + `bin`), `dist/cli-node.js`, `dist/runtime/server.js`, `resources/fe-dist`, `resources/gateway-drizzle`; wait for `spawn` before `executing`; child `error` → idle with message.
- `.github/workflows/release.yml`: `gh release edit` on existing-release before upload.
- Docs: `docs/2026021000-tmex-bootstrap/deployment.md`, `docs/release/2026041300-cli-release-process.md` — `install.sh` / `tmex …` instead of `npx tmex-cli`; tag push → GitHub Actions instead of `npm publish`.

## Verification

| Check | Result |
| --- | --- |
| `cd packages/app && bun test` | **473 pass / 1 fail** (baseline 453/1). Fail is pre-existing: `scripts/build-runtime.test.ts` (`dist/runtime/server.js` absent). |
| `cd packages/app && bunx tsc --noEmit -p .` | **1** `error TS` (baseline 1): `TS2688` missing `@types/node`. |
| `cd apps/gateway && bun test src/system src/api/system.test.ts` | **33 pass / 0 fail**. |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **21** `error TS` (baseline 21). |
| `bunx biome check` on changed TS/JS | clean (4 files auto-fixed with `--write`). |
| `bash -n install.sh` | ok. |
| `bun scripts/complexity/gate.ts` | ok (1085 files, 8997 functions). No lock raises. |
| `cd packages/app && npm pack --dry-run` | works with `"private": true` (tarball `tmex-cli-1.1.0.tgz`). |

## Out of scope / notes

- **`packages/app/src/commands/init.ts`** still only prints `pathHint` in the summary list. Foreign-shim skips are already `console.warn`’d inside `installTmexShim` (and printed by `upgrade`). A matching summary line in `init` would need an out-of-scope edit.
- Gateway invalid-version 400 reuses `apiError.upgradeVersionRequired` (no new shared i18n key in scope).
- `uninstall.ts` was edited because fix 1 requires passing `installDir` at the uninstall call site.
