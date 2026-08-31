# Task E1 报告

## 结论

当前“经 Hub 中转”状态并不是由网关完全缺失导致的：

- 网关在 relay 链路上会发送 `reach: 'relay'`、`transport: 'relay'`。
- `rttMs` 建链初始为 `null`，首次 peer ping/pong 后才会发送实际 RTT。
- 连接详情里的大量“未知”来自浏览器侧 WebRTC ICE 诊断；relay/primary 链路没有 `diagnostics.ice`，不是网关没有把 relay 字段传给前端。
- 当前详情面板没有显示 peer address、RTT、route、since 或 Hub name 这些字段。

## 1. 前端组件、字段与 fallback

组件链路：

- `[DevicePage.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/pages/DevicePage.tsx:38)` 的 `PageActions()` 渲染：
  ```tsx
  <DeviceNodeBadges nodeId={nodeId} />
  <DeviceConsoleActions {...params} />
  ```
- `[device-node-badges.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:109)` 的 `DeviceNodeBadges` 渲染 `badge-node-link` 和 `NodeLinkDiagnostics`。
- `nodeId === SELF_NODE_ID` 时直接返回 `null`（125 行），本机不显示该徽标。

### 徽标

`DeviceNodeBadges` 同时读取：

- `useDirectDiagnostics(nodeId)`：浏览器 ↔ node 的 WebRTC 诊断。
- `useNodeLink(nodeId)`：entry ↔ node 的 mesh 链路状态。

`resolveLinkBadge()` 位于 `[device-node-badges.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:46)`：

```ts
if (input.path === 'direct') {
  return { labelKey: 'nodes.badge.direct', rttMs: finiteRtt(input.directRttMs), tone: 'ok' };
}
return {
  labelKey: reachLabelKey(reach),
  rttMs: finiteRtt(rttMs),
  tone: reach === 'lan' || reach === 'wan' ? 'ok' : 'muted',
};
```

| 徽标内容 | 来源 | fallback |
|---|---|---|
| `直连` | `DirectDiagnostics.path === 'direct'` | 无 |
| `经 Hub 中转` | `NodeLink.reach === 'relay'` | `reach === null` 时是 `nodes.reach.none`，即“不可达”，不是“未知” |
| `局域网` / `公网` | `NodeLink.reach === 'lan'/'wan'` | 同上 |
| RTT 后缀 | 直连时 `DirectDiagnostics.rtt`；非直连时 `NodeLink.rttMs` | `null`、非有限数或负数时省略后缀；不会显示 `nodes.badge.unknown` |

徽标使用 `data-testid="badge-node-link"`（140 行），容器使用 `device-node-badges`（133 行）。

### 连接详情面板

`NodeLinkDiagnostics` 位于 `[device-node-badges.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:147)`，容器为 `data-testid="ice-diagnostics"`（159 行）。

| 显示字段 | i18n key | 实际值 | fallback |
|---|---|---|---|
| 到达路径 | `nodes.badge.reachRow` | `t(reachLabelKey(link.reach))` | `null` → `nodes.reach.none` |
| 承载 | `nodes.badge.transportRow` | `link.transport` 映射为 `nodes.badge.transportWs/transportDc/transportRelay` | `null` → `nodes.badge.unknown` |
| 连接状态 | `nodes.badge.connectionState` | `diagnostics.ice?.connectionState` | `null/undefined` → `nodes.badge.unknown` |
| ICE 状态 | `nodes.badge.iceState` | `diagnostics.ice?.iceConnectionState` | 同上 |
| 本端地址 | `nodes.badge.localCandidate` | `diagnostics.ice?.localCandidateType` | 同上 |
| 对端地址 | `nodes.badge.remoteCandidate` | `diagnostics.ice?.remoteCandidateType` | 同上 |
| 当前路径 | `nodes.badge.selectedPair` | `diagnostics.ice?.selectedPair` | 同上 |

统一 fallback 代码是：

```tsx
<dd>{value ?? t('nodes.badge.unknown')}</dd>
```

见 `[device-node-badges.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.tsx:201)` 的 `DiagnosticRow`。

当 `diagnostics.ice` 不存在时，额外显示：

```tsx
t('nodes.badge.icePlaceholder')
```

见 194–196 行。relay/primary 状态通常因此出现五行“未知”以及“暂无直连详情”提示。

详情面板没有渲染：

- RTT；
- `DirectDiagnostics.route`；
- peer address；
- 连接建立时间或 since；
- Hub name。

### 诊断数据来源

`useNodeLink()` 只读取模块级 `MeshNodesState.nodes`，不读取 hub 管理列表：

```ts
const state = useSyncExternalStore(
  subscribeMeshNodes,
  getMeshNodesState,
  getMeshNodesState
);
```

