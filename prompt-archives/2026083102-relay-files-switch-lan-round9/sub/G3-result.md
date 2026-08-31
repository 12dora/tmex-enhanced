# G3 结果：mesh 直连拨号调优 + `/api/mesh/nodes` 链路诊断

## 做了什么

A. **Endpoint ranking**（`rankPeerEndpoints` in `address-class.ts`）  
   拨号前按本机非 internal 网卡的 netmask/cidr 排序：同网段 → 其他私网 → 公网；同档 IPv4 先于 IPv6；同档同族保持输入相对顺序。`interfacesFn` 可注入（与 runtime 的 `stores.interfacesFn()` 同模式）。

B. **Happy-eyeballs ws-secure**（`PeerManager.dialWsSecure`）  
   排序后的 endpoint 以 250ms stagger 并发拨；首个握手成功者胜，其余 abort 并关 socket。单次仍 3s。`isTrusted` / transcript 未改。`stop()` 通过既有 generation + `stopAbort` 取消全部 in-flight。

C. **直连尝试记录**  
   内存 `lastDirectAttempt`：`{ at, ws, dc, endpointsTried }`。ws 为最后一次 ws-secure 失败短因（`timeout|refused|handshake: …`）；dc 为 `direct_capable=false` / `datachannel unavailable` / dcError。直连（dc/ws-secure）建成后 ws/dc 清为 null。`LivePeer.linkSinceAt` = 当前 live 安装时刻。

D. **REST only**  
   `GET /api/mesh/nodes` DTO 增加 `peerAddress` / `linkSinceAt` / `endpoints` / `directFailure`；self 为 null/[]。relay 的 `peerAddress` = hub host（runtime 用 `hubHostFromUrl(hubEndpointUrl(config))` 注入 PeerManager，不读 uplink 私有字段）。borsh NodeEvent 未改。

## 文件

- `apps/gateway/src/mesh/address-class.ts` (+ test)
- `apps/gateway/src/mesh/peer-manager.ts` (+ test)
- `apps/gateway/src/mesh/peer-manager.upgrade.test.ts`（16 个 endpoint 上限用例改为等 stagger 跑完，不再假设 50ms 内全部启动）
- `apps/gateway/src/mesh/node-list-projection.ts` (+ test)
- `apps/gateway/src/mesh/mesh-routes.ts` (+ test)
- `apps/gateway/src/mesh/mesh-runtime.ts`（`createPeerWiring` 注入 `interfacesFn`/`hubHost`；`wireMeshHttp` 的 peers 增加 `linkDetailOf`）

## 测试 / tsc

| | before | after |
|---|---|---|
| `apps/gateway` bun test | 2969 pass / 0 fail（298 files） | 2997 pass / 0 fail（302 files；含本任务 +10，其余为并行 agent） |
| `bunx tsc --noEmit -p .` | 22 errors（预存） | 22 errors（未增长） |
| biome check（上列改动文件） | — | 通过 |

新增单测要点：ranking 五条；hang+success 在 stagger 内成功且 hang socket 被关；双失败走 relay 并带 `directFailure`；`stop()` 取消竞速；projection/route 含新字段，self 为空。

## 指挥官需跟进（未改，非 owned）

1. **`apps/gateway/src/mesh/mesh-deps.ts`**：`PeerLinkProvider` 建议补可选 `linkDetailOf?(nodeId): MeshNodeLinkDetail | null`。本任务用 `MeshRoutesDeps.peers` 交叉类型绕过，避免碰非 owned 文件。`FakePeers`（`auth-routes.test.ts`）不必实现（可选方法）。
2. **api-client / 前端类型**（O1）：DTO 新字段需在 client 类型同步；本任务按要求未碰 frontend / api-client。
3. 未跑 Playwright / `bun run dev`。未改 i18n。
