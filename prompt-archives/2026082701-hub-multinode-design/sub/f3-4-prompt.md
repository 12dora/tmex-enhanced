# Task F3-4 — browser sends connectionId for RTC authorize

You are a senior frontend engineer in the git worktree `/Users/konata/code/tmex-enhanced-wt-hub` (branch `feat/hub-node`). No other agent is editing frontend files now. **Never run git commands that change state. Do not run `bun install`.** Bun `/Users/konata/.bun/bin/bun`; `cd packages/ws-client && bun test`, `cd apps/fe && bun test src/`; tsc per package; biome. Baselines: ws-client 222 / tsc 0; fe 206 / tsc 0; api-client 85 / 5.

Backend delta (`sub/b2-10-result.md`, section "前端"): the target node now binds a direct carrier to a specific gateway WebSocket via `connectionId`. `GET /n/:T/api/mesh/connection` (session cookie) → `200 {connectionId}` | `404 NO_CONNECTION` | `409 MULTIPLE_CONNECTIONS`; `POST /n/:T/api/rtc/authorize` must include `connectionId` in the body and/or header `x-tmex-connection`. Read the exact wording in that report and in `apps/gateway/src/mesh/mesh-routes.ts` / `mesh-deps.ts`.

Deliverables:
1. `DirectCarrierController` (packages/ws-client/src/direct/direct-carrier-controller.ts): before authorize, fetch `connectionId` via the node-prefixed `apiClient` (`/api/mesh/connection`) — do it per attempt (a reconnect of the primary WS changes it); 409 → treat as "cannot direct-connect now" and retry after the primary reconnects; 404 → wait for the primary connection to be open then retry. Send it in the authorize body and header.
2. If the gateway WS HELLO response or upgrade exposes the connectionId directly (check `apps/gateway/src/mesh/mesh-http.ts` upgrade data and `sub/b2-10-result.md` — if the server sends it in a header on the WS upgrade response or in HELLO, prefer that and skip the GET), implement the cheapest reliable path and document which one you used.
3. `packages/api-client/src/auth/auth-api.ts` (or the mesh API file): typed `getConnection()`; tests for 200/404/409.
4. Tests in ws-client: authorize includes connectionId; 409 backoff; new attempt refetches.

File scope: `packages/ws-client/src/direct/**` (+tests), `packages/api-client/src/auth/**` or `packages/api-client/src/mesh*.ts` (+tests). Result: `prompt-archives/2026082701-hub-multinode-design/sub/f3-4-result.md`.
