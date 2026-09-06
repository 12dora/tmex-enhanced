# EX1 — Relay operator quotas: code exploration report

Scope: everything a planner needs to implement, on the `relay` role,
(a) per-tenant **max file size** for file transfers, (b) **max tenant count**,
(c) **max total relay bandwidth** across all tenants, (d) **fair-share bandwidth** between tenants.

Repo: `/Users/konata/code/tmex-r32` (branch `main`, r32 worktree). All paths absolute.
Reference docs (read these first, they are accurate and current):

- `/Users/konata/code/tmex-r32/docs/relay/2026090304-relay-role.md` — the relay role spec (57 KB). §6 storage, §7 HTTP, §8 uplink protocol, §11 quota & metering, §13 known boundaries.
- `/Users/konata/code/tmex-r32/docs/relay/2026090403-relay-metrics.md` — `GET /api/relay/metrics`.
- `/Users/konata/code/tmex-r32/docs/relay/2026090501-relay-mgmt-switch-usage.md` — round-27 relay management UI + live usage (`relay.quota.usage`).
- `/Users/konata/code/tmex-r32/docs/files/2026061500-transfer-progress-chunked.md` — chunked file transfer.

---

## 1. Relay role architecture, tenant model, and the quota that exists today

### 1.1 Role wiring

| Concern | File:line |
|---|---|
| Runtime construction (`relay` / `relay,node` only) | `/Users/konata/code/tmex-r32/packages/app/src/runtime/assemble-relay.ts:35-66` |
| Route mounting order (TLS → setup → **relay** → hub → mesh → gateway → static), WS upgrade, shutdown | `/Users/konata/code/tmex-r32/packages/app/src/runtime/assemble-routes.ts:344-373`, `:436-453` |
| The relay runtime itself | `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-runtime.ts:115-357` |
| Public exports | `/Users/konata/code/tmex-r32/apps/gateway/src/relay/index.ts` |
| Env vars `TMEX_RELAY_PUBLIC_URL`, `TMEX_RELAY_ADMIN_TOKEN` | `assemble-relay.ts:42-52`; doc §1 |

`RelayRuntime` owns: `tenants` (`RelayTenantStore`), `keyLog`, `configStore`, `registry` (in-memory live links),
`metering`, `metrics`, `uplink` (`RelayUplinkServer`), `limiter` (enroll IP limiter), `adminAuth`.
Constructed at `relay-runtime.ts:132-198`.

### 1.2 Tenant join / enroll paths (where "max tenants" must bite)

There is exactly **one** place a tenant row is created:

```
/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-routes.ts:104-129   issueTenantToken()
  :111  const existing = deps.tenants.getByRootPublicKey(parsed.rootPublicKey);
  :119  deps.tenants.create({ ... })      // ← the only tenant INSERT in the codebase
```

reached from `handleRelayEnroll` (`relay-routes.ts:131-174`), route `POST /api/relay/enroll`
(`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-public-routes.ts:105-109`).

Body may carry `mode: 'enroll' | 'join'` (`relay-routes.ts:58-82`):

- `mode: 'enroll'` → new tenant **or** token re-issue for an existing root public key (`:114-127`).
- `mode: 'join'` → `handleRelayJoin` (`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-pack-http.ts:86-128`),
  the round-24 "password join / sealed pack" path. It **never creates a tenant**; it only hands back the
  sealed pack of an existing tenant. So a max-tenant cap does not need a hook here.

`relay.auth` over the uplink (`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-uplink-auth.ts:52-...`)
also never creates tenants — it only looks them up.

Enroll rate limiting today: per source IP (and per tenant id for the join/kdf routes)
`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-enroll-limiter.ts:12-52` (5 failures / 15 min,
`RELAY_ENROLL_FAILURE_LIMIT` / `_WINDOW_MS` in `types.ts:28-29`).

### 1.3 Storage (relay side) — migration `0039_relay.sql` + `0043`, `0046`

Schema: `/Users/konata/code/tmex-r32/apps/gateway/src/db/schema/relay.ts`

```
relay_config     (relay.ts:4-16)   id=1 singleton, password_hash, password_epoch,
                                   min_token_epoch, admin_token_hash,
                                   default_quota_json TEXT NOT NULL, updated_at
relay_tenants    (relay.ts:18-35)  id, root_public_key UNIQUE, root_epoch, token_hash, token_epoch,
                                   quota_json TEXT NULL,   ← per-tenant override, null = follow default
                                   label, kicked, created_at, last_seen_at,
                                   bytes_in, bytes_out, key_log_head_seq,
                                   kdf_params_json, sealed_pack, sealed_pack_updated_at
relay_nodes      (relay.ts:37-57)  PK(tenant_id,node_id), status pending|admitted|revoked, ...
relay_enrollments(relay.ts:59-71)
relay_key_log    (relay.ts:73-84)
```

Migrations live in `/Users/konata/code/tmex-r32/apps/gateway/drizzle/` (latest is `0048_share_password_enc.sql`;
next free number is **0049**). Generation: `cd apps/gateway && bun run db:generate` (drizzle-kit, config
`/Users/konata/code/tmex-r32/apps/gateway/drizzle.config.ts`). Runtime application:
`/Users/konata/code/tmex-r32/apps/gateway/src/db/migrate.ts:16-18` (auto at boot).
Migration test pattern to copy: `/Users/konata/code/tmex-r32/apps/gateway/src/db/relay-pack-updated-at.migration.test.ts`
(raw `PRAGMA table_info` assertions against a fresh in-memory DB).

### 1.4 The quota that exists today (rounds 24–27)

**Wire type** (shared, used by relay ⇄ node ctl and by both UIs):

```ts
// /Users/konata/code/tmex-r32/packages/shared/src/relay/codec.ts:67-85
export type RelayQuotaUsage = {
  currentNodes: number; currentStreams: number;
  bytesInPerSec: number; bytesOutPerSec: number;
  bandwidthBytesPerSec?: number;   // token-bucket admitted rate; old relays omit
  sampledAt: number;
};
export type RelayQuota = {
  maxNodes: number;
  maxStreams: number;
  bandwidthBytesPerSec: number | null;   // null = unlimited
  currentNodes?: number;                 // optional, old relays omit
  usage?: RelayQuotaUsage;               // optional, old relays omit
};
```

`relay.quota` ctl frame: `codec.ts:156` (`{ t:'relay.quota' } & RelayQuota`); parser `codec.ts:512-527`.
Codec is strict-but-forward-tolerant (unknown fields are **dropped**, `parseRelayCtl` at `codec.ts:538-544`),
so adding a field means touching `codec.ts` on both sides — old relays/nodes simply do not see it.

**Server-side limits and parsing**: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-quota.ts`

```
:8   RELAY_QUOTA_MAX_NODES_LIMIT   = RELAY_CTL_MAX_NODES (256)   // capped by one relay.list frame
:9   RELAY_QUOTA_MAX_STREAMS_LIMIT = 65_536
:10  RELAY_QUOTA_MAX_BANDWIDTH     = 10 GiB/s
:19  parseRelayQuotaJson()   lenient, for DB reads
:30  normalizeRelayQuota()   strict, for HTTP input → 400 RELAY_BAD_QUOTA on any bad field
:48  serializeRelayQuota()
:56  effectiveRelayQuota(tenantQuota, defaultQuota) = tenantQuota ?? defaultQuota
:63  defaultRelayQuota() → RELAY_DEFAULT_QUOTA
```

Default: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/types.ts:35-39` `{ maxNodes: 16, maxStreams: 64, bandwidthBytesPerSec: null }`.

