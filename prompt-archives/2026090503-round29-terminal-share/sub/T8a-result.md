# T8a — 前端「重开 PWA 后节点半天不出现」修复（H1 / H4 / H5 / H6 / H7）

对应 `sub/EX2-pwa-slow-nodes-report.md` 的五条前端假设。后端 H2（DC 先拨 15 s）/ H3（hub 在线集合清空）不在本任务内。

## 做了什么

### H1 — 设备列表 pending 期间不再整节隐藏
- `packages/panels/src/device-tree/device-tree-selectors.ts`：`SidebarDeviceStats` 加 `pending?: boolean`；`shouldHideSidebarNodeSection` 在 `pending === true` 时**一律返回 false**（`/api/devices` 跨节点要走直连/中转，弱网下几秒才回来，按那一刻的「零设备」把节点名与在线徽标一起藏掉正是本 bug 的直接成因）。
- `packages/panels/src/device-tree/use-sidebar-device-stats.ts`：
  - 签名从 `(devicesQueryKey?)` 改为 `(options?: { devicesQueryKey?, placeholderDevices? })`（原签名只有一个调用方）；
  - 返回值新增 `pending`（`isPending || isPlaceholderData`）与 `devices`（当前统计所依据的列表）；
  - 传了 `placeholderDevices` 时喂给 `useQuery` 的 `placeholderData`（补齐 `DeviceWithRuntime` 的运行时字段为「未知」）。
- `apps/fe/.../sidebar-device-list-runtime.tsx`：
  - `SidebarNodeSectionShell` 新增 `placeholderDevices` / `onDevicesLoaded`；
  - pending 时渲染 **分节头 + 占位设备行**（有本地快照就灰显上次的设备名，一台都不知道时给两条 `Skeleton`），落地后才挂真实设备树；
  - 抽出纯函数 `isNodeSectionVisible` / `pendingRows` 与纯组件 `PendingDeviceRows` 供测试。
- `apps/fe/.../sidebar-node-section.tsx`：`SidebarNodeRuntimeSection` 用 `offlineDevices(runtimeNodeId, inventory)`（`tmex:device-snapshot:*` → node inventory）算首帧占位，并在真实列表落地时 `writeDeviceSnapshot` 回写快照——**此前只有设备页写快照**，从没进过设备页的用户永远没有首帧数据。
- `use-section-presence.ts` **未改动**：pending 分节现在第一帧 `present === true`，`useSectionPresence` 本来就直接落 `visible`（不会从 hidden 淡入），无需改。已加测试固定这一点。

### H4 — 首帧缓存 + `/api/auth/mode` 不再「失败即永久记住」
- 新增 `apps/fe/src/node/mesh-nodes-cache.ts`：`tmex:mesh-nodes`（版本号 + `savedAt`，7 天过期、≤64 行、全部读写 try/catch）。落盘只留身份与在线态，**链路现场（reach / transport / rttMs / peerAddress / linkSinceAt / directFailure）一律清空**——它们描述上一次会话的那条链路，冷启动后必然是错的。
- 新增 `apps/fe/src/node/mesh-recovery.ts`：`createRetryScheduler`（1 / 3 / 10 秒**有界**三次，可注入定时器）+ `onPageRecovery`（`visibilitychange`→可见 与 `online`，无 document 时返回空订阅）+ `isPageVisible`。
- `mesh-nodes-store.ts`（见下「结构调整」）：
  - `MeshNodesState` 新增 `stale`（当前列表来自缓存）与 `cachedMesh`；模块加载时 `hydrateMeshNodesFromCache()` 同步把上次列表读回来（`stale: true`）；
  - `refreshMeshNodes` 成功后回写缓存并置 `stale: false`；
  - `ensureAuthMode` 的 catch 里 **清掉 `modePromise`** 并排一次有界重试；成功后 `modeRetry.reset()`；
  - `applyAuthMode`：mode 落地为 standalone、或 entry nodeId 与缓存里的不一致 → `clearMeshNodesCache()` + 清空列表（缓存作废的唯一入口，`resetMeshNodesStateForTest()` 也会清）；
  - `retryUnsettledOnRecovery()` 挂在 `onPageRecovery` 上：还没落地的那两条请求把退避倒回起点并立刻重来，已落地的不动。
