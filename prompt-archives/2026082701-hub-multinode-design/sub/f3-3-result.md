# F3-3 结果 —— browser direct/bulk 评审修复

分支 `feat/hub-node`（worktree `/Users/konata/code/tmex-enhanced-wt-hub`）。对应 `sub/f3-review.md` 的
4 个 major + 1 个 minor 全部落实（blocker 属后端 B2-7，不在本任务范围）。

## 1. 协议变更（node 侧必须镜像）

`packages/shared/src/ws-borsh/schema.ts`，两个 struct **各追加一个末尾字段** `rtcSession: b.string()`：

```ts
export const CarrierSwitchSchema = b.struct({
  epoch: b.u32(),
  to: b.u8(),
  rtcSession: b.string(),   // 新增，追加在末尾
});

export const CarrierSwitchAckSchema = b.struct({
  epoch: b.u32(),
  rtcSession: b.string(),   // 新增，追加在末尾
});
```

语义：`rtcSession` = 发起本次切换的**直连 attempt** 标识（浏览器在 `POST /api/rtc/authorize`
与信令里用的同一个值，形如 `br:<32hex>`）。ACK 原样回显收到的值。空串 = 未携带。

node 侧需要做的（本任务未改 `apps/gateway/**`）：

1. `apps/gateway/src/mesh/rtc/carrier-switch.ts`
   - `attachDirect(session, carrier)` 需要拿到该 PeerConnection 对应的 `rtcSession`（浏览器直连来自
     `RtcPeerManager.acceptBrowser(rtcSession, …)`；node↔node 用 `peerRtcSession(self, peer)`），
     存进 `SwitchState`；
   - `sendSwitch()` 的 `encodePayload(CarrierSwitchSchema, {...})` 补上 `rtcSession`（拿不到时填 `''`）；
   - `handleAck(session, epoch)` 建议同时校验回显的 `rtcSession`，不匹配就当陈旧 ACK 丢弃。
2. `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts:338` 的 `attachDirect(session, carrier)` 透传 `rtcSession`。
3. `apps/gateway/src/ws/index.ts:458` 解 ACK 后把 `rtcSession` 一并传给 `handleAck`。
4. 相关测试里所有 `encodePayload(CarrierSwitchSchema/CarrierSwitchAckSchema, …)` 都要补字段，
   否则 tsc 报缺字段（`apps/gateway/src/mesh/rtc/carrier-switch.test.ts`、`rtc-loopback.integration.ts` 等）。

**当前状态**：`apps/gateway` 尚未打这个补丁，其 tsc / 测试会因为缺字段失败，属预期，由 node 侧任务收口。
浏览器侧对空串是宽容的（见下），但**老 node 完全不带该字段时 borsh 解码会失败**，切换帧会被整帧忽略——
两侧必须同版本发布。

## 2. 代码改动

### major 1：切换帧绑定 attempt（`packages/ws-client/src/carrier-switch.ts`）

- `attachDirect(carrier, { rtcSession })` 登记期望值（`expectedRtcSession`），并累加 `attachSeq`
  （本次 primary 会话里挂过几次直连）。
- `applySwitch()` 在 epoch 校验之后加 `matchesAttempt()`：
  - 宿主没登记期望值 → 不校验（兼容老宿主 / 老测试桩）；
  - `frame.rtcSession === expected` → 接受；
  - `frame.rtcSession === ''`（老 node）→ 仅当 `attachSeq === 1` 时接受，否则拒绝；
  - 其余一律忽略，`console.warn` 记录，**不回 ACK**、不切换、不排空缓冲。
- ACK 回显 `frame.rtcSession`（`encodeAck(epoch, rtcSession)`）。
- 载体消失（`handleDirectClose` / `abortDirect`）清空 `expectedRtcSession`；`closeDirect()` 另把
  `attachSeq` 归零（primary 断开 = 会话结束）。
- 透传链：`client.attachDirectCarrier(carrier, options?)` →
  `connection.ts` 的 `GatewayConnection.attachDirectCarrier(carrier, options?)` →
  `DirectCarrierController.mountCarrier()` 传 `{ rtcSession: attempt.rtcSession }`。

取舍：老 node（空串）在**重试过 attempt 之后**不再被接受，直连会退回 primary。这是刻意的——
空串无法区分 A/B 两次 attempt，宁可不切也不能把 A 的切换套到 B 上。

### major 2：bulk 操作级空闲超时（`packages/ws-client/src/direct/bulk-client.ts`）

- 新增 `DEFAULT_BULK_IDLE_TIMEOUT_MS = 30_000` 与 `BulkClientOptions.idleTimeoutMs`。
- `BulkChannelSession` 增加 `armIdle/touchIdle/disarmIdle` 看门狗，**收发双向续期**：
  入站合法控制帧 / 数据帧（`dispatch`）、出站数据帧发送成功（`sendData`）都会 renew，
  因此慢速大文件不会被误杀；通道关闭时自动解除。
