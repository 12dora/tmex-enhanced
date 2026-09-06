# EX2 — File transfer subsystem: existing code map & recommended architecture

Repo: `/Users/konata/code/tmex-r32` (branch `feat/round32-relay-quota-transfer-portmap`, clean apart from the untracked `prompt-archives/2026090604-round32-relay-quota-transfer-portmap/`). **No round-32 code exists yet.**

Scope of this report: everything the planner needs to build (a) a two-pane node-to-node file transfer dialog and (b) a single shared, chunked / multi-stream / resumable transfer engine that browser↔node upload/download, node↔node transfer and upgrade push all sit on.

---

## 1. The existing file feature (browser ↔ node)

### 1.1 Server: routes

All file routes are aggregated in `/Users/konata/code/tmex-r32/apps/gateway/src/api/files.ts` (19 lines) and registered in the flat route table at `/Users/konata/code/tmex-r32/apps/gateway/src/api/index.ts:39` (`...filesRoutes`).

| Endpoint | File:line | Notes |
|---|---|---|
| `GET /api/files/roots`, `POST /api/files/roots`, `PATCH/DELETE /api/files/roots/:id`, `POST /api/files/roots/order` | `apps/gateway/src/api/file-root-routes.ts` (155 lines) | file-root CRUD (whitelisted `(deviceId, absolute path)` pairs) |
| `GET /api/files/browse?deviceId=&path=&hidden=` | `apps/gateway/src/api/file-browser-routes.ts:8,72` | **directories only**, not restricted by roots — used by the directory picker |
| `GET /api/files/list?rootId=&path=` | `file-browser-routes.ts:18,75` | root-scoped listing (files + dirs), capped at `MAX_ENTRIES` |
| `GET /api/files/content`, `GET /api/files/stat`, `GET /api/files/raw` | `file-browser-routes.ts:27,36,45` | text read / stat / inline raw (≤50 MB, `RAW_MAX_BYTES` at `device-storage.ts:30`) |
| `POST /api/files/upload/init` | `apps/gateway/src/api/file-transfer-routes.ts:35,213` | validates destDir is an existing dir + `size ≤ transferMaxBytes` + name sanitation; returns `{uploadId, chunkSize}` |
| `PUT /api/files/upload/:id?offset=N` | `file-transfer-routes.ts:58,223` | **strictly sequential** append (`offset !== session.received` → 409) |
| `POST /api/files/upload/:id/commit` | `file-transfer-routes.ts:87,218` | NDJSON stream of rsync push progress |
| `DELETE /api/files/upload/:id` | `file-transfer-routes.ts:115,229` | cancel + cleanup |
| `POST /api/files/download/prepare` | `file-transfer-routes.ts:120,198` | NDJSON stream of the rsync pull; ends with `{type:'done', downloadId, size, name}` |
| `GET /api/files/download/:id/content` | `file-transfer-routes.ts:158,203` | streams the temp file |
| `DELETE /api/files/download/:id` | `file-transfer-routes.ts:169,208` | cancel |
| `GET /api/files/download?rootId=&path=` | `file-transfer-routes.ts:174,193` | one-shot browser-native download (drag-to-desktop) |

**There is no mkdir / delete / rename / move endpoint anywhere.** The file subsystem today is read + upload + download only. (Verified by enumerating every `/api/files…` string literal in the repo.)

### 1.2 Server: chunked upload protocol constants

- `UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024` — `apps/gateway/src/api/file-transfer-routes.ts:33`
- `config.transferMaxBytes` default 2 GiB — `apps/gateway/src/config.ts:308` (`TMEX_TRANSFER_MAX_BYTES`), exposed to the browser as `SystemInfo.transferMaxBytes` (`packages/shared/src/contracts/system.ts:26`)
- Contracts: `UploadInitRequest`, `UploadInitResponse`, `UploadCommitEvent` — `packages/shared/src/contracts/files.ts:127-142`
- `Bun.serve({ idleTimeout: 255 })` — `apps/gateway/src/index.ts:21` (the NDJSON prepare stream exists partly to keep the socket non-idle)

### 1.3 Server: session state (in memory only)

`/Users/konata/code/tmex-r32/apps/gateway/src/files/transfer-session.ts` (262 lines) — **all transfer state is process memory; nothing is persisted to SQLite.**

- `UploadSession` (`:8-24`): `{id, rootId, destDir, name, size, received, tmpDir, tmpPath, abort, createdAt, committing}`; temp dir `mkdtempSync(tmpdir(), 'tmex-up-')` (`:87`), single file `f`.
- `DownloadSession` (`:30-38`): `{id, tmpPath, size, name, mime, cleanup, createdAt}`; temp dir prefix `tmex-dl-` (created in `pullFileFromDevice`, `device-storage.ts:409`).
- Append is serialized per session with a promise chain (`enqueueSessionOp`, `:136-148`) and writes with `fsPromises.open(tmpPath, 'a')` + a truncate-back-to-`committed` rollback on partial write (`persistChunk`, `:150-177`).
- Three-layer cleanup: explicit (`removeUploadSession`, `:215`), periodic GC every 5 min for sessions older than `SESSION_TTL_MS = 30 min` (`:27,234`), and a boot-time orphan sweep `sweepOrphanTransferTemps()` for `tmex-up-*` / `tmex-dl-*` older than 1 h (`:238-261`).
- Ownership binding: `apps/gateway/src/api/file-transfer-sessions.ts:10,29` keeps `transferId → uid` so the WebRTC bulk channel can check `owner.uid !== ch.uid`.

### 1.4 Server: the actual bytes — rsync, per device

`/Users/konata/code/tmex-r32/apps/gateway/src/files/device-storage.ts` (447 lines).

