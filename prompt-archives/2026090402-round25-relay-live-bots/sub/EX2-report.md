# EX2 调查报告：节点管理页首次进入误显示“无法连接到 Hub”

## 结论

问题不是 `error/failure` 初始值为错误，而是：

1. `useHubNode` 初始时 `hubNodes === null`。
2. `online` 直接由 `hubNodes !== null` 推导，因此初始为 `false`。
3. `HubUplinkNotices` 没有判断 `loading` 或“是否已经完成过一次请求”，只要 `hubOnline === false` 就渲染“无法连接到 Hub”。

因此首次请求真正开始前，页面就可能先显示错误。随后如果首次 Hub 请求返回 401，代码会静默登录节点并重试；重试成功后 `hubNodes` 不再为空，错误自然消失。

---

## 1. 产生错误状态的 Hook 和 UI

### `useHubNode` 的状态机

核心代码位于 [`apps/fe/src/node/mesh-nodes.ts:715`]( /Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:715 )（715–778）。

初始状态：

```ts
const [hubNodes, setHubNodes] = useState<HubNodeRow[] | null>(null);
const [loading, setLoading] = useState(false);
const [failure, setFailure] = useState<HubFailureReason | null>(null);
```

返回值：

```ts
return {
  hubNodeId: effectiveHubId,
  hubApi,
  hubNodes,
  online: hubNodes !== null,
  loading,
  failure,
  refresh,
};
```

也就是说：

| 阶段 | `hubNodes` | `loading` | `failure` | `online` |
|---|---:|---:|---:|---:|
| 首次 render | `null` | `false` | `null` | `false` |
| 请求开始后 | `null` | `true` | `null` | `false` |
| 请求成功 | rows | `false` | `null` | `true` |
| 所有候选 Hub 失败 | `null` | `false` | auth/unreachable | `false` |
| 没有请求目标或 disabled | `null` | `false` | `null` | `false` |

`loading` 和 `failure` 由 [`apps/fe/src/node/hub-load-coordinator.ts:118`]( /Users/konata/code/tmex-r25/apps/fe/src/node/hub-load-coordinator.ts:118 ) 管理：

```ts
if (!request) {
  this.sink.reset();
  return;
}

this.sink.loading(true, switched);

try {
  const rows = await request();
  if (this.canApply(generation)) this.sink.rows(rows);
} catch (err) {
  if (this.canApply(generation)) {
    this.sink.failed(classifyHubFailure(err));
  }
} finally {
  if (this.canApply(generation)) this.sink.loading(false);
}
```

首次请求时，`loading` 会变成 `true`，但 `hubNodes` 仍然是 `null`，所以 `online` 仍然是 `false`。

### 错误 Banner 的渲染逻辑

Banner 位于 [`apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx:213`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx:213 )。

```tsx
function HubUplinkNotices({ hubOnline, writesBlocked, hubFailure }) {
  const { t } = useTranslation();

  if (writesBlocked) {
    return (
      <p data-testid="nodes-hub-standby">
        {t('nodes.hubs.standbyNotice')}
      </p>
    );
  }

  if (hubOnline) return null;

  const notice = hubFailureNotice(hubFailure);

  return (
    <p data-testid={notice.testId}>
      <ShieldAlert />
      {t(notice.key, notice.params)}
    </p>
  );
}
```

关键点是：

```ts
if (hubOnline) return null;
```

除此之外没有任何 `loading` 或 `failure !== null` 判断。

所以初始状态：

```ts
hubOnline === false
hubFailure === null
```

仍会渲染：

```ts
nodes.hubOffline
```

Banner 的文案映射位于 [`apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx:28`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx:28 )：

```ts
if (failure?.kind === 'auth') {
  return {
    testId: 'nodes-hub-login-rejected',
    key: 'nodes.hubLoginRejected',
    params: { code: failure.code },
  };
}

return {
  testId: 'nodes-hub-offline',
  key: 'nodes.hubOffline',
};
```

因此有两种完全不同的情况都显示同一类错误：

- 初次尚未完成请求：`hubOnline=false, hubFailure=null`
- 请求最终失败：`hubOnline=false, hubFailure` 非空

