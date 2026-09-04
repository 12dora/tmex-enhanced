## 结论

问题已定位：远端节点版本过低时，前端最终调用的是 `packages/stores/src/tmux-event-router.ts` 中的 `tooOldMessage()`。该函数把 `nodeId` 的前 8 位作为 i18n 参数 `name`：

```ts
const nodeId = event.nodeId ?? ctx.core.nodeId;
if (!nodeId || nodeId === SELF_NODE_ID) return t('websocket.nodeTooOldUnnamed', params);
return t('websocket.nodeTooOld', { ...params, name: nodeId.slice(0, 8) });
```

见 [`tmux-event-router.ts:45-55`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-event-router.ts:45)。

因此当前 canonical v1.1 提示显示的是节点 ID 前缀，而不是类似 `jiefa-app` 的显示名。现场若看到完整 ID，则可能是某个上游原始错误字符串被直接透传；但 canonical 版本提示路径明确存在 ID 替代名称的问题。

推荐在前端根据现有 mesh nodes 状态解析 `nodeId → name`，不要修改网关 WebSocket 协议。

## 1. 终端失败、断开和版本过低相关调用点

### 确定需要修改：canonical 版本过低 toast

错误处理入口位于 [`tmux-event-router.ts:140-148`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-event-router.ts:140)：

```ts
'server-too-old': (event, ctx) => {
  console.error(
    '[tmux] peer too old for canonical state v1.1:',
    `side=${event.side} node=${event.nodeId ?? '-'} version=${event.version ?? 'unknown'} required>=${event.minVersion}`
  );
  ctx.core.notifications.error(tooOldMessage(event, ctx));
},
```

实际文案参数由 `tooOldMessage()` 生成：

- `gateway`：`websocket.gatewayTooOld`
- `client`：`websocket.clientTooOld`
- `node`：`websocket.nodeTooOld`
- 自身节点 ID 缺失或为 `SELF_NODE_ID`：`websocket.nodeTooOldUnnamed`

问题只在 `node` 分支：

```ts
return t('websocket.nodeTooOld', {
  ...params,
  name: nodeId.slice(0, 8),
});
```

现有测试也把这个错误行为固定下来了。见 [`tmux-event-router.test.ts:472-489`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-event-router.test.ts:472)：

```ts
expect(harness.notifications).toEqual([
  ['error', 'websocket.nodeTooOld'],
]);
expect(harness.tArgs.at(-1)).toEqual([
  'websocket.nodeTooOld',
  {
    version: '1.1.22',
    minVersion: '1.1.23',
    name: 'abcdef01',
  },
]);
```

### 普通设备连接错误：原始错误文本透传

设备错误由 [`tmux-device-events.ts:67-84`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-device-events.ts:67) 处理：

```ts
const summary = payload.message ?? 'Device Error';
...
if (shouldToast && !ctx.core.features.hostManagedNotifications) {
  ctx.core.notifications.error(summary);
}
```

前端面板通过 [`use-console-targets.ts:96-103`](/Users/konata/code/tmex-r25/packages/panels/src/device-console/use-console-targets.ts:96) 读取 `deviceErrors[deviceId]`，再传给 [`device-console.tsx:131-140`](/Users/konata/code/tmex-r25/packages/panels/src/device-console/device-console.tsx:131) 的 `useDeviceConsoleEffects()`。

最终 toast 位于 [`use-device-console-effects.ts:93-99`](/Users/konata/code/tmex-r25/packages/panels/src/device-console/use-device-console-effects.ts:93)：

```ts
useEffect(() => {
  if (!deviceErrorMessage) return;

  toast.error(deviceErrorMessage);
}, [deviceErrorMessage]);
```

这里没有自行插入 `nodeId` 或 `nodeName`，只是显示网关/设备事件中的 `message`。如果网关把节点 ID 写进 `message`，该路径会原样显示。

设备事件协议本身只有 `deviceId`、错误类型和消息，没有 `nodeId`/`nodeName`：

[`packages/shared/src/contracts/websocket.ts:16-22`](/Users/konata/code/tmex-r25/packages/shared/src/contracts/websocket.ts:16)

```ts
export interface EventDevicePayload {
  deviceId: string;
  type: DeviceEventType;
  errorType?: string;
  message?: string;
  rawMessage?: string;
}
```

