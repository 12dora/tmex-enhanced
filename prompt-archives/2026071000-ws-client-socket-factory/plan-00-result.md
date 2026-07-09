# 实施结果：ws-client 可注入 WebSocket transport

## 落地形态

按 plan-00 全量实现，无删减。

### `packages/ws-client/src/client.ts`

- 新增 `WebSocketLike` 接口（浏览器 `WebSocket` 的最小结构子集）与 `SocketFactory` 类型。
- 新增模块级常量 `WS_CONNECTING = 0` / `WS_OPEN = 1`（WHATWG 取值），替换原先对全局
  `WebSocket.OPEN` / `WebSocket.CONNECTING` 的读取（`connect()` 的幂等判定、`sendRaw()` 的发送前判定）。
- `private ws` 的类型由 `WebSocket | null` 改为 `WebSocketLike | null`。
- `connect()` 走 `this.options.socketFactory ?? defaultSocketFactory`。
- `defaultSocketFactory` 对 `new WebSocket(url)` 做一次显式结构断言，把 DOM `MessageEvent` 与
  `WebSocketLike.onmessage` 参数在 `strictFunctionTypes` 下的逆变不兼容收敛在这一处。

### `packages/ws-client/src/connection.ts`

`GatewayConnectionOptions.socketFactory` 透传给 client；`clientOptions` 的类型收紧为
`Partial<Omit<BorshClientOptions, 'url' | 'socketFactory'>>`，避免两条路径同时设置同一字段。

### `packages/ws-client/src/index.ts`

导出 `type WebSocketLike` / `type SocketFactory`。

### `packages/ws-client/src/client.test.ts`（新建，8 例）

以 `FakeSocket implements WebSocketLike` 手工驱动连接生命周期：

1. 注入工厂被调用一次并拿到解析后的 URL；`binaryType` 被设为 `arraybuffer`；状态进入 `WS_CONNECTING`。
2. 缺省 `url` 时工厂收到 `defaultWsUrl()` 的推导结果。
3. 注入 socket 的 `onopen` 驱动握手：发出 1 帧 Hello，状态转 `HELLO_NEGOTIATING`。
4. socket 已 OPEN 时 `connect()` 幂等，工厂不被二次调用。
5. `disconnect()` 调用注入 socket 的 `close()`，状态转 `CLOSED`。
6. 不传 `socketFactory` 时走全局 `WebSocket` 构造器，URL 原样传入。
7. **全局 `WebSocket` 不存在时，注入的 transport 仍可完成握手与关闭。**
8. `createGatewayConnection` 把 `socketFactory` 透传给 client；`dispose()` 关闭 socket。

## 验证

| 项 | 结果 |
|---|---|
| `bun test packages/ws-client` | 23 pass / 0 fail（4 文件，新增 8 例） |
| 默认路径零变化 | `connection.test.ts` / `state-machine.test.ts` / `pane-sink-registry.test.ts` 未改动即通过 |
| `tsc --noEmit -p packages/ws-client/tsconfig.json` | 三个源文件零错误 |
| `biome check`（触碰的 4 文件） | 错误数与 HEAD 持平（1 处既有 `catch {}` 格式问题，与本次改动无关，未顺手改） |

### 变异测试

新测试非空转，逐条改坏实现须变红：

| 变异 | 结果 |
|---|---|
| `WS_OPEN` / `WS_CONNECTING` 改回 `WebSocket.OPEN` / `.CONNECTING` | 2 fail（第 7 例报 `TypeError: undefined is not an object (evaluating 'WebSocket.OPEN')`） |
| `connect()` 忽略 `options.socketFactory`，恒用 `defaultSocketFactory` | 7 fail |

第一条变异正是第 7 例存在的理由：只要比较逻辑还读全局 `WebSocket` 的静态属性，
在没有全局 `WebSocket` 的宿主里注入自定义 transport 就会直接抛错。

## 与计划的偏差

无。

## 备注

- `tsc` 对 4 个 `*.test.ts` 均报 `TS2307: Cannot find module 'bun:test'`（含本次之前就存在的 3 个），
  是 `packages/ws-client/tsconfig.json` 未挂 `bun-types` 的既有状况，不在本次范围内。
- 工作区首次跑测试时 `@tmex/shared` 无法解析，是该 checkout 未执行过 `bun install`，非代码问题。
