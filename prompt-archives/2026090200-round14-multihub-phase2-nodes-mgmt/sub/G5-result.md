# G5 结果 — Hub-to-hub relay + attachedHubId

## 做了什么

不同 hub 上的 node 现在可以互达。每台 hub 维护内存附着路由表；standby 经已有 writer uplink 上报本地附着，写者合并后把 union 广播给已授权 hub。跨 hub 数据走 `hub-relay` 流（双向 pump，不终止 node↔node handshake）；`rtc.signal` 用 hub-only `hub.forward` 封装，回程走 `returnHubId`。

### 路由表与控制帧

- 新 `AttachmentRouter`：`nodeId → { hubId, version, lastSeen }`。本地来自 `NodeRegistry`；5 分钟无刷新过期；上限 4096。更高 `lastSeen` 覆盖；hub uplink 断开时丢掉指向该 hub 的条目，并 RST 进行中的跨 hub 流。
- `UPLINK_CTL_TYPES` 末尾追加 `hub.attachments`、`hub.forward`。只在 `isAuthorizedHub` 的对等体之间交换，只发给 advertised version ≥ 1.1.13 的 peer（复用 `peerSupportsHubTokens`）。legacy 剥成 `{ t }`。单帧 64 KiB；entries 上限 4096。未授权帧打日志丢弃。
- `hub.attachments { revision, entries: [{ nodeId, attached, hubId? }], full? }`：standby 鉴权后发全量、attach/detach 发增量；写者广播 union 时带 `hubId`。
- `hub.forward { kind: 'rtc.signal', originHubId, returnHubId, visitedHubIds, signal }`。session→hub 映射 TTL 10 min（`RtcHubRouteTable`）。

### 跨 hub relay

- `onIncomingStream`：目标不在本地但路由表给出 hub `H` 时，在已认证 hub uplink 上打开 `hub-relay`（OPEN `{ kind, to, from, originHubId, visitedHubIds, hop }`）。mux 两侧都能 `openStream`，未改 `packages/shared/src/link`。
- 对端校验：`isAuthorizedHub(origin)`、`hop ≤ 2`、`visitedHubIds` 无重复、目标本地且同用户、源证书未吊销；然后泵进本地目标，OPEN 形状与同 hub relay 相同。
- 目标仍不在本地且 hop 未超限时经写者再转一跳。

### `attachedHubId`

- `node.list.nodes[]` 可选字段，写者从路由表投影；`legacy: true` 剥离。
- `GET /api/mesh/nodes` → `MeshNode.attachedHubId?`（`node-list-projection` + `mesh-routes` 手术式追加）。

## 文件

新建：

- `apps/gateway/src/hub/attachment-router.ts`、`attachment-router.test.ts`
- `apps/gateway/src/hub/hub-relay.ts`、`hub-relay.test.ts`

修改：

- `packages/shared/src/uplink/codec.ts`、`codec.test.ts`
- `packages/api-client/src/auth/types.ts`（仅 `MeshNode.attachedHubId?`）
- `apps/gateway/src/hub/{uplink-server,uplink-server.test,uplink-protocol,hub-runtime,index}.ts`
- `apps/gateway/src/mesh/{uplink-client,mesh-runtime,mesh-routes,mesh-http,node-list-projection,node-list-projection.test}.ts`
- `apps/gateway/src/mesh/rtc/{signaling,signaling.test,index}.ts`
- `apps/gateway/src/mesh/integration/{multi-hub-harness,multi-hub.integration.test}.ts`
- `docs/hub/2026090104-multi-hub-standby.md`

`uplink-client.ts` 与 `mesh-http.ts` 不在原始 scope 列表里：standby 作为 node 收 `hub.attachments` / `hub.forward` / `hub-relay` 必须走 client 回调；`attachedHubIdOf` 需经 `MeshHttpRuntime` 传入 `MeshRoutes`。未改 `uplink-pool.ts`、`peer-manager.ts`、`packages/shared/src/link`。

## 测试 / tsc

| 包 | bun test | tsc `--noEmit` |
|---|---|---|
| `packages/shared` | **424 pass / 0 fail** | **0** |
| `apps/gateway` | **3463 pass / 0 fail** | **0** |
| `packages/api-client` | （未跑全量，仅改类型） | **5** 既有 |

Biome：变更源文件 `biome check --write` 后 `biome check` 干净。

单元：路由表 merge / 过期 / 4096 cap / 未授权拒绝；`hub.attachments` / `hub.forward` / `attachedHubId` codec 往返 + legacy 剥离；relay 校验矩阵（hop / visited 重复 / unauthorized / revoked / unknown target / cross-user）；跨 hub 时打开 `hub-relay`。

集成：`attachSplitAbcd` 让 C 挂 A、D 挂 B；C→D 与 D→C HTTP `/n/<id>/api/...` 成功；RTC offer/answer 往返；A down 后 C 切到 B，C→D 仍通。

## 未做 / 注意

- 当前仓库 `getDisplayVersion()` 仍是 1.1.12，写者 fanout 的版本门会挡住未 stamp 的 peer。集成测试用 `stampHubCtlVersions` 把 registry meta 写成 1.1.13（与 G4 token 复制相同）。发 1.1.13 后生产路径不再需要 stamp。
- `hub.attachments` union 仍是单帧；超过 64 KiB 会失败，以后需要分页。
- 未改 `apps/fe`、`uplink-pool.ts`、`peer-manager.ts`。