### 只显示状态，不包含节点 ID 的位置

这些位置没有节点名称替换问题，不需要修改：

- [`terminal-stage.tsx:59-80`](/Users/konata/code/tmex-r25/packages/panels/src/device-console/terminal-stage.tsx:59)：显示 `terminal.connecting`、`device.disconnected`。
- [`terminal-stage.tsx:453-472`](/Users/konata/code/tmex-r25/packages/panels/src/device-console/terminal-stage.tsx:453)：根据连接状态决定显示终端或断开占位符。
- [`connection-indicator.tsx:78-113`](/Users/konata/code/tmex-r25/packages/panels/src/connection-indicator.tsx:78)：显示重连、重新连接按钮。
- [`device-connection-control.tsx:25-45`](/Users/konata/code/tmex-r25/packages/panels/src/device-tree/device-connection-control.tsx:25)：显示 connected/connecting/reconnecting/disconnected 状态。
- [`device-status-badge.tsx:26-67`](/Users/konata/code/tmex-r25/packages/panels/src/device-status-badge.tsx:26)：显示设备错误 tooltip，但只消费已有的 `error.message`。
- [`use-editor-input.ts:122-127`](/Users/konata/code/tmex-r25/packages/panels/src/device-console/use-editor-input.ts:122)：`wsError.checkGateway`，没有节点参数。
- [`tmux-event-router.ts:267-273`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-event-router.ts:267)：`pending-overflow` 只显示 `websocket.inputDropped`。
- [`node-runtimes.ts:192-226`](/Users/konata/code/tmex-r25/apps/fe/src/node/node-runtimes.ts:192)：直连回退提示 `device.directFallbackToast`，没有节点 ID。

`websocket.error` 虽然存在于 locale 中，但没有发现它被用于节点连接失败 toast。

## 2. canonical-state-v1.1 消息契约与解析链路

网关生成的远端节点错误在 [`canonical-gate.ts:17-24`](/Users/konata/code/tmex-r25/apps/gateway/src/ws/canonical-gate.ts:17)：

```ts
export function peerNodeTooOldMessage(
  nodeId: string,
  peerVersion: string | null,
): string {
  return formatCanonicalV11RequiredError({
    side: 'node',
    nodeId,
    version: peerVersion,
  });
}
```

共享协议定义的格式是：

```text
canonical-state-v1.1 required: node <nodeId> version <version> < <min>
```

见 [`canonical-version.ts:51-71`](/Users/konata/code/tmex-r25/packages/shared/src/ws-borsh/canonical-version.ts:51)。

解析正则明确提取 `nodeId` 和版本：

```ts
return {
  side: 'node',
  nodeId: normalizeToken(node[1]),
  version: normalizeToken(node[2]),
};
```

见 [`canonical-version.ts:73-103`](/Users/konata/code/tmex-r25/packages/shared/src/ws-borsh/canonical-version.ts:73)。

`packages/ws-client` 收到 Borsh `ERROR_UNSUPPORTED_PROTOCOL` 后，将它转成：

```ts
{
  type: 'server-too-old',
  side: tooOld.side,
  minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
  version: tooOld.version,
  nodeId: tooOld.nodeId,
}
```

见 [`transport-message-decoder.ts:123-142`](/Users/konata/code/tmex-r25/packages/ws-client/src/transport-message-decoder.ts:123)。

随后 `websocket-transport.ts` 做去重并继续携带 `nodeId`：

[`websocket-transport.ts:189-210`](/Users/konata/code/tmex-r25/packages/ws-client/src/websocket-transport.ts:189)

当前协议只传 `nodeId`，不传 `nodeName`。这是合理的底层协议设计：节点名称属于展示/目录数据，而不是连接握手所必需的数据。

相关协议测试：

- [`canonical-version.test.ts:73-109`](/Users/konata/code/tmex-r25/packages/shared/src/ws-borsh/canonical-version.test.ts:73)
- [`transport-message-decoder.test.ts:149-211`](/Users/konata/code/tmex-r25/packages/ws-client/src/transport-message-decoder.test.ts:149)
- [`websocket-canonical-gate.test.ts:279-332`](/Users/konata/code/tmex-r25/packages/ws-client/src/websocket-canonical-gate.test.ts:279)

