# V2 — api-client: session interceptor must not trust a foreign `body.nodeId`

（通过 SendMessage 追加给 V1 同一 Opus agent，worktree `../tmex-enhanced-wt-vp`）

Production evidence: `POST /n/6b07817b…/api/rtc/authorize`（jiefa-app）returned 401 with body `{"code":"NODE_LOGIN_REQUIRED","nodeId":"ec42f364…"}`（hub）。`handleUnauthorized` trusts `body.nodeId` when `code === NODE_LOGIN_REQUIRED`, so the auth-required event was attributed to the hub row; on 1.1.8 that tore down the hub's runtime subtree.

Change: derive `urlNodeId = nodeIdFromPath(path)`; when the path is node-scoped, the event's `nodeId` must be the URL's id and a differing `body.nodeId` is ignored（`console.warn`）。Non-node paths keep using `body.nodeId`（entry-local endpoints answering on behalf of a node）。Global-401 behaviour unchanged. Tests for the four cases; verify api-client `bun test` / tsc / biome.
