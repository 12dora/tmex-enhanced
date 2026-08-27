# F3-4 结果 — 浏览器给 RTC authorize 带 connectionId

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `sub/b2-10-result.md`「前端必须做的 delta」与 `apps/gateway/src/mesh/mesh-routes.ts` / `mesh-deps.ts` / `mesh-http.ts` 的实际实现。未跑任何改变 git 状态的命令，未 `bun install`，未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session。

## 取 connectionId 走哪条路（交付项 2 的结论）

**只能走 `GET /api/mesh/connection`，B2-10 delta 里「WS 打开时带 `x-tmex-connection` 头」这一步在浏览器里做不到。**

依据：

1. `mesh-http.ts:163` 的 `guardGatewayWebSocket` 确实读 upgrade **请求**头 `x-tmex-connection`，但浏览器的 `new WebSocket(url)`（`packages/ws-client/src/client.ts:46`、`connection.ts` 的 `browserSocketFactory`）**不能设置自定义请求头**，也读不到 upgrade **响应**头。该路径只对 node↔node 的服务端 WS 客户端有效。
2. HELLO 没带 connectionId：`packages/shared/src` 全量搜 `connectionId` 无命中，B2-10 也明确「不改 HELLO Borsh」。
3. 服务端也没有在任何浏览器可读的响应头里回传它。

所以实现取「每次 attempt 打一次 `GET /api/mesh/connection`」这条路：单连接时**不带头也能拿到** 200，正是为浏览器准备的兜底。代价是一次极轻的 GET，且它同时充当「primary 是否已在 node 上登记」的探针。

## 做了什么

### 1. `DirectCarrierController`（`packages/ws-client/src/direct/direct-carrier-controller.ts`）

- attempt 流程加了第 0 步：`GET /api/mesh/connection` → `attempt.connectionId`。**每次 attempt 重取**（新增字段挂在 `Attempt` 上，不做跨 attempt 缓存）——primary 重连会换一条 WS，缓存旧值会把直连挂到已死的会话上。
- 放在 `fetchRtcConfig` **之前**：拿不到 connectionId 的那两种情况（404/409）本来就不该建 `RTCPeerConnection`、白收一轮 ICE 候选。
- `POST /api/rtc/authorize` 同时带 body `connectionId` 与请求头 `x-tmex-connection`（服务端 `mesh-routes.ts:313-315` 是 `body || header`，两者都带最稳）。老 node 拿不到 connectionId 时两者都不带，退化成 F3-1 的旧请求体。
- 新增「等 primary」这一类失败（`DirectPrimaryWaitError`，不走指数退避、**不消耗重试次数**）：
  - `404 NO_CONNECTION` → `mode:'open'`。primary 当前非 READY：挂到 primary 状态上，等它进 READY 再重来一轮；primary 已经 READY 却仍 404（登记竞态）：按普通退避重试，避免永久挂起。
  - `409 MULTIPLE_CONNECTIONS` → `mode:'reconnect'`。多标签下重试多少次都还是 409，必须先看到 primary **掉出 READY 再回到 READY** 才重来。
  - `authorize` 自己回 404/409 时同样按上面处理——GET 与 authorize 之间 primary 重连 / 又开一个标签页是真实竞态，按老逻辑会被当成 4xx 永久失败卡死在 `failed`。
- 判定严格按 **status + code** 双条件（`primaryWaitFor()`）：老 node 上 `/api/mesh/connection` 会落到 `/api/mesh/*` 的 405、或路由缺失的裸 404，都不会被误判成「等 primary」。5xx 走普通退避；其余非 2xx 退化成不带 connectionId（单连接场景 node 侧照样唯一定位）。
- primary 状态源：`GatewayConnectionLike` 新增可选 `readonly client?: PrimaryStatusLike`（`isReady()` / `onStateChange()`）。`GatewayConnection.client` 是 `BorshWebSocketClient`，**结构上已经满足，fe 侧零改动**（`apps/fe/src/node/node-runtimes.ts` 本来就把整个 connection 传进来）。宿主没有该成员（老测试桩）时退回普通退避，绝不静默挂死。
- `stop()` / `retry()` / `connect()` 都会注销 primary 等待订阅（`clearPrimaryWait()`），不泄漏 handler。

新导出：`MESH_CONNECTION_PATH`、`X_TMEX_CONNECTION_HEADER`、`PrimaryStatusLike`。

### 2. `packages/api-client/src/auth/`

