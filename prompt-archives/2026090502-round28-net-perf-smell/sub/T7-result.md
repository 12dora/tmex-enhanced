# T7 结果：浏览器 WS 重连韧性 / 测试假件收敛 / 网关 WS cork / 粘贴流水线

范围内四项全部落地，测试与门禁均通过。下面按交付项说明改法与取舍。

## 1. 浏览器 WS 重连（EX3 R4）

`packages/ws-client/src/reconnect-controller.ts`

- 新增导出 `reconnectDelayMs(attempt, minMs, maxMs, random?)`，形状照搬 `mesh/ctl.ts:85-89` 的
  `backoffDelayMs`（`exp = min(max, min * 2^n)`，`jitter = 0.5 + random()*0.5`，结果再 `min` 一次后 `floor`），
  未 import 网关代码。`attempt` 在本控制器里从 1 起算，故指数用 `2^(attempt-1)`。
- `maxAttempts` 变为可选，缺省 `Infinity`；`canRetry()` 相应改为 `attempts < (maxAttempts ?? Infinity)`。
  退避本来就封顶 30 s，所以「fast-retry 预算用尽后以封顶间隔无限重试」不需要额外状态。
- `random` 可注入，仅测试用。

`packages/ws-client/src/client.ts`

- `DEFAULT_OPTIONS.maxReconnectAttempts` 改为 `Number.POSITIVE_INFINITY`；`BorshClientOptions` 里字段保留
  （测试仍可显式收敛）。**fe / stores 无调用方传这两个选项**（全仓 grep 只有 ws-client 内部），所以没动
  `node-connection-manager.ts` 与 `node-runtimes.ts`。
- 停止重连的三条路径不变：`protocolFatal`（canonical v1.1 版本门 ERROR）就地熄火；4401 由
  `node-connection-manager.handleUnauthorized` 调 `client.disconnect()` 收敛；宿主显式 `disconnect()`。
- 新增 `online` / `navigator.connection.change` 唤醒。为控制 `client.ts` 体积（见门禁一节）抽成
  `packages/ws-client/src/network-wake.ts` 的 `NetworkWakeListeners`：`online` 立即唤醒、`change` 去抖
  800 ms（与 `direct-carrier-controller.ts:105-110` 同节奏，未 import 它）；两个事件源都做了
  `typeof addEventListener === 'function'` 探测，bun 里没有 `window`、`navigator.connection` 时装不上也不报错。
- 唤醒动作与 `visibilitychange` 的可见分支合并为 `wakeReconnect()`：`CLOSED` 走 5 s 节流后
  `reconnector.reset() + connect()`，`RECONNECT_BACKOFF` 直接 reset + connect，`protocolFatal` 一律不动。
  visibility 的 `READY → 补发 PING` 分支保持原样。
- `disconnect()` 里连同 visibility 监听一起摘掉网络监听并清去抖定时器。

测试：`reconnect-controller.test.ts` 原本断言精确延迟，改为注入固定 random 断言边界值 + 单独一组
抖动区间/随机性用例；新增「无上限连排 200 次」。`client.test.ts` 新增「缺省无上限连断 8 次仍在
RECONNECT_BACKOFF 且不报 Max reconnection attempts」「显式 maxReconnectAttempts 仍收敛 CLOSED」
「online 立即重连 + disconnect 后监听器清零」「change 去抖后重连」「fatal 后 online 不再重连」
「无 window 宿主不装监听」。

## 2. B6 测试假件收敛

新增 `packages/ws-client/src/test-fakes.ts`（不从包入口导出）：

- `createFakeSocket(options?)`，重载出两种记录方式：缺省按调用方原样记录 `sent`；
  `{ binary: true }` 时拒绝文本帧并把每帧复制成 `Uint8Array`（`websocket-canonical-gate.test.ts` 用的形态）。
  统一提供 `open()` / `simulateClose()` / `deliver()` / `closeCount`。
- `helloFrame(options?)` 统一两个 HELLO 构造器，默认值对应 `client.test.ts` 的老网关基线；
  canonical-gate 套件用一个 `HELLO_BASE = { serverVersion: '1.2.0', heartbeatIntervalMs: 60_000 }`
  常量展开，行为与原 `hello()` 完全一致。

三份本地 `FakeSocket` 类与两个 hello builder 已删除。`client.test.ts` 里 `class SpySocket extends FakeSocket`
改成返回 fake 的构造函数（全局 `WebSocket` 走 `new`，语义不变）。三套用例断言一条未改，全绿。

## 3. 网关 WS 批量 cork（EX3 R8，只做 cork，不做压缩）

先核对了 `node_modules/bun-types/serve.d.ts:230` 的签名 `cork<T>(callback: (ws) => T): T`。

`apps/gateway/src/ws/carrier.ts`

- `Carrier` 增可选 `sendMany(frames, options?): { statuses, bufferedAmount }`。
- `BunSocketCarrier.sendMany` 把整批 `send()` 包进一次 `socket.cork(...)`，逐帧记录状态，
  **cork 结束后**读一次 `getBufferedAmount()` 返回（批内读到的是陈旧值）。
  `stopOnBackpressure`（缺省 true）控制首帧非 `sent` 是否停发余下帧；cork 本身抛出记为 `closed`。

`apps/gateway/src/ws/websocket-send-guard.ts`

- 抽出 `deliver(carrier, frames, mode)`：多帧 + 载体有 `sendMany` + 非 priority 直发路径时走
  `corkedBatch`，否则 `sequentialBatch`；返回与 `frames` 等长的状态数组（空洞/未发出为 `unsent`）。