- `meshEnabledOf(state)`：`mode` 已落地时以它为准，未落地时退回缓存的 `cachedMesh`。`useSharedAuthMode` 用它，于是**冷启动第一帧就能渲染聚合视图，并让 `/api/mesh/nodes` 与 `/api/auth/mode` 并发发出**（原本是串行两次往返）。

### H5 — `/api/mesh/nodes` 首拉失败不再等 5 分钟
- `refreshMeshNodes` 的错误路径：`loadedAt === null` 时排同一套有界重试（已经拿到过列表的失败仍交给兜底轮询）。
- `useMeshNodes` 的 `listUnknown` 救援路径去掉 `error === null` 条件（改为只看 `loadedAt === null`）；`refreshMeshNodes` 单飞 + effect 依赖不变，不会变成循环。

### H6 — 会话还在时替用户点一次「登录此节点」
- `sidebar-node-section.tsx`：`SidebarNodeSignIn` 在 **有可见设备（或正浏览该 node 的设备）** 时先 `restoreSessionKey()`（点击路径 `useNodeLoginGate` → `ensureNodeLogin` 用的就是这条恢复入口），恢复得出会话才把 `useNodeLoginGate` 的 `enabled` 打开做静默登录；恢复不出来直接把按钮留给用户。
- 防循环：模块级 `eagerSignInAttempted` + `claimEagerSignIn(nodeId)`，**每个 node 每次页面加载只放行一次**；失败后 `gate.code` 非空 → 退回「登录此节点」按钮（用户手动点开不受这条记账约束）。
- 渲染分支改为 `busy → 转圈` / `expanded || gate.code → 错误+登录按钮` / 否则展开按钮，避免自动登录期间先闪一下按钮。

### H7 — mesh WS 重连
- `mesh-events.ts`：新增 `visibleMaxDelayMs`（缺省 5 s）、`recovery`、`visible` 三个可注入选项。
  - `retryDelay()` 在页面可见时把退避上限压到 `min(maxDelayMs, visibleMaxDelayMs)`（后台仍走 60 s 完整上限）；
  - `start()` 订阅 `onPageRecovery`，恢复信号到达且未连上时 **attempt 清零 + 撤掉在途定时器 + 立刻 open**；已连上或正在连时不动（不会叠连接）；
  - `stop()` 注销订阅；无 document 的环境（单测 / SSR）下 `onPageRecovery` 返回空订阅，`start/stop` 不抛。

### 结构调整（复杂度门禁要求）
`mesh-nodes.ts` 加完这些后到 794 行，超过 allowlist 记录的 780（规则「只降不升」）。把**宿主级 store 那一整段**（state / store / 缓存 / 重试 / `ensureAuthMode` / `refreshMeshNodes` / `markLoggedIn` 等 + `patchNodesWithEvent`）原样搬到新文件 `apps/fe/src/node/mesh-nodes-store.ts`，`mesh-nodes.ts` 全部原样再导出，**对外 API 一字未变**（所有调用方与测试仍只 import `mesh-nodes`）。结果：`mesh-nodes.ts` 503 行、`mesh-nodes-store.ts` 330 行，门禁通过。
> 注：`scripts/complexity/allowlist.json` 里 `apps/fe/src/node/mesh-nodes.ts: fileLines 780` 现在明显宽松（实测 503，已在 600 默认阈值内），可以整条删掉；因为是并发共享文件，**我没有动它**，留给指挥者收尾时 `--tighten`。

## 文件

新增：
- `apps/fe/src/node/mesh-nodes-cache.ts` / `mesh-nodes-cache.test.ts`
- `apps/fe/src/node/mesh-recovery.ts` / `mesh-recovery.test.ts`
- `apps/fe/src/node/mesh-nodes-store.ts`（从 `mesh-nodes.ts` 搬出）
- `apps/fe/src/node/mesh-nodes-recovery.test.ts`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.test.tsx`

修改：
- `apps/fe/src/node/mesh-nodes.ts`、`mesh-events.ts`、`mesh-events.test.ts`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx`、`sidebar-node-section.tsx`
- `packages/panels/src/device-tree/use-sidebar-device-stats.ts`、`device-tree-selectors.ts`、`device-tree-selectors.test.ts`

