# Task BG 结果：ws-client 未就绪队列静默丢帧

## 证据核对

主张成立，已对照源码后实施。

- `packages/ws-client/src/client.ts`：`maxPendingMessages = 100`；`send()` 在 `!isReady()` 时只 `push` 到 100，超出直接忽略仍 `return false`。
- 注释声称「两种情况数据都没丢，调用方不需要也不应该重发」——溢出路径实际已丢，注释错误。
- `flushPendingMessages` 在进入 `READY` 时按 FIFO `shift` 重发。
- 仓库内未就绪也会发的调用方（stores 几乎都不看 `isReady()`）：
  - **有序输入**：`tmux.sendInput` → `terminal-input` / `KIND_TERM_INPUT`（键盘、ghostty `paste()`→`emitData`、编辑器 `buildEditorPayloads` 多段）；`tmux.paste` → `terminal-paste` / `KIND_TERM_PASTE`。
  - **控制面**（可独立重试 / last-wins）：`connect-device`、select/focus、resize/sync-size、订阅、窗口/pane 操作等。
  - `site.updateTheme` 有 `isReady()` 守卫，不会进 pending。
  - `agent` subscribe/unsubscribe 走 `core.client.send`，同样可能排队。

大粘贴在重连/HELLO 期间被切成大量 `TERM_INPUT` 帧时，第 101 帧起静默丢失，发出残缺序列。

## 改动

### ws-client

- 新增 `pending-send-queue.ts`：待发队列改为 **2 MiB 字节预算 + 2048 帧上限**（可通过 `BorshClientOptions.maxPendingBytes` / `maxPendingFrames` 覆盖，便于测试）。
- `send()` 返回 `ClientSendResult`：`'sent' | 'queued' | 'backpressure' | 'overflow'`。纠正误导注释。
- overflow 时：
  - 有序输入（`KIND_TERM_INPUT` / `KIND_TERM_PASTE`）**整段丢弃**已排队输入，并 latch：同一未就绪周期内后续输入一律 `overflow`，避免丢掉头部后把尾部发出去。
  - 控制帧 overflow 只拒本帧，不拆已排队输入。
  - 每个 overflow 周期只 `console.warn` + `onPendingOverflow` **一次**；`READY` flush/`drain` 结束周期。
- `WebSocketGatewayTransport` 透传 `ClientSendResult`，并把 overflow 转成 `{ type: 'pending-overflow', ... }`。
- `GatewayTransport.send` 类型放宽为 `ClientSendResult | boolean`（共享 transport / 旧 fake 仍可返回 boolean）。

### stores（必要的最小接线）

- `tmux-event-router.ts`：事件联合是穷尽映射，补 `pending-overflow` → `console.warn`（与 `transport-error` 同级，不做 toast / i18n）。
- 三处 `getBorshClient` mock 补 `onPendingOverflow` stub（transport 构造会订阅）。

未改 `apps/fe`：`FakeTransport.send(): boolean` 仍满足 `ClientSendResult | boolean`。

## 设计决策

1. **有序输入整段丢 + latch，而不是只拒新帧或清空整条队列。** 只拒新帧会发出残缺前缀；overflow 后若立刻允许再入队，会发出残缺后缀。控制帧（connect/resize/subscribe）与输入无关，保留它们避免重连后丢订阅/建连。
2. **不把 resize 算进有序流。** resize 是 last-wins；跟输入混在一起时丢掉中间 resize 不会把字符插错位置。
3. **公共 API 源码兼容：** 忽略返回值的调用方不变；`implements GatewayTransport` 且 `send(): boolean` 的 fake 仍可编译。WebSocket transport 的 `send()` 现在返回字符串，**真值语义变了**（`'queued'` 为 truthy，旧 boolean `false` 为 falsy）。仓库内 stores 不检查返回值；共享 transport 测试仍是 `toBe(true/false)`。
4. **队列抽到独立模块**，避免 `client.ts` 再涨复杂度，并让字节/帧/latch 语义可单测。

## 风险

- **overflow 后输入彻底丢失直到 READY。** 这是有意的：残缺粘贴比整段失败更糟。用户只能靠 `pending-overflow` 日志/事件感知；FE 目前没有 toast。
- **单帧超过 2 MiB**（未分片的巨大 `TERM_PASTE`）会立刻 overflow。正常路径 payload 受 `maxFrameBytes`（1 MiB）约束，风险低。
- **WebSocket `send()` 真值变化：** 若有未检索到的 `if (transport.send())` 把 `false` 当「已排队」，现在 `'queued'` 会走另一分支。当前仓库调用方不依赖此判断。
- **latch 跨 disconnect 保留到下一次 READY drain。** 与原先 pending 跨重连存活一致；disconnect 不清队列。

## 测试

新增：

- `pending-send-queue.test.ts`：缺省预算、FIFO、字节/帧上限、整段丢输入、latch、单周期一次 info、控制帧 overflow 不拆输入、drain 结束周期。
- `client-pending-queue.test.ts`：小队列 flush 顺序、101 帧不再被 100 上限丢掉、overflow 状态 + 一次事件、输入整段丢而控制帧仍 flush、READY 后 `sent`、transport 透传。
- `client.test.ts`：背压断言改为 `'backpressure'` / `'sent'`。
- `tmux-event-router.test.ts`：`pending-overflow` 不抛。

| 包 | 基线 | 本次 |
|---|---|---|
| `packages/ws-client` `bun test` | 268 pass / 0 fail | **283 pass / 0 fail**（+15） |
| `packages/ws-client` `tsc` | 0 | **0** |
| `packages/stores` `bun test` | 357 / 0 | **357 pass / 0 fail** |
| `packages/stores` `tsc` | 1 pre-existing | **1**（`host-services.test.ts`，未引入） |
| `apps/fe` `tsc` | 0 | **0**（接口放宽，未改 fe 源码） |

`bunx biome check`：上述改动文件通过。

未跑 `apps/gateway bun test`（未改 gateway；并行 agent 在动 gateway）。
