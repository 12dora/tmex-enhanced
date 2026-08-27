# Task F3-5 — browser cid contract for direct connections

You are a senior frontend engineer in the git worktree `/Users/konata/code/tmex-enhanced-wt-hub` (branch `feat/hub-node`). No other agent is editing frontend files. **Never run git commands that change state. Do not run `bun install`.** Bun `/Users/konata/.bun/bin/bun`; `cd packages/ws-client && bun test`, `cd packages/stores && bun test`, `cd apps/fe && bun test src/`; tsc per package; biome. Baselines: ws-client 230 / 0; stores 123 / 1; api-client 91 / 5; fe 206 / 0.

Backend contract (`sub/b2-11-result.md`, section on the browser contract): every gateway WebSocket the browser opens must carry a client nonce `?cid=<random b64url ≥ 16 bytes>` — local `/ws?cid=`, `/n/self/ws?cid=`, remote `/n/<id>/ws?cid=`; then `GET /n/<id>/api/mesh/connection?cid=<nonce>` returns the server `connectionId` (404 if unknown); `/api/rtc/authorize` uses that server id (never the nonce). Without `cid`, the GET only works when exactly one live connection exists.

1. `packages/api-client/src/node-url.ts` `nodeWsUrl(nodeId, {cid})` appends the query; `packages/stores/src/node-connection-manager.ts` / `apps/fe/src/node/node-runtimes.ts` generate one nonce per `GatewayConnection` instance (regenerated on each reconnect if the ws-client reconnect creates a new URL — check `createGatewayConnection`'s reconnect path; if it reuses the URL string, generate the nonce once per connection object and document it) and expose it to the direct controller.
2. `DirectCarrierController.fetchConnectionId()` calls `GET /api/mesh/connection?cid=<nonce>`; keep the existing 404/409 wait-for-primary behaviour.
3. Tests: URL contains `cid`; each connection has a distinct nonce; controller queries with it and authorizes with the returned server id.

File scope: `packages/api-client/src/node-url*.ts`, `packages/api-client/src/auth/**` (getConnection query param), `packages/stores/src/node-connection-manager*.ts`, `packages/ws-client/src/**` (additive), `apps/fe/src/node/node-runtimes*.ts`. Result: `prompt-archives/2026082701-hub-multinode-design/sub/f3-5-result.md`.
