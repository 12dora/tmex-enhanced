# B2-1-fix 结果 — `apps/gateway/src/hub/` 安全审查修复

范围：`apps/gateway/src/hub/**` + `UserStore.invalidateUnusedEnrollmentTokens`。审查 `b2-1-review.md` 全部条目已按「先失败后通过」补回归并落地。`append` 原子消费返回值原先已接 `consumeEnrollmentToken`（7fe11d8），本次补上同一事务里的 `createNode`。

## 审查项 → 改动 → 测试

### 1. Revoke 必须带签名 `revoke-node` 记录

- `POST /api/hub/nodes/:id/revoke` 体改为 `{ bytes, sig }`（b64url，用户签名的 key-log 记录）。
- 先解码：`type === 'revoke-node'` 且 payload `node_id` 与 URL `:id` 一致，再 `keyLogSource.append`。
- 仅成功后、仅对该记录的 `revokeSessionsVia` 节点：`nodes.status='revoked'`、关 uplink、清 RTC、广播。无会话-only 吊销路径。
- 测试：无 body → 400 且 status 仍 `enrolled`；合法签名记录 → 200、cert `revokedLogSeq` 非空、链路 `revoked`。

### 2. `HubKeyLogSource.append` 必须是真实 validating apply

- 返回值改为 `{ ok:true, seq, hash, effects, record:{ type, payload } } | { ok:false, error }`。
- 新增 `createHubKeyLogSource(service, keyLogStore)`，内部走 `UserKeyService.apply` + `decodeKeyLogRecord`。
- 删除 `MemoryHubKeyLog` 随机字节假实现；hub 测试一律 `createHubTestStack(test-db)` + `@tmex/shared/auth` 组记录。
- 测试：错钥 `admit-node` / `revoke-node` / `rotate-root`、错 seq、错 epoch 均 `ok:false` 且 head 不变；合法 `revoke-node` 经 `key.log.append` 断开目标并拒绝重连。

### 3. Redeem 事务 + epoch + 作废 token

- `consumeEnrollmentToken` 与 `createNode` 包在 `db.transaction`；消费失败仍返回 `reused`。
- 消费前读用户，`authorization.root_epoch !== user.rootEpoch` → 400 `epoch_mismatch`（排在 expiry 之前）。
- `UserStore.invalidateUnusedEnrollmentTokens(userId, now)`：将该用户未使用且未过期 token 的 `expiresAt` 置为 `now`。
- `rotate-root` / `reset-root` 成功 append 后调用该方法。
- 测试：store 单测（只动本用户未用 token）；HTTP：create enrollment → rotate-root → redeem `epoch_mismatch`，token 已作废。

### 4. Passkey enrollment 授权

- 先 `decodeAuthorization`。`signer='root'`：64B Ed25519 + 当前 root pk。`signer='passkey'`：`makeVerifyPasskeyAssertion(userStore)`，challenge=`sha256(authorization_bytes)`。
- 测试：真实 ES256 authenticator 的 passkey enrollment 201；root enrollment 仍 201；假 assertion 400。

### 5. Revocation 立刻作用 live 状态

- 每次成功 append 后 `UplinkServer.applyAppendEffects`：`revokeSessionsVia` → 标 revoked、关 uplink、清 RTC、广播；`rotate-root`/`reset-root` 作废 token；扫描该用户仍在线节点，cert 已吊销/缺失则同样驱逐。
- 每个 ctl handler 与 `onIncomingStream` 再查 live 身份 cert 未吊销。

### 6. Relay 隔离用 cert.userId

- 发起方只用 `live.userId`（来自已认证 cert）。目标必须有未吊销 `node_certs` 且 `targetCert.userId === live.userId`。`nodes.userId` 不参与授权。
- 测试：把目标 `nodes.userId` 改成另一用户后，凭 cert 仍可 relay；无 cert 的 `nodes` 行、跨用户 cert 均 RST。

### 7. RTC 注册

- `registerRtcSession({ userId, browserSessionId, fromNodeId, toNodeId, ttlMs=2min })` → 服务端 `randomBytes(16)` b64url id；双方 cert 必须属于 `userId` 且未吊销。
- 转发时再验 `reg.userId === live.userId` 且双方 cert 仍有效。Map 上限 1024；过期 / 任一侧链路关闭 / 节点吊销时删除。
- 测试：路由 + spoof `from:node` 拒绝；跨用户注册返回 `null`；TTL 后不再转发；满员拒绝。
- **未**在每次成功转发后立刻删 session（SDP offer/answer/candidates 需要多次）。浏览器会话结束时由上层 `unregisterRtcSession`。

### 8. Auth timeout + stop

- 跟踪全部 `accepted` 链接；默认 10s（`HUB_AUTH_TIMEOUT_MS`，可注入）未 `auth.response` → `auth-timeout`。
- `stop()` 关闭未认证链接；timer 在 auth / close / replace 时清理。
- 测试：40ms 超时；`stop()` 对未认证链路给出 `hub-stop`。

### 9. Heartbeat

- 仅当存在 outstanding ping 时，匹配的 `pong` 才把 `misses` 清零。`misses >= limit` 关链路。
- 测试：原超时广播仍绿；持续 `node.status`（无 pong）仍 `heartbeat-timeout`。