> ⚠ Contract drift already present: `/Users/konata/code/tmex-r32/packages/api-client/src/relay/admin-api.ts:33-37`
> declares `RELAY_QUOTA_LIMITS.maxNodes = 4096` while the server caps at 256. The FE form validates against 4096
> and the server rejects >256 with `RELAY_BAD_QUOTA`. Worth fixing while in here.

**Where each quota is enforced today**

| Quota | Enforcement point |
|---|---|
| `maxNodes` | redeem: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-routes.ts:298-303` → `409 RELAY_QUOTA_NODES`; counted with `tenants.countActiveNodes()` (pending+admitted, revoked excluded) |
| `maxStreams` | relay stream OPEN: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-stream-router.ts:52-57` → `registry.reserveStream(tenantId, quota.maxStreams)`, else `stream.reset('quota-streams')`. Reserve-before-await so concurrent OPENs cannot punch through (`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-registry.ts:146-157`) |
| `bandwidthBytesPerSec` | per-tenant token bucket, applied in the data pump: `relay-stream-router.ts:88` (`ctx.bucketFor(tenantId).createStream()`) and `:153` (`await limiter.take(bytes.byteLength)`) |

**Per-tenant token bucket** — `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-quota.ts:99-296`:

- `RelayTokenBucket(rate, now, sleep)`; `rate === null` ⇒ no-op (`:149`).
- One `RelayTokenStream` per relay stream (`createStream()`, `:135`); its `take(bytes)` **delays, never drops**.
- Frames ≤ `RELAY_TOKEN_BUCKET_BYPASS_BYTES` (4 KiB, `:69`) go to a **bypass lane** so interactive terminal
  traffic is not stuck behind a bulk transfer (`takeBypass`, `:159`).
- Large takes are served **round-robin across streams** in `drain()` (`:195-241`), granting at most 4 KiB per
  turn (`:231`), and the bypass lane alternates with the ready queue (`shouldServeBypass`, `:267`) so neither
  starves the other. **This is already a fair-share scheduler — at the stream level, inside one tenant.**
- `setRate()` (`:117`) live-updates and resolves everything when switched to unlimited.
- Bucket lifecycle: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-uplink-server.ts:200-210`
  (`bucketFor`, one per tenant, lazily created, rate synced on every call), cleared on `stop()` (`:346`).

**Effective-quota resolution + push to tenants**

```
/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-uplink-server.ts
:180 quotaFor(tenantId)            = effectiveRelayQuota(tenant.quota, config.defaultQuota)
:188 quotaUsage(tenantId)          = { currentNodes, currentStreams, bytesIn/OutPerSec, bandwidthBytesPerSec, sampledAt }
:200 bucketFor(tenantId)
:218 notifyQuota(tenantId)         → setRate + broadcast relay.quota   (on quota change / admit / auth)
:227 pushQuotaUsageIfChanged()     → called once per 5 s metrics sample, only when the usage fingerprint changes
/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-quota-ctl.ts:5-27  fingerprint + ctl builder
```

`notifyQuota` call sites: auth (`relay-uplink-auth.ts:191`), redeem (`relay-routes.ts:323`),
key-log member records (`relay-uplink-handlers.ts:71-73`, `relay-pack-http.ts:244`),
admin config/tenant PATCH (`relay-admin-routes.ts:117`, `:151`).

**Node (tenant) side of the quota**

```
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-uplink-ctl.ts:221-233  applyRelayQuota() → host.quota
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-uplink-client.ts:101   quota: RelayQuota | null
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-routes.ts:161          GET /api/mesh/relay/status → quota
/Users/konata/code/tmex-r32/packages/api-client/src/relay/tenant-api.ts:50-71  RelayQuotaUsage / RelayQuotaView
                                                    :312-322  normalizeRelayStatus (usage ?? null)
/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/relay/relay-quota.ts:38-74  relayQuotaRows() → 3 progress rows
```

**Metering** — `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-metering.ts`:
in-memory counters flushed to `relay_tenants.bytes_in/out` every 30 s (`RELAY_METER_FLUSH_MS`, `types.ts:12`);
`record()` (`:55`) counts the same forwarded byte in **both** `bytesIn` and `bytesOut`;
`recordAdmitted()` (`:67`) counts only bytes the token bucket let through — this is the value that must be
compared against a bandwidth cap. `forgetTenant()` (`:110`) on tenant delete.

### 1.5 Operator API surface (admin auth = bearer admin token **or** local node-session)

`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-runtime.ts:230-338` (dispatch + `matchAdminRoute`),
handlers in `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-admin-routes.ts`:

| Route | Handler |
|---|---|
| `GET /api/relay/status` | `relayStatusPayload` `:26-71` — `{ config:{hasPassword,passwordEpoch,minTokenEpoch,defaultQuota}, tenants[], totals }` |
| `GET /api/relay/metrics` | `handleRelayMetrics` `:77-83` |
| `POST /api/relay/password` | `handleRelayPassword` `:85-105` |
| `PATCH /api/relay/config` | `handleRelayConfigPatch` `:107-120` — currently only `{ defaultQuota }` |
| `PATCH /api/relay/tenants/:id` | `handleRelayTenantPatch` `:122-153` — `{ quota?, label? }` |
| `POST /api/relay/tenants/:id/kick` | `:155-160` |
| `DELETE /api/relay/tenants/:id` | `:162-171` |

Error codes: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-http.ts:1-30`
(`RELAY_QUOTA_NODES`, `RELAY_BAD_QUOTA` already exist; body shape `{ error: { code, message } }`).

Config persistence: `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-config-store.ts`
(`ensure` `:20`, `read` `:49`, `setDefaultQuota` `:70`, `rotatePassword` `:79`).

### 1.6 CLI (must be kept in sync)

`/Users/konata/code/tmex-r32/packages/app/src/commands/relay-admin.ts:284-378` (`readQuotaFlags`, `mergeQuota`,
`applyDefaultQuota`, `applyTenantQuota`, `runRelayQuota`), helpers in
`/Users/konata/code/tmex-r32/packages/app/src/commands/relay-shared.ts:208-258`
(`formatQuota`, `quotaFromJson`, `parseBandwidthFlag`, `parseCountFlag`), flag allowlist
`/Users/konata/code/tmex-r32/packages/app/src/lib/args.ts:282`, help text
`/Users/konata/code/tmex-r32/packages/app/src/cli/help.ts:35` and `:79` (both English and Chinese blocks).

---

## 2. Relay data plane — where bytes actually flow, and the single choke point

### 2.1 Everything that crosses the relay process

| Path | Transport | Volume | Accounted today? | Throttled today? |
|---|---|---|---|---|
| **Relay streams** (node ⇄ node payload) | `LinkMux` streams on `WS /relay/uplink` | **all bulk traffic** | yes (`metering.record` + `recordMember` + `recordAdmitted`) | yes (per-tenant `RelayTokenBucket`) |
| ctl frames (`relay.status`, `relay.list`, `relay.keylog.*`, `relay.rtc`, `relay.quota`, ping/pong) | ctl stream (stream id 0) of the same mux | small; ≤64 KiB/frame (`RELAY_CTL_MAX_BYTES`, `codec.ts:213`) | **no** (only counted in `LinkMux.stats()` frame counters used by metrics) | **no** |
| `POST /api/relay/enroll`, `/tenants/:id/pack`, `/keylog`, `/enrollments*` | plain HTTP | small JSON; sealed pack ≤ `RELAY_PACK_MAX_BYTES` | no | no (IP rate limiter only) |
| RTC signalling | `relay.rtc` ctl frames (`relay-uplink-handlers.ts:29-37`) | tiny | no | no |

So: **one choke point for bulk bytes** —