未改动：`hub-polling.ts`（本身已有可见性门，H7 的恢复信号统一放在新的 `mesh-recovery.ts`）、`mesh-nodes-resident.tsx`（`meshEnabledOf` 的改动已让它在第一帧起轮询）、`use-section-presence.ts`（见 H1）、locale 文件（骨架是纯视觉，没有新文案）。

## 测试

- `cd apps/fe && bun test src/` → **2589 pass / 0 fail**（154 文件）
- `cd apps/fe && bunx tsc --noEmit -p .` → 0 error
- `cd packages/panels && bun test` → **993 pass / 0 fail**（91 文件）；`bunx tsc --noEmit -p .` → 0 error
- `bunx biome check <本任务的 14 个文件>` → clean
- `bun scripts/complexity/gate.ts` → `complexity gate ok (1649 files, 14409 functions)`

新增用例（共 26 条）：缓存落盘裁剪 / 过期 / 版本 / 畸形 / 条数上限 / 存储不可用；重试阶梯 1-3-10 与用尽即停、在途不重排、reset 倒回起点；`onPageRecovery` 无 document 与 visible/online 触发；hydrate + `stale` 标记 + REST 重整回写、standalone / entry 换人时缓存作废、entry 没变时保留；mode 与 nodes 的有界重试与恢复信号；退避前台封顶 / 恢复即重连 / stop 后注销；`shouldHideSidebarNodeSection` 的 pending 分支；`isNodeSectionVisible` / `pendingRows` / `PendingDeviceRows`（占位行与骨架）；`claimEagerSignIn` 一次性记账。

## 与任务描述的偏差

1. **缓存里不存整份 `mode`**，只存 `{ mesh: boolean, entryNodeId, nodes, savedAt }`。`AuthModeResponse` 带 `passkeySecondFactorWaived` / `localAuth` / `rootPublicKey` 等鉴权语义字段，从 localStorage 恢复它们等于让盘上的旧值在一小段时间里充当鉴权判据（例如把「需要通行密钥二次验证」误显示成已豁免）。改为只恢复「上次是不是 mesh」这一个布尔值供 `meshEnabledOf` 用，`state.mode` 始终只由真实 `/api/auth/mode` 写入。
2. **`placeholderData` 只加在 `useSidebarDeviceStats`**，没有加到 `packages/panels/src/device-tree/sidebar-device-list.tsx` 的那条同 key 查询（react-query 的 placeholder 是 per-observer 的）。改为 pending 期间由分节自己渲染占位行、落地后才挂真实设备树——这样既能第一帧显示上次的设备名，又不会让占位数据触发 `ensureDeviceSubscribed` 去连一台可能已经不存在的设备。因此**没有动 `sidebar-device-list.tsx`**。
3. **`use-section-presence.ts` 未改**：pending 分节第一帧就是 `present === true`，该 hook 本来就直接落 `visible`。
4. 未找到「登出时清 `tmex:device-snapshot:*`」这类钩子（快照只在 DevicesPage 用 `pruneDeviceSnapshots` 按 mesh 成员集裁剪）。mesh 缓存的作废点因此定在 **mode 落地为 standalone / entry nodeId 变化 / `resetMeshNodesStateForTest`**，外加 7 天过期。
5. 为过复杂度门禁做了 `mesh-nodes.ts` → `mesh-nodes-store.ts` 的纯搬运（对外 API 不变），见上。

## 遗留 / 建议

- 折叠着的远端在线分节（`SidebarNodeCollapsed`）与未登录分节仍以「至少开过一台设备显示」为门槛，跟本轮无关但也是「节点不出现」的另一类原因；本任务未动。
- 首帧缓存只在 `/api/mesh/nodes` 成功后写。全新浏览器（或清过站点数据）的第一次冷启动仍然没有兜底数据，只能靠 H4 的并发化省掉一次串行往返。
- 侧边栏现在也写 `tmex:device-snapshot:*`。快照条目上限 32（LRU），与设备页共用同一份索引，未观察到冲突。
- `apps/fe/src/node/device-node-badges.*`（T7）在我跑测试期间一度失败又恢复，与本任务无关。