- `types.ts`：`X_TMEX_CONNECTION_HEADER`、`MeshConnectionResponse`、`MeshConnectionErrorCode`、`MeshConnectionResult`（`{ok:true,connectionId}` | `{ok:false,status,code}`）。
- `auth-api.ts`：`AuthApi.getConnection(nodeId, connectionId?)`，走 `nodeAuthPath` 加 `/n/<id>` 前缀，可选带 `x-tmex-connection` 头。**失败不抛异常**——404/409 是调用方要分别处理的正常状态，抛异常会逼调用方去 parse message。

## 文件清单

| 文件 | 作用 |
|---|---|
| `packages/ws-client/src/direct/direct-carrier-controller.ts` | connectionId 取用 + authorize 带值；`DirectPrimaryWaitError` / `waitForPrimary` / `PrimaryStatusLike` |
| `packages/ws-client/src/direct/direct-carrier-controller.test.ts` | 新增 `connectionId 绑定（F3-4）` 一组 7 个用例；happy path 断言更新 |
| `packages/ws-client/src/direct/test-fakes.ts` | `FakeApiClient` 记录请求头；`FakeConnection.client` / `setPrimaryState` / `primaryHandlerCount` / `exposePrimaryStatus` |
| `packages/api-client/src/auth/auth-api.ts` | `getConnection()` |
| `packages/api-client/src/auth/types.ts` | mesh connection 相关类型 + 头常量 |
| `packages/api-client/src/auth/auth-api.test.ts` | 200 / 200-带头 / 404 / 409 / MALFORMED / 500 六个用例 |

## 测试

| | 基线 | 本次 |
|---|---|---|
| `packages/ws-client` `bun test` | 222 pass / 0 fail | **230 pass / 0 fail**（+8） |
| `packages/api-client` `bun test` | 85 pass / 0 fail | **91 pass / 0 fail**（+6） |
| `apps/fe` `bun test src/` | 206 pass / 0 fail | **206 pass / 0 fail** |
| ws-client tsc | 0 | **0** |
| fe tsc | 0 | **0** |
| api-client tsc | 5 | **5**（全部是既有 `*.test.ts` 的 `Response`/元组报错，未新增） |
| biome（6 个改动文件） | | **clean** |

ws-client 新增用例：authorize 同时带 body+头、每次 attempt 重取（primary 重连换新值）、409 不建 PC/不排退避/等重连后跑通、404 分「等 primary 连上」与「已 READY 走退避」两支、authorize 自身 409 转成等 primary、老 node 405 退化、5xx 退避 + 无状态源时退回退避、`stop()` 注销订阅。

## 未做 / 协调者需知

1. **多标签仍拿不到直连**：本任务范围只在 `direct/**` 与 `api-client/auth/**`，没法给每个 `GatewayConnection` 生成 UUID 并在 WS 上带头——**而且浏览器根本带不了这个头**。所以同 sid 开两个标签页时，两边的 `GET /api/mesh/connection` 都是 409，双方都等在「primary 重连过」上，直连长期建不起来（不会报错、不会耗尽重试、primary 功能完全不受影响）。要真正支持多标签直连，需要后端补一条浏览器可用的绑定通道，二选一：
   - **（推荐）** `GET /api/mesh/connection` 与 `POST /api/rtc/authorize` 接受 query/body 里的 `connectionId`，并且 gateway WS 的 upgrade 也从 **query string**（如 `/ws?conn=<uuid>`）读 `x-tmex-connection` 的等价值——浏览器唯一能在 WS 握手上携带自定义信息的地方就是 URL；
   - 或 HELLO/HELLO_ACK 里回传服务端生成的 `connectionId`（要动 Borsh schema，B2-10 明确避开了）。
   决定之后前端只需把 UUID 拼进 WS URL、把 `fetchConnectionId()` 改成直接用本地 UUID（或带头再 GET 一次），控制器其余逻辑不用动。
2. `packages/ws-client/src/index.ts`（barrel）未改，因为它不在文件范围内。新增的 `MESH_CONNECTION_PATH` / `X_TMEX_CONNECTION_HEADER` / `PrimaryStatusLike` 目前只能从 `@tmex/ws-client/direct/direct-carrier-controller` 深路径导入；若要从包根导出，请协调者在 barrel 里补一行（不影响现有编译）。
3. `AuthApi.getConnection()` 目前无生产调用点：控制器出于「不引入 ws-client → api-client 依赖」的考虑自己发的 GET（`DirectApiClientLike` 只有 `fetch`）。它是给 fe 侧（诊断面板 / 未来多标签绑定）备的类型化入口，行为与控制器内部逻辑一致。
