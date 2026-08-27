# F3-5 结果 — 浏览器直连的 cid 合约

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `b2-11-result.md`「浏览器合约」。未跑改状态的 git 命令，未 `bun install`，未 commit。未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session。

## 做了什么

1. **每条 Gateway WS 都带 `?cid=<nonce>`**：`generateClientNonce()`（16 随机字节 → 22 位 b64url）+ `nodeWsUrl(nodeId, { cid })`。self → `/ws?cid=`，其余 → `/n/<id>/ws?cid=`。
2. **nonce 一条 socket 一个，重连轮换**（见下节的关键决策）。`createNodeWsUrlSource(nodeId)` 是唯一的 nonce 生命周期归属点：`nextUrl()` 换 nonce 并给出 URL，`cid()` 给出当前 socket 那一个。
3. **控制器用 nonce 换服务端 id**：`DirectCarrierController.fetchConnectionId()` 打 `GET /api/mesh/connection?cid=<nonce>`，拿回的 **server `connectionId`** 照旧进 `POST /api/rtc/authorize` 的 body 与 `x-tmex-connection` 头。nonce 绝不进 authorize。404/409 的「等 primary 重连」分支、5xx 退避、老 node 非 2xx 退化成不带 id 的旧行为，全部原样保留。
4. `AuthApi.getConnection()` 支持 `cid` query（第二参数改成 `{ connectionId?, cid? }` 选项对象；该方法生产侧无调用方，只有测试）。

## 关键决策：重连必须换 nonce，所以加了 `wsUrlFactory`

任务书允许「若 ws-client 重连复用 URL 字符串，就一个连接对象一个 nonce 并写清楚」。实测 `BorshWebSocketClient.connect()` 是 `createSocket(this.options.url ?? defaultWsUrl())`，**重连确实复用同一个 URL 字符串**。但合约明写「重连必须换新 `cid`」，且服务端 `SessionRegistry.register()` 在 `{sid, via}` 作用域内撞 nonce 且旧 session **未 closed** 时返回 `DUPLICATE_CID` → 新 WS 被 RST。经 hub 转发时旧连接的关闭未必先于新连接的登记到达，固定 nonce 会留下一个「重连被 RST、旧会话还在」的死锁窗口。

所以在 `createGatewayConnection` 上加了一个**加性**选项 `wsUrlFactory?: () => string`：建 socket（含重连）的那一刻现算 URL，nonce 就挂在这一层轮换。`wsUrl` 仍是 `client.getUrl()` 的值，`client.ts` 一行未改。副作用：传了 `wsUrlFactory` 时 `client.updateUrl()` 不再影响真正的 socket URL——`updateUrl` 生产侧无调用方，仅 `connection.test.ts` 在用。

## 文件清单

| 文件 | 作用 |
|---|---|
| `packages/api-client/src/node-url.ts` | `CLIENT_NONCE_BYTES` / `generateClientNonce()` / `nodeWsUrl(id, {cid,…})` / `createNodeWsUrlSource()` |
| `packages/api-client/src/node-url.test.ts` | cid 拼接与编码、nonce 字符集/长度/唯一性、source 轮换 |
| `packages/api-client/src/auth/auth-api.ts` + test | `getConnection(nodeId, { connectionId?, cid? })` → `?cid=` |
| `packages/ws-client/src/connection.ts` + test | `wsUrlFactory`（与 `onClose` 包装可叠加） |
| `packages/ws-client/src/direct/direct-carrier-controller.ts` + test | `cid?: () => string \| null \| undefined`、导出 `meshConnectionPath()` |
| `packages/ws-client/src/direct/test-fakes.ts` | `FakeApiClient` 路由回落到去 query 的路径（`calls` 仍记原始路径） |
| `packages/ws-client/src/index.ts` | 导出 `meshConnectionPath` / `MESH_CONNECTION_PATH` |
| `packages/stores/src/node-connection-manager.ts` + test + `index.ts` | 缺省连接工厂抽成导出的 `createDefaultNodeConnection(nodeId, onClose, socketFactory?)` 并接上 nonce |
| `apps/fe/src/node/node-runtimes.ts` + test | 生产接线：连接带 `?cid=`，`createController(nodeId, connection, cid)` 把 nonce getter 递给控制器 |

## 公开 API

```ts
// @tmex/api-client
export const CLIENT_NONCE_BYTES = 16
export function generateClientNonce(): string            // 22 位 b64url
export interface NodeWsUrlOptions extends Partial<WsUrlLocation> { cid?: string | null }
export function nodeWsUrl(nodeId, options?: NodeWsUrlOptions): string   // 第二参数向后兼容 {protocol,host}
export interface NodeWsUrlSource { nextUrl(): string; cid(): string | null }
export function createNodeWsUrlSource(nodeId, location?): NodeWsUrlSource
AuthApi.getConnection(nodeId, options?: { connectionId?: string; cid?: string })

// @tmex/ws-client
GatewayConnectionOptions.wsUrlFactory?: () => string
DirectCarrierControllerOptions.cid?: () => string | null | undefined
export function meshConnectionPath(cid?: string | null): string

// @tmex/stores
export function createDefaultNodeConnection(nodeId, onClose, socketFactory?): GatewayConnection

// apps/fe
NodeDirectWiring.createController?: (nodeId, connection, cid: () => string | null) => …
```

## 测试

| 包 | 基线 | 本次 |
|---|---|---|
| `packages/ws-client` | 230 pass / 0 fail | **235 / 0**（+5） |
| `packages/stores` | 123 / 0 | **125 / 0**（+2） |
| `packages/api-client` | 91 / 0 | **96 / 0**（+5） |
| `apps/fe`（`bun test src/`） | 206 / 0 | **208 / 0**（+2） |

覆盖：WS URL 带 `?cid=` 且做 URL 编码；同一连接重连换新 nonce；不同连接 / 不同 node 的 nonce 互不相同；控制器查询带 nonce、authorize 用**返回的服务端 id**（并断言 body 里不出现 nonce）；每次尝试都现取 nonce；宿主没接线时退化成不带 cid 的旧查询。fe 那两条走的是**生产接线**（`createAppNodeRuntimes` / `createNodeConnection`），只把底层 socket 换成假的。

## tsc / biome

| | 基线 | 本次 |
|---|---|---|
| api-client tsc | 5 | **5**（全在 `client.test.ts` / `files-download.test.ts`，与本任务无关） |
| ws-client tsc | 0 | **0** |
| stores tsc | 1 | **1**（`host-services.test.ts` 既有） |
| fe tsc | 0 | **0** |
| packages/app tsc | 1 | **1** |
| gateway tsc | 23 | **23** |
| biome（四个包的 src） | clean | **clean** |

## 备注 / 后续

1. `stores` 的两条新用例要真的 `client.connect()` 才看得到 socket URL，而 `client.connect()` 会挂 `visibilitychange`；同包别的测试文件留下的 `document` 桩没有 `addEventListener`，因此该 describe 期间自备了一份完整 `document` 并在 `afterAll` 还原。
2. 服务端侧已核对可用：`mesh-http.ts` 与 `forwarder.ts` 都按 `url.pathname` 匹配路由、从 `searchParams` 取 `cid`，`/n/self/ws?cid=` 的 self-rewrite 保留 `url.search`，本地 `/ws` 在无 query 时才回落到 `x-tmex-connection` 头。
3. `/mesh/ws`（信令）不在合约范围内，未加 `cid`。