```
/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-stream-router.ts
:26  acceptRelayStream()   validates {to}, same-tenant, both admitted, reserves a stream slot
:69  outbound = await target.link.openStream(te.encode(JSON.stringify({ to, from })))
:78  pumpRelayPair()       creates ONE RelayTokenStream shared by both directions (:88)
:119 pumpMetered()         ← THE choke point
     :144 noteRelayByteFlow(from)
     :146 ctx.metering.record(tenantId, {bytesIn, bytesOut})
     :150 ctx.metering.recordMember(from, {bytesIn}) / (to, {bytesOut})
     :153 await limiter.take(bytes.byteLength)         ← bandwidth gate
     :154 ctx.metering.recordAdmitted(tenantId, bytes.byteLength)
     :162 await dst.write(bytes, value.head ? {head:true} : undefined)
```

Every byte of every relayed file, terminal, port-forward or HTTP proxy stream passes through
`pumpMetered`. Any global/hierarchical bandwidth control belongs here and nowhere else.

Context injected at `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-uplink-server.ts:483-495`
(`RelayStreamContext`: `registry`, `tenants`, `metering`, `quotaFor`, `bucketFor`, `now`, `isStopped`).

### 2.2 What the relay can and cannot observe (critical for feature (a))

A relay stream is **not** one HTTP request or one file — it is **one whole peer session**:

```
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-uplink-client.ts:340-359  openRelay(toNodeId)
    → link.openStream(encodeRelayOpenStream({ to }))            // OPEN payload is only {"to": "<32hex>"}
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-dialer.ts:329-349          dial fallback → handshakeRelay
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-dialer.ts:511-527          acceptRelay(stream, from)
/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-protocol.ts:398-460        handshakeRelay():
    :439  const secure = new SecureChannelLink(byteTransportFromStream(opts.stream), {sendKey, recvKey, ...})
    :443  const session = new LinkMux(secure, { role, logContext: { transport: 'relay' } })
```

i.e. inside the relay stream there is an **AES-GCM SecureChannelLink** and then a full `LinkMux`, in which the
two nodes multiplex every logical stream (HTTP proxy requests, terminal streams, file bodies).

Therefore the relay sees, per relay stream, only:

- the OPEN payload `{"to":"<nodeId>"}` (`/Users/konata/code/tmex-r32/packages/shared/src/relay/blobs.ts:14`,
  `RELAY_OPEN_STREAM_MAX_BYTES = 256`, encoder `:54`, decoder `:61`; the relay re-encodes `{to, from}` at
  `relay-stream-router.ts:69`);
- opaque ciphertext chunk sizes and timing (plus, if it chose to parse them, the 10-byte plaintext inner
  `SecureChannelLink` headers — see §3.4 and Option C in §8);
- END/RST.

It **cannot** see HTTP methods, paths, headers, `Content-Length`, file names, or the boundary between two
logical streams. This is the deliberate privacy boundary (doc §2 「隐私边界」, §13 「已知边界」).

**Consequence for (a):** a relay cannot itself observe "this is a 4 GB file". Options are laid out in
§8 Recommended insertion points.

### 2.3 Existing rate-limit / backpressure helpers (reuse, do not re-invent)

| Helper | Path | Note |
|---|---|---|
| `RelayTokenBucket` + `RelayTokenStream` | `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-quota.ts:99-296` | byte-rate, delay-not-drop, round-robin across streams, 4 KiB bypass lane |
| `TokenBucket` (per-minute, boolean allow) | `/Users/konata/code/tmex-r32/apps/gateway/src/hub/uplink-rate-limit.ts:9-32` | request-rate style |
| `IdleLruMap`, `WindowedLogBudget`, `KeyLogReqLimiter` | same file `:34-279` | bounded state maps |
| `SlidingWindowCounter` | `/Users/konata/code/tmex-r32/apps/gateway/src/lib/sliding-window.ts:15` | used by `RelayEnrollLimiter` / `RelayEnrollCreateRate` |
| Link-level flow control | `/Users/konata/code/tmex-r32/packages/shared/src/link/mux.ts` (`INITIAL_STREAM_WINDOW` 1 MiB, `MAX_LINK_UNACKED` 65 MiB, `types.ts:1-17`) | WINDOW credits are only issued when the consumer pulls, so throttling `pumpMetered` naturally back-pressures the sender |
| WS backpressure | `/Users/konata/code/tmex-r32/apps/gateway/src/runtime.ts:78-79`, `packages/shared/src/link/websocket-link.ts:27` | `closeOnBackpressureLimit: true` |

### 2.4 Metrics plumbing (already carries everything a global cap needs)

`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-metrics.ts`:

- `RelayMetricsCollector` samples every `RELAY_METRICS_INTERVAL_MS` = 5 s (`types.ts:24`), keeps 60 samples.
- `totals.bandwidthBytesPerSec` (`:349`, from `metering.liveAdmittedTotalsSnapshot()`) — **already the
  relay-wide admitted byte rate**, exactly the number a global cap would be compared against.
- `tenants[].quota` = effective quota; `tenants[].usage` = per-tenant live usage (`:396-411`).
- `tenantRates(tenantId)` (`:389`) feeds `RelayUplinkServer.quotaUsage` via
  `relay-runtime.ts:185` (`uplink.bindTenantRates(...)`), and `onSample` (`relay-runtime.ts:183`) drives
  `pushQuotaUsageIfChanged()`.
- Client mirror of these types: `/Users/konata/code/tmex-r32/packages/api-client/src/relay/metrics-types.ts`.

---

## 3. File transfer over the relay — can the relay see file size? (**no**)

### 3.1 The chunked transfer protocol

Doc: `/Users/konata/code/tmex-r32/docs/files/2026061500-transfer-progress-chunked.md`.

- Global cap `TMEX_TRANSFER_MAX_BYTES`, default 2 GiB → `config.transferMaxBytes`
  (`/Users/konata/code/tmex-r32/apps/gateway/src/config.ts:308`), surfaced to the browser as
  `SystemInfo.transferMaxBytes` (`/Users/konata/code/tmex-r32/apps/gateway/src/system/info-public.ts:41`,
  contract `/Users/konata/code/tmex-r32/packages/shared/src/contracts/system.ts:26`) so the UI pre-validates.
- Upload is 4 endpoints: `POST /api/files/upload/init` (declares `{rootId,path,name,size}`),
  `PUT /api/files/upload/:id?offset=N` (one chunk), `POST /api/files/upload/:id/commit`
  (rsync push, NDJSON progress), `DELETE /api/files/upload/:id`.
- `UPLOAD_CHUNK_SIZE = 8 MiB` (`/Users/konata/code/tmex-r32/apps/gateway/src/api/file-transfer-routes.ts:33`).
  **The declared total size exists on the wire exactly once, in the `init` JSON body.** Chunk PUTs carry only
  that chunk's `Content-Length` plus `?offset=`.
- Download: `POST /api/files/download/prepare` (NDJSON, ends `{type:'done',downloadId,size,name}`) then
  `GET /api/files/download/:id/content` streaming with `Content-Length`. Legacy single-shot
  `GET /api/files/download?rootId=&path=` still exists. **No `Range` support anywhere.**

### 3.2 Handlers and where a size is known

- `/Users/konata/code/tmex-r32/apps/gateway/src/api/files.ts:15-19` — route aggregation.
- `/Users/konata/code/tmex-r32/apps/gateway/src/api/file-transfer-routes.ts`
  `handleUploadInit` `:35-56` (**total-size gate at `:47`: `size > config.transferMaxBytes` → `too_large`**),
  `handleUploadChunk` `:58-85` (reads `Content-Length`, caps at `min(remaining, 8 MiB)`),
  `handleUploadCommit` `:87-113`, `handleDownloadPrepare` `:120-156`,
  `handleDownloadContent` `:158-167`, legacy `handleDownload` `:174-188`, route table `:190-232`.
