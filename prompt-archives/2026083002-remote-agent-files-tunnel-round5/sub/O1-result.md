# O1 结果 — 远端节点 agent 会话（前端）

## 做了什么

### 1. 会话状态统一由 entry（self）网关提供

- 新增 `packages/stores/src/agent-host-store.ts`：`setAgentHostStore(resolver)` / `resolveAgentStore(fallback)`（模式同既有的 `setSiteFallbackReader`）。包内组件只拿得到自己所在的路由 runtime，宿主注册一次解析器即可让所有 node 的界面读同一份 store；未注册（standalone / 单元测试）时回落到调用方自己的 store，单 node 行为完全不变。
- 新增 `apps/fe/src/node/self-agent-store.ts`：`selfAgentStore()` = `appNodeRuntimes.get(SELF_NODE_ID).runtime.stores.agent`（self runtime 由 `AppRoot` 长期持有，`get()` 不改引用计数），并在模块加载时注册解析器。
- `app-sidebar.tsx` 显式把 `agentStore={selfAgentStore()}` 传给 `AgentTab`；设备树侧的 `useSidebarAgentSessionsController` 直接用 `selfAgentStore()`。设备/快照/pane 数据仍来自路由 node 的 runtime。

### 2. nodeId 贯穿 store → API

- `AgentSessionDto.nodeId` 已由指挥官落地；本轮补齐前端：
  - `DraftSession.nodeId`、`CreateSessionOptions.nodeId`。
  - `startDraft` 从 4 个位置参数改为 `StartDraftInput { nodeId, deviceId, paneId, paneTitle, prompt? }`（5 个参数的位置签名会更难读）。
  - `createSessionRequest` 在 nodeId 非空时把它写进 POST body（self 省略该字段）。
  - `packages/api-client/src/agent.ts` 的 `CreateAgentSessionRequest` 补上 `nodeId?: string | null`（该类型不在「FIXED」清单内，`fetchAgentSessions` 未改）。
- 新增纯函数 `normalizeAgentNodeId`（`self` / 空值 → `null`）与 `isSessionOnNode`，从 `@tmex/stores` 导出。
- **会话列表仍是全局一份**：`loadSessions()` 不带 nodeId 过滤，切 node 路由不重新拉取；Agent 标签与侧栏各自在选择器里按 nodeId 过滤。

### 3. 路由匹配带 `/n/:nodeId` 前缀

- `use-agent-tab-state.ts` 导出 `AGENT_PANE_ROUTE_PATH`，`useRoutePane` 改用 `useMatch(hostAppPath(host, AGENT_PANE_ROUTE_PATH))`。
- `use-agent-tab-actions.ts` 的 `navigateToBinding` 改用 `hostAppPath(host, …)` + `encodePaneIdForUrl`（原来是裸路径 + `encodeURIComponent`）。

### 4. 离线态

- 新增 `packages/panels/src/agent/agent-node-offline.ts`：`NODE_OFFLINE_ERROR` 常量与 `isNodePaused(nodeOffline, lastError)`——**mesh 状态是权威信号**（node 回到在线立刻恢复输入，会话本身仍停在 error 直到用户重发）；宿主拿不到 mesh 状态时才用会话上的 `NODE_OFFLINE` 兜底。
- `AgentTab` 新增可选 prop `nodeOffline`；派生态多出 `showNodeOffline`，`inputDisabled` 含它；离线期间 `errorText` 不再原样回显 `NODE_OFFLINE`（横幅已经解释了）。
- `AgentStatusBanners` 增加 `data-testid="agent-node-offline-banner"` 横幅，文案 `agent.node.offlinePaused`。
- 侧栏：`isNodeOffline(nodes, entryNodeId, runtimeNodeId)` + `isSessionPaused(session, nodeOffline)`；`PaneSessionRow` / `OrphanSessionRow` 新增 `paused` → `text-muted-foreground/60`（与离线设备行同款）且 `disabled`，点不进错误页。

### 5. `isSessionAttached` 按会话所在 node 判定

控制器现在先按 nodeId 过滤会话再交给 `isSessionAttached`，而分节本身挂在该 node 的 runtime 下（快照/设备列表都是该 node 的），因此比对的一定是会话自己那个 node 的快照，不会拿当前路由 node 的快照去判别人。已在函数注释里写明。

### 6. 文案

- `agent.session.selectPaneHint`：`选择一个会话` / `Select a session` / `セッションを選択`（key 名保留）。
- 新增 `agent.node.offlinePaused`：`节点离线，会话已暂停` / `Node offline. Session paused.` / `ノードがオフラインです。セッションを一時停止しました。`
- `AgentBindingStatus` 里「新建会话」禁用态的 tooltip 原本复用 `selectPaneHint`，文案变短后语义不对，改用既有的 `agent.session.createDisabledNoPane`。
- 已跑 `bun run build:i18n` 重新生成 `resources.ts` / `types.ts`。

## 改动文件

新增：
- `packages/stores/src/agent-host-store.ts`
- `packages/stores/src/agent-session-node.test.ts`
- `packages/panels/src/agent/agent-node-offline.ts`
- `packages/panels/src/agent/agent-node-offline.test.ts`
- `apps/fe/src/node/self-agent-store.ts`

