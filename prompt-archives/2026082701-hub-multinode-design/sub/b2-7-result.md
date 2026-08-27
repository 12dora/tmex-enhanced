# B2-7 结果 — 接线/集成审查修复

worktree：`/Users/konata/code/tmex-enhanced-wt-hub`，分支 `feat/hub-node`。对照 `b2-4-review.md`（协调者判定全部有效）、`b3-1-fix-result.md`（authorize 先于 accept；`send` 返回 Promise；SWITCH 发出后切出站）、`b2-6-result.md`（keylog/hub meta 接线未回退）。未碰生产 tmex / 名为 `tmex` 的 tmux session。未 `bun install`。未 commit。

## 做了什么

1. **浏览器直连生产闭环**：`/api/rtc/authorize` 传入 `{sid,uid,via,rtcSession,fpBrowser}`；`SessionRegistry` 登记 `sid → GatewaySession`（`acceptWsStream` + assemble 本地 `/ws`）；目标 node 信令入口 `onLocal`/`deliverLocal` 调 `acceptBrowser`，仅当 `sid/uid/via` 全匹配才 `attachDirect`；`BulkTransferService` 接 `bulk:*`。
2. **node↔node DC 经真实 hub**：`UplinkServer` 对规范化 `dc:<lo>:<hi>` 隐式登记（同用户、未吊销证书）；node 在走 uplink 前 `ensureDcSession`。集成测试不 monkey-patch `sendCtl`。
3. **仲裁**：`initiatedBy` 来自 `result.role`；先 `dc > ws-secure > relay`，同级才 nodeId tie-break；`getLink()` 对低优先级 live 后台升级，旧链在途流跑完再关。
4. **信任门**：`getLink` / `receiveRtcSignal` / `listReach` / peer `node.status` 写 cache 都要求存在、同用户、未吊销的 `node_certs`；`node.list` 未 admit 节点删 cache、不拨号。
5. **控制帧发送状态**：`WebSocketServer.sendControl` 返回 `'sent'|'backpressure'|'closed'`；`CarrierSwitchController` 仅在帧被接受后切出站；背压等 `onDrain`；旧载体关闭取消切换。
6. **关停**：`createProcessShutdown` 单一 Promise，重启与 SIGINT/SIGTERM 共用 20s 预算；mesh/assemble 每阶段失败打日志并继续（peer → uplink → hub → gateway）。
7. **集成测试非空跑**：伪造 sid 走真实 relay 握手；伪造 `node.list` 经真实 uplink；relay 密文非空 + 跨分片无 Borsh magic / HTTP OPEN，并用会话密钥解密；upload abort 等 B dispatch latch。
8. **endpoint 枚举**：排除 loopback / unspecified / multicast / IPv4 169.254/16 / IPv6 fe80::/10（不论 `%`）。

## 文件清单

修改：

| 文件 | 作用 |
|---|---|
| `apps/gateway/src/mesh/mesh-deps.ts` | `RtcAuthorizeBrowserInput.sid?` |
| `apps/gateway/src/mesh/mesh-routes.ts` | authorize 传 `sid` |
| `apps/gateway/src/mesh/mesh-runtime.ts` | SessionRegistry、browser accept、bulk、信任清理、容错 stop、endpoint 过滤 |
| `apps/gateway/src/mesh/index.ts` | 导出 SessionRegistry / 仲裁常量 |
| `apps/gateway/src/mesh/peer-manager.ts` | 信任门、仲裁、升级、ensureDcSession、session keys |
| `apps/gateway/src/mesh/stream-targets.ts` | `acceptWsStream` 登记/注销 GatewaySession |
| `apps/gateway/src/mesh/rtc/{rtc-peer-manager,signaling,carrier-switch,index}.ts` | 授权载荷、deliverLocal、控制发送状态 |
| `apps/gateway/src/hub/uplink-server.ts` | `dc:A:B` 隐式登记 + `ensureDcSession` |
| `apps/gateway/src/ws/index.ts` | `sendControl` 返回 send-guard 状态 |
| `packages/app/src/runtime/{assemble,server}.ts` | 本地 `/ws` 登记、共享 shutdown、阶段失败继续 |
| `apps/gateway/src/mesh/integration/{mesh.integration,wiring}.test.ts` 及各单元测试 | 非空跑 + 回归 |

