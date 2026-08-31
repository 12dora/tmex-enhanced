# B1 result — gateway update check + one-click upgrade via GitHub Releases

## Changed files

- `apps/gateway/src/system/update-check.ts` — `checkForUpdate()` now queries `RELEASE_API_LATEST_URL` (GitHub REST, `application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `no-store`, 10s timeout). `latestVersion` = `tag_name` with a leading `v` stripped; `publishedAt` = `published_at`; `changelog` = release `body` (null if empty/whitespace). Missing `releaseTarballName(latest)` asset → `hasUpdate=false` with `latestVersion` still reported. HTTP 403/404/429 throw a clear `GitHub Releases API HTTP …` error; no npm/jsDelivr fallback. `UpdateCheckResult` shape unchanged.
- `apps/gateway/src/system/update-check.test.ts` — mocked `globalThis.fetch` (restored in `afterEach`): newer+asset → `hasUpdate` true + changelog; same version → false; missing asset → false + latest reported; 403 throws; plus empty body / 404.
- `apps/gateway/src/system/upgrade.ts` — downloading stage replaced `bun add tmex-cli@<version>` with `fetch(releaseTarballUrl(version))` → file (`redirect: 'follow'`) then `tar -xzf … -C <stageDir>`. CLI entry is `<stageDir>/package/bin/tmex.js` (`stageGithubRelease`). Detached execute stage unchanged: `process.execPath` + `upgrade --apply-current-package --install-dir … --version … --bun-path <execPath>`, same idle/downloading/executing machine and error-back-to-idle cleanup.
- `apps/gateway/src/system/upgrade.test.ts` — real `tar` pack/extract with mocked fetch: happy path, HTTP 403, missing `package/bin/tmex.js`.

Not edited: `managed.ts` / `managed-endpoint.ts` (no npm/`tmex-cli` registry usage).

## CLI launch: node vs bun

`packages/app/package.json` `build:cli` is `bun build src/cli-node.ts --outfile ./dist/cli-node.js --target node --format esm`. `bin/tmex.js` shebang is `#!/usr/bin/env node` and only re-exports that bundled file (self-contained; no `npm install` after extract).

Gateway still launches it with **bun**: `spawn(process.execPath, [binPath, 'upgrade', …, '--bun-path', process.execPath])`. Gateway runs on bun, so `process.execPath` is bun. The Node shebang/`--target node` means the same entry can also run under node; this path keeps bun, as before.

## Verification

| Check | Result |
| --- | --- |
| `cd apps/gateway && bun test src/system` | **22 pass, 0 fail** (4 files, 64 expects) |
| `cd apps/gateway && bunx tsc --noEmit -p .` | **21 `error TS`** (baseline 21, no increase; none in the files above) |
| `bunx biome check` on the four files (repo root) | **clean** |

## Out of scope (noticed, not changed)

- `packages/app/src/commands/upgrade.ts` `delegateUpgrade()` still runs `npx … tmex-cli@<version>` (looks like Task B2).
- `UpdateCheckResult` JSDoc in `packages/shared` still says “npm 上的最新版本”; contract shape was left unchanged as required.
- `apps/gateway/scripts/scan-managed-artifact.ts` still flags `--apply-current-package` in managed artifacts; that flag remains in the open-source upgrade execute stage on purpose.
