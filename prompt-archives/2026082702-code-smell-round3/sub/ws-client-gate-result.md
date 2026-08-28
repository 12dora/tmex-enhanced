# ws-client：history 门控 / select 状态机回调与缓冲整改

## 1. history 门控丢元数据（已修）

**问题**：`pane-sink-registry.ts` 的门控只缓冲 `frame.data` 裸字节，命中 history 或超时兜底时通过 `dispatchPaneOutput()` 重新分发，`paneEpoch` / `seqStart` / `seqEnd` 全丢。渲染面（`TerminalSurface`）判定缺口与 rebase 依赖这些字段，回放出来的等于一段伪造的无序号数据。

**改法**：新增 `packages/ws-client/src/pane-history-gate.ts`，把门控整体抽成 `PaneHistoryGates`：

- 缓冲完整的 `GatewayTerminalData` 帧，放行时逐帧走 `dispatchPaneTerminalData(frame)`；
- API 以 `(deviceId, paneId)` 为单位：`begin` / `capture` / `take` / `close` / `closeDevice` / `closeAll`，注册表不再自己拼/拆 pane key，`splitPaneKey`、`tokensEqual` 从注册表移除；
- `take(deviceId, paneId, token)` 命中才摘下门控并交还缓冲帧，调用方在写入 reset + history 基线之后再回放，顺序语义与原实现一致；
- 超时与超限行为通过构造参数注入：`new PaneSinkRegistry({ historyGate: { timeoutMs, maxBufferedBytes } })`，默认仍是 3000ms / 2 MiB，默认实例与模块级代理函数签名零变化。

**回归测试**（`pane-sink-registry.test.ts`）：

- `history gate 命中后回放保留 paneEpoch/seq 元数据`
- `history gate 超时兜底放行时同样保留 paneEpoch/seq 元数据`（5ms 超时 + `Bun.sleep`）
- `history gate 缓冲超限时丢弃缓冲并请求 rebase`（8 字节上限，顺带覆盖“门控撤下后直通、过期 token 不再被消费”）

原有 3 组门控测试（token 命中、token 不匹配、cleanup）保持绿。

## 2. `SelectCallbacks` 半套 history 回调（已修）

**问题**：`onResetTerminal` / `onApplyHistory` 各自 optional，但 `handleHistory()` 与 `replayDeferred()` 都要求两者同时存在。只给一半时 deferred history 永远提交不出去，`replayDeferred` 里的 `deferredHistories` 卡住 → 后面的 `deferredFlushes` / `deferredOutputs` 被前置 return 挡死，缓冲的 live 输出永不回放。

**改法**（`state-machine.ts`）：

```ts
export interface HistoryCallbacks { onResetTerminal: ...; onApplyHistory: ...; }
type WithoutHistoryCallbacks = { onResetTerminal?: undefined; onApplyHistory?: undefined };
export type SelectCallbacks = BaseSelectCallbacks & (HistoryCallbacks | WithoutHistoryCallbacks);
```

类型层强制“要么两个都给、要么都不给”；运行时 `resolveHistoryCallbacks()` 在构造与 `setCallbacks()` 时把半套直接抛错（未走类型检查的 JS 调用方）。状态机内部改用 `private historyCallbacks: HistoryCallbacks | null`，`handleHistory` / `handleLiveResume` / `replayDeferred` 一律经它判定，不再逐个 optional 判空。

**回归测试**（`state-machine.test.ts`）：

- `半套 history 回调在构造/设置时即被拒绝`（构造两种半套 + `setCallbacks` 半套）
- `补齐整套 history 回调后，deferred history 与缓冲输出都会回放`（无回调时跑完整条 SELECT→ACK→HISTORY→LIVE_RESUME，再 `setCallbacks` 整套，断言 `reset → history → flush:buffered`）

**已有测试的适配**：两处历史用例本来就传的是半套（`flush buffer carries the transaction paneId`、`请求 history 却只收到 LIVE_RESUME…`），各补一个空的 `onApplyHistory`，断言不变。