这些测试应继续验证 `nodeId` 的传输，不建议改成传名称。

## 3. 前端已有的节点名称来源

### mesh nodes store

权威来源是 `apps/fe` 的 mesh nodes store：

[`apps/fe/src/node/mesh-nodes.ts:310-320`](/Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:310)

```ts
export interface MeshNodesState {
  nodes: MeshNode[];
  entryNodeId: string | null;
  ...
}
```

状态通过：

```ts
export const getMeshNodesState = store.get;
export const subscribeMeshNodes = store.subscribe;
```

见 [`mesh-nodes.ts:332-345`](/Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:332)。

React 组件通常通过 `useMeshNodes()` 获取：

[`mesh-nodes.ts:614-642`](/Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:614)

```ts
const snapshot = useSyncExternalStore(
  subscribeMeshNodes,
  getMeshNodesState,
  getMeshNodesState,
);
...
return { ...snapshot, refresh };
```

节点名称来自 `/api/mesh/nodes`，并可由 `NODE_EVENT.name` 更新。见 [`mesh-nodes.ts:58-92`](/Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:58)：

```ts
name: event.name ?? node.name,
```

`MeshNode` 的类型定义包含 `id` 和 `name`，见 [`auth/types.ts:227-269`](/Users/konata/code/tmex-r25/packages/api-client/src/auth/types.ts:227)。

### 已存在的名称查找模式

`useLocalNodeName()` 已经使用相同的 store 做名称查找：

[`apps/fe/src/components/brand.tsx:44-53`](/Users/konata/code/tmex-r25/apps/fe/src/components/brand.tsx:44)

```ts
const meshName = entryNodeId
  ? mesh.nodes.find((node) => node.id === entryNodeId)?.name ?? null
  : null;
```

但这是 React hook，只处理入口节点，不适合在 `packages/stores` 的非 React 事件处理器中调用。

侧边栏也直接使用 `node.name`：

[`sidebar-device-list.tsx:61-79`](/Users/konata/code/tmex-r25/packages/panels/src/device-tree/sidebar-device-list.tsx:61)

并将实际节点 ID 映射为运行时 ID：

```ts
runtimeNodeId: isSelf ? SELF_NODE_ID : node.id,
name: node.name,
```

### `nodeNames` 和 `peer_cache`

没有发现前端可直接使用的 `nodeNames` projection：

- `packages/shared/src/auth/key-log.ts:65-73` 的 `nodeNames` 是认证 key-log 内部投影，不是前端 store。
- `peer_cache` 是网关侧 `UserStore` 数据，见 [`user-store.ts:113-122`](/Users/konata/code/tmex-r25/apps/gateway/src/auth/user-store.ts:113)，浏览器不能直接读取。

因此前端最便宜的来源就是：

```ts
getMeshNodesState().nodes.find((node) => node.id === nodeId)?.name
```

## 4. 网关侧只带 nodeId 的错误

### WebSocket canonical 错误

远端节点版本过低时，网关在 [`stream-replay-state.ts:18-50`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/stream-replay-state.ts:18) 生成 Error frame：

```ts
const message = peerNodeTooOldMessage(
  pump.nodeId,
  pump.replay.peerVersion,
);
```

然后发送包含完整 `nodeId` 的错误消息，并关闭 stream：

```ts
io.send(pump, {
  refSeq: null,
  code: ERROR_CANONICAL_V11_REQUIRED,
  message,
  retryable: false,
});

io.closePump(pump, {
  code: 1002,
  reason: 'node-too-old',
});
```

调用方位于 [`forwarder.ts:378-390`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:378)。

网关到浏览器的 gateway-too-old close reason 是通用的：

[`apps/gateway/src/ws/index.ts:528-539`](/Users/konata/code/tmex-r25/apps/gateway/src/ws/index.ts:528)

```ts
this.sendError(..., clientTooOldMessage(clientVersion), false);
this.closeSession(ws, 1002, 'canonical-state-v1.1 required');
```

这些 close reason 没有节点名称；而且 `packages/ws-client` 目前只将 Borsh ERROR 转为 `server-too-old`，没有发现将 close reason 直接转换成带节点名称的 toast。

### `/n/:id` HTTP/WS 代理

Forwarder 的多个路径返回只有 `nodeId` 的 JSON：

