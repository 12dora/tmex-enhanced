# Task B2-1 — HubRuntime (apps/gateway/src/hub/) + new Borsh kinds

## Context

tmex hub/node mesh. The hub is a registry / signaling / blind relay — it must never be able to mint user credentials or decide mesh membership. Read `docs/hub/2026082700-hub-node-architecture.md` §1, §2 ("node 注册与节点证书", "链路身份与握手" uplink part, "首个用户与 hub 管理", "撤销"), §3 ("帧格式", "流类型" — `relay` and `ctl` uplink messages, "entry 侧路由" for the `/api/hub/*` mount), §5 "配置".

Foundations you consume (read the reports — they are the API contracts):
- `sub/b1-2-result.md` — `@tmex/shared/link`: `LinkMux`, `LinkSession`, `LinkStream`, `WebSocketLink` (+ server-side `WebSocketLike` adapter), `createInMemoryLinkPair`.
- `sub/b1-3a-result.md` (+ its trailing "指挥官修正") — `@tmex/shared/auth`: certificate / authorization decode + `verifyNodeCertificate`, `verifyEd25519`, key-log types, `randomBytes`, `nodeIdToHex`.
- `sub/b1-3b-result.md` — `apps/gateway/src/auth/`: `UserStore` (`nodes`, `enrollment_tokens`, `node_certs`, `users`), `NodeSessionStore`, `test-db.ts`.
- `sub/b1-1-result.md` — not needed by hub, but note `apps/gateway/src/ws/**` is the gateway WS layer; do not modify it.
- Gateway HTTP routing conventions: read `apps/gateway/src/api/index.ts` (route table, `ApiRouteContext`) and `apps/gateway/src/runtime.ts` `handleRequest` to match style; the hub is mounted by the role assembler (another task) as `hubRuntime.handleRequest(req, server)` before the gateway.

A concurrent agent (B1-3c) is writing `apps/gateway/src/auth/key-log-store.ts` / `user-key-service.ts`. Do NOT import them. Instead define in your module the narrow interfaces you need and take them via constructor injection:

```ts
interface HubKeyLogSource {
  head(userId: string): Promise<{ seq: bigint; hash: Uint8Array }>;
  list(userId: string, fromSeq?: bigint): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]>;
  append(userId: string, record: { bytes: Uint8Array; sig: Uint8Array }): Promise<{ ok: true; seq: bigint; hash: Uint8Array } | { ok: false; error: string }>;
}
```
(The hub stores the full user log; validation of records is the same chain logic — the assembler will pass the real service.)

## Deliverables

