# T2 结果 — mesh-runtime wiring 拆分 + IPv6 parser 去重

对照 S1 findings 4、6。行为与现有测试一致；未改 mesh/ 内其它文件（forwarder / rtc / uplink-client / peer-manager 由并行 agent 编辑）。

## 做了什么

### 1. 共享 `parseIpv6Words()`，拆分 `isAdvertisablePeerAddress`

- 从 `address-class.ts` 导出纯函数 `parseIpv6Words()`：内部用 `indexOf('%')` 剥 zone-id 再 lowercase，压缩组展开算法与原先两份拷贝相同。
- 删除 `mesh-runtime.ts` 里的 26 行副本；`isLanIpv6` 改为走共享解析器。
- `isAdvertisablePeerAddress` 拆成 `isAdvertisableIpv4` / `isAdvertisableIpv6`（各 CC ≤ 6）+ 薄分发。畸形地址语义未改（`:::1`、dotted mixed、zone-id、`1:2:3:4:5:6:7:8::` 空压缩 missing=0 仍解析为 8 字）。

### 2. wiring 拆分（同文件，holder 与初始化顺序不变）

可变 holder（`peerHolder` / `innerSignalsHolder` / `startBrowserAcceptHolder` / `httpHolder`）仍用来拆环。顺序仍是：stores → session/rtc bindings → uplink → PeerManager 写入 holder → state-change → RTC router → browser accept → 返回。

| 函数 | 职责 |
|---|---|
| `createMeshStoresAndServices` | 存储、identity、key-log、事件、hub、holders |
| `createSessionBindings` | SessionRegistry、RtcPeerManager、verify/teardown |
| `constructMeshDeps` | 编排 + scheduler/statusProvider |
| `createUplinkWiring` | CA 提示、rejectPeer、UplinkClient |
| `handleUplinkNodeList` | node.list 投影；内嵌 `emitListed` / `emitHubIfUnlisted` 降 CC |
| `pruneStaleListedPeers` | 列表外无证 peer 删除 |
| `createPeerWiring` | HTTP dispatch、PeerManager、hub 掉线 synthetic offline |
| `createRtcBrowserWiring` | MeshRtcSignalRouter、browser accept、signals |

`startBrowserAccept` 留在 `createRtcBrowserWiring` 内（119 行，≤ 120）。未把顺序安全/协议逻辑改成表驱动。

## 文件

- `apps/gateway/src/mesh/address-class.ts`（+ 测试）
- `apps/gateway/src/mesh/mesh-runtime.ts`（+ 测试；`integration/wiring.test.ts` 无需改）

## CC / 行数（`bun scripts/complexity/gate.ts --report` 同类分析）

| 符号 | 改前 CC / 行 | 改后 CC / 行 |
|---|---:|---:|
| `isAdvertisablePeerAddress` | 20 / 27 | 6 / 7 |
| `isAdvertisableIpv4` | — | 6 / 9 |
| `isAdvertisableIpv6` | — | 5 / 9 |
| `parseIpv6Words`（runtime 副本） | 12 / 26 | 删除 |
| `parseIpv6Words`（address-class） | 原 `parseIpv6` 12 / 25 | 13 / 27 |
| `constructMeshDeps` | 12 / 201 | 2 / 19 |
| `wireMeshEventsAndSessions` | 6 / 317 | 1 / 6 |
| `onNodeList` | 30 / 57 | 1 / 1（转调） |
| `handleUplinkNodeList` | — | 8 / 54 |
| `pruneStaleListedPeers` | — | 5 / 12 |
| `createMeshStoresAndServices` | — | 9 / 105 |
| `createSessionBindings` | — | 3 / 73 |
| `createUplinkWiring` | — | 6 / 72 |
| `createPeerWiring` | — | 1 / 81 |
| `createRtcBrowserWiring` | — | 1 / 119 |
| `startBrowserAccept` | 5 / 57 | 5 / 55 |

文件：`mesh-runtime.ts` 1299 → 1307（git numstat +7）；`address-class.ts` 150 → 154（+3）。生产合计 **+10**。wiring 单项相对 item-1 后基线约 +33（签名 + CC 辅助）；IPv6 去重把总额拉回 +10。所有新函数 ≤ 120 行、CC ≤ 15。

## 测量

抛出脚本：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/t2-ipv6-bench.ts`（400k iter）

| 操作 | 总耗时 | 每次 |
|---|---:|---:|
| `parseIpv6Words`（含 zone-id / 畸形混合） | 90.22 ms | 226 ns |
| `isAdvertisablePeerAddress`（v4/v6 混合） | 78.68 ms | 197 ns |

Finding 6 目标是去重而非加速；共享解析器与原先算法相同，热路径仍是一次 parse。

## 测试

新增：

- `parseIpv6Words`：压缩展开、zone-id 归一、畸形/dotted reject；钉住 `1:2:3:4:5:6:7:8::` 现语义（missing=0）。
- `isAdvertisablePeerAddress`：公网 IPv6 + zone-id、`0.1.2.3`。
- node.list：hub 仅在 `list.hub`、不在 `nodes` 时仍发 online；无证 ghost peer 被 prune。

验证：

- `bun test src/mesh/mesh-runtime.test.ts src/mesh/mesh-runtime-node-presence.test.ts src/mesh/integration src/mesh/address-class.test.ts` → **77 pass / 0 fail**
- `bun test src/mesh` → **497 pass / 0 fail**（无 EADDRINUSE）
- `bunx tsc --noEmit -p .`（gateway）→ **21**（= 基线；T2 文件 0）
- `bunx biome check` 上述 4 个文件 → 通过

## 未做 / 风险

- `createRtcBrowserWiring` 119 行，贴近 120；再往里塞逻辑会破门禁。
- wiring 净行未到 S1 预估的 −5…+10（签名与 `emitListed`/`emitHubIfUnlisted` 为压 CC 所必需）；与 parser 去重合计生产 +10。
- 未改 `wireMeshHttp` / `assembleMeshRuntime`（已 ≤ 120）。
- 并行 agent 改过 `uplink-client`；本任务测试在当前 worktree 全绿。