### 10. Per-link ctl 串行

- 每条 link 一条 Promise chain；handler throw → `ctl-error` 关链路。
- 测试：连续两条合法 `clear-totp` 不 await 发出，head 前进 2。

### 11. Hostile ctl 边界

- 帧 ≤ 64 KiB；JSON 深度 ≤ 8；数组 ≤ 1024；字符串 ≤ 4 KiB；`endpoints` ≤ 32；`seq` 为安全整数或 ≤20 位十进制且 ≤ 2^64-1。
- 违规关链路 `protocol_error`（不再静默丢弃）。
- 测试：oversized inventory、深层 JSON、`from_seq = 2^64`。

## 文件清单

| 文件 | 变更 |
|---|---|
| `hub/types.ts` | `HubKeyLogSource.append` 新返回值；`HUB_AUTH_TIMEOUT_MS` / `HUB_RTC_*` |
| `hub/hub-key-log-source.ts` | **新** `createHubKeyLogSource` |
| `hub/uplink-protocol.ts` | ctl 边界 + 严格 u64 seq |
| `hub/uplink-server.ts` | 认证超时、心跳、ctl 队列、effects、relay/RTC 隔离 |
| `hub/hub-runtime.ts` | 签名 revoke、passkey enroll、redeem 事务+epoch |
| `hub/index.ts` | 导出新类型/常量/工厂 |
| `hub/hub-test-helpers.ts` | 真实 `UserKeyService`；删假 log |
| `hub/*.test.ts` | 上列回归 |
| `auth/user-store.ts` | `invalidateUnusedEnrollmentTokens` |
| `auth/user-store.test.ts` | 对应单测 |

## 对 B2-3 的签名变化（精确）

```ts
// HubKeyLogSource.append — 旧: {ok:true, seq, hash} | {ok:false, error}
type HubKeyLogAppendSuccess = {
  ok: true
  seq: bigint
  hash: Uint8Array
  effects: KeyLogEffect[]
  record: { type: KeyLogType; payload: Uint8Array }
}

function createHubKeyLogSource(
  service: UserKeyService,
  keyLogStore: KeyLogStore,
): HubKeyLogSource

new HubRuntime({
  db, userStore, keyLogSource, config, authenticate,
  now?, heartbeatIntervalMs?, heartbeatMissLimit?,
  authTimeoutMs?,          // 新增，默认 10_000
})

// 旧: registerRtcSession(rtcSession: string, { fromNodeId, toNodeId }): void
registerRtcSession(input: {
  userId: string
  browserSessionId: string
  fromNodeId: string
  toNodeId: string
  ttlMs?: number           // 默认 120_000
}): string | null          // 服务端随机 id；满员/跨用户/无 cert → null

UplinkServer.applyAppendEffects(userId, result: HubKeyLogAppendSuccess): Promise<void>

UserStore.invalidateUnusedEnrollmentTokens(userId: string, now: number): number
```

HTTP：

- `POST /api/hub/nodes/:id/revoke` 体 **必须** `{ bytes, sig }`（b64url）。不再接受空 body。
- `POST /api/hub/enrollments` 的 `authorization_sig` 不再强制 64 字节（passkey 为 Borsh `PasskeyAssertion`）。
- redeem 新增 400 `epoch_mismatch`。

Assembler 注入：`keyLogSource: createHubKeyLogSource(userKeyService, keyLogStore)`。`/api/rtc/authorize` 调 `hub.registerRtcSession({ userId, browserSessionId, fromNodeId, toNodeId })`，把返回的 id 交给浏览器。

## 测试

```
cd apps/gateway && bun test src/hub
  27 pass  0 fail  206 expect() calls
  Ran 27 tests across 4 files. [1031.00ms]

cd apps/gateway && bun test src/auth
  46 pass  0 fail  614 expect() calls
  Ran 46 tests across 10 files. [1.99s]

cd apps/gateway && bun test src/hub src/auth
  73 pass  0 fail  820 expect() calls
  Ran 73 tests across 14 files. [2.78s]
```

biome：`apps/gateway/src/hub` + `user-store.ts` + `user-store.test.ts` — `Checked 15 files. No fixes applied.`

## tsc

| | 数量 |
|---|---|
| 基线 gateway | 23 |
| 本次全量 gateway | 52（全在并发 mesh/push/tmux/telegram/ws） |
| `src/hub/**` | **0** |
| `src/auth/user-store.ts` | **0** |

本范围未引入 tsc 错误；全量数字上涨来自并发模块。

## 未能做的 / 协调者必须做的

1. **B2-3 接线**：用 `createHubKeyLogSource(userKeyService, keyLogStore)` 注入 `HubRuntime`；RTC authorize 改为消费新 `registerRtcSession` 返回值。
2. **RTC forward-complete**：未在每条 signal 转发成功后删 session（会打断 SDP 往返）。TTL / 链路关闭 / 撤销已覆盖。浏览器会话结束应调 `unregisterRtcSession`。
3. **未改** `mesh/**`、`ws/**`、`runtime.ts`、`packages/**`。

未碰生产 tmex、默认 tmux session `tmex`、`bun install`、生成文件。