1. **Borsh kinds** in `packages/shared/src/ws-borsh/kind.ts` + `schema.ts` (+ tests next to existing ones): `NODE_EVENT` `{nodeId: string, status: enum{online, offline, revoked}, reach: option<string>, inventory: option<string /*json*/>}`, `RTC_SIGNAL` `{rtcSession: string, from: enum{browser, node}, to: string, sdp: option<string>, candidate: option<string>}`, `CARRIER_SWITCH` `{epoch: u32, to: enum{direct, primary}}`, `CARRIER_SWITCH_ACK` `{epoch: u32}`. Pick kind numbers that don't collide; follow the existing pattern exactly (kind constants, schema map, any capability list). Only these files in `packages/shared` — nothing else there.
2. **`apps/gateway/src/hub/uplink-protocol.ts`** — `ctl` JSON message types for the uplink: `auth.challenge {nonce}`, `auth.response {node_id, sig}`, `auth.ok`, `ping/pong`, `node.status {version, tmux, direct_capable, inventory, endpoints}`, `node.list {version, key_log_head:{seq,hash}, rtc:{stun,turn}, nodes:[{id,name,online,endpoints,inventory,direct_capable,version}]}`, `key.log.req {from_seq}` / `key.log.res {records:[{seq, bytes(b64url), sig(b64url)}]}`, `key.log.append {bytes, sig}` (a node/entry submits a user-signed record; hub validates via `HubKeyLogSource.append` and rebroadcasts head), `rtc.signal {rtcSession, from, to, sdp?|candidate?}`, `enroll.redeemed {certificate(b64url), cert_sig(b64url), enroll_pk(b64url)}` (push to the entry that created the enrollment). Typed encode/decode with validation (reject unknown `t`).
3. **`apps/gateway/src/hub/node-registry.ts`** — in-memory map nodeId → `{link: LinkSession, meta, lastSeen, authenticated}`; duplicate connect for the same node id replaces (closes) the old link; `listForBroadcast()`; `get(nodeId)`.
4. **`apps/gateway/src/hub/uplink-server.ts`** — accepts a `LinkSession` (from `WebSocketLink` over `/hub/uplink` upgrade, or from `createInMemoryLinkPair` for the co-located node): sends `auth.challenge` (32-byte nonce), verifies `auth.response` with the Ed25519 pk from `node_certs` (via `UserStore.getCert`), rejects unknown/revoked certs (close), then handles `node.status` → `UserStore` `nodes` upsert + broadcast `node.list` to all online nodes; heartbeat 15 s / 3 missed → offline + broadcast; `key.log.req` → `HubKeyLogSource.list`; `key.log.append` → validate+store → broadcast updated `node.list` (with new `key_log_head`); `rtc.signal` → forward to the `to` node's link if online and the `rtcSession` registration matches (`registerRtcSession(rtcSession, {fromNodeId, toNodeId})` API; `from:'node'` signals accepted only from the registered target node's link); incoming `relay` stream (OPEN payload `{to}` JSON): check the initiating node and target share `user_id`, open a stream on the target link with the same OPEN payload plus `{from}` and pump bytes both ways with proper END/RST propagation — never parse inner bytes.
5. **`apps/gateway/src/hub/hub-runtime.ts`** — `HubRuntime({db, userStore, keyLogSource, config: {publicUrl, stun, turn}, now?})`: `handleRequest(req, server)` for `POST /api/hub/enrollments/redeem` (public, no session: body `{certificate, cert_sig, name, version}` b64url → look up `enrollment_tokens` by `certificate.enroll_pk`, check unused/unexpired, `verifyNodeCertificate`, check `authorization.enroll_pk == certificate.enroll_pk` and uid matches, mark used, create `nodes` row (status `enrolled`), respond `{user:{id, username, root_public_key, root_epoch, kdf_params}, user_key_log: [...全量], node_certs: [...]}`, then push `enroll.redeemed` to the entry node recorded on the token if online) and `GET /hub/uplink` upgrade (wrap the Bun socket with `WebSocketLink` acceptor role — write the small Bun adapter here). Management API — **authenticated by the node-session of the hub machine's own node** (`NodeSessionStore.verify` with `via` = the requester's entry; the assembler passes a `authenticate(req) → {userId} | null` callback, so just take it as a constructor dep): `GET /api/hub/nodes`, `POST /api/hub/nodes/:id/rename {name}`, `POST /api/hub/nodes/:id/revoke` (sets `nodes.status=revoked`, disconnects uplink, broadcasts; the user-signed `revoke-node` record itself arrives via `key.log.append`), `POST /api/hub/enrollments {enroll_pk, authorization(b64url), authorization_sig(b64url), exp}` (verify authorization sig with the user's current root pk and `root_epoch`, store token with `entry_node_id`). `attachLocalNode(link: LinkSession)` for the in-process hub,node pair. `stop()` closes all links.
6. **Tests** (`apps/gateway/src/hub/*.test.ts`, using `test-db.ts` + `createInMemoryLinkPair`): auth challenge/response happy + wrong key + revoked; duplicate node id replaces; node.status → node.list broadcast to others; heartbeat timeout; key.log req/res + append rebroadcast; relay between two fake nodes carries bytes unchanged both ways, END/RST propagate, cross-user relay refused; rtc.signal routing + spoofed `from:'node'` refused; enrollment create → redeem happy path (with a real certificate from `@tmex/shared/auth` `createEnrollment` + `createNodeCertificate`) → `enroll.redeemed` pushed; redeem with wrong enroll_pk / expired / reused refused; management API auth required.

## Your file scope

`apps/gateway/src/hub/**` (new), `packages/shared/src/ws-borsh/kind.ts`, `packages/shared/src/ws-borsh/schema.ts` and their test files. Nothing else. Other agents are concurrently editing `apps/gateway/src/auth/**` and `apps/gateway/src/mesh/**`, `runtime.ts` — never touch those.

## Acceptance

`cd apps/gateway && bun test src/hub` green; `cd packages/shared && bun test` green; tsc: 0 errors in your files, package totals ≤ current (gateway 23, shared 0); biome clean.

## Result file

`prompt-archives/2026082701-hub-multinode-design/sub/b2-1-result.md` — with exported API signatures and the exact ctl JSON wire shapes.
