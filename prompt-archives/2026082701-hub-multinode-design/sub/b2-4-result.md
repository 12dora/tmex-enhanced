# B2-4 结果 — wiring leftovers + Phase-2 集成测试

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。

## 做了什么

按 B2-3 review 未修项 + B3-1 钩子把 mesh 组装补齐，并加同进程 hub+A+B 集成测试（无真网卡、无生产 tmex / 无 `tmex` tmux session）。

- in-memory uplink 走公开 `UplinkClient.connectWithLink`，去掉 mesh-runtime 对私有状态机的强制转换。
- `node.status.endpoints` 枚举 `os.networkInterfaces()` 非 internal IPv4/IPv6；PeerServer bind host 显式读 `TMEX_PEER_BIND_HOST`（未设则 dual-stack）。
- standalone 不装 SIGINT/SIGTERM；mesh 角色关停预算 20s，`assembled.stop()` 单 `stopPromise` 给 restart/SIGINT/SIGTERM 共用。
- 构造 `RtcPeerManager` + `MeshRtcSignalRouter`；`direct_capable` 来自 `rtc.available`；`ws/index.ts` 接 `CARRIER_SWITCH_ACK`；PeerManager 在 `direct_capable` 时先试 DataChannel，再 `linkFactory` / `ws-secure` / relay。
- 集成：hub+node A + node B 同进程，in-memory uplink + in-memory peer link。

## 文件清单

修改：

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/uplink-client.ts` | `connectWithLink`；`start(connectOnce?)` |
| `apps/gateway/src/mesh/mesh-runtime.ts` | endpoints / RTC / in-memory uplink / 吊销扫 cert / 幂等 stop |
| `apps/gateway/src/mesh/peer-manager.ts` | `'dc'` 槽、`linkFactory`、`adoptLink`/`getLive`、revoked sweep |
| `apps/gateway/src/mesh/index.ts` | barrel：`createMeshRuntime`、`MeshHttpRuntime`、rtc |
| `apps/gateway/src/ws/index.ts` | `setOnCarrierSwitchAck` + `KIND_CARRIER_SWITCH_ACK` |
| `packages/app/src/runtime/assemble.ts` | 20s 预算、`stopPromise`、`loadNative`、`meshShutdownNeeded` |
| `packages/app/src/runtime/server.ts` | 仅 mesh 角色装信号处理器 |
| `packages/app/src/runtime/assemble.test.ts` | standalone 无 shutdown、stop 幂等 |
| `apps/gateway/src/mesh/peer-manager.test.ts` | linkFactory + DC 往返 |

新增：

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/integration/wiring.test.ts` | endpoints 假 `networkInterfaces`、`connectWithLink` |
| `apps/gateway/src/mesh/integration/mesh.integration.test.ts` | Phase-2 集群（bun 只发现 `*.test.ts`，见下） |

未改：`auth-routes.ts`、`mesh-routes.ts`、`hub/**`、`packages/shared/src/ws-borsh/**`、`auth/**`。

## 公开 API

```ts
// UplinkClient
start(connectOnce?: (signal: AbortSignal) => Promise<void>): void
connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void>
  // bind → 等 auth.challenge → 签 uplinkAuthMessage → auth.ok → online + heartbeat

// mesh-runtime
enumeratePeerEndpoints(port: number, interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[]
createMeshRuntime(opts: CreateMeshRuntimeOptions): Promise<MeshRuntime>
CreateMeshRuntimeOptions 增：
  uplinkHub?: HubRuntime          // 同进程远程 node 的 in-memory uplink
  loadNative?: LoadNative         // 缺省 async () => null → direct_capable=false
  networkInterfaces?: () => ...
  linkFactory?: PeerLinkFactory
  rtcHandshakeTimeoutMs?: number
MeshRuntime 增：readonly rtc: RtcPeerManager

// PeerManager
type PeerLinkFactory = (peerNodeId: string, signal: AbortSignal) => Promise<LinkSession | null>
opts.rtc?: RtcPeerManager
opts.linkFactory?: PeerLinkFactory
getLive(nodeId: string): LinkSession | null
adoptLink(peerNodeId, session, transport?, initiatedBy?): LinkSession | null
receiveRtcSignal(fromNodeId, msg): void
dial 顺序：dc（双方 direct_capable）→ linkFactory → LAN ws-secure → relay

// WebSocketServer
setOnCarrierSwitchAck(handler: ((session: GatewaySession, epoch: number) => void) | null): void

// assemble
SHUTDOWN_TIMEOUT_MS = 20_000
meshShutdownNeeded(roles: TmexRoles): boolean
AssembleTmexOptions.loadNative? / nativeDir?
AssembledTmex.stop(): 缓存单一 Promise
```

环境：`TMEX_PEER_BIND_HOST` 未写入 `config.ts`（范围外），mesh-runtime / assemble 直接读 env；空/未设 → PeerServer `['::','0.0.0.0']`。`TMEX_NATIVE_DIR` 给 `loadNodeDatachannel`；未设则 native=null。

## 测试

`cd apps/gateway && bun test`：

