You are a read-only code explorer for the tmex monorepo (Bun runtime; apps/gateway = backend, apps/fe = React frontend, packages/* = shared libs). Output your COMPLETE report as your final message (you cannot write files). Be concrete: cite file paths with line numbers, quote the relevant code snippets, and name the exact functions/hooks/components involved.

Task EX1 — "Terminal connection failed" toast shows a node id instead of the node name.
The user reports: when a terminal fails to connect (e.g. a remote node terminal via the mesh entry), the error toast/notice shows a long hex string (node id) rather than the node's display name such as "jiefa-app".
Investigate:
1. Find every place in apps/fe (and packages/*) that renders a terminal connection failure / disconnect / "gateway version too low" / canonical-state-v1.1 required notice (search for toast keys like terminal.*, connection*, canonical-state, `nodeId`, `node <`), and determine which of them interpolates a node id rather than a name. Include the round24 "canonical-state-v1.1 required: node <nodeId> version <ver> < <min>" message contract parsing (apps/fe and packages/ws-client).
2. Identify where node display names are available in the frontend (stores: mesh nodes list, `useMeshNodes`, nodes store, `nodeNames` projection, peer cache) and the cheapest way to resolve nodeId → name inside those toast call sites (a selector or helper that already exists?).
3. Also check the gateway side: which error messages sent to the client include only nodeId (ws close reasons, HTTP error bodies for /n/:id proxy, `NODE_LOGIN_REQUIRED`, `NODE_UNREACHABLE`, etc.) and whether the gateway could cheaply include `nodeName` in the payload.
4. Check i18n keys in packages/shared/src/i18n (source locale JSON files, NOT generated resources.ts) for those messages.
Deliver: a list of concrete call sites to change, the recommended resolution approach (frontend name lookup vs gateway payload), and any tests that cover those toasts.
