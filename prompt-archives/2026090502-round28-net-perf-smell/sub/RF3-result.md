# RF3 结果：mesh 退役硬截止 + 浏览器分片数上限

## 1. 心跳失活连接的退役硬截止（P1）

- `apps/gateway/src/mesh/peer-reconnect-wake.ts`：把已有的 `DRAIN_DROP_REASONS`（`missed-pong` / `idle`）暴露为 `isDrainRetireReason()`，保持单一来源。
- `apps/gateway/src/mesh/peer-manager.ts:maybeFinishRetire()`：把 `elapsed >= PEER_RETIRE_MAX_MS`（30 s）的硬截止判断**提到 `streams > 0` 之前**，且只对 drain 类退役（`missed-pong` / `idle`）生效。到期直接 `finishRetire(live, reason)`，以原始 reason 关闭旧 session，在途流拿到关闭通知走既有 failover。`replaced` 退役语义完全不变（仍受 `streams > 0` 保护，静默窗口/最小窗口逻辑照旧）。
- 退役定时器本身早已按 `retiredAt + PEER_RETIRE_MAX_MS` 起 interval，无需新常量，也无需新增 `LivePeer` 字段。
- 测试：`peer-manager.test.ts` 新增「missed-pong retire hits the hard deadline even while a stream never ends」——流永不结束，推进到 30 s 前 1 ms 仍未关，再推进 1 ms 后 `local.closed.reason === 'missed-pong'` 且 `outbound.closed` 兑现。回归验证：临时把该分支短路后此用例超时失败，恢复后通过。

## 2. 浏览器方向的分片数上限（P1）

- `packages/shared/src/link/fragment-core.ts`：新增 `RECEIVER_MAX_FRAGMENTS = 17`（与 ws-client `ceil(1 MiB / FRAGMENT_PAYLOAD_SIZE)` 一致）和 `pickFragmentPayloadSize(payloadLen, preferred, max)`：帧 ≤ `preferred × 17` 用 16 KiB；否则放大到 `ceil(len / 17)`，上限为通道 `max`（≤ 64 KiB−8）。
- `apps/gateway/src/mesh/rtc/fragmenter.ts`：`fragmentSizing(maxMessageSize)` 返回 `{ preferred, max }`（`fragmentPayloadSize()` 保留为 `preferred` 的薄封装）；`fragmentFrame()` 增加第 4 参 `maxPayloadSize`，内部走 `pickFragmentPayloadSize`。
- `data-channel-link.ts` / `data-channel-carrier.ts`（含浏览器会话的 `DataChannelCarrier`）改存 `sizing`，全部发送点传 `preferred + max`。
- mux 帧上限 1 MiB + 10 B → `ceil(1048586 / 17) = 61682 ≤ 65528`，即**任何合法帧现在都 ≤ 17 片**；超出 17 × 64 KiB 的输入（协议上不存在）仍与旧 64 KiB 代码一样按 `fragmentBytes` 切多片，行为未变。
- **`bulk.ts` 未改**：`BULK_FRAME_SIZE = 16 KiB` 是裸字节流的分块尺寸（无分片头、接收端只有 64 KiB/条的上限），不受 17 片约束，改动无收益。
- 测试：`fragmenter.test.ts` 新增 301,581 字节帧用例——片数 ≤ 17、每片 ≤ 64 KiB，并同时用 gateway `FrameReassembler` 和按 ws-client 接收端参数（`maxTotal: 17`、1 MiB、64 KiB）构造的 `FragmentAssembler` 复原成功（gateway 不依赖 `@tmex/ws-client`，故复刻其配置而非直接 import）；另有小帧仍走 16 KiB、边界长度全覆盖 ≤ 17 片、小 `maxMessageSize` 通道守住自身上限三个用例。`fragment-core.test.ts` 新增 `pickFragmentPayloadSize` 四个用例（含 `RECEIVER_MAX_FRAGMENTS` 与浏览器推导式一致的断言）。
- 顺带修正：原 `rejects a fragment whose payload exceeds payloadMax` 用例靠 `fragmentFrame` 不夹取超限 payloadSize 来造样本，现改用 `fragmentBytes` 直接构造，被测的接收端行为不变。

## 验收

- `apps/gateway`：`bun test src/mesh` → 1281 pass / 0 fail。
- `packages/shared`：`bun test src/link` → 74 pass / 0 fail。
- `packages/ws-client`：`bun test` → 407 pass / 0 fail（未改动该包）。
- `bunx tsc --noEmit` 对 `apps/gateway`、`packages/shared`、`packages/ws-client` 均无错误。
- `bunx biome check` 对本轮改动的 11 个文件干净；`bun scripts/complexity/gate.ts` 中本人文件无违规、未改 allowlist（剩余 2 项违规在 `apps/fe/.../use-node-upgrade.ts` 与 `apps/gateway/src/tunnel/manager.ts`，属其他 agent 范围）。
- 未执行任何 git 状态变更，未跑 e2e。