见 `[direct-diagnostics.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/direct-diagnostics.ts:35)`。

`useDirectDiagnostics()` 读取：

```ts
resolveDirectDiagnostics(appNodeRuntimes.get(nodeId).connection)
```

见同文件 17–22 行。

非 self node 创建时，`node-runtimes.ts` 把 `DirectCarrierController.diagnosticsSource` 挂到：

```ts
connection.directDiagnostics = controller.diagnosticsSource;
```

见 `[node-runtimes.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/node-runtimes.ts:217)` 的 217–233 行。

## i18n

`nodes.reach` 和 `nodes.badge` 的三语文案位于：

- `[zh_CN.json](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/i18n/locales/zh_CN.json:1965)`、2009 行；
- `[en_US.json](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/i18n/locales/en_US.json:1965)`、2009 行；
- `[ja_JP.json](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/i18n/locales/ja_JP.json:1965)`、2009 行。

| key | zh_CN | en_US | ja_JP |
|---|---|---|---|
| `nodes.reach.relay` | `经 Hub 中转` | `Via hub` | `ハブ経由` |
| `nodes.badge.transportRelay` | `Hub 中转` | `Hub relay` | `ハブ中継` |
| `nodes.reach.none` | `不可达` | `Unreachable` | `到達不可` |
| `nodes.badge.unknown` | `未知` | `unknown` | `不明` |
| `nodes.badge.icePlaceholder` | `暂无直连详情。` | `Direct connection details unavailable.` | `直接接続の詳細はありません。` |

其他面板字段 key：

```text
nodes.badge.iceTitle
nodes.badge.reachRow
nodes.badge.transportRow
nodes.badge.transportWs
nodes.badge.transportDc
nodes.badge.connectionState
nodes.badge.iceState
nodes.badge.localCandidate
nodes.badge.remoteCandidate
nodes.badge.selectedPair
```

这些 key 也列在 `[types.ts](/Users/konata/code/tmex-enhanced-wt-r9/packages/shared/src/i18n/types.ts:1821)` 的 i18n 类型中。

当前代码没有使用 `nodes.badge.rttUnknown`；徽标 RTT 未知时直接省略 RTT 后缀。现有测试也明确断言不包含该 key：`device-node-badges.test.tsx:192`。

## 2. 网关到前端的数据路径

### 前端 API、store、WebSocket

1. `MeshNodesResident` 在根布局常驻，调用 `useMeshNodes({ enabled: meshEnabled })`，见 `[mesh-nodes-resident.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-nodes-resident.tsx:9)` 和 `main.tsx:144`。
2. `useMeshNodes()`：
   - 首次及每 30 秒调用 `refreshMeshNodes()`；
   - `refreshMeshNodes()` 调用 `AuthApi.listNodes()`；
   - `AuthApi.listNodes()` 请求 `GET /api/mesh/nodes`。
   
   见 `[mesh-nodes.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-nodes.ts:292)`、351–375，以及 `[auth-api.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/konata/code/tmex-enhanced-wt-r9/packages/api-client/src/auth/auth-api.ts:67)`。
3. 同时订阅 `/mesh/ws` 的 `NODE_EVENT`。解码后的 payload 包含：
   ```ts
   nodeId, status, reach, transport?, rttMs?, inventory, version?, direct_capable?, name?
   ```
   见 `[mesh-events.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-events.ts:21)`。
4. `patchNodesWithEvent()` 将事件写回 store：
   ```ts
   reach: online ? event.reach : null,
   transport: online ? pick(event.transport, node.transport) : null,
   rttMs: online ? pick(event.rttMs, node.rttMs) : null,
   ```
   见 `[mesh-nodes.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-nodes.ts:43)` 的 53–64 行。

老事件没有 `transport/rttMs` 时，`pick()` 保留 store 旧值（69–73 行）；明确的 `null` 则会清除。

### `/api/mesh/nodes` 的网关投影

`GET /api/mesh/nodes` 由 `[mesh-routes.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-routes.ts:91)` 路由到 `handleNodes()`，再调用 `collectNodes()`。

`collectNodes()` 从 `PeerLinkProvider` 读取：

```ts
const reach = this.deps.peers.listReach();
...
(nid) => this.deps.peers.transportOf?.(nid) ?? null,
(nid) => this.deps.peers.rttOf?.(nid) ?? null
```

见 `mesh-routes.ts:195–227`。

`projectMeshListNode()` 输出的 DTO 明确包含：

```ts
reach: r,
transport: isSelf ? null : (transportOf?.(id) ?? null),
rttMs: isSelf ? null : (rttOf?.(id) ?? null),
```

