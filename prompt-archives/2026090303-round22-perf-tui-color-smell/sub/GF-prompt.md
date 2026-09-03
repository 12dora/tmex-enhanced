# TASK GF

Backlog items B10 + B13 from the smell report `/Users/konata/code/tmex-r22/prompt-archives/2026090303-round22-perf-tui-color-smell/sub/EX4-smell-backlog.md` (read section 3.10 (the three S items: `decodeB64url`, `identicalKeyLog`, `resolveUserId`), section 4.2, and rows B10/B13 in section 6 first).

### B10 — three small duplicate helpers
- `decodeB64url`: keep one implementation in `packages/shared/src/auth/` (check what already exists there, e.g. encoding helpers) and use it from `apps/gateway/src/api/route-input.ts` and `apps/gateway/src/hub/uplink-server.ts`.
- `identicalKeyLog`: single implementation in `packages/shared/src/auth/key-log.ts`, used by `apps/gateway/src/hub/hub-runtime.ts` and `apps/gateway/src/mesh/mesh-runtime.ts`.
- `resolveUserId`: single implementation used by `apps/gateway/src/hub/hub-authorization.ts` and its duplicate site (find it per the report).
Behavior identical; add a unit test for each shared helper if none exists.

### B13 — split `apps/gateway/src/db/schema.ts` (865 lines / 57 exports / fan-in 34) by domain
Create `apps/gateway/src/db/schema/*.ts` (e.g. `users-auth.ts`, `devices.ts`, `mesh.ts`, `agent.ts`, `messaging.ts`, `settings.ts` — choose by reading the tables) and turn `schema.ts` into a barrel that re-exports everything so that NO importer changes (34 importers must keep working untouched). Keep table definition order where relations/foreign keys reference each other (drizzle relations need the referenced table defined/imported). Verify migrations still generate no diff: run the project's drizzle check/generate command in dry mode if one exists (look in package.json scripts / `drizzle.config.*`) and confirm zero new migration files; delete any file it generates.

Files you own: `apps/gateway/src/api/route-input.ts`, `apps/gateway/src/hub/uplink-server.ts`, `apps/gateway/src/hub/hub-runtime.ts`, `apps/gateway/src/mesh/mesh-runtime.ts`, `apps/gateway/src/hub/hub-authorization.ts`, `packages/shared/src/auth/key-log.ts` (+ one shared encoding module for b64url + tests), `apps/gateway/src/db/schema.ts`, new `apps/gateway/src/db/schema/*.ts`. Do NOT edit any other importer of schema.
Acceptance: `cd apps/gateway && bun test src/db src/hub src/mesh src/api` no fewer passes than baseline (note mesh has 4–5 known flaky tests under full parallel runs — rerun a failing file in isolation before concluding); tsc not above baseline; `bun scripts/complexity/gate.ts` ok.
