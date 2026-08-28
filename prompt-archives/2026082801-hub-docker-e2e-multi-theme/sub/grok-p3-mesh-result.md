# grok-p3-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`，只改 `apps/gateway/**` 与 `scripts/hub-e2e/run.sh`（场景 8 在 native 已安装但 flag 未翻转时由 SKIP 改为 FAIL）。无 git 操作。未改 `packages/shared`。

远程验证 tag：**`p3`**。

## 根因（file:line）

### 4c — LAN 升级时机

LAN 拨号本身是通的（场景 6 停 hub 后 `reach` 变成 `lan`，终端/文件仍通）。4c 失败是因为 4b 已经在 **lan 网还不存在时** 经 node-a 登录 node-b，`PeerManager` 上留下一条 sticky **relay**，之后 60s 内没有人去换更高 rank 的 `ws-secure`。

两条缺口叠在一起：

1. **endpoint 会随 `os.networkInterfaces()` 变，但只在 uplink 心跳里重广告。**  
   `statusProvider`（`mesh-runtime.ts` ~L724–735）每次都调 `enumeratePeerEndpoints(port, interfacesFn())`。`UplinkClient` 心跳（15s）在 status JSON 变化时 `sendStatus()`，所以 docker `network connect` 之后 hub **能**收到新 LAN 地址并广播 `node.list`。这不是 4c 的主因；单测 `re-advertises node.status endpoints when network interfaces change` 在改升级逻辑之前就已经绿。

2. **`node.list` 更新 `peer_cache` 后不会对已有 relay 做升级拨号。**  
   `persistAdmittedPeers` 会写新 endpoints，但 `getLink` 的 `wantsUpgrade` 分支只在有人再调 `getLink` 时才跑。4c 的 `wait-reach` 只轮询 `GET /api/mesh/nodes` → `listReach()`，不建新流。场景 6 停 hub 后 relay 断了，终端/文件再次 `getLink` 才走到 LAN。  
   设计要求 LAN 优于 relay，但 `PeerManager` 没有「endpoints 变了 → 后台 upgrade dial → 认证成功再 swap，旧链保持到新链就绪」这条路径。

### 8 — `self.direct_capable` 一直 false

`collectNodes`（`mesh-routes.ts` 修复前 ~L257）对所有行都读 `peer_cache`：`direct_capable: peer?.directCapable ?? false`。self **不进** `peer_cache`（`persistAdmittedPeers` 显式跳过 `node.id === this.identity.nodeId`），所以 self 永远是 `direct_capable:false`、`version:null`、`inventory:null`。

这与 native 是否加载无关：`assembleTmex` 会把 `loadNodeDatachannel` 传进 `createMeshRuntime`；`start()` 先 `await rtc.ready()` 再连 uplink，`node.status` 里的 `direct_capable: rtc.available` 在 addon 加载成功后是 true。Harness 查的是 entry 的 `/api/mesh/nodes` `--name self`，不是 hub 注册表。把 self 接到 `statusProvider` 即可；不必改成查 `/api/hub/nodes`。

## 改动

### LAN 升级（4c）

- `PeerManager.notifyPeerEndpointsChanged(nodeId?)`：对 live relay（或任何 `wantsUpgrade`）排队更高 rank 的 `dial()`；成功后现有 `track()` 按 rank 替换，旧链 `retire`（在途流不丢）。
- 触发点：
  - `mesh-runtime` `onNodeList`：hub 广播新 endpoints 后立刻 `notifyPeerEndpointsChanged(node.id)`（`mesh-runtime.ts` ~L785）
  - `applyPeerStatus`：对端经 live link 发来的 `node.status`（hub 不可达时也能升级）
  - `PeerManager.start()` 每 15s 扫一遍 live + `refreshAdvertisedStatus()`（本地 iface 变了就向 live peer 重推 `node.status`）
- 限频：`PEER_UPGRADE_COOLDOWN_MS = 10_000`。endpoints JSON 变了立即拨，没变则走 cooldown；已有 `pending` 不再入队。
- `getLink` 仍走无 cooldown 的升级（用户流量）。
- `UplinkClient.sendStatusIfChanged()`：心跳只在 JSON 变化时重发。

### self 能力（8）

- `MeshRoutesDeps.selfStatus` / `MeshHttpRuntimeOptions.selfStatus` ← `statusProvider`。
- `collectNodes` 对 `isSelf` 用 live `direct_capable` / `version` / `inventory`（`mesh-routes.ts` ~L249–256）。
- `statusProvider.inventory = { version }`，对端 `node.list` 也能带出版本。
- Harness：native 文件在、但 60s 内 `self.direct_capable` 仍 false → **FAIL**（不再 SKIP）。检查入口仍是 `/api/mesh/nodes --name self`，与设计一致。

## 测试（先红后绿）

| 测试 | 覆盖 |
|---|---|
| `mesh-routes.test.ts` `reports live self.direct_capable, version, and inventory` | self 行不再读空 `peer_cache` |
| `peer-manager.test.ts` `upgrades a live relay to ws-secure when peer endpoints appear without getLink` | 4c：endpoints 出现即升级，不依赖再次 `getLink` |
| `peer-manager.test.ts` `rate-limits background upgrade dials for unchanged endpoints` | 相同 endpoints 10s 内只拨一次 |
| `mesh-runtime.test.ts` `re-advertises node.status endpoints when network interfaces change` | iface 变化经心跳/`sendStatusIfChanged` 重广告 |

## 数字

| 检查 | 结果 |
|---|---|
| `bun test`（`apps/gateway`） | **2248 pass / 0 fail**（基线 2244 + 本轮 4） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（基线 ≤ 23） |
| `bunx biome check`（改动文件） | 通过 |

## Harness（remote-cycle tag `p3`）

`scripts/hub-e2e/out/report.md`（远程 2026-08-28T06:42:17Z）：

| scenario | result |
|---|---|
| 1a–1c | PASS |
| 2a–2c | PASS |
| 3a–3g | PASS |
| 4a / **4b** | PASS |
| **4c** | **PASS**（`reach=lan`，`version=1.0.2`） |
| 4d | PASS |
| 5 | PASS |
| 6a / 6b / 6c | PASS |
| 7a–7b | PASS |
| **8** | **PASS**（`self.direct_capable=true`，`version=1.0.2`，`inventory.version=1.0.2`） |

4c 成功快照（`wait-reach`）：

```
node.online=true reach=lan version=1.0.2 loggedIn=true isHub=false
```

8 成功快照（`wait-direct-capable --name self`）：

```
name=self online=true reach=null version=1.0.2 direct_capable=true inventory={version:"1.0.2"}
```

无回归。日志在 `/private/tmp/claude-501/.../scratchpad/remote-out-p3/`。