见 `[node-list-projection.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/node-list-projection.ts:141)`；DTO 类型见 13–26 行。

### `NODE_EVENT` 的网关路径

`mesh-runtime.ts` 在收到 Hub 的 `node.list` 时：

```ts
reach: reach.get(node.id) ?? null,
transport: d.peerHolder.manager?.transportOf(node.id) ?? null,
rttMs: d.peerHolder.manager?.rttOf(node.id) ?? null,
```

见 `[mesh-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-runtime.ts:795)` 的 795–809 行。

PeerManager 链路变化通过 `onLinkInfo` 进入相同投影：

```ts
reach: info.reach,
transport: info.transport,
rttMs: info.rttMs,
```

见 `mesh-runtime.ts:976–990`。

最终 `mesh-routes.broadcastNodeEvent()` 把这三个字段编码进 `NodeEvent`：

```ts
transport: event.transport ?? null,
rttMs: event.rttMs ?? null,
```

见 `[mesh-routes.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/mesh-routes.ts:297)` 的 297–320 行。

### relay 情况的实际值

relay fallback 位于 `[peer-manager.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/peer-manager.ts:1365)`：

```ts
const stream = await this.uplink.openRelay(nodeId);
...
this.track(result.session, result.peerNodeId, 'relay', this.identity.nodeId, gen);
```

relay 调用没有传 `remoteAddress`。

`LivePeer` 初始字段包括：

```ts
remoteAddress: string | null;
rttMs: number | null;
```

见 `peer-manager.ts:136–166`；安装 relay 链路时 `remoteAddress` 和 `rttMs` 均为 `null`（1604–1605 行）。

随后：

```ts
reach: classifyPeerReach(live.transport, live.remoteAddress),
transport: live.transport,
rttMs: live.rttMs,
```

见 `peer-manager.ts:1907–1914`。

`classifyPeerReach()` 对 relay 有明确分支：

```ts
if (transport === 'relay') return 'relay';
```

见 `[address-class.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/address-class.ts:26)`。

因此 relay 状态是：

| 字段 | relay 建链立即发送 | ping/pong 后 |
|---|---|---|
| `reach` | `relay` | `relay` |
| `transport` | `relay` | `relay` |
| `rttMs` | `null` | `onPeerPong()` 测量值 |
| `remoteAddress` | `null` | 仍无 relay peer address |

RTT 测量代码是 `peer-manager.ts:1884–1905`：

```ts
live.rttMs = Math.max(0, Math.round(performance.now() - live.pingSentAt));
```

所以当前网关实际“不填”的是：

- relay peer 的 `remoteAddress`：relay `track()` 路径没有地址参数；
- per-peer `since`：`PeerLinkProvider`、`NodeEventPayload`、`MeshNodeDto` 都没有该字段；
- `hubName`：不是 mesh status 字段；
- `rttMs` 只在首次 ping/pong 前为 `null`，不是 relay 永远没有 RTT；
- `reach` 和 `transport` 当前会正常填为 `relay`。

### 网关侧已有但没有进入徽标的数据

- `UplinkClient` 有 `hubUrl`、`hubHost`、`onlineAt`、`connectingAt`，但这些是 uplink 状态/日志数据，不是 per-peer `since`，也不在 `NodeEvent` 或 `/api/mesh/nodes` 中。见 `[uplink-client.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/mesh/uplink-client.ts:152)`、329–364 行。
- Hub 的 `UplinkServer` 会保存 uplink socket 的 `remoteAddress`：
  ```ts
  this.linkRemoteAddress.set(link, opts.remoteAddress);
  ```
  见 `[uplink-server.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/uplink-server.ts:181)`、215–224 行。该地址是 node ↔ Hub 的 uplink 地址，仅用于 Hub 侧认证拒绝日志，不是 relay 目标 peer 地址，也没有下发到 mesh 状态。
- Hub 的 `NodeRegistry` 有 `lastSeen` 和 `meta.name`，见 `[node-registry.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/node-registry.ts:12)`、58–69 行；管理 API `/api/hub/nodes` 也输出 `last_seen_at`、`name`，见 `[hub-runtime.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/gateway/src/hub/hub-runtime.ts:244)`。
- 但 `useNodeLink()` 不读取 `useHubNode()` 的管理 API结果，且 `NodeLink` 只有 `reach`、`transport`、`rttMs` 三个字段。因此这些 Hub 管理字段当前不会进入详情面板。
- Hub relay stream 的 open payload 只有目标：
  ```ts
  JSON.stringify({ to: toNodeId })
  ```
  见 `uplink-client.ts:321–327`；Hub 转发时只补充 `from`，见 `uplink-server.ts:935–943`，没有地址、since 或 Hub 名称。

## 3. 终端页“download”按钮