- `/Users/konata/code/tmex-r32/apps/gateway/src/files/transfer-session.ts:113-120` `prepareAppend`
  (`received + len > size` → `too_large`).
- `/Users/konata/code/tmex-r32/apps/gateway/src/files/device-storage.ts:406`, `:441` — download-side
  `transferMaxBytes` checks (pre- and post-rsync); also `MAX_TEXT_BYTES` 2 MiB
  (`/Users/konata/code/tmex-r32/apps/gateway/src/files/categorize.ts:5`) and `RAW_MAX_BYTES` 50 MiB
  (`device-storage.ts:30`, checked `:282`, `:318`).
- `/Users/konata/code/tmex-r32/apps/gateway/src/api/file-http.ts:39-52` `attachmentHeaders()` builds
  `Content-Length`; `streamTempFile` `:54-83`.

### 3.3 The remote-node path (browser → entry node → forwarder → link → target node)

```
browser  → /n/<nodeId>/api/files/...            packages/api-client/src/node-url.ts:54-63, :167
                                                packages/api-client/src/file-urls.ts:18-31
entry gw → forwarder-path.ts:1-5                /^\/n\/([^/]+)(\/.*)?$/
         → forwarder.ts:155-172 handle()
         → forwarder.ts:616-662 forwardHttp()   ← serializes {method,path,query,headers,origin,auth}
         → stream-targets.ts:270-406 openHttpStream()
              :281  link.openStream(encodeJsonBytes(payload))   // OPEN payload = the request head JSON
              :306  pumpToLink(...)                             // body as DATA frames
              :408  readHttpHead()                              // response head, a `head:true` JSON frame
target   → peer-live-registry.ts:311-341 handleInboundStream → stream-targets.ts:148-249 acceptHttpStream
              :109-146 requestBodyFromLink()   // DATA frames re-assembled, no size accounting
```

Header filtering: `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/forwarder-headers.ts:63-79`
(`filterRequestHeaders`, drops cookie/authorization/host/x-forwarded-*; **keeps `content-length` and
`content-type`**) and `stream-targets.ts:39-46` (`stripForwardedRequestHeaders`, same policy).
Response headers whitelisted at `forwarder-headers.ts:33-61` (`content-length`, `content-range`,
`accept-ranges`, …). `openHttpStream` parses the *response* `Content-Length` only to detect truncation
(`stream-targets.ts:64-72`, `:324`, `:382-386`) — a minimum, not a maximum.

So `Content-Length` **is** on the wire, but only inside the peer session — which is encrypted (next section).

### 3.4 Encryption boundary — what the relay sees

`peer-dialer.ts:330-334` (initiator) / `:514-521` (`acceptRelay`) run `handshakeRelay`
(`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-protocol.ts:398-465`) **on top of** the relay stream:
X25519 + Ed25519 transcript → `derivePeerSessionKeys` (`:436`) → `new SecureChannelLink(...)` (`:439`) →
`new LinkMux(secure, { transport:'relay' })` (`:444`). Everything the forwarder writes — the request-head JSON
(method, path, headers incl. `Content-Length`, session auth), the response head frame, every body byte — is
inside AES-256-GCM. Direct `ws-secure` (`peer-protocol.ts:376`) and DataChannel links use the identical
construction, so relay vs. direct is cryptographically indistinguishable to the payload.

| Relay CAN observe | Relay CANNOT observe |
|---|---|
| relay-stream OPEN `{"to": nodeId}` → which two nodes talk (`blobs.ts:53-67`, ≤256 B) | HTTP method / path / query / headers, incl. `Content-Type` and `Content-Length` |
| bytes per stream / member / tenant, and byte-flow timestamps (`relay-metering.ts:56-88`, `relay-registry.ts:48`) | whether a stream is a terminal session, a file chunk, an LLM stream or a port-forward |
| outer frame boundaries and lengths | inner OPEN payload JSON, the `{status,headers}` head frame, all body bytes |
| **the 10-byte plaintext inner header of each `SecureChannelLink` frame** — `[streamId u32][op u8][flags u8][len u32]`, sent as GCM AAD (`/Users/konata/code/tmex-r32/packages/shared/src/link/secure-channel-link.ts:183-198`, `:275-301`) ⇒ inner mux stream ids, OPEN/DATA/END/RST ops and ciphertext lengths are technically readable | anything those frames carry; tenant `K_meta` blobs (status/inventory/endpoints/SDP), key-log payloads |

The hub role is identical and in fact does *less*: `/Users/konata/code/tmex-r32/apps/gateway/src/hub/hub-relay-streams.ts:128-143`, `:186-235` → `/Users/konata/code/tmex-r32/apps/gateway/src/relay/hub-relay-pump.ts:5-32` is a blind pump with **no metering at all**.

Documented as an explicit privacy boundary at `docs/relay/2026090304-relay-role.md:50-58`.

### 3.5 Direct/WebRTC bypass (bytes may never touch the relay)

- Node side `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/bulk.ts` — `bulk:` DataChannel,
  `BULK_FRAME_SIZE` 16 KiB (`:7`), `BULK_MAX_RECEIVED_FRAME_SIZE` 64 KiB (`:8`),
  `BULK_UPLOAD_QUEUE_BUDGET_BYTES` 8 MiB (`:11`), `startPut` requires `owner.expectedSize === size` (`:224-255`),
  `writePut` rejects overrun (`:264-267`); hooks at
  `/Users/konata/code/tmex-r32/apps/gateway/src/api/file-transfer-sessions.ts:88-99`.
- Browser side `/Users/konata/code/tmex-r32/packages/ws-client/src/direct/bulk-client.ts`.
- Transport choice `/Users/konata/code/tmex-r32/packages/panels/src/files/bulk-transfer.ts:92-101` (`pickBulk`),
  `:116-135` / `:240-268` return `'direct' | 'relay'`; fall back to full REST on any pre-commit failure.
- **Only the payload leg bypasses the relay** — `init` / `commit` / `prepare` / `DELETE` still go over
  `/n/<nodeId>/…` (hence possibly the relay), but they are a few KB regardless of file size.
- Node↔node links likewise race DC and LAN `ws-secure` before falling back to the relay
  (`peer-dialer.ts:288-334`).

### 3.6 Existing size limits in `apps/gateway` (for reference)