- `resolveContext(rootId)` (`:99`) → `file_roots` row → `devices` row. A "machine" in the file UI is therefore a **(node, fileRoot) pair**, and the root's device may be `local` **or** an `ssh` device hanging off that node.
- Path safety `checkAndNormalize` (`:62-93`): path must stay inside the root; for `local` devices an extra `realpathSync` symlink-escape check.
- `pushFileToDevice(rootId, destDir, srcPath, name, {signal, onProgress})` (`:354-386`) — reverse rsync from a local temp file to the device.
- `pullFileFromDevice(rootId, inputPath, {signal, onProgress})` (`:397-447`) — forward rsync into `tmex-dl-*/f`, then the HTTP layer streams that temp file.
- `sanitizeUploadName` (`:340-345`) — last path segment only; rejects ``, `.`, `..`, `/`, `\`, NUL.
- `TRANSFER_IDLE_TIMEOUT_MS = 120_000` (`:33`) — idle timeout, reset on progress.

rsync argv builders — `/Users/konata/code/tmex-r32/apps/gateway/src/files/ssh-command.ts`:
- `rsyncListArgs` `:159`, `rsyncCopyArgs` `:166` (`-L --progress`), `rsyncUploadArgs` `:176` (`--progress`, no `-L`).
- **No `-r` / `-a` anywhere → single-file only. Directory (folder) transfer does not exist and is net-new work.**

Progress parsing + idle-timeout process runner — `/Users/konata/code/tmex-r32/apps/gateway/src/files/rsync.ts`: `parseRsyncProgress` `:25`, `runRsync` `:118`, `classifyRsyncFailure` `:463`.

Concurrency — `/Users/konata/code/tmex-r32/apps/gateway/src/files/queue.ts`: `enqueueDeviceJob` (`:30`) serializes **all** rsync work per `deviceId` and caps global concurrency at `GLOBAL_MAX_CONCURRENT = 4` (`:4`). Every file op goes through it via `withDeviceRsync` (`apps/gateway/src/files/rsync-operation.ts:25-46`).

> ⚠️ **Planner-critical**: because of `enqueueDeviceJob`, N parallel byte streams against the same device will serialize at the rsync layer. Multi-stream throughput only materializes if the engine (a) reads/writes local-device files directly with ranged `Bun.file().slice()` instead of spawning rsync, or (b) opens N rsync jobs against *different* devices. Also note that for a `local` device today a download costs a **full extra copy** of the file into `$TMPDIR` before a single byte reaches the client.

### 1.5 Client: the two-leg transfer protocol

`packages/api-client/src/transfer-types.ts` (18 lines) is the whole progress contract:

```ts
export interface LegProgress { pct: number; rate?: string; detail?: string }
export type OnLeg = (leg: 1 | 2, p: LegProgress) => void;
export interface TransferOpts { onLeg?: OnLeg; signal?: AbortSignal }
```

- `uploadFileChunked(rootId, destDir, file, opts, client)` — `packages/api-client/src/upload-transfer.ts:12-91`. init → sequential `PUT` of `file.slice(offset, end)` (`:44-48`) → `commit` NDJSON. leg1 progress is computed client-side; leg2 comes from the rsync stream. `catch` always fires a best-effort `DELETE`.
- `downloadFileWithProgress(...)` — `packages/api-client/src/download-transfer.ts:37-91`; `prepareDownload(...)` (leg1, reusable) at `:96-140`. leg2 accumulates `Uint8Array` chunks into a `Blob` in page memory.
- `readNdjsonStream<T>` — `packages/api-client/src/ndjson-stream.ts` (23 lines), shared by commit and prepare.
- Byte/rate formatting is already shared: `formatBytes` / `formatRate` / `formatBytesPair` in `packages/shared/src/format-bytes.ts` (re-exported by `packages/api-client/src/format.ts`). **There is no ETA helper** — a transfer list needs one.

### 1.6 Client: where transfer state lives → **nowhere durable**

It is **client-only, per-call, and lives inside a sonner toast**. There is no transfer store, no list, no persistence, and no server-side registry of "transfers in flight" beyond the upload/download session maps.

- `startTransferToast(fileName, direction, onCancel)` — `packages/panels/src/files/transfer-toast.tsx:83-151`. Returns `{leg, setPath, success, fail, cancel}`; renders two `<Progress>` bars (leg1/leg2) + a `direct`/`relay` badge; working state is `duration: Infinity, dismissible: false, closeButton: false` so the only way out is the action button; render is throttled to 100 ms except at 100 % (`:119-123`).
- Upload entry point: `packages/panels/src/files/use-directory-upload.ts:52-83` — loops files **sequentially**, one `AbortController` + one toast each.
- Download entry point: `packages/panels/src/files/file-node-actions.tsx:30-51` — then `runtime.host.saveFile({name, blob})`.
- Cancel = `AbortController.abort()`; there is no server-driven cancel and no resume after a page reload.

> The round-32 "transfer list below the dialog (speed, size, progress)" has **no existing home**. It needs a new store; `transfer-toast.tsx` is only a rendering precedent, not a state model.

### 1.7 The direct (WebRTC) fast path already in place

`/Users/konata/code/tmex-r32/packages/panels/src/files/bulk-transfer.ts` (322 lines) is the dispatcher that the file panel actually calls:

- `uploadFileWithTransport(nodeId, rootId, destDir, file, opts, client, deps)` `:116-139`
- `downloadFileWithTransport(nodeId, rootId, path, name, opts, client, deps)` `:240-269`
- `TransferPath = 'direct' | 'relay'` `:36`; `pickBulk()` `:94-104` refuses `self` and requires `client.isAvailable()`.
- Fallback rules are documented at `:10-14`: any failure **before commit** rewinds the session (`DELETE`) and re-runs the whole transfer over REST; **once commit starts there is no fallback** (would write the file twice); user `AbortError` always propagates.
- Byte-count paranoia on both directions (`:188-189`, `:304-311`) — a size mismatch is treated as a bulk failure.

Wire protocol (browser side) — `/Users/konata/code/tmex-r32/packages/ws-client/src/direct/bulk-client.ts` (600 lines), header comment `:1-15`:
```
upload:   {op:'put', transferId, size} → 64 KiB binary frames → {op:'done'} → {ok:true} | {ok:false, code}
download: {op:'get'}                   → 64 KiB binary frames → {op:'eof'}  | {ok:false, code}
abort:    {op:'abort'}
```
one `bulk:<transferId>` DataChannel per transfer, `BULK_FRAME_SIZE = 64 KiB` (`:24`), open timeout 15 s (`:25`), idle timeout 30 s (`:31`), high/low water 4 MiB / 1 MiB (`DC_HIGH_WATER_BYTES` / `DC_LOW_WATER_BYTES`). `iterateBulkFrames()` (`:124-153`) slices a `Blob` **or** drains a `ReadableStream` into exact-size frames. Per-node registry: `registerBulkClient` / `getBulkClient` / `clearBulkClients` (`:586-600`), populated by `apps/fe/src/node/node-runtimes.ts`.

Node side — `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/rtc/bulk.ts` (455 lines), `class BulkTransferService`:
- `BULK_FRAME_SIZE = 16 KiB` (`:7`), `BULK_MAX_RECEIVED_FRAME_SIZE = 64 KiB` (`:8`), `BULK_IDLE_TIMEOUT_MS = 30_000` (`:9`), `BULK_UPLOAD_QUEUE_BUDGET_BYTES = 8 MiB` (`:11`).
- State machine `idle | put | get | done | eof | aborted` (`:13`); auth via `owner.uid !== ch.uid` (`:239`, `:300`) plus a re-checkable `verify()` (`:162`, `:358`).
- Backpressure: write queue budget with a `backpressure` failure (`:186-189`), and `waitDrain()` / `onBufferedAmountLow` for the download direction (`:377-389`).
- It talks to the REST session store through the narrow `FilesBulkHooks` interface — `apps/gateway/src/api/file-transfer-sessions.ts:19-27`, implemented at `:95-100` (`getTransferOwner` / `openDownload` / `appendUpload` / `abortTransfer`).

`FilesBulkHooks` is exactly the seam a shared transfer engine should keep and widen.

---

## 2. Reaching a remote node's file API, and node↔node byte streams

### 2.1 `/n/<nodeId>/api/files/...` — browser → entry → target node

- URL construction is centralized in `/Users/konata/code/tmex-r32/packages/api-client/src/node-url.ts`: `SELF_NODE_ID = 'self'` (`:7`), `NODE_ID_PATTERN = /^[0-9a-f]{32}$/` (`:10`), `assertNodeId` (`:37-42`, deliberately rejects `..`/`%2e%2e`), `nodePathPrefix` (`:50`), `createNodeApiClient(nodeId)` (`:161-163`) → `new ApiClient('/n/<id>')`.
- Entry-side dispatch: `Forwarder.handle` → `parseNodePrefix` (`apps/gateway/src/mesh/forwarder-path.ts`) → `forwardHttp` (`apps/gateway/src/mesh/forwarder.ts:616-655`). The node session cookie is picked out per-node: `parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId))` (`forwarder.ts:314`) and passed as the stream's `auth` field.
- Transport: `this.deps.streams.openHttpStream(link, {method, path, query, headers, origin, auth}, body, abort)` — implemented at `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/stream-targets.ts:270-395`.

### 2.2 `openHttpStream` — a real bidirectional streaming HTTP-over-mux primitive

`stream-targets.ts:270` opens a **new mux stream** on the peer `LinkSession`, pumps the request body into it (`pumpToLink`, `:305`), reads a JSON head frame, then exposes the response body as a `ReadableStream` (`:355-390`) with a truncation check against `content-length` (`:377-381`). Inbound side is `acceptHttpStream` (`:145-238`): it rebuilds a `Request` whose body is a pull-based stream over the link (`requestBodyFromLink`, `:108-144`) and dispatches it into the node's own router.

**Both directions stream. Nothing is buffered end-to-end.** This is the single most important primitive for round 32.

### 2.3 The mux and its flow control (why multi-stream matters)

`/Users/konata/code/tmex-r32/packages/shared/src/link/types.ts`:
- `MAX_FRAME_PAYLOAD = 1 MiB` (`:2`), `MAX_DATA_SEND_PAYLOAD = 256 KiB` (`:4`)
- **`INITIAL_STREAM_WINDOW = 1 MiB` (`:5`)** — per-stream credit window; `MAX_LINK_UNACKED = 65 × window` (`:7`)
- `LinkStream` (`:50-67`): `readable` is pull-based with `highWaterMark = 0`, so WINDOW credits are only issued when the application reads (`:53-57`).
- `LinkSession.openStream(openPayload)` (`:74-81`) — any number of concurrent streams.
- Implementation: `packages/shared/src/link/mux.ts` (`streamWindow` `:411`, `sendWindowCredit` `:527`, `creditSendWindow` `:179`).

> **A single stream is capped at 1 MiB in flight.** Over a relay with, say, 60 ms RTT that is ~17 MB/s ceiling regardless of bandwidth. Parallel streams are the intended scaling knob — and they map directly onto the relay quota's `maxStreams`.

Carriers under the mux: `WebSocketLink` (`packages/shared/src/link/websocket-link.ts`, `SERVER_WS_BACKPRESSURE_LIMIT = 1 MiB` `:28`), `DataChannelLink` (`apps/gateway/src/mesh/rtc/data-channel-link.ts`), `SecureChannelLink` (relay path, `packages/shared/src/link/secure-channel-link.ts`), `in-memory-link.ts` (hub-in-same-process).

### 2.4 Peer links exist between *any two* trusted nodes

`PeerManager.getLink(nodeId)` — `/Users/konata/code/tmex-r32/apps/gateway/src/mesh/peer-manager.ts:427-455`. It checks `requireTrusted(nodeId)`, reuses a live session, else dials. Transport preference is ranked in `apps/gateway/src/mesh/peer-manager-state.ts:30` (`PEER_TRANSPORT_RANK`) and dialed in `apps/gateway/src/mesh/peer-dialer.ts:277-360`: WebRTC `dc` → `ws-secure` / direct → **`relay`** (through the hub/relay, `:339-349`, wrapped in `SecureChannel` so the relay only moves ciphertext).

**So node A can open a streaming HTTP request to node B directly, and it works identically in hub mode and relay mode** — the relay leg is just a different carrier under the same `LinkSession`. Reference: `docs/hub/2026082700-hub-node-architecture.md:73-83`.

### 2.5 Node → node call paths that already exist

**(a) `forwardAuthorizedHttp` — user-credentialed, supports a raw streaming body + progress.** `apps/gateway/src/mesh/forwarder.ts:271-350`:

```ts
async forwardAuthorizedHttp(req, input: {
  nodeId; method; path; query?; body?; rawBody?: ReadableStream<Uint8Array>;
  headers?; signal?; retry?: { attempts: number };
  onProgress?: (uploadedBytes: number) => void;
}, signal?): Promise<Response>
```
- `rawBody` is byte-counted through `countStreamBytes` (`:918-930`) with a throttled `onProgress` (`:906-916`).
- `attempts = rawBody ? 1 : forwardAttempts(...)` (`:309`) — a raw stream can only be read once, so resume must be driven by the caller re-opening at an offset.
- Auth comes from the **incoming browser request's** cookie for the target node (`:301-305`), returning `NODE_LOGIN_REQUIRED` 401 if absent.

**(b) `forwardInternalHttp` — peer-credentialed, JSON body only.** `forwarder.ts:236-268`. Builds a one-shot `ReadableStream` from a JSON payload and opens the stream with `auth: null`.

**(c) `/api/mesh-internal/*` — the peer-only RPC surface.**
- Auth is *skipped* for this prefix: `isAuthSkippedPath` — `apps/gateway/src/mesh/stream-auth.ts:44-47`.
- It is instead gated on the peer marker header `x-tmex-mesh-peer` — `apps/gateway/src/mesh/peer-request-marker.ts:3-19`; `acceptHttpStream` stamps it with the verified peer node id (`stream-targets.ts:159-162`) and it is in `BLOCKED_REQUEST_HEADERS` (`stream-targets.ts:25-32`) so it can never be spoofed from outside.
- Entry point + `requirePeerMarker` gate: `apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:41-46,186-205`; route table composed at `:195`. Existing consumers: tmux RPC (`.../tmux/pane-info|capture|send-input`, `:168-183`, used by `apps/gateway/src/agent/remote-pane-runtime.ts:37,48,69`) and notifications (`MESH_INTERNAL_NOTIFICATION_ROUTE = '/api/mesh-internal/notifications'`, `packages/shared/src/contracts/mesh-notifications.ts:12`).
- Wiring pattern for non-mesh code to reach the forwarder: global bridge registries set in `apps/gateway/src/mesh/mesh-runtime.ts:1315-1341` (`setMeshAgentBridge`, `setMeshNotificationBridge` via `apps/gateway/src/mesh/notification-bridge-wiring.ts:27-55`).

> 🔒 **Critical auth finding.** `stripForwardedRequestHeaders` drops `cookie` (`stream-targets.ts:25-32`). A user's node-session cookie therefore **does not survive a node→node hop**. Consequences:
> - Entry node E *can* call both A and B with user credentials (it holds `tmex_s_<A>` and `tmex_s_<B>` from the browser request). This is what remote upgrade does.
> - Node A *cannot* call node B on the user's behalf with `forwardAuthorizedHttp`. A→B must go through `/api/mesh-internal/*` (peer marker), which means **the peer marker alone authorizes it** — any trusted mesh node could then ask any other to read/write files. A node-to-node transfer over `mesh-internal` therefore needs an explicit, short-lived, entry-issued job grant carried in the request (see §8).

### 2.6 The upgrade push: an already-working resumable node→node chunk push

Design doc: `/Users/konata/code/tmex-r32/docs/update/2026090502-resumable-remote-upgrade-push.md`.

**Protocol** (implemented on both ends):
- `GET /api/system/upgrade/package?version=&sha256=` → `{version, sha256, receivedBytes, complete}` — receiver: `apps/gateway/src/system/upgrade.ts:297-322`.
- `PUT /api/system/upgrade/package?version=&sha256=&offset=N` with `content-type: application/octet-stream` + `content-length` — receiver `stagePackage` → `stagePackageLocked` — `apps/gateway/src/system/upgrade.ts:324-405`.

**Receiver internals** — `/Users/konata/code/tmex-r32/apps/gateway/src/system/upgrade-staging.ts` (124 lines):
- `stagedPartPath()` `:47` — deterministic `.part` name `…tgz.part-<sha256[0..16]>` so a resume can find it.
- `resumeStagedPart()` `:97-123` — `offset` must equal the on-disk size or `409 UPGRADE_OFFSET_MISMATCH {receivedBytes}`; then **re-hashes the existing prefix** streaming at 1 MiB (`hashFilePrefix`, `:74-91`) so the running `createHash('sha256')` is correct across resumes.
- `truncatedTransfer(received, expected)` `:68-71` — the subtle one: a relay RST makes the request body end *cleanly*, so only comparing against the declared `content-length` distinguishes "link died" from "bad package". A short body returns `500 PACKAGE_INCOMPLETE` and **keeps** the `.part`.
- `STAGED_PART_TTL_MS = 24 h` `:11`.
- `receiveStagedBody` — `upgrade.ts:418-465`: reader loop, `hash.update(value)` + `fh.write(value)`, `maxBytes` guard, `stagingPreempt` so a *newer* PUT for the same `(version, sha256)` can cancel the older stuck one (`upgrade.ts:333-338`).
- `commitStagedPackage` — `upgrade.ts:466-505`: `rename(partPath, finalPath)` + chmod 0600 + a JSON sidecar. **Rename-on-complete.**

**Sender internals** — `/Users/konata/code/tmex-r32/apps/gateway/src/system/remote-upgrade-job.ts` (688 lines):
- In-memory job registry `const jobs = new Map<string, Job>()` `:95`; `Job` shape `:69-88` (`phase: 'download'|'push'|'start'`, `pushedBytes`, `totalBytes`, `downloadedBytes`, `attempt`, `abort`, `fileStream`).
- `readPushedOffset()` `:447-473` — asks the target how much it has; failure ⇒ 0.
- `attemptPush()` `:476-521` — `fileReadableStream(path, offset)` → `forwardAuthorizedHttp({method:'PUT', rawBody, headers:{content-length: bytes-offset}, onProgress})`.
- Retry policy: `PUSH_RETRY_BACKOFF_MS = [1,2,4,8,15,15,15]s` `:26`, `PUSH_MAX_ATTEMPTS = 8` `:28` (resume-capable target) vs `LEGACY_PUSH_MAX_ATTEMPTS = 3` `:30`; budgets `REMOTE_UPGRADE_TIMEOUTS = {download 10m, push 15m, start 60s}` `:20-24`; `OFFSET_QUERY_TIMEOUT_MS = 30s` `:32`.
- `shouldReuploadFromZero()` `:417-419` — a single full re-upload if the on-disk prefix hash disagrees.
- `retryablePushStatus()` `:552+` — retries on `NODE_UNREACHABLE` / gateway 5xx / `UPGRADE_OFFSET_MISMATCH`.
- IO helpers: `/Users/konata/code/tmex-r32/apps/gateway/src/system/remote-upgrade-io.ts` — `detachRequest(req)` `:8-15` (keeps only `cookie` + `origin`, so the job outlives the HTTP request), **`fileReadableStream(path, start)` `:18-30`** (ranged `createReadStream` → web stream), `abortableSleep` `:32`, `describeUpstream` `:51`.
- Capability negotiation: `SystemInfo.upgradeCapabilities` includes `'staged-package-resume'` — `packages/shared/src/contracts/system.ts:35-41`.

**This is 90 % of the engine round 32 needs.** It is single-stream and file-scoped, but the offset negotiation, prefix re-hash, `.part` + rename-on-complete, truncation detection, backoff ladder and byte-progress reporting are all production-tested against relays.

Integration harness for exactly this shape of traffic: `apps/gateway/src/mesh/integration/large-push-harness.ts` (`LARGE_PUSH_BYTES = 24 MiB`, `LARGE_PUSH_CHUNK = 64 KiB`, a `BackpressuredServerSocket`) driving `apps/gateway/src/mesh/integration/large-push.integration.test.ts`.

---

## 3. Byte-level helpers, and what is duplicated

### 3.1 Inventory

| Concern | Implementations |
|---|---|
| **sha256 streaming** | `createHash('sha256')` in `apps/gateway/src/system/upgrade.ts:381` (staging) and `apps/gateway/src/system/release-download.ts:208,538`; prefix re-hash `apps/gateway/src/system/upgrade-staging.ts:74-91`. `sha256Hex(string)` (non-streaming, auth tokens) `apps/gateway/src/relay/relay-password.ts:120`. `crypto.subtle.digest` for a cache key `apps/gateway/src/tmux-client/pane-history-page.ts:62`. **The file transfer path does no hashing at all — uploads/downloads are unverified.** |
| **File → stream** | `Bun.file(tmpPath).stream()` `apps/gateway/src/api/file-http.ts:61` (`streamTempFile`, with a cleanup hook); `Readable.toWeb(createReadStream(path,{start}))` `apps/gateway/src/system/remote-upgrade-io.ts:18-30`. Two different mechanisms for the same job; only the second supports an offset. |
| **Chunk / frame sizes** | 8 MiB HTTP upload chunk (`file-transfer-routes.ts:33`); 64 KiB bulk frame browser-side (`bulk-client.ts:24`) vs 16 KiB node-side send / 64 KiB accept (`rtc/bulk.ts:7-8`); 256 KiB mux DATA cap + 1 MiB window (`shared/src/link/types.ts:4-5`); 1 MiB resume-hash read (`upgrade-staging.ts:12`); 64 KiB large-push test chunk. |
| **Backpressure** | DataChannel 4 MiB/1 MiB water marks + `waitDrain` — duplicated in `apps/gateway/src/mesh/rtc/bulk.ts:377-389` and `packages/ws-client/src/direct/bulk-client.ts:276-288`; mux credit-window in `packages/shared/src/link/mux.ts`; `LinkStreamCarrier` high-water in `apps/gateway/src/mesh/link-stream-carrier.ts:25`; upload queue budget `rtc/bulk.ts:186-189`. |
| **Frame slicing from a Blob/stream** | `iterateBulkFrames` `packages/ws-client/src/direct/bulk-client.ts:124-153` (browser) vs `pumpDownload`'s `concatBytes` + `subarray().slice()` loop `apps/gateway/src/mesh/rtc/bulk.ts:319-356` (node). Same algorithm, two copies. Plus a third `concatBytes` at `bulk-client.ts:116` / `rtc/bulk.ts:87`. |
| **Sequential-append with rollback** | `persistChunk` `apps/gateway/src/files/transfer-session.ts:150-177` vs `receiveStagedBody` `apps/gateway/src/system/upgrade.ts:423-465`. Same problem (append a chunk, survive a mid-write failure), two solutions — the upgrade one is strictly better (keeps the partial, knows the expected length). |
| **Retry / resume** | Only `remote-upgrade-job.ts` has it. `uploadFileChunked` restarts a chunk only implicitly via fetch; `bulk-transfer.ts` re-runs the **entire** transfer on any pre-commit failure. |
| **Progress + rate** | `formatBytes/formatRate/formatBytesPair` `packages/shared/src/format-bytes.ts` (shared ✅); elapsed-time rate math duplicated in `upload-transfer.ts:51-56`, `download-transfer.ts:65-76`, `bulk-transfer.ts:178-185` and `:284-291`. |
| **NDJSON progress framing** | `ndjsonResponse` (server) `apps/gateway/src/api/file-http.ts:88-116`; `readNdjsonStream` (client) `packages/api-client/src/ndjson-stream.ts` — already shared ✅. |
| **Abort plumbing** | `abortError()` duplicated at `packages/panels/src/files/bulk-transfer.ts:77-82` and `packages/ws-client/src/direct/bulk-client.ts:84-89`; `combineAbortSignals` exists in `@tmex/shared` (used at `remote-upgrade-job.ts:495`). |

### 3.2 The five things that should collapse into one upstream

1. **Ranged file source** — `fileReadableStream(path, start, end?)` (today `remote-upgrade-io.ts:18`) should replace `streamTempFile`'s non-ranged `Bun.file().stream()` and become the only way any subsystem reads bytes off disk.
2. **Resumable sink** — `.part` naming + offset check + prefix re-hash + truncation check + rename-on-commit (today `upgrade-staging.ts`) should be generic over `(id, expectedBytes, expectedSha256, destPath)` and replace `transfer-session.ts`'s append-only temp file.
3. **Chunker** — one `iterateFrames(source, frameSize)` for Blob / ReadableStream / file range.
4. **Push driver** — offset query → ranged push → classify → backoff ladder (today `remote-upgrade-job.ts:390-560`), parameterized by "what endpoint" and "how many parallel streams".
5. **Progress model** — one `{transferredBytes, totalBytes, ratePerSec, etaSec, phase, path: 'direct'|'relay'}` type replacing `LegProgress`+`RemoteUpgradeJobSnapshot.progress`+`transfer-toast`'s ad-hoc leg math.

---

## 4. The 管理设备 page, its header actions, and the UI kit

### 4.1 The page and the 恢复布局 button

`/Users/konata/code/tmex-r32/apps/fe/src/pages/DevicesPage.tsx` (193 lines) exports three things by convention:
- `default DevicesPage` `:92`
- `PageTitle` `:109`
- **`PageActions` `:167-193`** ← the top-right header area
- local `ResetLayoutButton` `:114-159` — `IconTooltip` + ghost `icon-sm` `Button` with `<RotateCcw className="h-4 w-4"/>`, `data-testid="devices-reset-layout"`, plus its own `AlertDialog` confirm (`devices-reset-layout-confirm`).

Current top-right JSX (`:172-192`):
```tsx
<div className="flex items-center gap-0.5">
  {commands && (<>
    <ResetLayoutButton onConfirm={commands.resetLayout} disabled={commands.layoutBusy} />
    <IconTooltip label={t('devices.folders.newFolder')}>
      <Button variant="ghost" size="icon-sm" data-testid="devices-new-folder" …><FolderPlus className="h-4 w-4" /></Button>
    </IconTooltip>
  </>)}
  {targets.length > 0 ? <AddDeviceMenu targets={targets} /> : <DeviceManagementActions />}
</div>
```

### 4.2 How header actions are composed — a page-module convention, not a slot component

There is **no shared `PageHeader`, no portal, no header-actions slot**. `/Users/konata/code/tmex-r32/apps/fe/src/page-wrapper.tsx:49-71` lazily loads the page module and renders `PageTitle` / `PageActions` itself into a sticky `<header>` (`:55-72`). Contract type: `apps/fe/src/use-page-module.ts:10`. Other implementers: `FilePage.tsx:326`, `SettingsPage.tsx:336`, `DevicePage.tsx:40`. (`packages/panels/src/device-console/page-actions.tsx` is the *terminal* page's version, unrelated.)

**Gotcha**: `PageActions` and the page body live in two disconnected React subtrees, so context cannot cross. Two module-level `useSyncExternalStore` registries bridge them:
- `/Users/konata/code/tmex-r32/apps/fe/src/pages/devices/page-commands.ts` (56 lines) — `DevicesPageCommands {newFolder, resetLayout, layoutBusy}`, `registerDevicesPageCommands()` / `useDevicesPageCommands()`; registered from `apps/fe/src/pages/devices/device-folders-view.tsx:43-51`.
- `/Users/konata/code/tmex-r32/apps/fe/src/pages/devices/add-device-targets.ts` (66 lines) — same pattern for `AddDeviceMenu`.

A file-transfer dialog needs only the mesh node list, which `PageActions` can fetch directly (`useMeshNodes` / `useAddDeviceTargets`), so it can be **fully self-contained** and skip the registry.

**Three-dot menu precedent** (for folding 恢复布局 into an ellipsis menu): `apps/fe/src/pages/devices/add-device-menu.tsx:78-110` and `apps/fe/src/pages/settings/nodes/management/bulk-actions-menu.tsx` (uses lucide `Ellipsis`). ⚠️ Base UI caveat documented at `add-device-menu.tsx:32-36`: **`DropdownMenuLabel` must be wrapped in `DropdownMenuGroup`**, or production builds throw "Base UI error #31".

### 4.3 i18n

- Existing key: `devices.folders.resetLayout` = 恢复默认布局.
- **Source files (edit these three):** `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` (`devices.folders` block at `zh_CN.json:2909-2935`; manifest at `locales/manifest.json`).
- **Generated (never hand-edit, never lint):** `packages/shared/src/i18n/resources.ts`, `types.ts`, `locales/generated/*.json`.
- **Regenerate:** `bun run build:i18n` from repo root (`packages/shared/scripts/build-i18n.ts`).
- Core/rest split: `packages/shared/src/i18n/core-keys.ts:8-27`. `devices.*` is **not** a core prefix → lands in the lazily-loaded rest bundle (good). `files.*` **is** core → putting transfer strings under `files.transfer.*` pushes them into the first-screen bundle.
- Guardrails: `packages/shared/src/i18n/locale-consistency.test.ts` (all three locales must have identical key sets, and generated output must match), `apps/fe/src/i18n/core-coverage.test.tsx`.
- Reusable existing strings: `files.transfer.*` at `zh_CN.json:1861-1875` (`legUserToTmex`, `legTmexToServer`, `legServerToTmex`, `legTmexToUser`, `cancel`, `downloaded`, `downloadFailed`, `tooLarge`, `pathDirect`/`pathRelay` + hints), `files.upload.success/fail` at `:1857`.

### 4.4 UI kit: `@tmex/ui` is shadcn-shaped on **Base UI**, not radix

`packages/ui/package.json` deps: **`@base-ui/react ^1.2.0`**, `sonner`, `class-variance-authority`, `clsx`, `lucide-react`. **Zero `@radix-ui/*` in the whole monorepo.** Import style: `@tmex/ui/dialog`, `@tmex/ui/button`, … (exports map `"./*": "./src/components/*.tsx"`); the root barrel only exposes `cn` and `useIsMobile`.

| Needed | Available | File |
|---|---|---|
| Dialog | ✅ | `packages/ui/src/components/dialog.tsx` + `dialog-impl.tsx` |
| Sheet | ✅ | `sheet.tsx` + `sheet-impl.tsx` (`side`, `animation`) |
| Drawer | ⚠️ use `Sheet side="bottom"` |
| DropdownMenu | ✅ | `dropdown-menu.tsx` (+ CheckboxItem / RadioItem / Sub / Group) |
| ContextMenu | ✅ | `context-menu.tsx` |
| Popover | ❌ | none — hand-rolled example `apps/fe/src/node/device-node-badges.tsx:405` |
| Command palette | ❌ | none (no `cmdk`) |
| Select | ✅ | `select.tsx` |
| Progress | ✅ | `progress.tsx` (`<Progress value={0..100}/>`, no label) |
| Table / DataTable | ❌ | raw `<table>`; best reference `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx` |
| ScrollArea | ✅ | `scroll-area.tsx` (`axis?: 'both'|'vertical'`) |
| Tabs / Tooltip / Checkbox | ✅ | `tabs.tsx`, `tooltip.tsx` + `icon-tooltip.tsx`, `checkbox.tsx` (has `indeterminate`) |
| Resizable panels | ❌ | none — bespoke resizers in `packages/ui/src/components/sidebar/resize-controller.ts` and `packages/terminal-ui/src/components/SplitTerminalArea.tsx` |

Also present: `confirm-dialog.tsx` (shared `ConfirmDialog` — prefer it over hand-rolled AlertDialogs), `alert-dialog.tsx`, `card/badge/input/textarea/switch/collapsible/separator/skeleton/otp-input/sparkline/stat-tile/toast/motion`, `sidebar/*`.

**Lazy overlay architecture**: every overlay is split `foo.tsx` (façade) + `foo-impl.tsx` (code-split chunk) via `createOverlayPart` / `useOverlayGate` (`packages/ui/src/lazy-overlay.tsx`, `overlays-impl.ts`). Transparent to importers, and it means a large new dialog costs nothing at page load.

### 4.5 Dialog patterns to copy

**Every existing dialog is smaller than what round 32 needs.** Widest today is `sm:max-w-4xl` (`apps/fe/src/pages/settings/share/replay-viewer.tsx:36`); the only genuine two-column body is `packages/panels/src/settings/telegram-bot-chats-modal.tsx:128` (`grid grid-cols-1 gap-4 lg:grid-cols-2`).

`DialogContent` defaults (`packages/ui/src/components/dialog-impl.tsx:~55`): `display:grid`, `sm:max-w-sm`, `gap-4 rounded-xl p-4`, fixed-centered, zoom/fade on `data-open`/`data-closed`, built-in close X. `DialogFooter` is already a flush footer bar (`bg-muted/50 -mx-4 -mb-4 border-t p-4`).

Best skeleton — `packages/panels/src/device-management/device-dialog.tsx:79-125`:
```tsx
<DialogContent className="flex max-h-[calc(100dvh-2rem)] w-full flex-col sm:max-w-2xl">
  <DialogHeader>…</DialogHeader>
  <form className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
    <div className="-mr-2 min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto pr-2">…</div>
    <DialogFooter>…</DialogFooter>
  </form>
</DialogContent>
```
Alternative grid idiom: `packages/panels/src/share/share-dialog.tsx:79` (`max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)]`).

**⭐ The most relevant existing file: `packages/panels/src/settings/directory-picker-modal.tsx` (475 lines).** A graphical directory browser on an arbitrary device, deliberately factored into pure, unit-testable pieces:
- `DIRECTORY_BROWSE_QUERY_KEY` `:31`; `directoryBrowseQueryOptions({deviceId, path, hidden, client})` `:41` (accepts an injected `ApiClient` — essential for multi-node)
- `resolvePickerInitialPath` `:54`, `directoryBreadcrumbs` `:65`, `moveDirectoryHighlight` `:77`
- `DirectoryPickerState`/`Action` `:84-102`, `directoryPickerReducer` `:108-136`, `resolvePickerSelection` `:139`
- `PICKER_SKIP_RENDER_THRESHOLD = 200` `:149` + `SKIPPED_ROW_STYLE {contentVisibility:'auto', containIntrinsicSize:'auto 32px'}` `:151`
- `DirectoryEntryList` `:176-228` — rows are plain `<button data-picker-index=…>`, **single-highlight, directories only**
- Layout `:370-474`: breadcrumb bar → up-button + editable path `<Input>` → `<ScrollArea className="h-64 rounded-lg border">` → truncation hint → hidden-files `<Switch>` → footer with selected path + confirm
- Keyboard handling at the container level `:~400` (↑/↓/Enter, skips when focus is in an INPUT)
- Tests: `directory-picker-modal.test.tsx` (320 lines)

Reusable as-is: the query options, breadcrumbs, reducer shape, highlight movement. **Not reusable**: the list itself (dirs-only, single-select).

### 4.6 Multi-select: does not exist in the file browser

`packages/panels/src/files/selected-file.tsx` models selection as **one route-derived `{rootId, path} | null`**, published through a hand-rolled external store so each row subscribes to a single boolean (`useIsFileSelected`) — a deliberate perf design for 500-row trees. Similarly `packages/panels/src/files/file-leaf-menu.tsx:1-24` explains that the whole tree shares **one** ContextMenu via event delegation because per-row `ContextMenu.Root` was ~17× slower; rows have no callbacks at all. Adding per-row checkboxes fights this design — read that comment first.

**The one multi-select in the repo to copy**: `apps/fe/src/pages/settings/nodes/management/` —
- pure helpers `bulk-actions-menu.tsx:21-50` (`selectableRows`, `toggleSelection`, `toggleAllSelection`, `pruneSelection` — returns the same reference when unchanged)
- interface `types.ts:152-158` (`NodeSelection {ids: ReadonlySet<string>; selectableCount; toggle; toggleAll}`)
- state owner `nodes-management.tsx:135-152` (`useState<ReadonlySet<string>>` + prune effect + memoized object)
- row `nodes-table.tsx:141-150` (`<Checkbox checked={selection.ids.has(row.id)} onCheckedChange={…}/>`)

**Shift-click range selection does not exist anywhere** — net-new.

---

## 5. Node/device selection: enumerating nodes and building two node-scoped clients

### 5.1 The node list

- `GET /api/mesh/nodes` → `{nodes: MeshNode[]}`. Client: `packages/api-client/src/auth/auth-api.ts:100-108`. Row type `MeshNode` — `packages/api-client/src/auth/types.ts:277-315`: `id, name, publicKey, online, reach:'lan'|'wan'|'relay'|null, transport?:'ws-secure'|'relay'|'dc', rttMs, peerAddress, linkSinceAt, endpoints[], directFailure, dcBreaker, version, direct_capable, inventory, loggedIn, isHub?, hubMode?, attachedHubId?, operation?`.
  - There is **no `role` field**; hub-ness is `isHub` + `hubMode`. Role names only exist server/CLI-side (`packages/shared/src/roles.ts:1-42`).
  - `loggedIn` literally means "the browser's cookie jar has this node's cookie" — `apps/gateway/src/mesh/node-list-projection.ts:260`.
- Server: `apps/gateway/src/mesh/mesh-routes.ts:148-150` → `handleNodes` `:224` → `collectNodes` `:415-462`; projection `node-list-projection.ts:200-262`.
- Store (host-level singleton, **not** react-query, because the list is entry-scoped while pages hang off per-node QueryClients): `apps/fe/src/node/mesh-nodes-store.ts` — state `:70-88`, localStorage hydrate `:133-145`, `ensureAuthMode()` `:185-201`, `refreshMeshNodes()` `:248-273`, `ensureFreshMeshNodes()` `:283-290`, `patchNodesWithEvent()` `:19-52`.
- Hooks/polling: `apps/fe/src/node/mesh-nodes.ts` — `useSharedAuthMode()` `:60-71`, `useMeshNodes(options)` `:333-364`, cadence `:209-215` (`POLL 300 s` fallback, `STALE 30 s`, `THROTTLE 2 s`; real-time updates come from `/mesh/ws` `NODE_EVENT`). Single owner: `apps/fe/src/node/mesh-nodes-resident.tsx:15-19`, mounted at `apps/fe/src/main.tsx:205`.
- **`self` collapse**: `toRuntimeNodeId(nodeId, entryNodeId)` — `apps/fe/src/node/merge-nodes.ts:27-29`; `sortNodes()` `:38-46` (self first, online first, then name). `entryNodeId` comes from `GET /api/auth/mode` → `AuthModeResponse.nodeId`.
- Rendering precedents: sidebar `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx` (`toSidebarEntries` `:61-80`) + `sidebar-node-section.tsx:527-545` (four shapes: offline / not-logged-in / expanded-with-runtime / collapsed-without-runtime); settings `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:58-80`.
- Badge component ready for the dialog's node pickers: `packages/panels/src/device-tree/node-badge.tsx:29-36`.

### 5.2 Node-scoped clients — and yes, N at once

- `createNodeApiClient(nodeId)` — `packages/api-client/src/node-url.ts:161` → `new ApiClient(nodePathPrefix(nodeId))` where the prefix is `''` for `self` and `/n/<32-hex>` otherwise. `assertNodeId` `:37-42` is the security gate (rejects `..` / `%2e%2e`; `encodeURIComponent` alone is insufficient).
- **Credentials are same-origin cookies**, one per node: `tmex_s_<nodeId>` (`apps/gateway/src/auth/cookies.ts:27-38`). The browser only ever talks to the entry origin, so nothing special is needed on the client. The entry picks the right cookie when forwarding (`forwarder.ts:102-109`, `:314`). Establishing one: `ensureNodeLogin(nodeId, opts)` — `apps/fe/src/auth/session-key-store.ts:433-460`.
- 401 routing: `packages/api-client/src/auth/session-interceptor.ts` — a forwarded `{code:'NODE_LOGIN_REQUIRED', nodeId}` raises a **per-node** event only, never a global logout (see the rationale at `packages/api-client/src/client.ts:20-27`).
- Runtime multiplexer: `packages/stores/src/node-connection-manager.ts` — `NodeConnectionManager` with `get/acquire/release/dispose` `:198-257`, `DEFAULT_RELEASE_GRACE_MS = 30_000` `:38`, `WS_UNAUTHORIZED_CLOSE_CODE = 4401` `:41`, `useNodeRuntime(nodeId)` `:267-280`. `create()` `:154-183` binds `createNodeApiClient(nodeId)`, `nodeStoragePrefix(nodeId)`, a **shared** UI store, and `controlsBrowserPrefs: nodeId === SELF_NODE_ID`.
- App wiring: `apps/fe/src/node/node-runtimes.ts` — `createNodeConnection` `:287-311` (attaches the lazy WebRTC direct stack for non-self nodes, `attachDirectLink` `:241-281`, and registers the per-node `BulkClient`), `appNodeRuntimes` `:337`, **per-node QueryClient** `nodeQueryClient(nodeId)` `:353-361`.
- Mounting N runtimes at once: `apps/fe/src/node/node-runtime-scope.tsx:21-39` (`NodeRuntimeScope` = `RuntimeProvider` + `QueryClientProvider` + `GlobalDeviceProvider`). This is exactly what the sidebar does today for the aggregated device/file trees.

> **For the two-pane dialog**: wrap each pane in its own `<NodeRuntimeScope nodeId={…}>`, or — simpler and lighter — just build two `ApiClient`s via `createNodeApiClient(a)` / `createNodeApiClient(b)` and pass them explicitly, the way `directoryBrowseQueryOptions({client})` already allows. The dialog does not need WS or a runtime to list files.

### 5.3 What a "machine" means in the two-pane dialog

`resolveContext(rootId)` (`apps/gateway/src/files/device-storage.ts:99`) resolves a **file root → device → node**. So a pane is really `(nodeId, deviceId | rootId, path)`. Two useful listing APIs already exist:
- `GET /api/files/list?rootId=&path=` — files + dirs, but **restricted to whitelisted roots**.
- `GET /api/files/browse?deviceId=&path=&hidden=` — arbitrary path on the device, **but directories only** (`buildSshBrowseCommand`, `apps/gateway/src/files/directory-browse.ts:160-169`).

Neither gives "arbitrary path, files + dirs". The dialog needs either root-scoped listing (simplest, consistent with the existing security model) or a `browse` extension that also emits files.

---

## 6. Tests

### 6.1 Unit tests already covering this area

Gateway: `apps/gateway/src/files/{transfer-session,directory-browse,path-safety,queue,rsync,rsync-operation,ssh-command,upload}.test.ts`; `apps/gateway/src/api/{file-transfer-routes,file-transfer-sessions,file-browser-routes,file-root-routes,files}.test.ts`; `apps/gateway/src/db/file-roots.test.ts`; `apps/gateway/src/mesh/rtc/bulk.test.ts`.
Upgrade resume: `apps/gateway/src/system/remote-upgrade-job.test.ts` (resume cases at `:294, :337, :364, :411, :456, :498, :534, :584, :621`) and `apps/gateway/src/system/upgrade.test.ts` (`:710, :880, :910, :954, :998, :1029, :1049, :1081, :1100, :1507`). **These are the behavioral spec for the resume engine — reuse them when generalizing it.**
Client: `packages/api-client/src/{files-upload,files-download,download-transfer,file-resources}.test.ts`; `packages/panels/src/files/*.test.ts(x)`; `packages/ws-client/src/direct/bulk-client.test.ts`; `packages/panels/src/settings/directory-picker-modal.test.tsx`.

### 6.2 Integration (in-process, real mux)

`apps/gateway/src/mesh/integration/`: `large-push.integration.test.ts` + `large-push-harness.ts` (24 MiB through a backpressured socket — the closest existing analogue of a big transfer), `dc-http-bulk.integration.test.ts`, `direct-path.integration.test.ts`, `stream-failover.integration.test.ts`, `multi-hub.integration.test.ts`, `mesh.integration.test.ts`. Relay: `apps/gateway/src/relay/integration/relay.integration.test.ts`, `relay-membership.integration.test.ts`, `relay-password-join.integration.test.ts`.

### 6.3 e2e

`apps/fe/tests/` has 60 specs. Standalone files coverage: `files-context-menu.spec.ts`, `files-sidebar-drag.spec.ts`, `settings-files.spec.ts`. The mesh Playwright project matches only `/mesh-.*\.spec\.ts$/` and today contains `mesh-login`, `mesh-notify`, `mesh-passkey`, `mesh-share` — **there is no multi-node files spec.**

The round-9 "文件多节点" work was verified instead by:
1. **the bash docker harness**: `scripts/hub-e2e/run.sh:498-522` scenario 5 (`files list+read /e2e/marker.txt via entry`, addressing node B through the entry) and `:531-545` scenario 6 (same with the hub stopped → relay/direct path). Driver: `scripts/hub-e2e/driver/files.ts`.
2. a manual two-instance run archived at `prompt-archives/2026083102-relay-files-switch-lan-round9/sub/V1-result.md`.

### 6.4 Commands

```bash
# unit — the one to use
bun run test:unit                     # scripts/ci/unit-tests.ts, all workspaces
cd apps/gateway && bun test src/files
cd apps/gateway && bun test src/system
cd apps/fe      && bun test src/      # NOT `bun test` — that runs Playwright
cd packages/api-client && bun test
cd packages/panels     && bun test
cd packages/ws-client  && bun test

# lint + complexity gate
bun run lint                          # biome check . && bun scripts/complexity/gate.ts

# e2e
cd apps/fe && bun run test:e2e
cd apps/fe && bun run test:e2e -- --project=mesh
cd apps/fe && bun run test:e2e -- tests/files-context-menu.spec.ts

# docker mesh harness (hub + node-a + node-b + caddy + driver, project tmex-e2e)
bun run pack:tmex
TMEX_TARBALL=/path/to/tmex-cli-<ver>.tgz scripts/hub-e2e/run.sh
scripts/hub-e2e/run.sh down
RSSH=… RSYNC_SSH=… scripts/hub-e2e/split/run.sh     # remote-hub × NAT-node topology
scripts/docker-node/run.sh up|status|logs|shell|down
```
⚠️ Root `bun run test` fans out to every workspace's `test` script, and `apps/fe`'s `test` **is** the Playwright e2e run. Use `test:unit`.

---

## 7. Server-side task model and the ws event bus

### 7.1 There is no persistent job/task table

Drizzle schema is `apps/gateway/src/db/schema.ts` re-exporting `apps/gateway/src/db/schema/{settings,devices,messaging,agent,users-auth,mesh,relay,mesh-relay,share}.ts`; migrations `apps/gateway/drizzle/0000_*.sql … 0048_share_password_enc.sql`; runner `apps/gateway/src/db/migrate.ts`; generator `cd apps/gateway && bun run db:generate` (drizzle-kit).

**No `jobs` / `tasks` / `transfers` / `uploads` / `upgrades` table exists.** Everything long-running is in-memory:

| Job | Storage | Location |
|---|---|---|
| Remote upgrade push | `const jobs = new Map<string, Job>()` | `apps/gateway/src/system/remote-upgrade-job.ts:99` (failed rows kept `FAILED_TTL_MS = 10 min`, `:18,114-120`) |
| Release download | `inflight` keyed `${cacheDir}::${version}` | `apps/gateway/src/system/release-download.ts:300-372` |
| Upload sessions | `Map<string, UploadSession>` | `apps/gateway/src/files/transfer-session.ts:26` |
| Download sessions | `Map<string, DownloadSession>` | `transfer-session.ts:39` |
| Staged package | **on-disk `.part-<sha16>` + JSON sidecar** | `apps/gateway/src/system/upgrade-staging.ts:47-49`, `upgrade.ts:467-499` |

The *only* durable resume state in the repo is the upgrade `.part` file plus its deterministic, content-addressed name — deliberately reconstructible without a DB. The FE compensates for restart amnesia by falling back to version comparison (`apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts:280-290`).

Persistent-but-not-a-job: `shares` / `share_logs` (`apps/gateway/src/db/schema/share.ts:13-84`) do persist a long session with byte counters (`logBytes`, `logSeq`, `logTruncated`).

### 7.2 Does any job push progress to browsers over ws? Only the Agent.

- **Upgrade progress = HTTP polling.** `use-node-upgrade.ts:313-345` polls `GET /api/mesh/nodes/:id/upgrade`; the entry synthesizes `state:'downloading'` + `progress` from the in-memory job (`apps/gateway/src/system/upgrade-service.ts:172-179`, `remoteUpgradeProgress` `:413-422`). Contract `RemoteUpgradeProgress` — `packages/shared/src/contracts/system.ts:64-80`.
- **File transfer progress = NDJSON over HTTP** (`ndjsonResponse` `apps/gateway/src/api/file-http.ts:88-116`; `readNdjsonStream` `packages/api-client/src/ndjson-stream.ts`) plus client-side counting for the RTC leg.
- **The ws notify channel carries none of this.** `KIND_NOTIFY_EVENT` only transports the 15 `EventType`s in `packages/shared/src/contracts/notifications.ts:5-20` (bell / tmux / device / session / agent / watch). No transfer or upgrade event type exists.

### 7.3 The ws bus, concretely

Kinds — `packages/shared/src/ws-borsh/kind.ts` (flat `u16`): session `0x0001-0x0005`; device `0x0101-0x0105`; tmux `0x0201-0x0215`; terminal `0x0301-0x0309`; `KIND_CHUNK 0x0501`; agent `0x0601-0x0603`; `KIND_WATCH_EVENT 0x0701`; site `KIND_SITE_THEME_UPDATE 0x0801` / `KIND_SETTINGS_UPDATE 0x0802` / `KIND_NOTIFY_EVENT 0x0803`; canonical `0x0901-0x0902`; mesh `KIND_NODE_EVENT 0x0a01` / `KIND_RTC_SIGNAL 0x0a02` / `KIND_CARRIER_SWITCH 0x0a03` / `_ACK 0x0a04` / `KIND_ENROLL_REDEEMED 0x0a05`. `VALID_KINDS` `:79-127`; retired kinds listed `:4-8` must never be reused; drift test `packages/shared/src/ws-borsh/kind-doc-drift.test.ts`.

Two separate buses:
- **Gateway WS (per node).** `apps/gateway/src/ws/index.ts` — `connectedClients: Set<GatewaySession>` `:87`, facade `broadcastSettingsUpdate` `:794` / `broadcastEventNotify` `:798` / `broadcastTmuxEvent` `:824` / `broadcastDeviceEvent` `:841`. Actual fan-out loops: `apps/gateway/src/ws/theme-settings-broadcaster.ts:80-129` (all skip `client.shareScope`, all carry a monotonic `serverTimestamp`) and `apps/gateway/src/ws/device-feed-broadcaster.ts`. Non-ws code reaches them through registration bridges: `apps/gateway/src/settings/broadcaster.ts:22-28` and `apps/gateway/src/events/broadcaster.ts:10-16` (registered/unregistered by `runtime.ts`).
- **Mesh WS (`/mesh/ws`, entry only).** `apps/gateway/src/mesh/mesh-routes.ts` — `broadcastNodeEvent()` `:529-553`, `broadcastRtcSignal()` `:555-565`, `broadcast()` `:567-571`, `sendToMeshClient()` `:573-597` (backpressure cutoff + drop). Browser side: `MeshEventSource` — `apps/fe/src/node/mesh-events.ts:265+`.

**How a per-node event reaches the browser (identical in hub and relay mode).** The browser already holds a second Gateway WS at `/n/B/ws`. On the entry that socket is a `Forwarder` pump bound to a `ws` stream on the A↔B peer link (`forwarder.ts:733-788`); on B the stream is turned into a first-class `GatewaySession` by `acceptWsStream()` (`stream-targets.ts:449-482`) wrapping it in a `LinkStreamCarrier`. So **B's ordinary broadcast loops already reach the browser** — no new plumbing is needed for a per-node progress event, only a new kind (or an NDJSON endpoint).

**If you do want a WS-pushed job feed**, the pattern to copy is the Agent subsystem — the only DB-backed job model with resumable push: tables `agent_sessions` / `agent_messages` (monotone `seq`, `unique(sessionId, seq)`) at `apps/gateway/src/db/schema/agent.ts:73-131`; hub `apps/gateway/src/agent/ws-hub.ts:61` (`class AgentWsHub`), `broadcastAgentEvent(sessionId, eventType, payload, seq)` `:130-141`, `setSyncProvider` `:72` for replay-after-reconnect.

---

## 8. Recommended architecture

### 8.1 One transfer engine, three consumers

Create **`packages/transfer/`** (new workspace package, or `packages/shared/src/transfer/` if a new package is unwanted — but a separate package keeps `@tmex/shared`'s browser bundle clean, since the sink half is Node-only). Structure:

```
packages/transfer/src/
  types.ts          # TransferId, TransferPlanItem, TransferProgress, TransferPhase, TransferErrorCode
  chunker.ts        # iterateFrames(source: Blob|ReadableStream|FileRange, frameSize) — replaces
                    #   bulk-client.ts:124 iterateBulkFrames + rtc/bulk.ts:319 pumpDownload buffering
  source.ts         # Node-only: openRange(path, start, end?) -> ReadableStream
                    #   (generalizes remote-upgrade-io.ts:18 fileReadableStream; replaces
                    #    file-http.ts:61 streamTempFile's non-ranged Bun.file().stream())
  sink.ts           # Node-only: ResumableSink — the generalized upgrade-staging.ts
  push-driver.ts    # offset negotiation + N parallel ranged pushes + backoff (generalized
                    #   remote-upgrade-job.ts:370-560)
  progress.ts       # rate/ETA/throttle — one implementation replacing forwarder.ts:906,
                    #   release-download.ts:540, and the three client-side rate loops
  bytes.ts          # concatBytes/copyBytes — collapses the 7+4 copies found across the repo
```

**`ResumableSink` API sketch** (lifted almost verbatim from `upgrade-staging.ts` + `upgrade.ts:414-499`, which already have the hard-won edge cases):

```ts
export interface SinkDescriptor {
  /** deterministic, content-addressed: `<dest>.part-<sha256.slice(0,16)>` */
  destPath: string;
  totalBytes: number;
  sha256: string;              // required — today's file upload path verifies nothing
  ttlMs?: number;              // default STAGED_PART_TTL_MS (24 h)
}