当前 UI 把它们混合成了同一个状态。

---

## 2. 首次请求为什么会在登录前触发

### Hub API 请求地址

[`apps/fe/src/node/hub-api.ts:80`]( /Users/konata/code/tmex-r25/apps/fe/src/node/hub-api.ts:80 )：

```ts
async listNodes(): Promise<HubNodeRow[]> {
  const res = await this.client.fetch(this.path('/nodes'));

  if (!res.ok) {
    throw await readError(res, 'hub_nodes_failed');
  }

  const body = (await res.json()) as { nodes?: HubNodeRow[] };
  return body.nodes ?? [];
}
```

`path('/nodes')` 最终形成：

```text
/n/<hubNodeId>/api/hub/nodes
```

### Hub 候选节点的确定

[`apps/fe/src/node/mesh-nodes.ts:230`]( /Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:230 )：

```ts
export function hubCandidateIds(
  nodes: MeshNode[],
  modeHubNodeId?: string | null,
): string[] {
  const primary = findHubNodeId(nodes, modeHubNodeId);
  const ids: string[] = primary ? [primary] : [];

  for (const node of nodes) {
    if (
      node.isHub === true &&
      node.online !== false &&
      !ids.includes(node.id)
    ) {
      ids.push(node.id);
    }
  }

  return ids;
}
```

`findHubNodeId` 会优先使用 `/api/auth/mode` 返回的 `hubNodeId`，即使 mesh 节点列表尚未加载：

[`apps/fe/src/node/mesh-nodes.ts:218`]( /Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:218 )：

```ts
if (writer) return writer.id;
...
return modeHubNodeId || null;
```

所以在 Settings → Nodes 页面中，只要 `mode.hubNodeId` 已知，`useHubNode` 就可以立即请求 Hub，不需要等待完整 mesh 节点列表。

### 页面挂载时的请求关系

本地上行控制器位于 [`apps/fe/src/pages/settings/nodes/uplink/local-uplink-controller.ts:44`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/local-uplink-controller.ts:44 )：

```ts
const { nodes } = useMeshNodes({
  enabled: meshEnabled,
  api,
});

const hub = useHubNode(nodes, {
  enabled: meshEnabled,
  hubNodeId: rawMode?.hubNodeId ?? null,
});

const hubs = useMeshHubs({
  owner: true,
  enabled: meshEnabled,
});

const relay = useMeshRelay({
  owner: true,
  enabled: meshEnabled,
});
```

请求之间是并发启动的，不存在“先加载 mesh nodes，再加载 Hub nodes”的等待关系：

1. `GET /api/auth/mode`：由 `useSharedAuthMode` 获取模式和 `hubNodeId`。
2. `GET /api/local/status`：`useLocalStatus` 独立查询。
3. `GET /api/mesh/nodes`：mesh 节点列表尚未加载时发起。
4. `GET /n/<hubId>/api/hub/nodes`：只要模式中已有 `hubNodeId`，`useHubNode` 立即发起。
5. `GET /api/mesh/hubs`：Hub 归属和写入权限。
6. `GET /api/mesh/relay/status`：中继状态。

具体完成顺序取决于网络延迟；源码能确定请求是独立发起的，不能保证浏览器中的响应完成顺序。

如果 `hubNodeId` 还未知且 mesh nodes 也为空，`hubCandidateIds` 会返回空数组，此时不会发 Hub 请求。等节点列表或模式信息到达后，`request` 变化，Hook 再开始加载。

### 401 后的静默登录和重试

`loadHubNodes` 位于 [`apps/fe/src/node/mesh-nodes.ts:243`]( /Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:243 )：

```ts
for (const hubNodeId of candidates) {
  try {
    return {
      hubNodeId,
      rows: await deps.list(hubNodeId),
    };
  } catch (error) {
    lastError = error;

    if (!isNodeLoginRequired(error)) continue;

    const login = await deps.login(hubNodeId).catch(() => ({
      ok: false,
    }));

    if (!login.ok) {
      ...
      continue;
    }

    try {
      return {
        hubNodeId,
        rows: await deps.list(hubNodeId),
      };
    } catch (retryError) {
      lastError = retryError;
    }
  }
}
```

401 时使用：