```
 1748 pass
 0 fail
 6004 expect() calls
Ran 1748 tests across 205 files. [46.25s]
```

（基线 ~1704/1706；增量来自 wiring + integration + peer-manager DC/linkFactory。）

`cd packages/app && bun test src/runtime`：

```
 17 pass
 0 fail
 49 expect() calls
Ran 17 tests across 3 files. [335.00ms]
```

owned mesh 抽样：`wiring.test.ts` + `peer-manager.test.ts` + `uplink-client.test.ts` + `mesh-runtime.test.ts` 29 pass。

## tsc / biome

| | 数量 |
|---|---|
| 基线 gateway tsc | 24 |
| 本次全量 gateway | **23**（owned 文件 0；未升） |
| 基线 packages/app | 1（`Cannot find type definition file for 'node'`） |
| 本次 packages/app | **1** |
| biome 范围 11 文件 | clean |

## 验收标准 4 对照

设计「测试策略·集成」+ 验收标准 4。用例都在 `mesh.integration.test.ts`（另 `wiring.test.ts` 覆盖接线）。

| 设计/任务子项 | 测试 |
|---|---|
| 登录 fan-out：root delegation → A self + `/n/B/api/auth/login`，cookie 落在 A origin | `browser-style login fan-out...`（`tmex_s_self` + `tmex_s_<B>`） |
| `GET /n/B/api/devices` 经 A 返回 B gateway 数据 | 同上 |
| `/n/B/ws` HELLO → DEVICE_CONNECT 到 B `WebSocketServer` | `/n/B/ws HELLO then DEVICE_CONNECT...`（fake device `dev-b`） |
| relay：A→B 经 hub，hub 侧看不到明文 Borsh / JSON | `relay path carries SecureChannel ciphertext...`（抓 `openRelay` 流，断言无 `dev-b` / `B box` / `/api/devices`） |
| `node.list` 广播 B online | `enrollNodeB` 里 `waitUntil(lastNodeList.nodes includes B)` |
| upload abort：`Request.signal` + cleanup | `upload abort aborts the target Request.signal...` |
| 签名 `revoke-node`：B uplink 断、A peer 关、via=B 会话失效、`/n/B/*` 503/401 | `signed revoke-node disconnects B...` |
| **4a** 只持 A 节点钥 + A DB：http/ws 拒；签不出 B 接受的 login | `compromise: A node key cannot obtain...` |
| **4b** 持 hub 全库：错钥 `admit-node` 拒；伪造 `node.list`/无 cert 节点 `getLink` 拒 | `compromise: hub DB cannot mint...` |
| **4c** 掉包 `target_pk` 登录失败；假 PC 指纹 mismatch DC 失败 | `compromise: swapped target_pk fails login; DC fingerprint mismatch...` |
| standalone 无 signal handlers | `assemble.test.ts` `meshShutdownNeeded` + `server.ts` 守卫 |
| stop 幂等 / 20s | `stop is idempotent...`；`SHUTDOWN_TIMEOUT_MS === 20_000` |
| endpoint 枚举 | `wiring.test.ts` 假 `networkInterfaces`（跳过 loopback / link-local `%`） |

验收 1–3、5–6（真双机 LAN / hub 停机 / standalone e2e / tarball）不是本任务。

## 未能做 / 协调者必须做

1. **文件名**：prompt 写 `mesh.integration-test.ts`，但 bun test **不发现** `*.integration-test.ts`（只要 `.test` / `.spec`）。落地为 `mesh.integration.test.ts` 以便 `bun test` 自动跑。
2. **`config.ts`** 未加 `TMEX_PEER_BIND_HOST` / `peerBindHost`（范围外）。运行时已读 env。
3. **browser RTC 闭环未完**：`authorizeBrowser` 已接到 `RtcPeerManager`；`signals.send` 在首次 browser 信令时 auto-`register`。`acceptBrowser` → `attachDirect(gatewaySession)` 仍缺浏览器 `/ws` GatewaySession（B3-1 钩子 1 后半；`mesh-routes.ts` 范围外，authorize 入参无 sid）。
4. **hub 侧** `rtc.signal` 无 `fromNodeId` 字段。node↔node DC 用 `rtcSession === 'dc:<lo>:<hi>'` 反推对端。若 hub 改信令形状，PeerManager 要跟着改。
5. **吊销后 A 的 in-memory peer**：hub 已断 B uplink 并 `append` 同一 DB；`getLive`/`listReach`/`getLink` 见 `revokedLogSeq` 即 `onRevoked`。依赖 node.list 回调关闭 live link 在同库 hub,node 下不可靠（catch-up seq 已对齐）。
6. **B2-5** redeem 证书持久化仍不是本任务。集成测试在 redeem 后本进程 `signAndApply(admit-node)` + `verifyChainForJoin` 把链拷到 B。
7. `loadNative` 未注入时 `direct_capable=false`；生产由 assemble 传 `loadNodeDatachannel({ nativeDir: TMEX_NATIVE_DIR })`，未设 env 则 null（不读生产 `~/Library/Application Support/tmex/native`）。

未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）、默认 tmux session `tmex`、`bun install`。