该按钮不是文件下载按钮，而是终端滚动到底部按钮。

位置：

- `[device-console-toolbar.tsx](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/device-console-toolbar.tsx:80)`：
  ```tsx
  {
    key: 'jump-to-latest',
    icon: ArrowDownToLine,
    label: t('nav.jumpToLatest'),
    disabled: !model.canInteract,
    onClick: model.onJumpToLatest,
  }
  ```
- 它没有设置 `testId`；`ToolbarIconButton` 只会把 `button.testId` 写入 DOM，见 120–143 行。
- handler 位于 `[use-device-console-actions.ts](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/use-device-console-actions.ts:116)`：
  ```ts
  window.dispatchEvent(
    new CustomEvent('tmex:jump-to-latest', { detail: { nodeId: runtime.nodeId } })
  );
  ```
- 消费端位于 `[use-device-console-effects.ts](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/use-device-console-effects.ts:110)`：
  ```ts
  const handler = () => {
    terminalRef.current?.scrollToBottom();
  };
  ```
  监听 `tmex:jump-to-latest`，实际只调用 `TerminalRef.scrollToBottom()`。

因此它在终端上下文中有明确作用：回到终端输出底部；不是 `downloadFileWithProgress()`。

真正的文件下载按钮在 `[FilePage.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/pages/FilePage.tsx:366)`：

```tsx
data-testid="file-download-action"
onClick={() => triggerDownload(runtime, rootId, path, basename(path))}
```

`triggerDownload()` 调用 `downloadFileWithProgress()`，成功后调用 `runtime.host.saveFile(file)`，见 `FilePage.tsx:37–59`。该按钮必须保留。

现有 e2e 中：

- 没有引用终端 header 的 `jump-to-latest`，因为它没有 test id；
- `apps/fe/tests/terminal-shortcuts.spec.ts:57–59` 的 `shortcut-add-action-scrollToBottom` 是快捷键编辑器里的“添加滚到底部动作”，不是 header 按钮；
- 文件下载 e2e 位于 `apps/fe/tests/files-context-menu.spec.ts:139–143`，验证真实浏览器 download；
- `use-device-console-effects.test.ts:8–20` 只测试浏览器标题恢复，没有测试 jump 事件消费。

## 4. 现有测试与可能需要更新的位置

直接覆盖徽标/详情：

- `[device-node-badges.test.tsx](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/device-node-badges.test.tsx:54)`：
  - `resolveLinkBadge` 的 direct/LAN/WAN/relay/不可达矩阵；
  - RTT 缺失、负数、NaN；
  - `reachLabelKey()`、`transportLabelKey()`；
  - relay 详情、ICE 详情、`nodes.badge.unknown` fallback；
  - self 不显示徽标、`badge-node-link`、默认不展开。
- `[mesh-nodes.test.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-nodes.test.ts:100)`：
  - `transport`/`rttMs` 事件写入；
  - offline 清除；
  - 老事件缺字段时保留旧值。
- `[mesh-events.test.ts](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/node/mesh-events.test.ts:101)`：
  - relay reach 解码；
  - NodeEvent 的 `transport/rttMs` 默认值；
  - legacy NodeEvent 兼容。

网关数据链路测试：

- `apps/gateway/src/mesh/node-list-projection.test.ts:74–112`：验证 `reach`、`transport`、`rttMs` 进入 DTO。
- `apps/gateway/src/mesh/mesh-routes.test.ts:124–165`：验证 `GET /api/mesh/nodes` 返回 transport/RTT。
- `apps/gateway/src/mesh/mesh-routes.test.ts:750–777`：验证 `NODE_EVENT` 编码。
- `apps/gateway/src/mesh/peer-manager.test.ts:278–326`：endpoint 失败后使用 relay。
- `apps/gateway/src/mesh/peer-manager.test.ts:710–810`：relay 升级到 DC。
- `apps/gateway/src/mesh/node-event-dedupe.test.ts:5–54`：transport/RTT 变化触发事件。
- `apps/gateway/src/mesh/mesh-runtime.test.ts:706` 起：node.list 变化投影为 NodeEvent。

终端按钮测试：

- `packages/panels/src/device-console/device-console-actions.test.ts:105–115`：按钮顺序；
- `:130–137`：`jump-to-latest` 在不可交互时禁用；
- `:164–188`：按钮 handler 路由到 `onJumpToLatest`；
- `packages/panels/src/device-console/toolbar-tooltips.test.tsx:50–76`：所有 toolbar 按钮的 aria-label/tooltip；
- 当前没有测试 `tmex:jump-to-latest` 事件最终调用 `scrollToBottom()`。

本次按要求只进行了静态代码阅读，没有启动开发服务器，也没有运行测试。