[`apps/fe/src/node/mesh-nodes.ts:302`]( /Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.ts:302 )：

```ts
function silentNodeLogin(hubNodeId: string): Promise<{ ok: boolean }> {
  return import('@/auth/session-key-store').then((mod) =>
    mod.ensureNodeLogin(hubNodeId),
  );
}
```

`ensureNodeLogin` 会先恢复本地 session，再调用 `loginToNode`：

[`apps/fe/src/auth/session-key-store.ts:408`]( /Users/konata/code/tmex-r25/apps/fe/src/auth/session-key-store.ts:408 )：

```ts
const task = restoreSessionKey()
  .then(async (session) => {
    if (!session) {
      return { ok: false, code: 'NO_SESSION_KEY' };
    }

    const mod = await loadLogin();
    const result = await mod.loginToNode(nodeId, opts);

    if (result.ok) {
      markLoggedIn(nodeId);
      return result;
    }

    ...
  });
```

登录流程本身包括：

```text
GET  /n/<hubId>/api/auth/challenge
POST /n/<hubId>/api/auth/login
GET  /n/<hubId>/api/hub/nodes  ← 重试
```

对应 [`apps/fe/src/auth/session-login.ts:542`]( /Users/konata/code/tmex-r25/apps/fe/src/auth/session-login.ts:542 ) 和 [`apps/fe/src/auth/session-login.ts:610`]( /Users/konata/code/tmex-r25/apps/fe/src/auth/session-login.ts:610 )。

因此，“首次请求时浏览器还没有该 Hub 节点的 session，第一次返回 401，静默登录后重试成功”是当前代码明确支持的正常路径。

但需要区分：

- 首次错误 Banner 的出现，不需要真实 401。
- 即使 Hub 请求最终成功，首屏也会因为 `online` 初始为 `false` 先显示 Banner。
- 如果实际发生 401，登录过程只是延长了这个错误状态的可见时间。

### API Client 的 401 行为

[`packages/api-client/src/client.ts:57`]( /Users/konata/code/tmex-r25/packages/api-client/src/client.ts:57 ) 的 `fetch` 只执行 response hook，不会自动重试：

```ts
return pending.then((res) => {
  runResponseHooks(res, {
    path,
    url,
    pathname: urlPathname(url),
  });

  return res;
});
```

401 处理在 [`packages/api-client/src/auth/session-interceptor.ts:152`]( /Users/konata/code/tmex-r25/packages/api-client/src/auth/session-interceptor.ts:152 )：

```ts
if (body.code === NODE_LOGIN_REQUIRED) {
  emit({
    nodeId: resolveNodeLoginTarget(body.nodeId, path),
    scope: 'node',
    path,
  });
  return;
}

const nodeId = nodeIdFromPath(path);

if (nodeId !== SELF_NODE_ID) {
  emit({
    nodeId,
    scope: 'node',
    path,
  });
  return;
}
```

而 response hook 只对 401 调用它：

```ts
export const sessionResponseHook = (res, ctx) => {
  if (res.status !== 401) return;

  void handleUnauthorized(res, ctx.pathname);
};
```

结论：

- API Client interceptor 不负责 `login + retry`。
- 它只发出节点级未登录事件。
- 真正的 Hub 登录和重试由 `loadHubNodes` 完成。
- 原始 401 response 仍会返回给 `HubApi`，并被转换成 `HubApiError`。

---

## 3. i18n、节点管理 UI 和 Sidebar 状态

### 实际使用的 i18n Key

中文资源位于 [`packages/shared/src/i18n/locales/zh_CN.json:1727`]( /Users/konata/code/tmex-r25/packages/shared/src/i18n/locales/zh_CN.json:1727 )：

```json
"nodes": {
  "management": {
    "title": "节点管理"
  },
  "empty": "暂无节点",
  "self": "当前",
  "hub": "Hub",
  "loggedIn": "已登录",
  "hubOffline": "无法连接到 Hub，节点管理暂不可用。",
  "hubLoginRejected": "Hub 拒绝了本次登录（{{code}}）：请重新登录后再试。",
  "hubs": {
    "standbyNotice": "主 Hub 不可达，正在使用备用 Hub；加入、重命名、移除等管理操作暂不可用。"
  }
}
```