`config.transferMaxBytes` 2 GiB (`config.ts:308`); `UPLOAD_CHUNK_SIZE` 8 MiB
(`file-transfer-routes.ts:33`); `JSON_BODY_MAX_BYTES` 1 MiB and `readBodyCapped`
(`/Users/konata/code/tmex-r32/packages/shared/src/http/read-body.ts:1`, `:34-66`);
`MAX_TEXT_BYTES` 2 MiB / `RAW_MAX_BYTES` 50 MiB (`files/categorize.ts:5`, `files/device-storage.ts:30`);
`STREAM_QUEUE_MAX_FRAMES` 256 / `STREAM_QUEUE_MAX_BYTES` 4 MiB
(`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/mesh-deps.ts:29-30`, WS forward only);
mux `MAX_FRAME_PAYLOAD` 1 MiB / `MAX_DATA_SEND_PAYLOAD` 256 KiB / `INITIAL_STREAM_WINDOW` 1 MiB
(`/Users/konata/code/tmex-r32/packages/shared/src/link/types.ts:2-7`);
`Bun.serve` sets `idleTimeout: 255` and **no** `maxRequestBodySize`
(`/Users/konata/code/tmex-r32/apps/gateway/src/index.ts:16-29`, so Bun's 128 MB default applies).

**There is no per-request or per-stream maximum byte cap anywhere in the mesh/relay layer today.**

---

## 4. Relay management UI (`设置 → 中继管理`)

Tab gating: `/Users/konata/code/tmex-r32/apps/fe/src/pages/SettingsPage.tsx:99` (`OPTIONAL_SETTINGS_TABS = ['relay']`),
`:125-152` (inserted right after `nodes` when the probe succeeds).

`/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/relay/`:

| File | Lines | Role |
|---|---|---|
| `relay-tab.tsx` | 264 | shell; `RelayTabHeader` (`:82`, refresh + `RelayAdminMenu`), `RelayTabBody` (`:124`, sole owner of `useRelayMetrics`), `RelayTabDialogs` (`:173`) |
| `use-relay-controller.ts` | 162 | all mutable state + write paths (`submitDefaultQuota` `:81`, `submitTenant` `:89`, kick/remove) |
| `relay-status-store.ts` | 197 | `useRelayAdmin` — polls `GET /api/relay/status`, 404⇒role absent, 401⇒unauthenticated |
| `relay-metrics-store.ts` | 188 | `useRelayMetrics` — 5 s poll of `GET /api/relay/metrics` |
| `relay-forms.ts` | 150 | **quota draft model**: `QuotaDraft{maxNodes,maxStreams,bandwidthKb,unlimited}` `:18`, `parseQuotaDraft` `:60`, `quotaEquals` `:80`, `TenantDraft` `:92`, password draft `:128` |
| `quota-fields.tsx` | 99 | **the shared quota field group** used by both the default-quota dialog and the tenant editor |
| `default-quota-dialog.tsx` | 126 | operator default quota (`PATCH /api/relay/config`) |
| `tenant-editor-dialog.tsx` | 159 | per-tenant label + quota override (`inherit` switch) |
| `relay-menus.tsx` | 93 | `RelayAdminMenu` (header ⋯ → change password), `TenantsMenu` (tenant card ⋯ → default quota) |
| `tenants-card.tsx` / `tenant-table.tsx` | 70 / 341 | tenant table incl. `TenantQuotaCell` (`tenant-table.tsx:174-190`) |
| `members-card.tsx`, `relay-metrics-*.tsx` | — | member table, 12 stat tiles (`relay-metrics-tiles.tsx`, grouped `traffic` / `process` at `:378-395`), trends |
| `relay-format.ts` | 151 | `bandwidthText` `:51`, `bytesToKb`/`kbToBytes` `:56-62`, `quotaSummary` `:71`, `trafficText`, metric formatters |

API client: `/Users/konata/code/tmex-r32/packages/api-client/src/relay/admin-api.ts`
(`RelayQuota` `:23`, `RELAY_QUOTA_LIMITS` `:33`, `RelayConfigSummary` `:40`, `RelayTenantSummary` `:48`,
`RelayTotals` `:66`, `updateDefaultQuota` `:195`, `updateTenant` `:203`).

Tenant-facing view of the quota (the "what the relay allows me" panel):
`/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/connection-details.tsx` +
`/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/relay/relay-quota.ts` (`relayQuotaRows`, 3 rows
with `used / max` and a progress bar; bandwidth "不限" when null).

Operator's own-machine card (`relay,node`): `/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/relay-service-section.tsx`
fed by `RelayRuntime.snapshotForLocalStatus()` (`relay-runtime.ts:255-275`, injected at `assemble-relay.ts:63`).

**Where new operator settings belong** (see §8 for the full proposal):

- relay-global limits (`maxTenants`, `totalBandwidthBytesPerSec`, fair-share toggle) → `relay_config` +
  `PATCH /api/relay/config` + a new "中继限额" dialog reachable from `RelayAdminMenu` (header ⋯),
  next to "修改接入密码".
- per-tenant `maxFileBytes` → `RelayQuota` (so it rides `quota_json` / `default_quota_json`,
  `PATCH /api/relay/tenants/:id`, and the `relay.quota` push), rendered as a 4th field inside
  `quota-fields.tsx` — which automatically gives both the default-quota dialog and the tenant editor the field.

---

## 5. i18n conventions

- Sources (hand-edited): `/Users/konata/code/tmex-r32/packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`,
  each wrapped in a single top-level `"translation"` object; locale list in `locales/manifest.json` (3 locales,
  `en_US` default).
- Generated (**never lint/format, never hand-edit**): `packages/shared/src/i18n/resources.ts`,
  `packages/shared/src/i18n/types.ts`, `packages/shared/src/i18n/locales/generated/*.{core,rest}.json`.
- Build: root `bun run build:i18n` → `packages/shared/scripts/build-i18n.ts`. Must be re-run after every key
  edit; `locale-consistency.test.ts` fails otherwise (identical key sets across locales `:34`, non-empty values
  `:47`, `resources.ts` deep-equals sources `:65`, generated split matches `:72`).
- `relay.*` namespace ranges: `en_US.json:2943-3273`, `zh_CN.json:2937-3267`, `ja_JP.json:2937-3267`.
  Three children only: `relay.metrics` (69 leaves), `relay.tenant` (101), `relay.admin` (105).
  Quota keys live at `relay.admin.quota.*` (`en_US.json:3205-3222`):
  `title, menuItem, description, maxNodes, maxStreams, bandwidth, unlimited, unlimitedValue, inherit,
  inheritBadge, summary, bandwidthValue, invalidNodes, invalidStreams, invalidBandwidth, saved, failed`.
  Tenant-side error keys are SCREAMING_SNAKE server codes under `relay.tenant.errors.*`
  (e.g. `RELAY_QUOTA_NODES`) — a new `RELAY_QUOTA_TENANTS` / `RELAY_QUOTA_FILE_SIZE` code needs a leaf there.
  Tenant-side quota labels also exist outside the namespace at `nodes.machine.details.quota*`
  (`en_US.json:2149-2154`).
- `relay.*` is **not** in `I18N_CORE_KEY_PREFIXES` (`packages/shared/src/i18n/core-keys.ts:8-28`), so it ships in
  the lazily loaded `rest` bundle — no bundle-budget concern.
- Interpolation is i18next `{{name}}`.

---

## 6. Tests that must stay green + how to run them

### 6.1 Relay unit tests — `/Users/konata/code/tmex-r32/apps/gateway/src/relay/`

| File | What it pins |
|---|---|
| `relay-units.test.ts` (305) | `describe('relay quota')` `:55` — normalize/reject `:56`, JSON round-trip `:76`, and **all `RelayTokenBucket` behaviour**: delay-not-drop `:85`, round-robin across streams `:102`, ≤4 KiB bypass `:125`, small frames cannot starve a queued bulk stream `:154`, close rejects queued take `:180`, unlimited never sleeps `:200`. **Fair-share work lands here.** |
| `relay-metrics.test.ts` (431) | collector rates, retired links, wrap-around, `tenants.quota` = effective quota + `usage` (exact JSON at `:290-300`, `:401-423`) |
| `relay-routes.test.ts` (526) | enroll/redeem HTTP; node quota at redeem `:303`; quota push after HTTP redeem `:214` |
| `relay-admin.test.ts` (317) | admin auth; status merge; **`PATCH /api/relay/config` default quota + push `:183`, `RELAY_BAD_QUOTA` `:201`, per-tenant quota/label `:211`**; `RELAY_DEFAULT_QUOTA` literal asserted at `:124` |
| `relay-uplink.test.ts` (795) | `auth.ok` + quota push `:40`, usage push after a metrics sample `:64`, fingerprint cleanup `:86`, **byte relay + metering `:524`, concurrent stream quota `:625`** |
| `relay-stream-router.test.ts` (165) | half-close / reset semantics with a real `RelayTokenBucket` + `RelayMetering` |
| `relay-hardening.test.ts` (287) | enrollment caps; **`relay stream quota` `:189` (reserve-before-await), `relay list capacity` `:249` (maxNodes capped by list capacity `:271`)** |
| `relay-registry.test.ts` (112) | per-member stream counters `:99` |
| `relay-enroll-create.test.ts`, `relay-enroll-limiter.test.ts`, `relay-member.test.ts`, `relay-runtime.test.ts`, `hub-relay-pump.test.ts` | supporting |

### 6.2 In-process integration (no ports, no docker)

`/Users/konata/code/tmex-r32/apps/gateway/src/relay/integration/`:
`relay.integration.test.ts` (359), `relay-membership.integration.test.ts` (276 — **`describe('relay quotas')` `:156`:
node quota at redeem `:157`, over-quota relay stream RST `:219**`), `relay-password-join.integration.test.ts` (253).

Harness: `relay-test-harness.ts:107` `bootRelayHarness()` (in-memory sqlite + fake clock + `sleep` stubbed to
resolve immediately — **so bandwidth throttling is not time-real there**; token-bucket tests inject their own
`now`/`sleep`), `relay-test-tenant.ts` (454, keys/certs/in-memory link pairs),
`integration/relay-mesh-harness.ts:74` (monkey-patches `globalThis.fetch` for `relay.example`, real
`createMeshRuntime()` nodes), `integration/relay-tenant-ops.ts` (435).

These are named `*.integration.test.ts`, so plain `bun test` **does** discover them (AGENTS.md only exempts
`*.integration.ts` without `.test.`).

### 6.3 Frontend / client / CLI tests that mirror the quota contract

- `/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/relay/relay-forms.test.ts:153` — hard-codes the server
  limits; `relay-format.test.ts:97` (`quotaSummary`); `relay-mgmt-ui.test.tsx:76` (default-quota dialog body);
  `relay-tab.test.tsx`; `relay-metrics-ui.test.tsx`.
- `/Users/konata/code/tmex-r32/apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx:192` — `describe('三档配额')`
  (usage rows, unlimited, clamping). Adding a 4th quota row touches this.
- `/Users/konata/code/tmex-r32/packages/shared/src/relay/codec.test.ts:105,:128,:254` — `relay.quota` back-compat.
- `/Users/konata/code/tmex-r32/packages/api-client/src/relay/admin-api.test.ts:139,:149`.
- `/Users/konata/code/tmex-r32/packages/app/src/commands/relay-shared.test.ts:31` and
  `relay-admin.test.ts:214`, `/Users/konata/code/tmex-r32/packages/app/src/lib/args-relay.test.ts:47`.
- `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/relay-uplink-client.test.ts:552-605` — node-side quota+usage shape.

### 6.4 e2e

- Docker hub e2e (`/Users/konata/code/tmex-r32/scripts/hub-e2e/run.sh`, doc
  `/Users/konata/code/tmex-r32/docs/hub/2026082801-hub-docker-e2e.md`) uses "relay" to mean *hub-relayed
  transport*, **not** the relay role. No docker or Playwright coverage of the relay operator console exists today.
- Playwright: `/Users/konata/code/tmex-r32/apps/fe/playwright.config.ts` + `apps/fe/tests/` (60 specs, none relay).

### 6.5 Commands

```bash
# fastest signal for relay quota work
cd /Users/konata/code/tmex-r32/apps/gateway && bun test src/relay
cd /Users/konata/code/tmex-r32/apps/gateway && bun test src/relay/relay-units.test.ts
cd /Users/konata/code/tmex-r32/apps/gateway && bun test src/relay/integration
cd /Users/konata/code/tmex-r32/apps/gateway && bun test src/mesh

cd /Users/konata/code/tmex-r32/apps/fe      && bun run test:unit     # == bun test src/
cd /Users/konata/code/tmex-r32/packages/shared     && bun test src/relay
cd /Users/konata/code/tmex-r32/packages/api-client && bun test src/relay
cd /Users/konata/code/tmex-r32/packages/app        && bun test src

# repo-wide
cd /Users/konata/code/tmex-r32 && bun run test:unit     # scripts/ci/unit-tests.ts (per-dir processes, retries)
cd /Users/konata/code/tmex-r32 && bun run lint          # biome check . && bun scripts/complexity/gate.ts
cd /Users/konata/code/tmex-r32 && bunx tsc --noEmit -p tsconfig.json   # no `typecheck` script exists
cd /Users/konata/code/tmex-r32 && bun run build:i18n    # after any locale edit
```

Caution: root `bun run test` runs **Playwright** for `apps/fe`. Use `test:unit`.

---

## 7. Complexity / size gate budget

- Gate: `/Users/konata/code/tmex-r32/scripts/complexity/gate.ts`; allowlist:
  `/Users/konata/code/tmex-r32/scripts/complexity/allowlist.json` (165 entries).
- Limits (`gate.ts:13`): **cyclomatic complexity ≤ 15 per function, ≤ 120 lines per function, ≤ 600 lines per
  file**. Files >540 lines that are not allowlisted emit a non-fatal warning (`WARN_RATIO = 0.9`, `gate.ts:16`).
- Scope: `apps/` + `packages/`; skips `*.test.*`, `*.spec.*`, `*.integration.*`, `*.d.ts`, `i18n/resources.ts`,
  `i18n/types.ts`, `/vendor/`, `/tests/`, plus `node_modules`, `dist`, `fe-dist`, `resources`, `docs`, `scripts`.
- Allowlist entry = `"<relpath>"` or `"<relpath>:<fn>"` → `{ cc?, lines?, fileLines?, reason }` with a required
  Chinese `reason`. It is a **ratchet**: the entry raises the limit to exactly the recorded value, and a stale
  entry (matching nothing) is a hard failure (`gate.ts:161`, `:217`). `--report` ranks the top-30 CC;
  `--tighten` lowers entries to current values.
- Runs inside `bun run lint` (`package.json:23`) and in CI (`.github/workflows/ci.yml:22-23`).
- Biome (`/Users/konata/code/tmex-r32/biome.json`) is `recommended: true` with only `noExplicitAny: off`;
  no cognitive-complexity rule — all size enforcement is `gate.ts`.

**Current headroom of the files this work touches** (none of these are allowlisted, so the 600/120/15 defaults apply):

| File | Lines now | Headroom to 600 |
|---|---|---|
| `apps/gateway/src/relay/relay-quota.ts` | 296 | 304 |
| `apps/gateway/src/relay/relay-uplink-server.ts` | 571 | **29** (already in warn band) |
| `apps/gateway/src/relay/relay-metrics.ts` | 586 | **14** (warn band) |
| `apps/gateway/src/relay/relay-stream-router.ts` | 196 | 404 |
| `apps/gateway/src/relay/relay-admin-routes.ts` | 171 | 429 |
| `apps/gateway/src/relay/relay-routes.ts` | 349 | 251 |
| `apps/gateway/src/relay/relay-tenant-store.ts` | 444 | 156 |
| `apps/gateway/src/relay/relay-metering.ts` | 142 | 458 |
| `packages/shared/src/relay/codec.ts` | 563 | **37** (warn band) |
| `packages/api-client/src/relay/admin-api.ts` | 221 | 379 |
| `apps/fe/src/pages/settings/relay/relay-forms.ts` | 150 | 450 |
| `apps/fe/src/pages/settings/relay/quota-fields.tsx` | 99 | 501 |

⚠ `relay-uplink-server.ts`, `relay-metrics.ts` and `packages/shared/src/relay/codec.ts` are each within ~40 lines
of the cap. Plan on **extracting new logic into new files** (e.g. `relay-bandwidth.ts`, `relay-limits.ts`,
`relay-limits-store.ts`) rather than growing these three. Under `apps/fe/src/pages/settings/nodes/relay/` and
`.../settings/relay/` nothing is allowlisted either — new UI must stay under the defaults.

---

## 8. Recommended insertion points

### (b) Max tenant count — smallest, do it first

1. **Storage.** New migration `apps/gateway/drizzle/0049_relay_limits.sql` adding nullable columns to
   `relay_config`: `max_tenants integer`, `total_bandwidth_bytes_per_sec integer`, `fair_share integer NOT NULL DEFAULT 1`
   (null = unlimited). Schema: `/Users/konata/code/tmex-r32/apps/gateway/src/db/schema/relay.ts:4-16`.
   Migration test modelled on `apps/gateway/src/db/relay-pack-updated-at.migration.test.ts`.
   *Rationale for columns over widening `default_quota_json`:* `defaultQuota` has per-tenant semantics and is
   pushed verbatim to tenants via `relay.quota`; relay-global limits must not leak into that frame.
2. **Store.** Extend `RelayConfigRecord` and `read()/ensure()` in
   `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-config-store.ts:7-60`, add `setLimits(...)` next to
   `setDefaultQuota` (`:70`). Parsing/validation of the new limits goes in a **new** `relay-limits.ts`
   (mirror the shape of `relay-quota.ts`: strict `normalizeRelayLimits()` → `400 RELAY_BAD_QUOTA` or a new
   `RELAY_BAD_LIMITS` code in `relay-http.ts:1-30`).
3. **Enforcement.** One check in `issueTenantToken`
   (`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-routes.ts:104-129`), on the `!existing` branch only —
   re-enroll of an existing root public key must keep working even when full:

   ```
   if (!existing && maxTenants !== null && deps.tenants.count() >= maxTenants)
       return relayError(RelayErrorCode.quotaTenants, 409);   // new code RELAY_QUOTA_TENANTS
   ```

   `tenants.count()` already exists (`relay-tenant-store.ts:89`). Do the check inside `handleRelayEnroll`
   (`relay-routes.ts:164-168`, after password verification, before `issueTenantToken`) so a wrong password still
   fails first and a full relay does not become a tenant-enumeration oracle.
4. **Surface.** `GET /api/relay/status` `config` block (`relay-admin-routes.ts:61-67`) gains `limits`;
   `PATCH /api/relay/config` (`:107-120`) accepts `{ limits }` alongside `{ defaultQuota }`.
   `GET /api/relay/health` (`relay-routes.ts:335-348`) already returns `tenants` — do **not** add `maxTenants`
   there (unauthenticated).
5. **Client + UI + CLI.** `packages/api-client/src/relay/admin-api.ts` (`RelayConfigSummary`, new
   `updateLimits()`), new `relay-limits-dialog.tsx` under `apps/fe/src/pages/settings/relay/` reachable from
   `RelayAdminMenu` (`relay-menus.tsx:61-71`), plus a `tmex relay limits` subcommand next to `relay quota`
   (`packages/app/src/commands/relay-admin.ts:358-378`, help at `packages/app/src/cli/help.ts:35` **and** `:79`).
6. **i18n.** `relay.admin.limits.*` (title/menuItem/maxTenants/…​) and
   `relay.tenant.errors.RELAY_QUOTA_TENANTS`, in all three locales, then `bun run build:i18n`.

### (c) + (d) Global bandwidth cap with inter-tenant fairness — one change, in one place

The per-tenant bucket already implements delay-not-drop + round-robin + a small-frame bypass lane. Do **not**
write a second scheduler; make it two-level.

**Design: a relay-wide parent bucket keyed by tenant.**

- New file `/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-bandwidth.ts` holding a
  `RelayBandwidthLimiter` that owns:
  - one relay-wide `RelayTokenBucket(totalBandwidthBytesPerSec)`,
  - a `Map<tenantId, RelayTokenStream>` of **one parent stream per tenant** (not per relay stream).
  Because `RelayTokenBucket.drain()` rotates grants across its ready `TokenStreamState`s at ≤4 KiB per turn
  (`relay-quota.ts:226-239`), one state per tenant yields exact **round-robin fairness between tenants** —
  which is precisely requirement (d). No new algorithm required.
- Wire it in `RelayUplinkServer`: a `globalBucket` sibling of `buckets`
  (`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-uplink-server.ts:96`, `:200-210`), rate refreshed
  from `configStore` in the same place `bucketFor` refreshes per-tenant rate, and cleared in `stop()` (`:346`).
  Extend `RelayStreamContext` (`relay-stream-router.ts:10-18`) with `globalLimiterFor(tenantId)`, injected at
  `relay-uplink-server.ts:483-495`.
- The single enforcement line, in `pumpMetered`
  (`/Users/konata/code/tmex-r32/apps/gateway/src/relay/relay-stream-router.ts:152-158`):

  ```ts
  await limiter.take(bytes.byteLength);          // per-tenant cap (existing)
  await globalLimiter.take(bytes.byteLength);    // relay-wide cap + inter-tenant fairness (new)
  ctx.metering.recordAdmitted(tenantId, bytes.byteLength);
  ```

  Order matters: per-tenant first so a tenant over its own cap does not hold a slot in the global rotation.
  Both only delay, so there is no deadlock; the mux WINDOW credits (`packages/shared/src/link/mux.ts`,
  `INITIAL_STREAM_WINDOW`) propagate the back-pressure to the sending node for free.
  `pumpRelayPair` (`:78-117`) must close the global stream handle in both `abortBoth` and `finish` exactly as it
  already closes `limiter`.
- **Fair-share toggle:** when off, keep the existing `bucketFor` path plus a plain relay-wide `take()` on the
  default stream (`RelayTokenBucket.take`, `relay-quota.ts:143`) — i.e. first-come-first-served against the
  global rate. When on, use the per-tenant parent streams. One boolean in `relay_config`.
- **Optional refinement:** weight the rotation by "tenants with traffic in the last window" so an idle tenant
  does not hold a slot. The current `drain()` already skips states with an empty `pending` list
  (`relay-quota.ts:205-209`), so idle tenants cost nothing; a weighted variant is *not* needed for v1.
- **Reporting.** `totals.bandwidthBytesPerSec` already exists (`relay-metrics.ts:349`). Add the configured
  ceiling to `RelayMetricsTotals` / `RelayMetricsResponse` (`relay-metrics.ts:24-36`,
  `packages/api-client/src/relay/metrics-types.ts:20-33`) so the console can render a "8.2 / 10 Mbit/s" tile in
  `relay-metrics-tiles.tsx` (traffic group at `:378-389`). Because `relay-metrics.ts` is 586/600 lines, put any
  new computation in `relay-bandwidth.ts` and only reference it from the collector.
- **Tests.** New cases in `relay-units.test.ts` next to `describe('relay quota')` (`:55`): two tenants sharing a
  global rate get ~50/50; a tenant under its own cap is not throttled when the relay is idle; the fair-share
  toggle changes the split. `relay-units.test.ts` already injects `now`/`sleep`, so this is deterministic.
  Add one integration case in `relay-membership.integration.test.ts` beside `describe('relay quotas')` (`:156`).
  Note the mesh harness stubs `sleep` to resolve immediately (`relay-test-harness.ts:107`), so assert on
  *admitted byte accounting*, not wall-clock timing, there.

### (a) Per-tenant max file size — the one that needs a design decision

**Hard constraint (see §2.2):** a relay stream carries a `SecureChannelLink` + `LinkMux` peer session
(`apps/gateway/src/mesh/peer-protocol.ts:439-443`). The relay sees only `{"to":"<nodeId>"}` and opaque
ciphertext. It **cannot** observe a file's size, name, or even where one logical stream ends and the next
begins. Any claim that "the relay rejects files over N bytes" must be built on one of:

**Option A — quota-declared, node-enforced (recommended for v1; smallest, matches the blind-relay model).**

1. Add `maxFileBytes: number | null` to `RelayQuota`
   (`/Users/konata/code/tmex-r32/packages/shared/src/relay/codec.ts:77-85` + parser `:512-527` +
   `packages/shared/src/relay/codec.test.ts` back-compat cases). Optional field ⇒ old nodes/relays ignore it.
2. Operator config: `relay-quota.ts` `normalizeRelayQuota`/`serializeRelayQuota` (`:30`, `:48`), a new
   `RELAY_QUOTA_MAX_FILE_BYTES` ceiling next to `:8-10`, default `null` in `types.ts:35-39`.
   It then flows for free through `quota_json` / `default_quota_json`, `PATCH /api/relay/tenants/:id`
   (`relay-admin-routes.ts:122`), `PATCH /api/relay/config` (`:107`), and the `relay.quota` push
   (`relay-uplink-server.ts:218`, `relay-quota-ctl.ts:15`).
3. Node side: `applyRelayQuota` (`apps/gateway/src/mesh/relay-uplink-ctl.ts:221-233`) already spreads the whole
   frame into `host.quota`; expose it via `GET /api/mesh/relay/status` (`apps/gateway/src/mesh/relay-routes.ts:161`)
   and `RelayQuotaView` (`packages/api-client/src/relay/tenant-api.ts:63-71`).
4. **Enforcement on the node that owns the transfer.** There is already exactly one funnel per direction, and
   both already carry the declared/actual total size:
   - upload: `handleUploadInit` — `/Users/konata/code/tmex-r32/apps/gateway/src/api/file-transfer-routes.ts:47`
     currently `size > config.transferMaxBytes` → `too_large`; make the effective cap
     `min(config.transferMaxBytes, relayQuota.maxFileBytes ?? ∞)`;
   - download: `/Users/konata/code/tmex-r32/apps/gateway/src/files/device-storage.ts:406` and `:441`
     (pre- and post-rsync `transferMaxBytes` checks) — same `min(...)`;
   - direct DataChannel bulk path already validates against the session's `expectedSize`
     (`/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/bulk.ts:224-255`, `:264-267`), so gating `init`
     covers it too.
   Wire the effective cap through a single new helper (e.g. `effectiveTransferMaxBytes()`), not by sprinkling
   `Math.min` at three sites. Scoping choice for the planner: apply it **whenever the node is a relay tenant**
   (simplest, matches the operator's mental model) or only when the peer link transport is `'relay'`
   (`PeerHandshakeResult.transport` is `'relay' | 'ws-secure' | 'dc'`,
   `apps/gateway/src/mesh/peer-protocol.ts:443-450`, `peer-dialer.ts:341-347`, `:511-527`, kept by
   `apps/gateway/src/mesh/peer-live-registry.ts`). The former is recommended: at `init` time the transport for
   the eventual bytes is not yet decided (direct is raced per dial), so a transport-scoped rule is racy.
5. UI: a 4th row in `relayQuotaRows` (`apps/fe/src/pages/settings/nodes/relay/relay-quota.ts:38-74`) and a 4th
   field in `quota-fields.tsx` (which lands in both operator dialogs at once).
   Error code `RELAY_QUOTA_FILE_SIZE` in `relay-http.ts` + `relay.tenant.errors.*`;
   the FE file panel already handles `too_large` from `init`, so reuse that copy path
   (`/Users/konata/code/tmex-r32/packages/panels/src/files/bulk-transfer.ts`).

*Honest framing for the operator copy:* this is a **policy the relay publishes and tenants enforce**, backed by
the hard bandwidth cap. A tenant running patched software could ignore it; the bandwidth quota (b/c/d) is what
actually protects the operator. Say so in the dialog hint rather than over-promising.

**Option B — dedicated bulk relay stream with a relay-enforced byte ceiling (hard enforcement, larger).**
Only viable if round 32's new file-transfer feature opens a *separate* relay stream per transfer:
extend `RelayOpenStream` (`packages/shared/src/relay/blobs.ts:14`, `:54`, `:61`, and the re-encode at
`relay-stream-router.ts:69`) with `{ class: 'bulk', bytes: N }`; the relay then (i) refuses OPEN when
`N > maxFileBytes` (`RST quota-file-size`) and (ii) counts bytes in `pumpMetered` and RSTs past
`maxFileBytes` regardless of the declared `N`, which makes lying useless for that stream. Node side already
tolerates extra OPEN fields (`apps/gateway/src/mesh/relay-uplink-client.ts:479-481` reads only `to`/`from`).
Costs: a second `SecureChannelLink` per transfer (session keys are already kept by
`peer-dialer.rememberKeys`), a new stream class in the `maxStreams` accounting, and it does **not** cover the
existing file API, which rides the shared peer session. Defer unless the new transfer feature is built on a
dedicated bulk stream anyway.

**Option C — parse the inner `SecureChannelLink` headers and cap bytes per inner mux stream. Rejected.**
Technically possible (the 10-byte `[streamId][op][flags][len]` header is plaintext AAD,
`packages/shared/src/link/secure-channel-link.ts:183-198`, `:275-301`), but:
(i) uploads are chunked into 8 MiB `PUT`s, each its own inner stream
(`apps/gateway/src/api/file-transfer-routes.ts:33`), so a per-inner-stream cap would not catch a large upload
at all — only downloads, which are one inner stream of full size;
(ii) the relay cannot tell a file stream from a long-lived terminal/agent/LLM stream, so any ceiling low enough
to matter would kill legitimate sessions;
(iii) it makes the relay depend on the inner mux framing and erodes the documented privacy boundary
(`docs/relay/2026090304-relay-role.md:50-58`, §13). Do not do this.

### Cross-cutting checklist

- Files to touch for **any** quota-shape change (they all hard-mirror the 3-field quota):
  `packages/shared/src/relay/codec.ts` → `apps/gateway/src/relay/relay-quota.ts` + `types.ts:35` →
  `relay-admin-routes.ts` → `packages/api-client/src/relay/{admin-api.ts,tenant-api.ts,metrics-types.ts}` →
  `apps/fe/src/pages/settings/relay/{relay-forms.ts,quota-fields.tsx,relay-format.ts}` →
  `apps/fe/src/pages/settings/nodes/relay/relay-quota.ts` →
  `packages/app/src/commands/{relay-admin.ts,relay-shared.ts}` + `cli/help.ts` (both language blocks) →
  the test files listed in §6.3.
- Fix while in here: `RELAY_QUOTA_LIMITS.maxNodes` 4096 vs server 256
  (`packages/api-client/src/relay/admin-api.ts:33-37` vs `apps/gateway/src/relay/relay-quota.ts:8`).
- Update `docs/relay/2026090304-relay-role.md` §6 (storage), §7 (admin routes), §8 (`relay.quota` frame),
  §11 (配额与计量) and `docs/relay/2026090403-relay-metrics.md` (new totals field) — the docs are the spec here.
- Keep `relay-uplink-server.ts`, `relay-metrics.ts` and `packages/shared/src/relay/codec.ts` under 600 lines:
  new logic goes into new modules (`relay-limits.ts`, `relay-bandwidth.ts`, `relay-limits-store.ts`).
- **Interaction with the rest of round 32.** The new machine-to-machine file transfer and the port-mapping
  tunnel both ride the same peer session, so on a relay they funnel through the *same* `pumpMetered` line —
  the (c)/(d) work covers them automatically with no extra hooks, and `maxStreams` accounting stays correct as
  long as they do not open extra relay streams. If port mapping opens one relay stream per TCP connection,
  budget for `maxStreams` pressure (default 64) and consider raising `RELAY_DEFAULT_QUOTA.maxStreams` or
  multiplexing port-forward connections inside the existing peer session (preferred — it is already a mux).
- The relay-side `maxFileBytes` in Option A does **not** apply to port forwarding (no declared size); the
  bandwidth quota is the only control there. Say so in the docs so the operator is not surprised.