[`forwarder.ts:224-256`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:224)

```ts
return jsonError('NODE_UNREACHABLE', 503, { nodeId });
```

认证缺失：

[`forwarder.ts:273-277`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:273)

```ts
return jsonError('NODE_LOGIN_REQUIRED', 401, {
  nodeId: input.nodeId,
});
```

最终 failover 失败仍然只带 `nodeId`：

[`forwarder.ts:315-319`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:315)。

远端 WebSocket proxy 也使用相同错误：

[`forwarder.ts:641-683`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:641)。

下游 401 重写逻辑同样只补充 `nodeId`：

[`forwarder.ts:805-842`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:805)。

`jsonError()` 本身只是把扩展字段原样序列化：

[`session-middleware.ts:209-214`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/session-middleware.ts:209)。

其它网关路径也有类似响应：

- [`node-operations.ts:157-217`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/node-operations.ts:157)
- [`upgrade-service.ts:76-94`](/Users/konata/code/tmex-r25/apps/gateway/src/system/upgrade-service.ts:76)
- [`upgrade-service.ts:117-193`](/Users/konata/code/tmex-r25/apps/gateway/src/system/upgrade-service.ts:117)
- [`upgrade-service.ts:323-334`](/Users/konata/code/tmex-r25/apps/gateway/src/system/upgrade-service.ts:323)

还有一个内部错误类直接将 ID 写进 Error 文本：

[`remote-pane-runtime.ts:13-24`](/Users/konata/code/tmex-r25/apps/gateway/src/agent/remote-pane-runtime.ts:13)

```ts
super(`NODE_UNREACHABLE: remote node ${nodeId} is not reachable`);
```

### 网关是否能便宜地加入 nodeName？

网关已经有名称投影逻辑：

- [`mesh-routes.ts:415-462`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/mesh-routes.ts:415)
- [`node-list-projection.ts:92-109`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/node-list-projection.ts:92)
- [`node-list-projection.ts:172-237`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/node-list-projection.ts:172)

但 `ForwarderDeps` 当前只有 `nodeId`、peer provider、stream opener 等，没有名称解析器：

[`forwarder.ts:69-76`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.ts:69)

如果 HTTP 错误要增加 `nodeName`，需要把名称 resolver 从 `MeshHttpRuntime` 传入 `Forwarder`，并修改 API client 类型和错误对象保留逻辑。目前：

- `session-interceptor.ts` 只消费 `nodeId` 来触发节点登录事件，见 [`session-interceptor.ts:123-177`](/Users/konata/code/tmex-r25/packages/api-client/src/auth/session-interceptor.ts:123)。
- 通用 API 错误解析不会保留所有字段，见 [`client.ts:83-97`](/Users/konata/code/tmex-r25/packages/api-client/src/client.ts:83)。

所以仅给 HTTP body 增加 `nodeName`，不会自动修复当前 canonical WebSocket toast。

更重要的是，canonical Borsh `ErrorSchema` 目前没有独立的名称字段，增加字段会涉及协议版本、编码兼容和旧节点处理，不属于便宜改动。

## 5. i18n 源 locale JSON

英文源文件已有正确的名称占位符：

[`en_US.json:1117-1131`](/Users/konata/code/tmex-r25/packages/shared/src/i18n/locales/en_US.json:1117)

```json
"gatewayTooOld": "Terminal connection failed: Gateway {{version}} is too old, please upgrade it to {{minVersion}} or newer.",
"nodeTooOld": "Terminal connection failed: node {{name}} runs tmex {{version}}, please upgrade it to {{minVersion}} or newer.",
"nodeTooOldUnnamed": "Terminal connection failed: the node runs tmex {{version}}, please upgrade it to {{minVersion}} or newer.",
"clientTooOld": "Terminal connection failed: this page is too old, please reload it."
```

中文源文件同样已经定义了 `{{name}}`：

[`zh_CN.json:1117-1131`](/Users/konata/code/tmex-r25/packages/shared/src/i18n/locales/zh_CN.json:1117)