当前源码中没有找到 `nodes.hubUnreachable` 或 `settings.nodes.hubError`；实际 Key 是：

- `nodes.hubOffline`
- `nodes.hubLoginRejected`
- `nodes.hubs.standbyNotice`

### 节点管理表的空状态

节点管理页位于 [`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:56`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:56 )。

它把 mesh 节点和 Hub 节点合并：

```ts
const rows = useMemo(
  () =>
    mergeNodes(nodes, hub.hubNodes, {
      entryNodeId,
      hubNodeId: hub.hubNodeId,
    }),
  [nodes, hub.hubNodes, entryNodeId, hub.hubNodeId],
);
```

写入权限由：

```ts
const writable = relay.relayMode
  ? relay.writable
  : hub.online && !hubs.writesBlocked;
```

传给 NodesTable：

[`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:253`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:253 )。

表格本身在 rows 为空时只显示通用空文本：

[`apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:92`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:92 )：

```tsx
{rows.length === 0 && (
  <tr>
    <td>{t('nodes.empty')}</td>
  </tr>
)}
```

所以 `nodes.hubOffline` 红色提示不是 `NodesTable` 产生的，而是上方的 `HubUplinkNotices` 产生的。

### Sidebar 的“在线”状态并不是 Hub 管理连接状态

Sidebar 节点列表使用 `useMeshNodes()` 的 mesh 投影：

[`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:126`]( /Users/konata/code/tmex-r25/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:126 )：

```tsx
function MeshDeviceList() {
  const { nodes, loading } = useMeshNodes();

  const entries = useMemo(
    () => toSidebarEntries(nodes, entryNodeId, order),
    [nodes, entryNodeId, order],
  );

  ...
}
```

节点条目的在线字段直接来自 mesh 节点：

[`apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:55`]( /Users/konata/code/tmex-r25/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:55 )：

```ts
return {
  id: node.id,
  online: node.online,
  loggedIn: node.isSelf ? true : node.loggedIn,
};
```

节点 section 根据 `node.online` 和 `node.loggedIn` 渲染：

[`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:470`]( /Users/konata/code/tmex-r25/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:470 )：

```tsx
if (!node.online) {
  return <SidebarNodeOffline ... />;
}

if (!node.loggedIn) {
  return <SidebarNodeSignIn ... />;
}

if (node.isSelf || node.runtimeNodeId === SELF_NODE_ID) {
  return <SidebarNodeRuntimeSection ... />;
}

return <SidebarNodeOnline ... />;
```

此外，左上角的 `ConnectionIndicator` 观察的是运行时 WebSocket：

[`packages/panels/src/connection-indicator.tsx:19`]( /Users/konata/code/tmex-r25/packages/panels/src/connection-indicator.tsx:19 )：

```ts
const { connectionState, hasConnectedOnce } = useTmuxStore(
  runtimeStore,
  (state) => ({
    connectionState: state.connectionState,
    hasConnectedOnce: state.hasConnectedOnce,
  }),
);
```

这代表的是 gateway/runtime 连接，不是：

```text
/n/<hubId>/api/hub/nodes
```

因此“Sidebar 正常”与“Hub 管理 API 尚未完成登录或请求失败”可以同时成立。Sidebar 不能直接作为 `hub.online` 的替代判断。

另外，`apps/fe/src/pages/DevicesPage.tsx:63` 只使用 `useMeshNodes` 和节点运行时状态，并不直接调用 `useHubNode`，也不直接渲染 `nodes.hubOffline`。如果用户在“devices page”看到的正是该文案，实际来源更可能是 Settings → Nodes 的 `LocalMachineCard` Hub 标签，或连接设备侧的 Hub 状态组件。

---

## 4. 最小修复建议

### 推荐修复

只在有真实失败结果时显示 Hub 错误，不要把“尚未完成首次探测”当作错误。

修改 [`apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx:235`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.tsx:235 )：

```tsx
if (hubOnline || hubFailure === null) return null;
```

替换当前的：

```tsx
if (hubOnline) return null;
```

这样状态表现为：

