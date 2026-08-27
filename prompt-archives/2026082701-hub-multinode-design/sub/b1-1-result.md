# B1-1 结果：GatewaySession / Carrier 拆分

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

按 E0-1 §5 九步完成重构：**无新协议、无客户端可见行为变化**。Bun `ServerWebSocket` 只留在 `carrier.ts` 与 ingress 边界（`ws/index.ts` upgrade/open、`runtime.ts`、`managed-entry.ts`）。身份键全部改为 `GatewaySession`；发送与背压按 `Carrier`。

## 做了什么

### 新增

- `apps/gateway/src/ws/carrier.ts` — `Carrier` + `BunSocketCarrier`
- `apps/gateway/src/ws/carrier.test.ts` — Bun `send()` 数值映射
- `apps/gateway/src/ws/gateway-session.ts` — 逻辑会话
- `apps/gateway/src/ws/gateway-session.test.ts` — attach/detach/switch、旧载体 drain 不推进

### 改造（范围内）

- `ws/borsh/codec-borsh.ts`：`BorshClientState` → `BorshSessionState`；`sendToClient(carrier, data, maxFrameBytes?)`
- `ws/borsh/session-state.ts`：`createSessionState()`；`SessionStateStore` 以 `GatewaySession` 为键，操作 `session.state`；两套 seq 未合并
- `ws/borsh/switch-barrier.ts`：pending Map 与定时器闭包捕获 session，发送时读 `session.activeCarrier`
- `ws/websocket-send-guard.ts`：`WeakMap<Carrier, …>`；`maxFrameBytes` 显式传入；公开三态与终止原因不变
- `ws/types.ts`：`GatewaySocketData = { session, carrier }`；删除 `ClientState` / `SwitchBarrierSocket` / `asSwitchBarrierSocket`；`DeviceConnectionEntry.clients|canonicalClients` 改为 `Set<GatewaySession>`
- `ws/index.ts`：`connectedClients` / `canonicalSessions` 以 session 为键；ingress 仍接 raw socket，内部 session 化；canonical 闭包捕获 session；`handleDrain` 校验 `isActiveCarrier`
- `ws/device-connection-registry.ts`、`legacy-feed-broadcaster.ts`、`theme-settings-broadcaster.ts`、`gateway-metrics-log.ts`、`borsh-dispatcher.ts`、`tmux-command-handlers.ts`
- `agent/ws-hub.ts`：删除 `AgentHubClient`；`Set<GatewaySession>` / `Map<string, Set<GatewaySession>>`
- `runtime.ts`：Bun adapter，把 raw socket 转成 `GatewaySocketData`
- `managed-entry.ts`：`socketOwners: Map<GatewaySession, …>`；重启关连接走 `session.activeCarrier.close(1012, …)`
- 测试 fixture：`createFakeCarrier()` / `createGatewaySession()`（`createBorshTestWs` 为其别名）

## 公开 API

```ts
type CarrierSendResult = 'sent' | 'backpressure' | 'closed'

interface Carrier {
  send(bytes: Uint8Array): CarrierSendResult
  bufferedAmount(): number
  onDrain(cb: () => void): void
  close(code: number, reason: string): void
  terminate(): void
}

class BunSocketCarrier implements Carrier {
  constructor(socket: ServerWebSocket<unknown>)
  emitDrain(): void  // 仅 Bun ingress 调用
}

type CarrierRole = 'primary' | 'direct'

class GatewaySession {
  readonly id: string
  borshState: BorshSessionState
  readonly state: SessionState
  readonly primary: Carrier
  direct: Carrier | null
  activeCarrier: Carrier
  closed: boolean
  constructor(options: { id?: string; primary: Carrier; borshState?: BorshSessionState; state?: SessionState })
  attachCarrier(carrier: Carrier, role: CarrierRole): void
  detachCarrier(carrier: Carrier): void
  switchActiveCarrier(carrier: Carrier): void
  isActiveCarrier(carrier: Carrier): boolean
  handleCarrierDrain(carrier: Carrier): boolean  // 非 active 返回 false，不推进 canonical
}

interface GatewaySocketData {
  session: GatewaySession
  carrier: BunSocketCarrier
}

interface BorshSessionState { seqGen; negotiated; clientImpl; maxFrameBytes; chunkReassembler; selectedPanes; subscribedPanes }
function createBorshSessionState(): BorshSessionState
function createSessionState(): SessionState
function sendToClient(carrier: Carrier, data: Uint8Array | Uint8Array[], maxFrameBytes?: number | null): boolean

class WebSocketSendGuard {
  canSend(carrier: Carrier): boolean
  isBackpressured(carrier: Carrier): boolean
  sendFrames(carrier, frames, maxFrameBytes?): boolean
  sendFramesStatus(carrier, frames, maxFrameBytes?): 'sent' | 'backpressured' | 'dropped'
  handleDrain(carrier: Carrier): void
  markStreamGap(carrier: Carrier): void
  forget(carrier: Carrier): void
  snapshotStats(carriers: Iterable<Carrier>): WebSocketSendGuardStats
}

// 测试
function createFakeCarrier(options?: CreateFakeCarrierOptions): FakeCarrier
function createGatewaySession(options?: CreateGatewaySessionOptions): BorshTestWs
const createBorshTestWs = createGatewaySession
```

