# T3d — bring apps/gateway/src/mesh/forwarder.ts back under the file-length gate (1042 lines > 964 allowlist)

Result file: /Users/konata/code/tmex-r26/prompt-archives/2026090403-round26-pwa-login-localtab/sub/T3d-result.md

## Scope
apps/gateway/src/mesh/forwarder.ts, apps/gateway/src/mesh/forwarder.test.ts, and NEW sibling modules you extract (e.g. `apps/gateway/src/mesh/forwarder-auth-policy.ts`, `forwarder-unreachable.ts`, `forwarder-cookies.ts`) with their own small test files. Do not edit `scripts/complexity/allowlist.json`. Nothing else.

## Task
`bun scripts/complexity/gate.ts` reports `apps/gateway/src/mesh/forwarder.ts: 1042 lines > 964`. Move cohesive, side-effect-free pieces out of `forwarder.ts` into new modules with named exports — good candidates: the 401→`NODE_LOGIN_REQUIRED` rewrite + cookie clearing (`applyAuthPolicy` and helpers), `classifyUnreachableReason`/`safeUnreachableReason` and the 503 body builder, the `/n/:nodeId` path parsing + `isCanonicalNodeId`, any static header allow/deny lists. Keep the `Forwarder` class API and all behaviour identical; re-export nothing from forwarder.ts that isn't needed. Target ≤ 900 lines so the next small change doesn't trip the gate again. Move the corresponding tests alongside (forwarder.test.ts may also be over a limit — check the gate output for it and split similarly).

Verify: `cd apps/gateway && bun test src/mesh` → 0 fail; `bunx tsc --noEmit -p .` → 0; biome clean; `bun scripts/complexity/gate.ts` → no forwarder violation and no new ones.
