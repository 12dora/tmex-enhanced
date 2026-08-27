# B2-3 结果 — MeshRuntime 组装、`TMEX_ROLES` 启动矩阵、请求顺序、关停

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 做了什么

按角色装配 packaged server：standalone 仍只起 `GatewayRuntime`；`node` 起 gateway + mesh（真实 WS uplink）；`hub,node` 起 hub + gateway + mesh，并用 `createInMemoryLinkPair()` 做进程内 uplink。未改 `src/auth/**`、`src/hub/**`、其它 `src/mesh/**`、`src/ws/**`。

## 文件清单

新增：

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/mesh-runtime.ts` | `createMeshRuntime`：identity / stores / uplink / peers / `MeshHttpRuntime` |
| `apps/gateway/src/mesh/mesh-runtime.test.ts` | node PeerServer 冒烟；hub,node 内存 uplink handshake；关停顺序 |
| `packages/app/src/runtime/assemble.ts` | 角色矩阵、fetch/WS 分发、SIGINT/SIGTERM |
| `packages/app/src/runtime/assemble.test.ts` | 请求顺序、standalone 不构造 mesh、WS kind 分发、关停/信号 |

修改：

- `apps/gateway/src/runtime.ts` — 暴露 `db`、`wsServer`。**未**加 `roles` 选项（迁移 / tmux / supervisors 全角色相同）。
- `packages/app/src/runtime/server.ts` — `assembleTmex` + 信号关停；`TMEX_BIND_HOST` 默认 `127.0.0.1` 不变。

## 启动矩阵

`TMEX_ROLES`：`standalone`（默认）\| `node` \| `hub,node`（`parseTmexRoles`）。

| 角色 | 构造 | uplink | 鉴权 |
|---|---|---|---|
| standalone | `GatewayRuntime` | 无 | 无；不构造 mesh |
| node | Gateway + Mesh | `UplinkClient` → `config.hubUrl` `/hub/uplink` | mesh `localUiGuard` |
| hub,node | Hub + Gateway + Mesh（单次迁移） | `createInMemoryLinkPair` + `hub.attachLocalNode` | 同上；hub 管理 API 用 session-middleware |

`RtcPeerManager` 属 Phase 3，未构造。

### 读取的环境变量

| 变量 | 用途 |
|---|---|
| `TMEX_ROLES` | 角色矩阵 |
| `TMEX_BIND_HOST` | HTTP 绑定（默认 `127.0.0.1`） |
| `GATEWAY_PORT` | HTTP 端口 |
| `TMEX_FE_DIST_DIR` | 前端静态根 |
| `TMEX_HUB_URL` | node 连 hub |
| `TMEX_HUB_PUBLIC_URL` | hub `publicUrl` |
| `TMEX_PEER_PORT` | PeerServer（默认 39001，与 HTTP 口分离） |
| `TMEX_STUN_SERVERS` | `node.list` / rtc-config |
| `TMEX_TURN_URL` / `USERNAME` / `CREDENTIAL` | TURN |

`config.*` 仍由 gateway `config.ts` 在模块加载时解析。

### fetch 顺序

```
HubRuntime.handleRequest        // /api/hub/*, /hub/uplink
  → MeshRuntime.localUiGuard    // 仅 /api/* 且非 standalone；公开 /api/auth/{mode,challenge,login,passkey/login/options}
  → MeshRuntime.handleRequest   // /api/auth/*, /api/mesh/*, /mesh/ws, /n/:id/*
  → GatewayRuntime.handleRequest
  → serveFrontend               // SPA 覆盖 /login /nodes /n/:id/...（无扩展名 fallback index.html）
```

命中以 `instanceof Response` 为准；upgrade 返回 `undefined` 后继续走下游，Bun 会忽略。

### WebSocket `ws.data.kind`

- `hub-uplink` → hub `handleUplinkOpen/Message/Drain/Close`
- `mesh-event` / `mesh-forward-ws` → mesh
- 其它 → gateway（含 `closeSession` 原样转发）

### 关停

`SIGINT`/`SIGTERM`：peer links → uplink → hub → gateway；完成后 `process.exit(0)`，超过 5s `process.exit(1)`。运行时重启走同一 `assembled.stop()`。

## 公开 API

```ts
createMeshRuntime(opts: CreateMeshRuntimeOptions): Promise<MeshRuntime>

type CreateMeshRuntimeOptions = {
  db: AuthDb
  gateway: GatewayRuntime
  config: MeshRuntimeConfig
  hub?: HubRuntime
  wsFactory?: UplinkWsFactory
  peerHostname?: string | string[]
  startPeerServer?: boolean
  pingIntervalMs?: number
  scheduler?: MeshScheduler
  userId?: string
}

type MeshRuntimeConfig = {
  roles: TmexRoles
  hubUrl: string | null
  hubPublicUrl?: string | null
  peerPort: number
  stunServers: string[]
  turnUrl?: string | null
  turnUsername?: string | null
  turnCredential?: string | null
  bindHost?: string
}

