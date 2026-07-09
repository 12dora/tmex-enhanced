# ws-client：可注入的 WebSocket transport

## 背景

`BorshWebSocketClient.connect()`（`packages/ws-client/src/client.ts:160`）硬编码 `new WebSocket(...)`，
且 `:153` / `:367` 直接读全局 `WebSocket.OPEN` / `WebSocket.CONNECTING`。

宿主目前只能通过 `BorshClientOptions.url`（或 `createGatewayConnection({ wsUrl })`）替换端点，
无法替换 transport 实现。任何「ws-borsh 帧不直接跑在裸 WebSocket 上」的场景都接不进来。

## 设计

### 1. `WebSocketLike`

浏览器 `WebSocket` 的最小结构子集，覆盖 `client.ts` 实际用到的全部成员：

```ts
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: 'blob' | 'arraybuffer';
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
}
```

`onmessage` 的事件参数在 DOM 里是 `MessageEvent`，在 `strictFunctionTypes` 下与上面的结构化参数
互不可赋值（参数逆变）。因此默认工厂对 `new WebSocket(url)` 做一次显式结构断言，把这层不兼容
限制在**一处**，而不是把 `any` 撒进接口。

### 2. `SocketFactory`

```ts
export type SocketFactory = (url: string) => WebSocketLike;
```

`BorshClientOptions.socketFactory?: SocketFactory`，缺省为 `defaultSocketFactory`。
`GatewayConnectionOptions.socketFactory?: SocketFactory` 透传。

### 3. readyState 常量本地化

`WebSocket.OPEN` / `WebSocket.CONNECTING` 换成模块内常量 `WS_OPEN = 1` / `WS_CONNECTING = 0`
（值来自 WHATWG 规范，注入实现按同一约定返回）。这样比较逻辑不再依赖全局 `WebSocket` 是否存在。

## 任务清单

1. `client.ts`：加 `WebSocketLike` / `SocketFactory` / `defaultSocketFactory`；`this.ws` 改类型；
   `connect()` 走工厂；`:153` / `:367` 换本地常量。
2. `connection.ts`：`GatewayConnectionOptions.socketFactory` 透传给 client。
3. `index.ts`：导出两个新类型。
4. 测试（`client.test.ts` 新建）：
   - 不传 `socketFactory` 时不触碰自定义工厂，且 URL 仍按 `url ?? defaultWsUrl()` 推导；
   - 传入时工厂被调用一次并拿到正确 URL；
   - 注入的假 socket 触发 `onopen` 后客户端进入握手态、`binaryType` 被设为 `arraybuffer`；
   - `disconnect()` 会调用注入 socket 的 `close()`；
   - `connect()` 在 socket 已 OPEN/CONNECTING 时幂等（不重复建连）。

## 验收标准

- `bun test packages/ws-client` 全绿。
- `bun run typecheck`（或等价）无新错误。
- 默认路径行为零变化：现有 `connection.test.ts` / `state-machine.test.ts` 不需改动即通过。

## 风险

- `strictFunctionTypes` 下的 handler 参数逆变（见「设计」1）：靠单点断言隔离，不扩散 `any`。
- 注入实现若返回非标准 `readyState` 数值，连接状态机会误判——在类型注释里写明必须遵循 WHATWG 取值。
