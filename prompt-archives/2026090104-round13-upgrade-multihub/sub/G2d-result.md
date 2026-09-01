# G2d result — RV4 mesh-side fixes (2, 3, 5, 6, 7, 8, 9)

## Fix mapping

| Item | Status |
|---|---|
| RV4-2 blocker — global candidate ordering + probe when self is not index 0 | Done |
| RV4-3 blocker — dual-role standby local key-log gate from live hub mode | Done |
| RV4-5 should-fix — mesh server-socket backpressure (`-1` pause/`0` close / 1 MiB skip) | Done |
| RV4-6 should-fix — advertisement reflects live `hub.mode()` / `writerEpoch()` | Done (poll path; see note) |
| RV4-7 should-fix — CA bootstrap requires `keyCertSign` when keyUsage present | Done |
| RV4-8 should-fix — hub URL logs print origin only (`redactUrl`) | Done |
| RV4-9 should-fix — rate-limit try/failover/switch-back/failed as state transitions | Done |

未改：`src/hub/**`、`packages/shared/**`、`src/system/**`、`src/mesh/integration/**`、`packages/app/**`、`apps/fe/**`。无 git 操作。

## RV4-2 — candidate ordering

`mergeUplinkCandidates()` 先去重收集 stored + unmatched seeds（seeds 仍是 `mode:'active'`、`writerEpoch 0`、`priority 1000+i`），再 **全局排序**：active（epoch desc, priority asc）→ standby（priority asc）→ 其它 mode。来源类别不再压过 mode/epoch/priority。

性质：新 standby 只有自身 stored 行 + `TMEX_HUB_URL` seed 时，seed active 排在 own standby 之前；pool 先拨 seed，self 只作 fallback。挂在 self（index > 0）时 `syncProbe()` 与其它非首选候选相同，会启动 preferred probe。

## RV4-3 — dual-role standby local-write gate

`AuthRoutesDeps.hubMode?: () => HubMode | null`，由 `mesh-runtime` 注入 `() => hub?.mode() ?? null`，经 `mesh-http` 传到 AuthRoutes。

`refuseIfAttachedNotWriter()`：本进程有 hub 角色且 **live mode === `standby`** 时，即使 `attachedHub() === null` 也 `409 HUB_NOT_WRITER`（writer 字段来自 `pickWriterHub`）。dual-role `active` 仍本地 apply；plain node / standalone 不走该围栏（unknown attach 保持原行为）。

四组合均有测试。

## RV4-6 — live mode advertisement

`hubRoleAdvertisement(config, caFingerprint, liveHub?)` 读 `liveHub.mode()` / `liveHub.writerEpoch()`，statusProvider 传入 `stores.hub`。`setMode('standby')` 后下一次 `sendStatusIfChanged()` 带出 `standby`。

**Note（未改 `src/hub/**`）：** `HubRuntimeOptions` 没有通用变更 hook。G3c 的 `UplinkServerOptions.onModeChange` 在 `HubRuntime` 构造里已写死为 `peerPoller.pollNow()`，mesh-runtime 订阅不到。fencing 路径因此不会立刻推 `node.status`；下一次 status tick（promote、TLS poll、显式 `sendStatusIfChanged`）会带上 live mode。

`mesh-runtime.websocket.drain` 接到 `http.handleWebSocket.drain`（assemble 已调用它）。未重排 `new HubRuntime({...})` 块。

## RV4-7 — CA keyCertSign

`parseSingleCaCertificate`：`keyUsage` 存在（`X509Certificate.keyUsage` 或 DER 解析，Bun 的 getter 常为 `undefined`）且不含 `keyCertSign` → `ca_no_key_cert_sign`；然后再要求 `ca === true`。CA:true + KU=digitalSignature 的 PEM 被拒绝。无 KU 扩展的 CA 仍接受。

## RV4-8 / RV4-9 — log hygiene + volume

`redactUrl()`：`URL.origin`（strip userinfo/query/fragment）。所有 `[uplink]` hub URL 行使用 origin。

try / failover / switch-back / candidate-failed 按 `(url, kind)` + `(index, error, transport)` 限流，60 s 内相同状态不打。try/failover/switch-back 的 error 不参与比较（避免 fail 后的重试再打 try）。10 次相同失败 → ≤ 2 行。

## RV4-5 — mesh WS backpressure

- `MESH_FORWARD_WS` remote→browser：`send() === -1` 暂停并排队，`drain` 后冲刷；`=== 0` 以 `1011 forward-ws-closed` 关掉浏览器侧。
- `/mesh/ws` 广播与 ENROLL_REDEEMED：`getBufferedAmount() > 1 MiB` 跳过该 client（每 socket `console.warn` 一次）；`send() === 0` 以 `1011 mesh-ws-closed` 关闭。`undefined`/正数仍视为成功（兼容旧 fake）。

`MeshServerWebSocket.getBufferedAmount?()`、`MESH_WS_BACKPRESSURE_LIMIT_BYTES` 加在 `mesh-deps.ts`。

## Files touched

- `apps/gateway/src/mesh/uplink-pool.ts` / `.test.ts`
- `apps/gateway/src/mesh/auth-routes.ts` / `.test.ts`
- `apps/gateway/src/mesh/mesh-runtime.ts` / `.test.ts`（advertisement + `hubMode` 接线 + `websocket.drain`；未重排 HubRuntime 块）
- `apps/gateway/src/mesh/mesh-http.ts`（`hubMode` + `handleWebSocket.drain`）
- `apps/gateway/src/mesh/forwarder.ts` / `.test.ts`
- `apps/gateway/src/mesh/mesh-routes.ts` / `.test.ts`
- `apps/gateway/src/mesh/mesh-deps.ts`（`getBufferedAmount?`、`MESH_WS_BACKPRESSURE_LIMIT_BYTES`）

## Verification

| Check | Result |
|---|---|
| owned 5 suites (`uplink-pool` `auth-routes` `mesh-runtime` `forwarder` `mesh-routes`) | **186 pass / 0 fail** |
| `cd apps/gateway && bun test src/mesh` | **673 pass / 2 fail** — 失败在 `src/mesh/integration/dc-http-bulk.integration.test.ts`（1 MiB mux DATA 重组，属禁止改的 integration / 并发 agent RV4-4），不是本任务文件 |
| `bunx tsc --noEmit -p .`（apps/gateway） | **0 errors** |
| `bunx biome check` 本任务 12 个文件 | **clean**（`--write` 只动了 `uplink-pool.ts` 换行） |

## Commander

1. **Hub fencing → 立刻 `node.status`：** 需要 `HubRuntimeOptions`（或 UplinkServer 可叠加的）mode-change 回调。当前构造把 `onModeChange` 独占给 peer poller，本任务不能改 `src/hub/**`。
2. 全量 `src/mesh` 的 2 个 fail 在 integration 1 MiB 帧，不要算进本任务。
3. `openForwardWs` 测试夹具原先 `send() { return 0 }`（返回值被忽略）；现在 `0` 表示连接已关，夹具改为返回 `byteLength`。

## Open risks

- Bun `X509Certificate.keyUsage` 经常是 `undefined`，所以 RV4-7 额外从 DER 解析 KU。Node 的 getter 若将来填上，行为一致。
- fencing 后最多等到下一次 status tick 才广告 `standby`（默认 TLS poll 10 min）。写入口仍由 live mode / `isWriter()` 拒绝。
- `/mesh/ws` 在 `buffered > 1 MiB` 时丢该 client 本帧，不排队；慢浏览器会丢 node event，但不会被 Bun fatal close。
