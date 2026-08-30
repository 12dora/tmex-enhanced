# T1 结果 — mesh forwarder replay-state 拆分 + 重复 helper + 死导出 + pending TTL

## 做了什么

对照 S1 finding 1 / Exact duplicated blocks / Dead-export candidates，以及 Z2 MEDIUM pending-stream TTL。

### 1. `StreamReplayState` 独立模块；`DEVICE_CONNECTED` 只解码一次

- 类迁到 `mesh/stream-replay-state.ts`。
- `noteInbound()` 返回 `{ kind, deviceId? }`：`DEVICE_CONNECTED` 在已解码的 envelope 上再解 payload，把 `deviceId` 一并带回。
- 删除 `noteDeviceConnected()`。`handleRemoteBytes` 用返回值做 `connectedForwarded` 去重，不再二次 `decodeEnvelope`。
- 损坏 payload：仍返回 `kind`、不带 `deviceId`、不推进 resume、帧仍转发给浏览器（与旧行为一致）。

### 2. `withPeerHandshakeTimeout()` 三处合一

`rtc-peer-manager.ts` / `dc-handshake.ts` / `peer-protocol.ts` 的 timeout Promise（清 timer + `PeerHandshakeError('timeout')`）抽到 `mesh/peer-handshake-timeout.ts`。

### 3. 共享 `jsonText()`

`uplink-client.ts` 与 `peer-manager.ts` 的 JSON 保真 stringify 抽到 `mesh/json-text.ts`。hub 的 `stringifyJson`（catch 循环引用）未动。

### 4. tunnel/manager 去掉四个内部 `export`

`PatchHostEnv`、`ReadHostEnv`、`writeNamedConfigYml`、`isAccessProtectedHealthResponse` 改为模块内符号。无仓内外部 importer。

### 5. pending-stream TTL 15s → 60s，可注入

默认 `DEFAULT_PENDING_FORWARD_STREAM_TTL_MS = 60_000`；`setPendingForwardStreamTtlMs` 供测试缩放。测试把 60s 缩到 40ms，等待超过旧 15s 对应的 10ms 后再 `open`，stream 仍在、pump 能转发。

## 文件

新建：

- `apps/gateway/src/mesh/stream-replay-state.ts` + `.test.ts`
- `apps/gateway/src/mesh/peer-handshake-timeout.ts` + `.test.ts`
- `apps/gateway/src/mesh/json-text.ts` + `.test.ts`

修改：

- `apps/gateway/src/mesh/forwarder.ts` + `.test.ts`（TTL / DEVICE_CONNECTED 去重 / 损坏帧）
- `apps/gateway/src/mesh/rtc/rtc-peer-manager.ts`
- `apps/gateway/src/mesh/rtc/dc-handshake.ts`
- `apps/gateway/src/mesh/peer-protocol.ts`
- `apps/gateway/src/mesh/uplink-client.ts`（仅 `jsonText` import；文件主体被并行 T2 抽 key-log）
- `apps/gateway/src/mesh/peer-manager.ts`（仅 `jsonText`）
- `apps/gateway/src/tunnel/manager.ts`（去 export）

## 行数 / CC

生产（不含测试、不含 T2 对 uplink-client 的大拆）：约 **−21 行**。`forwarder.ts` **1089 → 779**（&lt; 900）。

| 函数 | 前 CC / 行 / 位置 | 后 CC / 行 / 位置 |
|---|---|---|
| `handleRemoteBytes` | 10 / 23L / forwarder:271 | 10 / 23L / forwarder:272 |
| `noteInbound` | 10 / 31L / forwarder:652 | 10 / 35L / stream-replay-state:94 |
| `noteDeviceConnected` | 2 / 9L / forwarder:684 | 已删 |
| `withTimeout` ×2 + `waitWithTimeout` | 1 / 15L ×3 | `withPeerHandshakeTimeout` 1 / 19L |
| `jsonText` ×2 | 4 / 11L ×2 | 4 / 11L / json-text.ts:1 |
| `armPendingExpiry` | 1 / 7L | 1 / 7L（改用注入 TTL） |

## 测量

scratchpad：`t1-device-connected-decode.bench.ts`（500k 次 25B `DEVICE_CONNECTED` 帧，从 `apps/gateway` 跑以解析 `@tmex/shared`）。

| | Time | Per frame |
|---|---:|---:|
| Decode envelope+payload twice（旧） | 551.2 ms | 1.102 µs |
| Decode once（新 `noteInbound`） | 373.4 ms | 0.747 µs |

省 177.8 ms / 32.3%（约 0.355 µs/帧）。S1 基线是 0.729 µs/帧；同方向。

TTL：缩放 1500× 后 delay 15ms（旧 15s）仍 `open` 成功；若默认仍是 15s，注入 TTL 会变成 10ms，该测试会红。

## 验证

- `cd apps/gateway && bun test src/mesh src/tunnel` → **581 pass / 0 fail**（55 files）
- 本范围 `bunx tsc --noEmit -p .` **0 新错误**
- 整包 tsc 当前 **25**（基线 21；多出的在 hub/auth/tmux-client/telegram 等并行任务，T1 文件 0）
- `bunx biome check` 上述 14 个文件 → **clean**

RED：新模块不存在时 import 失败；TTL 默认 15s 时缩放测试会在 `open` 前丢掉 pending stream。

## 未做 / 风险

- `uplink-client.ts` 只改 `jsonText`；key-log 拆分是并行 T2，验证时曾短暂 `this.keyLog.reset` 未就绪，T2 完成后 uplink-client 42/42 通过。
- 更长 TTL 会让从未 `open` 的废弃 remote stream 多留 45s。浏览器 close 仍立即 `discardPendingStream`。
- 未动 `mesh-runtime.ts` / `address-class.ts` / `hub/**` / `auth/**` / `tmux-client/**`。