```json
"gatewayTooOld": "终端连接失败：Gateway 版本 {{version}} 过低，请升级到 {{minVersion}} 或更新版本。",
"nodeTooOld": "终端连接失败：节点 {{name}} 的 tmex 版本 {{version}} 过低，请升级到 {{minVersion}} 或更新版本。",
"nodeTooOldUnnamed": "终端连接失败：节点的 tmex 版本 {{version}} 过低，请升级到 {{minVersion}} 或更新版本。",
"clientTooOld": "终端连接失败：网页版本过低，请刷新页面。"
```

`ja_JP.json` 对应位置也保留相同的 `{{name}}`、`{{version}}`、`{{minVersion}}` 参数。

结论：不需要修改 locale key 或文案，只需要传入正确的 `name`。应修改源 JSON 时不要直接编辑生成的 `resources.ts`。

## 6. 推荐修改方案

推荐“前端名称查找 + 保留 wire-level nodeId”：

1. 在 `RuntimeCore`/`AppRuntimeOptions` 增加可选 resolver，例如：

   ```ts
   resolveNodeName?: (nodeId: string) => string | null;
   ```

   相关扩展位置：

   - [`runtime.ts:96-127`](/Users/konata/code/tmex-r25/packages/stores/src/runtime.ts:96)
   - [`runtime.ts:141-157`](/Users/konata/code/tmex-r25/packages/stores/src/runtime.ts:141)
   - [`runtime.ts:279-298`](/Users/konata/code/tmex-r25/packages/stores/src/runtime.ts:279)

2. 在 `tooOldMessage()` 中调用 resolver：

   ```ts
   const nodeName = nodeId
     ? ctx.core.resolveNodeName?.(nodeId)
     : null;
   ```

   然后传递：

   ```ts
   name: nodeName?.trim() || nodeId.slice(0, 8)
   ```

   或者更符合用户体验地，在名称不存在时使用 `nodeTooOldUnnamed`，完全不显示 ID。

3. 在 `apps/fe/src/node/mesh-nodes.ts` 增加纯函数 helper，复用现有 `getMeshNodesState()`。需要处理 `SELF_NODE_ID` 到 `entryNodeId` 的映射。

4. 在 [`node-runtimes.ts:318-333`](/Users/konata/code/tmex-r25/apps/fe/src/node/node-runtimes.ts:318) 通过现有的 `runtimeOptions` 注入 resolver。`NodeConnectionManager` 已经支持按节点注入运行时选项：

   [`node-connection-manager.ts:77-100`](/Users/konata/code/tmex-r25/packages/stores/src/node-connection-manager.ts:77)。

这样可以动态读取最新 mesh store，避免运行时创建过早导致名称缓存过期。

## 7. 现有测试与建议补充

现有覆盖：

- 错误行为回归测试：[`tmux-event-router.test.ts:472-505`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-event-router.test.ts:472)
- gateway/client/self 的版本过低分支：[`tmux-event-router.test.ts:452-537`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-event-router.test.ts:452)
- canonical 格式与解析：[`canonical-version.test.ts:73-135`](/Users/konata/code/tmex-r25/packages/shared/src/ws-borsh/canonical-version.test.ts:73)
- ws-client 节点 ID 解码：[`transport-message-decoder.test.ts:149-211`](/Users/konata/code/tmex-r25/packages/ws-client/src/transport-message-decoder.test.ts:149)
- canonical 错误去重：[`websocket-canonical-gate.test.ts:279-332`](/Users/konata/code/tmex-r25/packages/ws-client/src/websocket-canonical-gate.test.ts:279)
- 网关发送带 nodeId 的 canonical 错误：[`forwarder.test.ts:708-754`](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/forwarder.test.ts:708)
- 普通设备错误 toast sink：[`tmux-device-events.test.ts:273-360`](/Users/konata/code/tmex-r25/packages/stores/src/tmux-device-events.test.ts:273)

应新增或修改：

- 将 `tmux-event-router.test.ts` 当前的 `name: 'abcdef01'` 改为 resolver 返回的 `jiefa-app`。
- 增加“事件中的远端 `event.nodeId` 优先于当前 runtime nodeId”的测试。
- 增加名称缺失时的 fallback 测试。
- 保留 ws-client/shared/gateway 测试中的 `nodeId` 断言，因为底层协议仍然应该传输 ID。
- 当前没有发现专门验证最终 React toast 文案包含 mesh display name 的测试；最合适的测试层级是 `tmux-event-router.test.ts`，因为 toast 的最终业务参数就在该 store handler 中生成。