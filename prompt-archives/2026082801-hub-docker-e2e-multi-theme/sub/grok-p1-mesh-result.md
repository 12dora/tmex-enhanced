# grok-p1-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`，只改 `apps/gateway/**`，无 git 操作。CLI（`packages/app`）不需要改。

## 根因（file:line）

Docker 3 容器现象：node-a 的 `GET /api/mesh/nodes` 只有 self + hub 证书行（`online:false, isHub:false`），没有后加入的 node-b；`GET /api/auth/mode` 的 `hubNodeId` 为 `null`。是三条互相叠加的缺陷，不是「hub 没广播 node.list」。

### 1. mesh 侧丢掉整份 `node.list`（docker 主因）

Hub `buildNodeList` 把 `nodes[].version` 编成 `string | null`（`apps/gateway/src/hub/uplink-protocol.ts` `NodeListEntry.version`）。`hub join` redeem 默认 `version: ''` → 库里 `null`；节点刚 `auth.ok`、还没发 `node.status` 时 `live.meta.version` 也是 `null`。

Node 解码却要求 version 必为 string：`apps/gateway/src/mesh/uplink-protocol.ts` 原 `parseNodeInfo` `requireString(value.version, 'nodes[].version')`。`UplinkClient.handleCtl` 把解码失败吞掉（`uplink-client.ts` bindLink ~L338–344）。**任意一个 node 的 version 为 null，整份 `node.list` 被丢**，因此：

- `hub_meta` 从不落库 → `hubNodeId: null`、`isHub: false`
- 不发起 `key.log.req` → 后加入节点的 `admit-node` 进不了本机 `node_certs` → `collectNodes`（`mesh-routes.ts` ~L206–218，只枚举 `listCerts()`）看不到 node-b

CLI `redeemEnrollment` 发 `version: options.version ?? ''`（`packages/app/src/lib/hub-client.ts`），正好打中这条。进程内旧测试 redeem 写 `version: 'test'`，所以之前绿。

### 2. catch-up 之后不回写 `peer_cache`

`ingestNodeList` 原先在 key-log catch-up **之前**按已有证书 `upsertPeer`。后加入节点此时还没有 `admit-node` 证书，被跳过；`applyMany` 验签写入证书后也没有第二次 persist。重启后 `peer_cache` 里没有对端，LAN 直连没有缓存地址。

### 3. `onNodeList` 把 hub 哨兵行删掉

`hub_meta` 存在 `peer_cache.node_id = 'hub'`（`HUB_META_PEER_ID`）。`mesh-runtime.ts` `onNodeList` 扫 `listPeers()`，对没有证书的行 `deletePeer`。`'hub'` 没有 cert，**刚 upsert 的 hub_meta 被立刻删掉**。即使 node.list 解码成功，`/api/auth/mode.hubNodeId` 仍是 `null`。

证书信任链没有削弱：`persistAdmittedPeers` 仍要求 `userStore.getCert`（只来自已验证的 `admit-node`）；ghost `node.list` 行仍然被忽略。

## 协议 / 数据流改动

```
hub buildNodeList
  version: live.meta.version ?? n.version ?? ''     # 不再下发 JSON null
  + hub: { nodeId, publicUrl }

node decodeUplinkCtl
  nodes[].version 允许 null / 缺省 → null          # 兼容已发出去的旧帧

UplinkClient.ingestNodeList
  1. upsertHubMeta(list.hub)                         # 立刻
  2. persistAdmittedPeers                            # 已有证书的 peer
  3. catch-up key.log.req → applyMany（验签 admit-node）
  4. persistAdmittedPeers 再跑一遍                   # 新证书对应的 peer_cache
  5. onNodeListCb

mesh-runtime.onNodeList
  跳过 HUB_META_PEER_ID，不再 deletePeer('hub')

listReach overlay（仅 uplink online）
  lastNodeList.online && 本地已 admit → reach 缺省标 relay
  真正的 lan/relay 仍以 live LinkSession 为准；getLink 仍懒建
```

`key.log.req` 增加 10s 超时，避免 catch-up 链永久挂起。签名 / `admit-node` 验证路径未改。

## CLI

不需要改 `packages/app`。join 继续发 `version: ''` 即可；hub 侧已把 null 收成 `''`，mesh 侧也能吃 null。

## 测试

先红后绿：

- `uplink-protocol.test.ts`：hub 线上 JSON `version: null` 必须能 decode
- `uplink-client.test.ts`：`node.list` 里尚无证书的 peer，等 `key.log.res` 写入 admit 后再进 `peer_cache`，并留下 `hub_meta`
- `mesh.integration.test.ts`：hub + 已 uplink 的 node A → 再 join node B → A 的 `/api/mesh/nodes` 含 B 且 `online:true`；`/api/auth/mode.hubNodeId` = hub id；hub 行 `isHub:true`；经 A 登录 B 并 `GET /n/<B>/api/devices` 成功；停 A 再起，`peer_cache` + `hub_meta` 仍在

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2236 pass / 0 fail**（基线报告 1823/0；本仓测试已增多） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 23） |
| `bunx biome check`（7 个改动文件） | 通过 |

## 改动文件

- `apps/gateway/src/mesh/uplink-protocol.ts` — `version` 可选
- `apps/gateway/src/mesh/uplink-client.ts` — catch-up 后再 persist；key.log.req 超时
- `apps/gateway/src/mesh/mesh-runtime.ts` — 保留 hub 哨兵；listReach overlay
- `apps/gateway/src/hub/uplink-server.ts` — `version` 不下发 null
- 对应单测 / 集成测试