- 上传：`ready()` 之后、发 `put` 之前 arm；超时 → 发 `{op:'abort'}` → `failReply(BulkTransferError('timeout'))`
  → 关通道（先 reject 再 close，保证抛出的是 `timeout` 而不是 `closed`）。
- 下载：`ready()` 之后、发 `get` 之前 arm；超时 → `fail(BulkTransferError('timeout'))`（内部会 abort + 关通道 + error 流）。
- 效果：连到「通道能开但没有 bulk 接线」的 node（即 blocker B2-7 的现网状态）时，面板 30 s 内收到
  `timeout`，走既有的整次回落 REST 路径，而不是永久挂起。

### major 3：入站分片上限（`packages/ws-client/src/direct/data-channel-carrier.ts`）

`FrameReassembler` 固定用 `maxMessageBytes: MAX_DC_MESSAGE_BYTES`（64 KiB）+ `maxFrameBytes: MAX_FRAME_BYTES`
（1 MiB）；`options.maxMessageBytes`（`sctp.maxMessageSize`）只用于计算**出站** `effectiveFragmentPayloadSize`。
超大入站消息 → `chunk-too-large` → `inbound chunk-too-large` → 载体自毁。

### major 4 + minor：`packages/panels/src/files/bulk-transfer.ts`

- 下载 `drainBulkDownload()` 累计 `received`：
  - 任一帧令 `received > size` → 立即抛错并 `reader.cancel()`（触发向 node 发 `{op:'abort'}`）；
  - 正常 EOF 但 `received !== size` → 同样当 bulk 失败。
  两种情况都走既有 catch：`DELETE /api/files/download/<id>` 回收 + 重新 `prepare` 走 REST，
  截断内容绝不会作为结果返回。
- 上传：用 `onProgress` 跟踪 `sentBytes`，`{ok:true}` 但 `sentBytes !== total` 时抛
  `bulk_size_mismatch` → `BulkStageError` → 回落 REST，不 commit 截断文件。
- minor：新增 `rethrowIfCanceled(err, signal)`——清理期间 `signal.aborted` 时抛标准 `AbortError`
  （原错误本身是 AbortError 则原样上抛），上传/下载两处 catch 都改用它。

## 3. 测试

新增 18 个用例（ws-client +13，panels +5），另更新 shared 的 CARRIER_SWITCH roundtrip。

- `carrier-switch.test.ts`：匹配才切换且 ACK 回显；**attempt A 的迟到 `to:'direct'` 在 B 挂上后被忽略**
  （不切换、不回 ACK）；迟到帧不会排空 B 的缓冲；别的 attempt 的 `to:'primary'` 不生效；
  老 node 空串在唯一 attempt 时接受、重挂后拒绝；宿主未登记时不校验。
- `client.test.ts`：`attachDirectCarrier(carrier, {rtcSession})` 后别的 attempt 的切换帧不生效、不回 ACK。
- `bulk-client.test.ts`（用 `ManualClock` 注入定时器，确定性）：上传不回 `{ok}` → abort + `timeout` + 关通道；
  上传每帧续期（累计 80 s 不误杀）；下载不发数据 → abort + `timeout`；下载每帧续期。
- `data-channel-carrier.test.ts`：`maxMessageBytes: 256 KiB` 时入站 64 KiB+1 仍报 `inbound chunk-too-large`
  并关闭载体；出站分片仍按协商值。
- `bulk-transfer.test.ts`：下载超量 → `cancel()` + REST 回落；提前 EOF 字节不足 → REST 回落；
  上传送出字节不足 → REST 回落且只 commit 一次；上传/下载清理期间取消 → `AbortError`。
  （`fakeBulk` 默认 upload 改为上报满进度，配合新的字节核对。）

验证结果（`bun test` / `bunx tsc --noEmit`）：

| 包 | 测试 | 基线 | tsc |
| --- | --- | --- | --- |
| ws-client | 222 pass / 0 fail | 209 | 0 |
| panels | 217 pass / 0 fail | 212 | 0 |
| shared（`src/ws-borsh`） | 83 pass / 0 fail | — | 0 |

`biome check` 对改动文件干净。

## 4. 越界说明与风险

- 文件范围外另动了两处（都在 ws-client 内、为透传 `rtcSession` 所必需）：
  `packages/ws-client/src/connection.ts`（`attachDirectCarrier` 增加可选第二参并转发）、
  `packages/ws-client/src/index.ts`（导出 `AttachDirectOptions` 类型）；
  另在 `direct/test-fakes.ts` 的 `FakeConnection` 记录 `attachedSessions`（测试桩）。
  参数是可选的，实现方不传也仍然类型兼容，不影响 F4-5 的 `apps/fe`。
- `biome check --write` 曾顺手改了不属于本任务的 `packages/panels/src/files/rsync-install-flow.ts`
  的 import 顺序，已手工还原，未提交任何 git 状态变更。
- 风险：`CarrierSwitch*` 是**破坏性线格式变更**，node 与浏览器必须同版本；node 侧补丁落地前
  `apps/gateway` 编译不过（见第 1 节清单）。