type MeshRuntime = {
  readonly nodeId: string
  readonly identity: NodeIdentityKeys
  readonly hub: HubRuntime | null
  readonly uplink: UplinkClient
  readonly peers: PeerManager
  readonly userStore: UserStore
  readonly userKeyService: UserKeyService
  lastNodeList: UplinkNodeList | null
  handleRequest(req, server: MeshUpgradeServer): Promise<Response | null | undefined>
  localUiGuard(req): Response | null
  websocket: { open, message, drain, close }
  start(): Promise<void>
  stop(): Promise<void>
}

assembleTmex(opts?: AssembleTmexOptions): Promise<AssembledTmex>
installShutdownHandlers(stop: () => Promise<void>, hooks?: ShutdownHooks): void
SHUTDOWN_TIMEOUT_MS = 5_000

// GatewayRuntime 新增（构造选项无 roles）
readonly db: AuthDb
readonly wsServer: WebSocketServer
```

接线要点：

- `KeyLogApplier`：`KeyLogStore.head` + `UserKeyService.applyMany` + `list`
- Hub `keyLogSource`：现成 `createHubKeyLogSource(service, store)`（`hub/hub-key-log-source.ts`）
- hub `authenticate`：`authenticateRequest` + `getMeshRequestContext(req).via`（默认 `self` → 本机 `nodeIdHex`）
- `PeerLinkProvider.onNodeEvent`：PeerManager 没有该 API，由 mesh-runtime 包一层，从 `node.list` 投影
- `openWsStream`：B2-2a 的 `{send, readable, close}` 适配成 B2-2b 的 `{send, onMessage, onClose, close}`
- `UplinkClient` 无 `attachLink`：内存 uplink 通过私有 `bindLink`/`authenticate` 接线（先 bind 再 `attachLocalNode`，ctl inbox 可补帧）

## B2-2b 实际导出（相对 prompt 的差异）

- `MeshHttpRuntime` 是 **class**，不是工厂函数
- `handleRequest` → `Response | null | undefined`（upgrade 为 `undefined`）
- `handleWebSocket` 只有 `open/message/close`，无 `drain`
- WeakMap 名是 `setMeshRequestContext` / `getMeshRequestContext`，不是 `RequestVia`
- WS kind：`mesh-event`、`mesh-forward-ws`

已按真实导出适配。

## 测试

`cd apps/gateway && bun test src/mesh/mesh-runtime.test.ts`：

```
 3 pass
 0 fail
 9 expect() calls
Ran 3 tests across 1 file. [415.00ms]
```

`cd packages/app && bun test src/runtime`：

```
 13 pass
 0 fail
 33 expect() calls
Ran 13 tests across 3 files. [345.00ms]
```

（9 条 assemble + 既有 gateway/serve-frontend。）排除范围外 `src/commands/hub.test.ts` 后：

```
 124 pass
 0 fail
 321 expect() calls
Ran 124 tests across 17 files. [794.00ms]
```

全量 `cd packages/app && bun test src` 当前 **127 pass / 4 fail / 4 error**，失败全在并发 CLI `src/commands/hub.test.ts`（`Cannot find module '@tmex/shared/auth'`），非本任务。

biome：范围 6 文件 `Checked 6 files. No fixes applied.`

## tsc

| | 数量 |
|---|---|
| 基线 `apps/gateway` | 23 |
| 本次全量 | **30**（hub-test-helpers `HubKeyLogSource.append` 签名变更、既有 push/tmux/ws；**`mesh-runtime.ts` / `mesh-runtime.test.ts` / 本任务对 `runtime.ts` 的改动 = 0**） |
| 基线 `packages/app` | 1 |
| 本次 | **1**（仍是 `Cannot find type definition file for 'node'`；`assemble.ts` / `server.ts` = 0） |

新文件无 tsc 错误。全量 gateway 数字上涨来自并发 hub/ws，不是本范围引入。

## 协调者必须做

1. **`apps/gateway/src/mesh/index.ts`** 未 re-export `createMeshRuntime`（barrel 属 B2-2a）。调用方目前从 `./mesh-runtime` 直引。
2. **`apps/gateway/src/hub/index.ts`** 未 re-export `createHubKeyLogSource`；本任务从 `../hub/hub-key-log-source` 直引。
3. **未**给 `GatewayRuntimeOptions` 加 `roles`：设计表迁移/tmux/supervisors 全角色相同。若后续 standalone 要跳过某 supervisor，再加。
4. `GatewayRuntime.websocket.closeSession` 由并发 B1-1-fix 加入；assemble 已原样转发，不要在 mesh 路径上调用它。
5. `/n/<hubNodeId>/api/hub/*` 经 http 流打到目标的 `dispatchHttp`，**不会**进 `HubRuntime.handleRequest`。本机 `/api/hub/*` 走 fetch 链没问题；跨 node 管 hub 需后续把 hub 路由接入 `dispatchHttp` 或目标侧 fetch 链。
6. `packages/app` 全量测试被 CLI `hub.test.ts` 染红，需 F4/shared export 修好。

未碰生产 tmex / 默认 tmux session `tmex`。未 `bun install`。