export interface SinkStatus { receivedBytes: number; complete: boolean }

export interface ResumableSink {
  status(d: SinkDescriptor): Promise<SinkStatus>;
  /**
   * offset must equal the on-disk .part length, else OFFSET_MISMATCH { receivedBytes }.
   * offset > 0 re-hashes the existing prefix (1 MiB streaming reads) so the digest stays correct.
   * expectedBytes = offset + content-length: a short body means the link died (keep the .part
   * and return INCOMPLETE), not a corrupt payload. Only a full-length body with a wrong digest
   * deletes the .part.
   * Commit = rename(.part, dest) + chmod, atomically.
   */
  write(d: SinkDescriptor, body: ReadableStream<Uint8Array>, opts: { offset: number; expectedBytes: number }): Promise<SinkResult>;
  discard(d: SinkDescriptor): Promise<void>;
  sweep(now: number): Promise<void>;    // TTL GC + boot-time orphan scan
}
```

**`PushDriver` API sketch** (generalizes `remote-upgrade-job.ts`, adds parallelism):

```ts
export interface PushTransport {
  /** GET the receiver's current offset. */
  status(): Promise<SinkStatus>;
  /** PUT bytes [offset, offset+len) — one call per parallel stream. */
  put(range: { offset: number; length: number }, body: ReadableStream<Uint8Array>,
      opts: { signal: AbortSignal; onProgress(uploaded: number): void }): Promise<Response>;
  /** capability probe: does the receiver accept ranged/parallel writes? */
  capabilities(): Promise<ReadonlySet<string>>;
}