新增：`apps/gateway/src/mesh/integration/direct-path.integration.test.ts`（浏览器直连 + 真实 hub DC）。

未改：`peer-protocol.ts`、`uplink-client.ts`（范围外；未 admit 的 cache 行在 `onNodeList` 删除）。

## 公开 API

```ts
// mesh-deps
RtcAuthorizeBrowserInput { rtcSession, uid, via, sid?: string, fpBrowser }

// rtc
RtcPeerManager.authorizationOf(rtcSession): BrowserAuthorization | null
AcceptBrowserResult { carrier, pc, uid, sid, via }
MeshRtcSignalRouter.deliverLocal(signal): void
SendControl = (session, kind, payload) => ControlSendStatus | Promise<ControlSendStatus> | void
ControlSendStatus = 'sent' | 'backpressure' | 'closed'

// WebSocketServer
sendControl(session, kind, payload): 'sent' | 'backpressure' | 'closed'

// mesh-runtime
class SessionRegistry {
  register(entry: RegisteredGatewaySession): void
  unregister(sid: string, session?: GatewaySession): void
  unregisterSession(session: GatewaySession): void
  get(sid: string): RegisteredGatewaySession | null
}
MeshRuntime.sessions: SessionRegistry
registerGatewaySession(entry): void
unregisterGatewaySession(sid | GatewaySession): void
isAdvertisablePeerAddress(addr): boolean

// PeerManager
comparePeerTransport(a, b): number
PEER_TRANSPORT_RANK
transportOf(nodeId): PeerTransportKind | null
sessionKeysOf(nodeId): { sendKey, recvKey } | null
getLink: 未 admit → NodeUnreachableError('not admitted')
opts: onGatewaySession, onGatewaySessionClose, onBrowserSignal, ensureDcSession

// UplinkServer
ensureDcSession(userId, nodeA, nodeB): boolean
handleRtcSignal: dc:<lo>:<hi> 证书校验后转发，无需 registerRtcSession

// assemble
createProcessShutdown(stop, hooks?): () => Promise<void>
installShutdownHandlers(...): () => Promise<void>  // 同一 Promise
AssembledTmex.stop(): 阶段失败继续
```

## 测试

`cd apps/gateway && bun test`：

```
 1791 pass
 0 fail
 6318 expect() calls
Ran 1791 tests across 208 files. [43.97s]
```

`cd packages/app && bun test src/runtime`：

```
 19 pass
 0 fail
 53 expect() calls
Ran 19 tests across 3 files. [399.00ms]
```

（assemble 关停失败路径会 `console.error` 堆栈，属预期日志，测试仍绿。）

## tsc / biome

| | 基线 | 本次 |
|---|---|---|
| gateway tsc | 23 | **23**（owned 文件 0；未升） |
| packages/app tsc | 1 | **1** |
| biome 范围 25 文件 | | **clean** |

## 未能做 / 协调者必须做

1. **`uplink-client.ts` 仍会先 `upsertPeer` 再回调 `onNodeList`**（范围外）。本任务在 `onNodeList` 把无证书/跨用户/已吊销行删掉，因此测试看到的是「无 cache 行、零拨号」。若要在写入前拦截，需改 uplink-client。
2. **`rtc-loopback.integration.ts` 未改**（范围外）：`authorizeBrowser` 的 `sid` 仍可选，缺省 `''`，不影响该文件。
3. **`config.ts` 仍未登记 `TMEX_PEER_BIND_HOST`**（范围外，B2-4 已说明）。
4. 本地 `/ws` 的 `sid→GatewaySession` 登记在 `packages/app` 的 assemble 里（`bindSocket` 会覆盖 `ws.data`，故先抓 sid 再 open）。纯 `createMeshRuntime` 测试请用 `registerGatewaySession`。

未碰生产 tmex（9883 / `~/Library/Application Support/tmex/`）、默认 tmux session `tmex`。
