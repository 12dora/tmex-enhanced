# TASK H prompt（2026-09-03）

de-duplicate cross-package HTTP body helpers and two small clones.

Owned files: `apps/gateway/src/api/http.ts`, `packages/app/src/runtime/http.ts`, `apps/gateway/src/mesh/uplink-pool.ts` (ONLY :982-1004), `packages/shared/bench/legacy-snapshot-diff.bench.ts`, `packages/shared/src/ws-borsh/legacy-snapshot-draft.test.ts`.

New files allowed: `packages/shared/src/http/read-body.ts` (+ test), `packages/shared/src/ws-borsh/test-fakes.ts`.