export interface PushOptions {
  streams: number;             // 1 for legacy receivers; N for range-capable ones
  maxAttempts: number;         // PUSH_MAX_ATTEMPTS = 8 today
  backoffMs: readonly number[];// [1,2,4,8,15,15,15]s today
  deadlineMs: number;
  onProgress(p: TransferProgress): void;
  signal: AbortSignal;
}

export function runPush(src: RangeSource, transport: PushTransport, o: PushOptions): Promise<PushResult>;
```

**Parallelism is the point.** `INITIAL_STREAM_WINDOW = 1 MiB` per mux stream (`packages/shared/src/link/types.ts:5`) caps a single stream's in-flight bytes, so on a high-BDP relay one stream is the bottleneck, not the bandwidth. `runPush({streams: N})` opens N concurrent `openHttpStream` requests at disjoint ranges. Two constraints to respect:
- **Receiver must accept out-of-order ranges.** Today `resumeStagedPart` demands `offset === on-disk size` (strictly append-only) and `prepareAppend` demands `offset === session.received`. For N>1 the sink needs per-range `pwrite` into a preallocated `.part` plus a received-range bitmap, and the sha256 must then be computed in a **final verification pass** over the completed file rather than incrementally. That is a real design change — keep `streams: 1` (incremental hash, current behavior) as the compatibility mode and negotiate `streams: N` via a capability bit.
- **Relay quota.** `RelayQuota.maxStreams` (`packages/shared/src/relay/codec.ts:79`, limit 65 536 at `apps/gateway/src/relay/relay-quota.ts:10`) and the per-tenant `RelayTokenBucket` (`relay-quota.ts:99+`, "≤4 KiB frames get a priority lane so they aren't blocked behind bulk streams") mean N parallel streams consume N stream slots and share one bandwidth budget. **Cap `streams` lower when `MeshNode.transport === 'relay'`** and surface the reason in the UI. This dovetails with round-32 item 1 (per-tenant bandwidth/fairness).

**Capability negotiation** follows the existing `SystemInfo.upgradeCapabilities` precedent (`packages/shared/src/contracts/system.ts:35-41`): add e.g. `transferCapabilities: ['transfer-v2', 'transfer-ranged-parallel']` so a new node never breaks against an old peer.

### 8.2 Rewiring the three consumers

| Consumer | Today | After |
|---|---|---|
| **Browser upload** | `uploadFileChunked` sequential 8 MiB PUTs, no retry, no resume, no hash (`packages/api-client/src/upload-transfer.ts`) + in-memory append-only session (`files/transfer-session.ts`) | `runPush` against the node's file sink; `transfer-session.ts`'s temp file replaced by `ResumableSink`. **This alone gives browser uploads resume-across-reconnect, which they do not have today.** The RTC `bulk:` fast path stays as a leg-1 alternative and keeps its `FilesBulkHooks` seam (`apps/gateway/src/api/file-transfer-sessions.ts:19-27`) — widen it to `{status, writeRange, openRange, abort}`. |
| **Upgrade push** | `remote-upgrade-job.ts` + `upgrade-staging.ts` | keep the job state machine and the phase/budget/watchdog semantics; delete the byte-moving half and call `runPush`. Its existing tests (`remote-upgrade-job.test.ts:294-621`, `upgrade.test.ts:710-1507`) become the engine's regression suite. |
| **Node→node transfer** | does not exist | new `/api/mesh-internal/transfer/*` sink on the receiver + `runPush` on the sender. |

### 8.3 Where the node→node job runs

**Run the job on the *source* node, pushing to the destination.** Reasons: it halves the hop count versus entry-brokered relaying, it uses `PeerManager.getLink(src→dst)` which already picks `dc` → `ws-secure` → `relay` automatically (so hub and relay mode both work with zero extra code — `apps/gateway/src/mesh/peer-dialer.ts:277-358`), and pushing lets the sender own the retry/backoff/offset loop exactly as the upgrade job does.

Concretely:

1. **Browser → entry**: `POST /n/<A>/api/transfer/jobs { toNodeId: B, items: [{rootId, path}], destRootId, destPath, grant }`. The browser holds cookies for both A and B, so it can obtain the grant itself.
2. **Grant (this is the security-critical bit).** As established in §2.5, a user's cookie **does not survive a node→node hop** (`cookie` is in `BLOCKED_REQUEST_HEADERS`, `stream-targets.ts:25-32`), and `/api/mesh-internal/*` is authorized by the peer marker alone — i.e. *any* trusted mesh node could otherwise write files anywhere. So before starting the job the browser must mint a short-lived, single-purpose grant from **B**: `POST /n/<B>/api/transfer/grants {fromNodeId: A, destRootId, destPath, totalBytes, sha256}` → `{grantId, exp}` (2–5 min, one destination, one byte budget, bound to `fromNodeId`). A then presents `grantId` on every `/api/mesh-internal/transfer/*` call, and B checks `readMeshPeerMarker(req) === grant.fromNodeId`. This mirrors how `POST /api/rtc/authorize` mints a nonce bound to `{uid, rtcSession, fingerprint}` before the direct data channel is trusted.
3. **A runs the job**: for each item, `status()` on B → `runPush` with N ranged `forwardInternalHttp`-style streams. `forwardInternalHttp` (`forwarder.ts:236-268`) must gain `rawBody`/`onProgress`/`headers`, mirroring `forwardAuthorizedHttp` (`:271-350`) — a small, mechanical change.
4. **B receives** at `PUT /api/mesh-internal/transfer/:grantId?offset=&length=` → `ResumableSink` → on completion, hand the file to the existing `pushFileToDevice` if the destination root is an `ssh` device, or `rename` straight into place if it is `local`.
5. **Fallback for a legacy/unreachable B**: entry-brokered — the entry pulls from A and pushes to B using `forwardAuthorizedHttp` on both legs (exactly the remote-upgrade shape). Slower, but needs no new auth surface. Keep it as the compatibility path.

**Special cases worth short-circuiting:** if A === B, do a local copy. If the source root's device is `local`, read it with `openRange` instead of the current full-file rsync-to-tmpdir round trip (`pullFileFromDevice`, `device-storage.ts:397`) — that alone removes a full extra copy of every downloaded file. And note `enqueueDeviceJob` (`files/queue.ts:30`) serializes per device, so parallel streams must not each spawn an rsync against the same device.

**Folders**: `rsyncUploadArgs`/`rsyncCopyArgs` have no `-r`, so directory transfer must be expanded client-side or job-side into a file list (recursive `list`) and then run as N file jobs sharing one job record. Do not try to make rsync recursive here — the per-file offset/hash model is what makes resume work.

### 8.4 Job model and how progress reaches the browser

Follow the **upgrade precedent, upgraded one notch**:

- **Job registry on the source node**: `Map<jobId, TransferJob>` with a snapshot type mirroring `RemoteUpgradeJobSnapshot` (`remote-upgrade-job.ts:37-53`) — `{jobId, state, fromNodeId, toNodeId, items[], currentIndex, phase, transferredBytes, totalBytes, ratePerSec, etaSec, attempt, error, path:'direct'|'relay'}`. In-memory is acceptable and consistent with the rest of the codebase; durability comes free from the content-addressed `.part` files, so a restarted job resumes rather than restarts.
- **Progress to the browser: NDJSON, not a new ws kind.** `GET /n/<A>/api/transfer/jobs/:id/events` returning the existing `ndjsonResponse` (`apps/gateway/src/api/file-http.ts:88-116`) consumed by `readNdjsonStream`. This works unchanged through the forwarder (responses stream end-to-end, `stream-targets.ts:359-395`), in hub and relay mode alike, needs no new borsh kind / schema / dispatcher wiring, and matches what upload-commit and download-prepare already do. Add a plain `GET .../jobs` snapshot endpoint so the dialog can render on open and recover if the stream drops.
  - A new `KIND_TRANSFER_EVENT` in the `0x0800` range is possible (`kind.ts:63-65`) and would let the transfer list survive with the dialog closed, but it costs a schema + dispatcher + store on both sides. Only do it if the transfer list must live outside the dialog. If you go that way, copy `AgentWsHub`'s seq-numbered replay (`apps/gateway/src/agent/ws-hub.ts:61-141`).
- **Client store**: a small zustand store in `packages/panels/src/files/` (`transfer-jobs.ts`) holding `Map<jobId, TransferJobView>`, fed by the NDJSON stream, exposing rate/ETA computed by the shared `progress.ts`. `startTransferToast` becomes one *renderer* over that store rather than the owner of state, so the toast and the dialog's transfer list show the same rows.

### 8.5 Frontend shape

- Entry point: a new ellipsis `DropdownMenu` in `apps/fe/src/pages/DevicesPage.tsx:167-193` holding 恢复布局 + 文件传输 + 端口映射 (mirror `add-device-menu.tsx:78-110`; remember the `DropdownMenuGroup` wrapper rule).
- Dialog: `Dialog` from `@tmex/ui/dialog`, `className="flex max-h-[calc(100dvh-2rem)] w-full flex-col sm:max-w-5xl"` (wider than anything existing — current max is `sm:max-w-4xl`), body `grid grid-cols-1 gap-4 lg:grid-cols-2` per `telegram-bot-chats-modal.tsx:128`, each pane a node `Select` + breadcrumb + `ScrollArea` list, footer = the transfer list.
- Panes: fork `DirectoryEntryList` from `directory-picker-modal.tsx:176-228` into a multi-select, files+dirs variant; reuse `directoryBreadcrumbs` `:65`, `moveDirectoryHighlight` `:77`, the reducer `:108-136`, and `PICKER_SKIP_RENDER_THRESHOLD`/`SKIPPED_ROW_STYLE` `:149-151`. Selection state: `ReadonlySet<string>` + pure helpers, copying `bulk-actions-menu.tsx:21-50` / `nodes-management.tsx:135-152`.
- Node pickers: `useMeshNodes()` + `sortNodes` + `NodeBadge`; each pane builds its own `createNodeApiClient(nodeId)` and passes it to the query options (they already accept a `client`). No `NodeRuntimeScope` needed for listing.
- Transfer list: `formatBytes` / `formatRate` from `@tmex/shared` (add `formatEta`), `<Progress>` from `@tmex/ui/progress`, `direct`/`relay` badge reusing `files.transfer.pathDirect/pathRelay`.
- i18n: put new keys under `devices.transfer.*` (rest bundle) rather than `files.transfer.*` (core bundle), then `bun run build:i18n`.

### 8.6 Suggested ordering

1. Extract `packages/transfer` from the upgrade code **without behavior change**, re-point `remote-upgrade-job.ts` at it, and prove it green with `apps/gateway/src/system/*.test.ts`.
2. Re-point browser upload/download at the same engine (`transfer-session.ts` → `ResumableSink`; `upload-transfer.ts` → `runPush`). This delivers resumable browser uploads and sha256 verification, both missing today.
3. Add ranged/parallel support to the sink + `runPush({streams:N})` behind a capability bit, with relay-aware stream caps.
4. Add the node→node grant + `/api/mesh-internal/transfer/*` sink + job registry + NDJSON progress.
5. Build the dialog.
6. Tests: unit for sink/driver (port the upgrade cases), an integration test modeled on `large-push-harness.ts` for A→B over a relayed link, and a docker-harness scenario alongside `scripts/hub-e2e/run.sh` scenario 5.

### 8.7 Risks the planner should price in

- **Out-of-order ranges break incremental hashing.** Parallel streams force a final verification pass over the completed file; budget the extra read (~1 GB/s locally, negligible vs. the transfer, but not free).
- **`enqueueDeviceJob` serializes per device** — parallelism buys nothing against a single `ssh` device unless the engine bypasses rsync or opens N ssh sessions.
- **`forwardAuthorizedHttp` forces `attempts = 1` with a `rawBody`** (`forwarder.ts:309-310`); resume must be driven by re-opening at an offset, never by transport-level retry.
- **A relay RST looks like a clean body end** — the `expectedBytes` comparison (`upgrade-staging.ts:68-71`) is load-bearing and must survive the refactor.
- **`/api/mesh-internal/*` is peer-marker-only.** Do not ship a node→node file write without the grant, or any admitted node can write anywhere on any other node.
- **Relay quota interaction** with round-32 item 1: N streams × M concurrent transfers is exactly the shape that starves other tenants; the fair-share work and the parallel-stream work must be designed together.
- **No mesh files e2e exists** — the "文件多节点" safety net is the bash docker harness, not Playwright. Plan for harness work, not a quick spec.