`BunSocketCarrier` 映射：`send()>0 → 'sent'`，`-1 → 'backpressure'`，`0` 或 throw → `'closed'`。

Guard 仍保留 `oversized_frame` / `dropped_frame` / `backpressure_timeout` / `backpressure_gap`。

两套 seq：`borshState.seqGen`（envelope）与 `state.wsConnection.seq`（状态机）。attach 第二载体不重置、不合并。HELLO 仍只在 fresh session 上走一遍；`agentWsHub.registerClient` 仍只在 `handleHello` 调用。

## 测试

`cd apps/gateway && bun test`：

```
1520 pass
0 fail
4901 expect() calls
Ran 1520 tests across 172 files. [27.33s]
```

基线 1472。本任务新增：`carrier.test.ts`、`gateway-session.test.ts`，以及 (a) Bun 数值映射 (b) attach/detach/switch (c) 旧载体 drain 不推进 canonical (d) 双载体独立背压；另补 seq 跨 attach 复用、barrier 事务跨 carrier 仍在同一 session。其余增量来自同 worktree 其他 agent。

新覆盖要点：

- `BunSocketCarrier`：`>0 / -1 / 0 / throw`
- `GatewaySession` attach/switch/detach；seq 不重置
- `WebSocketServer.handleDrain(session, staleCarrier)` 不调用 `canonical.onDrain()`
- 同一 session 上两个 carrier 的 Guard 背压互不干扰

## tsc

`bunx tsc --noEmit -p apps/gateway`：**23 个错误**（基线 27，未升高；新文件 0 错）。

本任务范围内仅剩 1 条，与其他文件同类、属既有 `process.on('unhandledRejection')` 类型问题：

```
apps/gateway/src/ws/index.test.ts(227,17): error TS2345:
  Argument of type '"unhandledRejection"' is not assignable to parameter of type '"memoryPressure"'.
```

其余 22 条均在范围外（与本次改动无关；部分可能由并行 agent 引入）：

```
apps/gateway/src/push/connection-alerts.test.ts(22,3)     TS2741 disabledNotificationChannels
apps/gateway/src/push/supervisor.test.ts(22,3)            TS2741 同上
apps/gateway/src/push/supervisor.test.ts(168,15)          TS2339 onSnapshot on never
apps/gateway/src/push/supervisor.test.ts(169,15)          TS2339 onEvent on never
apps/gateway/src/push/supervisor.test.ts(253,15)          TS2339 onSnapshot on never
apps/gateway/src/push/supervisor.test.ts(254,15)          TS2339 onEvent on never
apps/gateway/src/push/supervisor.test.ts(322,19)          TS2339 onClose on never
apps/gateway/src/system/managed-endpoint.test.ts(103,25)  TS2769
apps/gateway/src/telegram/service.ts(153,34)              TS2341 Updates.offset private
apps/gateway/src/telegram/service.ts(214,40)              TS2341 同上
apps/gateway/src/tmux-client/control-mode-capture.ts(120,3) TS2741 historyText
apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts(433,33) TS2769
apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts(498,33) TS2769
apps/gateway/src/tmux-client/local-external-connection.eagain.test.ts(554,19) TS2345 unhandledRejection
apps/gateway/src/tmux-client/local-external-connection.test.ts(1532,19) TS2345 同上
apps/gateway/src/tmux-client/local-external-connection.test.ts(1823,5) TS2349 never not callable
apps/gateway/src/tmux-client/ssh-auth-resolvers.ts(326,9) TS2322
apps/gateway/src/tmux-client/ssh-connect-config.test.ts(156,40) TS2769
apps/gateway/src/tmux-client/ssh-connect-config.test.ts(262,40) TS2769
apps/gateway/src/tmux-client/ssh-external-connection.test.ts(1091,7) TS2322
apps/gateway/src/tmux/ssh-auth.ts(13,3) TS2559
apps/gateway/src/tmux/ssh-auth.ts(32,3) TS2559
```

## biome

`bunx biome check` 对所有触及文件 **clean**。

## 未做 / 协调者注意

- **未实现 `CARRIER_SWITCH` 协议**（按设计留给后续阶段）。`attachCarrier` / `switchActiveCarrier` 是会话内部 API，fresh `/ws` 仍只建 primary。
- 已删除：`ClientState`、`SwitchBarrierSocket`、`asSwitchBarrierSocket`、`BorshClientState` / `createBorshClientState`、`AgentHubClient` / `AgentHubClientState`。全仓库无残留引用。
- 范围外无需改文件。后续 B1-2 的 `LinkStreamCarrier` 只需 `implements Carrier`，再 `session.attachCarrier(carrier, 'direct')`。
- `sendToClient` 名称保留，参数改为 `Carrier`。
- `managed-entry` 用 `import type` 引用 `GatewaySession` / `GatewaySocketData`，不在 `lockManagedRuntime` 前加载业务模块。