- 初始状态：`hubOnline=false, hubFailure=null` → 不显示错误。
- 登录中或重试中：仍然不显示错误。
- Hub 请求成功：不显示错误。
- 所有候选 Hub 均失败：`hubFailure` 非空 → 显示错误。
- 明确的 Hub 登录拒绝：显示 `nodes.hubLoginRejected`。

这个修改也自然处理了“没有 Hub 请求目标”的 reset 状态，因为此时没有足够信息判定 Hub 不可达。

如果产品希望首次加载期间显示专门的加载提示，可以进一步把 `hub.loading` 从 [`local-uplink-tabs.tsx:90`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.tsx:90 ) 传给 `HubUplinkNotices`，但这不是修复闪烁所必需的。

不建议直接把：

```ts
online: hubNodes !== null
```

改成：

```ts
online: hubNodes !== null || loading
```

因为 `online` 的语义是“最近一次 Hub list 成功”，而不是“请求正在进行”。这会把加载中误报为在线，并影响节点管理按钮的可写权限。

也不建议直接复用 Sidebar 的 `node.online` 作为 Hub 管理 API 健康状态，因为两者检查的是不同接口和不同连接层。

---

## 5. 现有测试和建议扩展位置

当前没有发现直接使用 React DOM 渲染 `useHubNode` 的专门 Hook 测试；相关逻辑被拆成了 coordinator、纯函数和消费者测试。

### 直接覆盖 Hook 内部逻辑的测试

[`apps/fe/src/node/mesh-nodes.test.ts:843`]( /Users/konata/code/tmex-r25/apps/fe/src/node/mesh-nodes.test.ts:843 )

覆盖：

- Hub writer 优先级
- 在线备用 Hub 候选
- 首次 401 → 登录 → 同一 Hub 重试
- writer 登录失败后切换其他 Hub
- 鉴权错误优先级
- 非 401 错误直接切换候选

例如已有测试验证：

```text
list:b → login:b → list:b
```

[`apps/fe/src/node/hub-load-coordinator.test.ts:1`]( /Users/konata/code/tmex-r25/apps/fe/src/node/hub-load-coordinator.test.ts:1 )

文件明确说明：

```text
useHubNode 的加载时序测试；不依赖 DOM，时序逻辑集中在 coordinator。
```

覆盖：

- loading 开始和结束
- 成功写入 rows
- 失败写入 failure 并清空 rows
- stale response 不覆盖新请求
- 切换 Hub 时清理旧 failure
- reset 后忽略旧响应
- auth/unreachable 分类

### UI 消费者测试

[`apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.test.tsx:46`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/hub-uplink-panel.test.tsx:46 )

当前测试 `hubFailureNotice`：

- auth failure → `nodes.hubLoginRejected`
- null/unreachable → `nodes.hubOffline`

应在这里增加首次加载场景，测试：

```text
hubOnline = false
hubFailure = null
```

不应渲染 `nodes.hubOffline`。

如果 `HubUplinkNotices` 仍保持私有，可以将其导出供测试使用，或者通过 `HubUplinkPanel` 测试其公开行为。

其他间接覆盖点：

- [`apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.test.tsx:206`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.test.tsx:206 )
- [`apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx:124`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx:124 )
- [`apps/fe/src/pages/settings/use-node-rename-channel.test.tsx:54`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/use-node-rename-channel.test.tsx:54 )
- [`apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx:146`]( /Users/konata/code/tmex-r25/apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx:146 )

这些测试覆盖 `useLocalUplinkController`、节点管理操作或页面集成，但目前没有验证“首次 Hub 请求期间不显示错误 Banner”。

### 最应新增的回归测试

优先在 `hub-uplink-panel.test.tsx` 增加：

1. 初始状态：不显示 Hub offline。
2. 401 后静默登录重试成功：不显示 Hub offline。
3. 所有 Hub 候选失败：显示 Hub offline。
4. 登录被拒绝：显示 Hub login rejected。
5. standby fallback：仍显示 `standbyNotice`，并且优先级高于 offline。

最终根因可以概括为：`useHubNode` 的 tri-state 状态被 `online: hubNodes !== null` 压缩成了 boolean，而 UI 又把 `online=false` 直接解释为“Hub 不可达”。