**调用方**：`packages/stores/src/tmux.ts` 已经成对传入，无需改动；`packages/terminal-ui`、`apps/fe` 无直接调用（`usePaneSinkRegistration.ts` 里的 `onApplyHistory` 是 `PaneSink` 的方法，与本类型无关）。

## 3. 门控缓冲字节上限 + 少拷贝（已修）

**改法**（`state-machine.ts`）：

- `SelectStateMachineOptions.maxBufferedBytes`，默认 `4 * 1024 * 1024`；帧数上限 `MAX_BUFFERED_FRAMES = 1000` 保留，但不再 `shift()` 静默丢最老一帧——两种上限都走同一条 overflow 路径。原先的 `shift()` 等于悄悄在流里挖一个洞，把终端状态机喂到未定义状态；
- overflow 时：清空缓冲、`gate.overflowed = true`（此后本事务不再缓冲）、`transaction.outputGapped = true`（`SelectTransaction` 新增字段，`getTransaction()` 可读）、`console.warn`，并调用新的可选回调 `onRebaseRequired(deviceId, paneId, 'resource_exhausted')`；
- `OutputGate` 新增 `bufferedBytes` / `overflowed`；`stopOutputBuffering()` 不再复制数组（gate 随即删除，缓冲数组已无第二个持有者）。

**为什么是 `onRebaseRequired` 而不是新协议消息**：客户端现成的缺口恢复通道就是 `paneSinks.dispatchPaneRebase(deviceId, paneId, reason)` → `PaneSink.onRebase` → `TerminalSurface.rebase()` → 重取首屏快照（`tmux-event-router.ts` 处理 `rebase-required` / `subscription-applied` 用的就是它）。状态机拿不到 `paneSinks`（连接级实例由宿主注入），所以沿用它既有的回调注入风格透传，不涉及任何 wire 变更。

**⚠️ 需要宿主补一行接线（文件在我 scope 外，另一个 agent 正在改 `packages/stores/src/tmux.ts`，我没有动它）**：在 `setupTransportHandlers()` 里 `core.selectMachine({...})` 的回调对象中加：

```ts
onRebaseRequired: (deviceId, paneId, reason) => {
  core.paneSinks.dispatchPaneRebase(deviceId, paneId, reason);
},
```

不加也不会报错/崩溃（可选回调），但 overflow 后只剩 `transaction.outputGapped` 这个标记，画面要等下一次 select 或服务端 rebase 才恢复。

**免拷贝的所有权依据**：帧字节从 `protocol-dispatcher.handleFrame()` 的 `new Uint8Array(event.data)` 起就是单次 WS 消息独占的 buffer，borsh 解码结果不复用底层 buffer，transport 也没有 scratch buffer 复用。因此 `bufferOutput()` 与 `emitOutput()` 里的 `new Uint8Array(data)` 是纯浪费，已去掉。`pane-sink-registry` 里 **未挂载 pane 的 pending 拷贝保留**：那条缓冲可以一直存活到组件挂载（无时限），持有 subarray 会连带整条消息 buffer 一起钉住；门控缓冲有 3s / 2 MiB 上限，所以门控内改为按引用存帧。

## 验证

- `cd packages/ws-client && bun test` → **82 pass / 0 fail**（原 76，新增 6）
- `cd packages/ws-client && bunx tsc --noEmit -p .` → 0
- `bunx biome check --write` 五个文件 → clean
- `cd packages/terminal-ui && bunx tsc --noEmit -p .` → 0
- `cd packages/stores && bunx tsc --noEmit -p .` → 仅 1 条**既有**错误 `src/host-services.test.ts(93,23)`（DOM mock 类型，文件未被本次改动触碰，`git status` 显示未修改）；`bun test src/tmux-reselect-retry.test.ts src/tmux-event-router.test.ts src/tmux-sync-theme.test.ts` → 27 pass / 0 fail

## 改动文件

- 新增 `packages/ws-client/src/pane-history-gate.ts`
- 改 `packages/ws-client/src/pane-sink-registry.ts`、`pane-sink-registry.test.ts`
- 改 `packages/ws-client/src/state-machine.ts`、`state-machine.test.ts`