修改：
- `packages/stores/src/`：`agent-state.ts`、`agent-session-map.ts`、`agent-session-crud-actions.ts`、`agent-session-draft-actions.ts`、`agent.ts`、`index.ts`，测试 `agent-session-actions.test.ts`、`agent-session-crud-actions.test.ts`、`agent-event-router.test.ts`
- `packages/api-client/src/agent.ts`
- `packages/panels/src/agent/`：`use-agent-tab-state.ts`、`use-agent-tab-actions.ts`、`use-agent-tab-model.ts`、`agent-tab-view.ts`、`agent-tab.tsx`、`agent-status-banners.tsx`、`agent-binding-status.tsx`、`index.ts`、`agent-tab-view.test.ts`
- `packages/panels/src/device-console/use-terminal-shortcut-actions.ts`、`packages/panels/src/files/rsync-install-flow.ts`（见下「越界说明」）
- `apps/fe/src/components/page-layouts/components/`：`app-sidebar.tsx`（仅 agent tab 那几行）、`sidebar-agent-sessions.tsx`、`use-sidebar-agent-sessions.ts`（+ 测试）、`agent-session-row.tsx`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的 `agent` 子对象（+ 生成产物）

## 越界说明（请复核）

1. **`packages/panels/src/device-console/use-terminal-shortcut-actions.ts` 与 `packages/panels/src/files/rsync-install-flow.ts`**（各 1 处调用）：它们也 `startDraft`，签名改了必然要动；更重要的是如果继续用路由 runtime 的 agent store，在 `/n/:id` 路由下起的草稿会落进远端 store，而 Agent 标签已经只读 self store —— 用户点「新建 Agent 会话」/ rsync 安装流程会什么都看不到。已改为 `resolveAgentStore(runtime.stores.agent)` + 带上 `normalizeAgentNodeId(runtime.nodeId)`。这两个文件不在任何 agent 的 scope 列表里。
2. **`apps/fe/src/components/page-layouts/components/agent-session-row.tsx`**：离线灰显必须落在行组件上，不在我的 scope 列表但属于侧栏 agent 行、无人认领。
3. **`packages/api-client/src/agent.ts`**：只给 `CreateAgentSessionRequest` 加了一个可选 `nodeId` 字段，未动 `fetchAgentSessions`。

## 已知遗留 / 风险

1. **`usePaneAgentState`（`packages/stores/src/react.tsx` + `use-pane-agent-state.ts`）仍读路由 runtime 的 store**，供 `packages/terminal-ui` 的分屏 pane 徽标使用。在 `/n/:id` 路由下该徽标（Agent 已绑定 / 输出中）现在不会亮。两个文件都不在我的 scope（也不匹配 `agent*.ts`），改法很简单：`resolveAgentStore(useRuntime().stores.agent)` 并按 nodeId 过滤。**建议交给一次收尾提交处理。**
2. **单一 `activeSessionId` 的取舍**：store 只保留一个活动会话。切到别的 node 的路由时，本 node 的会话会被过滤掉；若新路由有 pane，自动起草会把 `activeSessionId` 清成 null（回到原 node 需要在侧栏重新点一次会话）。这与「路由 X 上只展示 nodeId === X 的会话」一致，也避免了引入 per-node 的 activeSessionId/draft（那会牵动 event-router、history-sync 与 persist）。
3. **离线灰显的可达性有限**：`SidebarNodeSection` 对离线 node 走的是 `SidebarNodeOffline` 分支（根本不渲染设备树 / agent 装饰），所以「远端离线 node 的会话行灰显」实际只在 mesh 状态与分节退场动画之间的窗口、以及 `lastError === 'NODE_OFFLINE'` 的会话上生效。Agent 标签的离线横幅不受此限制（`/n/<offline>/…` 路由可直接进入）。
4. **`isRouteNodeOffline`（app-sidebar，O2a 写的）与我的 `isNodeOffline`（use-sidebar-agent-sessions）逻辑重复**。不能互相 import（`app-sidebar → sidebar-device-list → sidebar-agent-sessions → use-sidebar-agent-sessions` 会成环），建议收尾时把它挪进 `apps/fe/src/node/` 合成一个。
5. `useMatch` 的 pane 参数：react-router 7 是先 `decodePath(pathname)` 再匹配，所以 `routePaneId` 拿到的是解码后的真实 pane id（测试里已按同一形状断言）。本轮没有改动这里的编解码语义。

## 验证

| 包 | 测试 | tsc（基线） |
|---|---|---|
| packages/stores | 293 pass / 0 fail | 1 error（`host-services.test.ts`，基线即 1） |
| packages/panels | 562 pass / 0 fail | 0 |
| apps/fe (`bun test src/`) | 760 pass / **2 fail** | 0 |
| packages/api-client | 132 pass / 0 fail | 5 error（基线 5） |
| packages/shared | 365 pass / 0 fail | 0 |

- apps/fe 的 2 个 fail 全在 `src/node/mesh-events.test.ts`（`NODE_EVENT` 的 `transport` 期望 `null` 实得 `undefined`），属 G2/O3 的 mesh 契约改动，与本任务无关。
- biome：上述全部改动文件 `bunx biome check` 通过（跑过一次 `--write` 只做格式化，未触碰任何生成文件）。
