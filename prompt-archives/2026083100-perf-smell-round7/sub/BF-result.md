# BF 结果：消除 mesh WS 入站双 decode + 全量拷贝

## 证据核对

任务描述属实，按符号重定位后路径如下。

1. `acceptWsStream`（`apps/gateway/src/mesh/stream-targets.ts`）对每帧调用 `wsBorsh.decodeEnvelope(value.bytes)` 只做合法性校验，结果丢弃，再把原始 `value.bytes` 交给 `attached.onMessage`。
2. `attachStreamSession.onMessage`（`apps/gateway/src/ws/index.ts`）执行 `Buffer.from(bytes)`（整帧拷贝），再进 `handleMessage`。
3. `handleMessage` 再次 `wsBorsh.decodeEnvelope(data)`，然后 `void handleBorshMessage(...)`。
4. `packages/shared/src/ws-borsh/codec.ts` 已有 `decodeEnvelope`（zorsh deserialize，payload 独立缓冲）和 `decodeEnvelopeView`（payload 为入参 `subarray`）。`codec-view.test.ts` 确认 `decodeEnvelope(frame).payload.buffer !== frame.buffer`。

改前每条 mesh 入站帧：1 次整帧 `Buffer.from` + 2 次 envelope deserialize（含 2 次 payload 拷贝）。

mux 层 `FrameDecoder.take()` 已对 DATA payload `slice()`，当前入站 `value.bytes` 并非循环复用池；但 `handleBorshMessage` 是 `async` 且 `void` 派发，canonical `TerminalInput` 会在 `await bootstrapInitialDevices()` 之后才读 `command.data`。因此 **视图 payload 若跨 await 持有，必须在保留点拷贝**。

## 改动

范围仅限声明文件，未改 `packages/shared`。

- `apps/gateway/src/ws/index.ts`
  - 抽出 `handleDecodedEnvelope(session, envelope)`：浏览器路径 `handleMessage` 解码后走此入口；不再二次解码。
  - `attachStreamSession` 新增 `onDecodedEnvelope`。若 payload 已是独立缓冲（`byteOffset === 0 && byteLength === buffer.byteLength`）则直接派发；否则 `payload.slice()` 后再派发（覆盖 `decodeEnvelopeView` 与未来 mux 缓冲回收）。
  - 原 `onMessage(bytes)` 仍 `Buffer.from` + `handleMessage`，兼容既有测试与未预解码调用方。
- `apps/gateway/src/mesh/stream-targets.ts`
  - 保留 `decodeEnvelope` 校验，把结果交给 `attached.onDecodedEnvelope(envelope)`，不再 `onMessage(raw bytes)`。
- 测试
  - `stream-targets.test.ts`：mesh 转发帧 `decodeEnvelope` 恰好 1 次；128KiB 大帧 payload 字节一致且仍只 decode 一次。
  - `inbound-frame.test.ts`：预解码信封不再二次 decode；`decodeEnvelopeView` + 异步 handler 在 backing buffer 被填 `0xee` 后仍看到原 payload。

## 设计决策

- **继续用 `decodeEnvelope` 而非 `decodeEnvelopeView` 做 mesh 校验**：任务要求 spy `decodeEnvelope` 恰好一次；zorsh deserialize 已给出独立 payload，生产路径启发式判定为 owned，不再二次 `slice`。View 入口留给测试与将来零拷贝热路径。
- **拷贝只发生在 mesh 预解码入口，且仅针对视图**：浏览器 `handleMessage` 仍走 `decodeEnvelope`，不额外 slice，避免本地 WS 热路径回归。
- **chunk 重组**：mesh 入站 payload 在 `onDecodedEnvelope` 已 owned，`decodeChunk` / `addChunk` 即使持有 `chunk.data` 视图，backing ArrayBuffer 仍由该 payload 保活。重组结果本身是新 `Uint8Array`。
- **消费者核对**：TERM_INPUT/PASTE 在 handler 内同步 `TextDecoder` 成 string；canonical `TerminalInput` 跨 await 持有 `data` 字节——由 owned payload / 视图 slice 覆盖。控制类消息在 `dispatchBorshKind` 的 `await handler.handle` 之前已 deserialize 成结构化对象。

未改 `codec.ts`（wire format 不变，无需动 shared）。

## 范围外（未改）

`apps/gateway/src/mesh/mesh-runtime.ts` 的 RTC `deliverInbound` 仍 `handleMessage(session, Buffer.from(bytes))`，会再 decode 一次。不在本任务 scope。若要对齐 mesh WS 路径，可由后续任务改为 `handleDecodedEnvelope`。

`handleMessage` 圈复杂度由 allowlist 的 16 降到 9。按规则未改 `scripts/complexity/allowlist.json`，交 commander 处理。

## 风险

- `onDecodedEnvelope` 的 owned 启发式依赖「独立 ArrayBuffer 且 offset 0」。若 zorsh 将来返回「offset 0 但共享更大 scratch buffer」，可能漏拷贝；当前 `codec-view` 实测 payload 使用独立 buffer。视图路径（offset ≠ 0）仍会 slice。
- 既有 `onMessage(bytes)` 仍全帧拷贝，行为与改前一致。
- 无效帧仍由 `acceptWsStream` RST（`invalid-ws-frame`），与浏览器路径 `sendError` 不同，此语义未改。

## 测试计数

| 套件 | 改前 | 改后 |
|------|------|------|
| `apps/gateway` `bun test` | 2842 pass / 0 fail | **2846 pass / 0 fail**（+4 新用例） |
| `apps/gateway` `bunx tsc --noEmit -p .` | 21 既有错误 | **21**（未新增；错误均不在本任务文件） |
| 相关文件 | — | `inbound-frame.test.ts` + `index.test.ts` + `stream-targets.test.ts`：**105 pass / 0 fail** |
| `packages/shared` | 未触碰 | 未跑 |

`bunx biome check` 于 `src/ws/index.ts`、`src/mesh/stream-targets.ts`、`src/ws/inbound-frame.test.ts`、`src/mesh/stream-targets.test.ts`：无问题。

`apps/gateway/src/ws/index.ts` 文件 899 行（门限 900）；`handleDecodedEnvelope` CC 9 / 34 行；`acceptWsStream` CC 14。
