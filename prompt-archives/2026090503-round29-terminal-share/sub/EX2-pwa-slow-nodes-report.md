# EX2 — PWA 进入时 tmex / konata-mac 节点显示慢（Opus explore，2026-09-05，节选）

节点：`668842…` 本机 konata-mac；`ec42f364…` = tmex（同时是 hubNodeId，https://ai.jiefakj.com:18443）；`49b1d2a4…` tmexhub-sh。`/api/mesh/nodes` 处理器同步、无探测（1.3 ms），排除后端列表慢。

## 渲染条件链
1. `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:174-180` 需 `meshEnabled`（`/api/auth/mode` 返回 mesh，`apps/fe/src/node/mesh-nodes.ts:236-247,255-270`）。
2. `:128,:147` `/api/mesh/nodes` 未返回时无任何节点头。
3. `sidebar-node-section.tsx:470-486`：offline → `SidebarNodeOffline`（需有快照设备）；online 未登录 → `SidebarNodeSignIn`（手动按钮，`:216-245` 静默登录 gated by `expanded` useState(false)）；online 已登录 → `SidebarNodeRuntimeSection`。
4. **阻塞门**：`sidebar-device-list-runtime.tsx:69-100` `useSidebarDeviceStats()`（react-query GET `/n/<id>/api/devices`）pending 时 stats={0,0,failed:false}，`shouldHideSidebarNodeSection`（`packages/panels/src/device-tree/device-tree-selectors.ts:86-92`）对非 self 返回 true → 整段含节点名 `return null`，无骨架（`use-section-presence.ts:38-40`）。
5. 后端 online = isSelf || hubOnline.has(id) || isPeerReachable（`node-list-projection.ts:229`）；loggedIn = cookie 存在（`:249`）。

## 假设（按优先级）与修法
- **H1 UI 门控**（最高）：`sidebar-device-list-runtime.tsx:73-80` 加 `stats.pending`（`use-sidebar-device-stats.ts` 暴露 `isPending`）视同 failed → 立刻渲染 header，设备行显示骨架；可用 `offlineDevices(runtimeNodeId, inventory)` 做 placeholderData。
- **H2 DC 先拨 15 s**（日志实证）：`peer-manager.ts:870-889 dial()` 先 await `tryDc`，`rtc-peer-manager.ts:73 CONNECT_TIMEOUT_MS=15000`；日志 `dial_ms_avg=15013 … breaker trip fails=56`，`breaker rearm source=local-fingerprint`（`peer-manager.ts:917-926` 网络指纹变化重置熔断）后立刻又 15 s。`forwarder.ts:565-595` GET 重试 4 次无总 deadline，react-query 再 retry 1。修：用户路径 dial 给 DC 短预算（2–3 s）或与 ws/relay 并行竞速、有失败记录时 skipDcFirst；forwarder 重试循环加 5 s 总 deadline。
- **H3 hub 在线集合清空**（日志实证）：`mesh-runtime.ts:1231-1238 listHubOnline` 在 `uplink.state !== 'online'` 时返回空；uplink 20 s 超时 + 60 s 退避，日志有分钟级空档。修：uplink 掉线后按 staleness 界限沿用 `lastNodeList` 的 presence；网络指纹变化时重置 uplink 退避。
- **H4 无首屏缓存且串行两次往返**：`mesh-nodes.ts:203-212,236-247,280-300`；`ensureAuthMode` 失败永久记忆（`modePromise` 只在 reset 清）。修：localStorage 持久化 `{mode, entryNodeId, nodes}` 做首帧；catch 里 `modePromise=null` 并有界重试。
- **H5 首次 nodes 失败 5 min 不重试**：`mesh-nodes.ts:291,528,388`。修：错误路径 1/3/10 s 有界重试。
- **H6 18 h 会话过期后变手动登录按钮**：`node-session-store.ts:6`；日志 20+ `4401 NODE_LOGIN_REQUIRED`。修：`sidebar-node-section.tsx:216-225` 有可见设备且内存有会话钥时 eager 静默登录。
- **H7 mesh WS 重连退避不在恢复时重置**：`mesh-events.ts:225-227,305-320`；无 visibilitychange/online 监听（仅 `hub-polling.ts:17-26`）。修：可见/online 时 attempt=0 立即重连。
- 无 service worker（`index.html` 只链 manifest），每次重开都是冷启动。
