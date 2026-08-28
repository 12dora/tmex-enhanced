# cpu-features Bun auto-install stall

Date: 2026-08-28. Branch `chore/merge-hub-tabs`. No git state changes. Did not touch production tmex, the `tmex` tmux session, or files outside `packages/app/scripts/`.

## Root cause

`packages/app/scripts/build-runtime.ts` built `dist/runtime/server.js` with `--external cpu-features`. ssh2 wraps `require("cpu-features")` in try/catch, so the native addon is optional, but the **bare specifier stayed in the bundle**. The installed layout has no `node_modules` next to `runtime/server.js`, so Bun auto-install fetched `cpu-features@0.0.10` into `$BUN_INSTALL/install/cache` during module evaluation — minutes on a blocked registry, a needless network round-trip on a fresh host.

`--external` was the only non-builtin external. After rebuild, remaining `require("…")` specifiers are Node builtins only.

## What changed

- `packages/app/scripts/build-runtime.ts`: server + cli-auth entries now use `Bun.build` JS API (CLI `outfile` is a no-op in Bun 1.3.14; `outdir` + `naming` actually writes). A plugin resolves `cpu-features` to a virtual module that `throw new Error('cpu-features unavailable')`, matching ssh2’s optional-dep catch.
- Build fails if the produced bundle still has any unresolved package `require()`.
- `packages/app/scripts/build-runtime.test.ts`: scanner, stub inlining, catchable throw, and packaged `dist/runtime/server.js`.

Did not change `apps/gateway/scripts/build-managed.ts` (`--compile` still `--external cpu-features`; out of scope).

## Verified

- Rebuilt: `cd packages/app && bun run build:runtime` (no unresolved-specifier warning).
- Bundle: `server.js` has `// tmex-optional-stub:cpu-features` + `throw new Error("cpu-features unavailable")`; no `require("cpu-features")`. `cli-auth.js` does not pull ssh2.
- Isolated start (copied `runtime/server.js` into a temp dir with no `node_modules`/`package.json`; `BUN_INSTALL=<emptytmp>`; `BUN_CONFIG_REGISTRY=http://127.0.0.1:1`; **no** `--no-install`; port 19985):
  - `[tmex] version 1.0.2` then `/healthz` 200 `{"status":"ok",…,"env":"production",…}`
  - elapsed **0.473s**
  - no `install/cache/cpu-features*` under the temp `BUN_INSTALL`
- `bun test src`: 240 pass
- `bun test scripts/build-runtime.test.ts`: 4 pass
- `bunx tsc --noEmit -p .`: 1 error (baseline `TS2688` missing `@types/node`)
- `bunx biome check` on the two changed files: clean

## Open issues

- ssh2’s bundled `package.json` still contains the string `"cpu-features": "~0.0.10"` (metadata, not a require).
- `packages/app` `"test": "bun test src"` does not pick up `scripts/*.test.ts`.
- `build-managed.ts` `--compile --external cpu-features` is unchanged.