- `sendFramesStatus` 的判定顺序（unavailable → 硬上限 → 已背压 → 超帧长 → 发送）完全不变，
  发送后由 `settleStreamBatch` 扫描：`backpressure` 的 skipped 仍是 `frames.slice(index+1)`、
  `rejected` 仍是 `frames.slice(index)`，`closed`/异常仍是 `dropped_frame` 终止。
  `enterBackpressure` 的 `bufferedBefore` 优先用批返回的 cork 后水位，省一次系统调用（时间点与原来一致）。
- `sendPriorityFrames` 保持「`backpressure` 继续发、`closed`/`rejected` 停」的语义（`stopOnBackpressure=false`）；
  有 `sendPriority` 的载体（DataChannel）仍逐帧走优先队列，不进批路径。

测试：`carrier.test.ts` 新增 4 例（一次 cork、缺省停发、`stopOnBackpressure:false`、cork 抛出），
假 socket 在 cork 内读 `getBufferedAmount()` 会抛，用来钉住「水位只在 cork 后读」。
`websocket-send-guard.test.ts` 新增一组批路径用例，逐条对齐逐帧路径的结局，
含「缓冲已越硬上限时整批一帧不发且照旧 `backpressure_gap` 终止」。

## 4. 粘贴流水线（EX3 R11）

- `handleTermPaste` 不再按 1024 字符切块，整段交给连接（`entry.runtime.sendInput(paneId, data)`）。
  **tmux 命令级的切块没有取消**：`buildSendKeysCommands` 仍按 `SEND_KEYS_HEX_CHUNK_BYTES = 256`
  字节一条 `send-keys -H`（实参 768 字符、整条 786 字符，低于 1024 的上限，已在 input-encoder 用例里断言）。
- `input-encoder.ts` 新增共享 helper：`buildSendKeysCommands(paneId, bytes)` 与
  `pipelineSendKeys(commands, execute)`（整段命令一次写完，`Promise.all` 等全部回执；
  `PIPELINED_INPUT_TIMEOUT_MS = 30_000` 只在多块时生效，单块按键仍是控制口默认超时）。
- `local-external-connection.enqueueInputBytes`：`inputTransition` 串行链保持不变（顺序保证靠它），
  链内改为一次写完所有 `send-keys` 再等；控制口不可用时的 `runTmux` 回退保持逐条串行。
  `controlProcess` 在整段开头取一次，避免半段切换到另一条控制口。
- `ssh-external-connection.sendInputBytes` 本来就是并发 `Promise.all`，改为复用同一 helper，
  超时改读 `getControlCommandTimeoutMs()`（仍是 30 s）。
- 单键路径（`handleTermInput` → 1 条命令）与改前逐字节完全一致。

测试（`local-external-connection.test.ts` 新增一组控制模式用例）：
32 KiB 粘贴在**一条回执都没回**之前就写出全部 128 条 `send-keys`（逐块串行时这里只会有 1 条）；
`A` / 600 字节粘贴 / `Z` 交错时写入顺序与解码后的字节序完全一致；中间一块回 `%error` 时整段 reject
且 `onError` 收到该错误。另加 `input-encoder.test.ts` 的 `buildSendKeysCommands` 三例、
`tmux-command-handlers.test.ts` 的「粘贴整段一次交给连接」。

## 验收与门禁

- `packages/ws-client`：`bun test` 407 pass / 0 fail；`bunx tsc --noEmit` 干净。
- `apps/gateway`：`bun test src/ws src/tmux-client` 984 pass / 0 fail。
  `bunx tsc --noEmit -p apps/gateway` 我的文件无报错（当前仓库里 `apps/tunnel/manager.ts` 有另一 agent
  在途的未完成改动，报 5 个 `Cannot find name`，不在本任务范围）。
- `packages/stores`：431 pass / 0 fail；tsc 干净。
- `bunx biome check` 对全部 19 个改动文件干净。
- 复杂度门禁（`scripts/complexity/gate.ts`）：本任务涉及的文件**零违规**。过程中触发过三处，已就地消化，
  **没有放宽 allowlist**：
  - `client.ts` 加监听后 899 行 > 记录的 826 → 抽出 `network-wake.ts`，现 824 行；
  - `local-external-connection.ts` 691 行 > 680 → 把流水线 helper 抽进 `input-encoder.ts`，现 679 行；
  - `websocket-send-guard.ts` 的 `sendFramesStatus`(CC 17)/`deliver`(CC 19) → 拆成
    `settleStreamBatch` + 模块级 `collectPayloads` / `corkedBatch` / `sequentialBatch`，均回到 15 以内。

## 注意事项 / 遗留

- 弱网下 `CLOSED` 现在基本只由 fatal / 4401 / 显式关闭产生，`ConnectionIndicator` 的「已断开 + 手动重连」
  按钮相应只在这三种情况出现，普通断网停在 `RECONNECT_BACKOFF`（这正是 R4 想要的效果），未改 UI。
- `sendMany` 目前只有 `BunSocketCarrier` 实现；LinkStream / DataChannel 载体未实现即自动退回逐帧，
  行为与改前逐字节一致。如果后续给 LinkStream 加批写，要一并确认它的 `rejected` 语义。
- 粘贴流水线把「每 256 字节一次往返」压成「整段一次往返」，代价是超大粘贴（1 MiB ≈ 4096 条命令）
  末条命令要在 30 s 内拿到回执；本机 tmux 处理这个量级远快于该阈值，若将来允许更大的粘贴负载，
  应改成滑动窗口而不是继续放大超时。
