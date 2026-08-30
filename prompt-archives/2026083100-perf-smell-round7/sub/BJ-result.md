# BJ 结果：RTC inbound 统一解码 + 四项清理

## Claim 核实

五条 claim 均在改代码前对照源码与全仓 importer 核实，全部成立。

1. **RTC 双路径解码（成立）**  
   `mesh-runtime.ts` 的 `deliverInbound` 原先 `Buffer.from(bytes)` 后调用 `handleMessage`；`handleMessage` 再 `checkMagic` + `decodeEnvelope` + `handleDecodedEnvelope`。mux/WS stream 已在 `stream-targets.ts` 解码一次后走 `onDecodedEnvelope`。RTC 仍走另一套 bytes→decode 入口。  
   补充：当前 RTC 路径本身是「拷贝 + 一次 decode」，不是 envelope 被 decode 两次；问题是未与 mux 统一入口，协议校验 / payload 所有权 / 坏帧处理要维护两套。

2. **`stream-replay-state` 四处 decode try/catch（成立）**  
   `noteOutbound` / `noteInbound` / `rewriteQueuedFrame` / `paneSubPayloads` 各自包一层 `decodeEnvelope`。各点 fallback 不同，`rewriteQueuedFrame` 坏帧必须返回原始 `bytes` 引用。

3. **external-detect 死 API + 重复投影（成立）**  
   `detectExternalCloudflared`、模块级 `cache`、`resetExternalDetectCache` 仅在本文件定义；`toExternalStatus` 无调用方；`manager.ts` 另有一份 `EMPTY_EXTERNAL` 和 `externalStatus()`。`ExternalTunnelDetector` 已用 `localCache`。gateway 非公开包。

4. **`decodeEnvelopeAndPayload` 无 importer（成立）**  
   仅 `codec.ts` 定义 + `ws-borsh/index.ts` re-export。`packages/shared` 为 workspace-private。

5. **access-rules 旧名仅 alias（成立）**  
   仓库只 import `toCloudflareInclude` / `fromCloudflareInclude`（`access-client.ts` / `access-client.test.ts`）。

未改：`apps/gateway/src/config.ts`、`mesh/mesh-deps.ts`、`packages/app/**`、`packages/shared/src/roles*`。

## 改动

### 1. RTC inbound 单次解码

- `WebSocketServer.deliverRtcInbound(session, bytes)`：`checkMagic` → `decodeEnvelope` 一次 → 按所有权拷 payload → `handleDecodedEnvelope`。坏帧仍 `sendError`（与原 `handleMessage` 一致：缺 magic 为 `Missing magic bytes`，其余用 `WsBorshError`），外层空 `catch` 吞异常；不 RST。
- `handleMessage` 对 binary 委托 `deliverRtcInbound`（浏览器 WS 与 RTC 共用）。mux 仍走已解码的 `onDecodedEnvelope`。
- `mesh-runtime` 的 `deliverInbound`：校验绑定后 `gateway.wsServer.deliverRtcInbound(session, bytes)`，不再 `Buffer.from` + `handleMessage`。

Payload 所有权：`payload.buffer !== 入站 buffer && byteOffset === 0 && byteLength === buffer.byteLength` 才视为已持有。单纯 owned 启发式会把「覆盖整个 ArrayBuffer 的视图」当成已持有；RTC 缓冲可能被回收，必须再排除仍指向入站缓冲的情况。测试用 `decodeEnvelopeView` 模拟零拷贝后再 `fill` 入站缓冲。

`ws/index.ts` 保持 898 行（900 上限）；`mesh-runtime.ts` 1343 行（allowlist 1347）。未把大段逻辑塞进 `mesh-runtime`，避免撑破文件行数门禁。

### 2. `tryDecodeEnvelope`

私有方法，四处复用。fallback 不变：`noteOutbound` 直接 return；`noteInbound` 返回 `{ kind: null }`；`rewriteQueuedFrame` 返回原始 bytes；`paneSubPayloads` 推 `null`（payload 解码失败仍 catch → null）。

### 3. external-detect / manager

删除 `detectExternalCloudflared`、模块级 cache、`resetExternalDetectCache`。`invalidate()` 只清实例 `localCache`。  
`EMPTY_EXTERNAL` 升为 `ExternalDetection`（含 `tokenAccountId: null`），manager 直接 import。  
`status()` 调用 `toExternalStatus(this.lastExternal)`，删除 manager 内重复的 `externalStatus()`。

### 4. 删除 `decodeEnvelopeAndPayload`

`codec.ts` 函数与 `index.ts` re-export 均删。保留未使用的 `DecodedEnvelope` 类型导出（未在任务要求内删除）。

### 5. access-rules

实现直接挂在 `toCloudflareInclude` / `fromCloudflareInclude` 上，去掉 `rulesToCfInclude` / `rulesFromCfInclude` 导出名。

## 设计取舍

- 坏帧语义对齐原 `handleMessage`（`checkMagic` 在 `decodeEnvelope` 之前），而不是 mux 的 RST `invalid-ws-frame`。短帧 / 缺 magic 仍是 `Missing magic bytes`，不是 decode 抛出的 `Envelope too small` / `Invalid magic bytes`。
- 浏览器 WS 的 `handleMessage` 也走同一入口：decodeEnvelope 本身已拷 payload，owned 检查对常规路径不会多拷；与 RTC 一致。
- 未改 `onDecodedEnvelope` 的 mux owned 启发式（mux 入站已在 stream-targets 用 `decodeEnvelope` 拷过）。

## 风险

- `handleMessage` 现在对所有 binary 帧做 buffer 身份检查；若未来 `decodeEnvelope` 改为零拷贝且 payload 看起来 owned，依赖 identity 检查才能保住异步 handler。已用 `decodeEnvelopeView` 回归覆盖。
- 删除的函数若有仓库外调用会编译失败。gateway / `@tmex/shared` 均非发布 API，全仓已搜过。
- `EMPTY_EXTERNAL` 现含 `tokenAccountId`；`detectUncached` 展开它时多一个字段，对 `DetectedTunnel` 调用方无害。

## 测试

新增 / 扩展：

- `inbound-frame.test.ts`：RTC 只 decode 一次且不走 `handleMessage`；坏帧错误帧与 `handleMessage` 逐字段相同；异步持有 payload 在入站缓冲被 `fill` 后仍稳定。
- `stream-replay-state.test.ts`：`rewriteQueuedFrame` 对无法解码的帧返回同一引用。
- `external-detect.test.ts`：`invalidate` 丢实例缓存；`toExternalStatus` 投影并拷贝 `hostnames`。
- `access-rules.test.ts`：`toCloudflareInclude` / `fromCloudflareInclude` 往返。

### 数量

| 包 | 基线 | 本次 | 说明 |
|---|---|---|---|
| `apps/gateway` bun test | 2854 pass / 0 fail | **2861 pass / 0 fail** | +7 条本任务测试 |
| `apps/gateway` tsc | 21（既有） | **21** | 无新增；无一落在本任务文件 |
| `packages/shared` bun test | 387 pass / 0 fail | **392 pass / 0 fail** | 本任务未加 shared 测试（只删死导出）；多出的 5 条应为并行 agent |
| `packages/shared` tsc | 0 | **0** | |

`bunx biome check` 覆盖全部改动文件：通过。  
`bun scripts/complexity/gate.ts`：通过。`handleMessage` CC 下降、`manager.ts` 文件行数 1255→1185，allowlist 未改（交指挥官收紧）。
