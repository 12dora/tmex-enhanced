# O8 结果 — 远端 agent 会话 / node 离线态（前端）审查修复

`review-fe-1-report.md` 的 5 项全部修完，无遗留 TODO。

## 1. mesh 状态常驻更新（should-fix 1）

- 新增 `apps/fe/src/node/mesh-nodes-resident.tsx`：`<MeshNodesResident />` 只做一件事——
  `useSharedAuthMode()` 判定 mesh 模式后 `useMeshNodes({ enabled: meshEnabled })`，拿住
  `/api/mesh/nodes` 的拉取 + 轮询 + `/mesh/ws` NODE_EVENT 订阅，standalone 下一个请求都不发。
- 挂载点：`apps/fe/src/main.tsx` 的 `RootLayout`（`<FlowBridges />` 之后）。RootLayout 是跨 node
  常驻的外壳，既不随侧边栏标签切换卸载，也不随路由 node 换 runtime 重挂；`/login` 在 RootLayout
  之外，所以未登录页面仍然不会发 mesh 请求。**这是 O8 唯一改动 `main.tsx` 的地方**（scope 允许，
  按要求列出）。
- 消费方（`app-sidebar`、`use-sidebar-agent-sessions`）仍是 `useMeshNodes({ enabled: false })`
  的只读快照，注释同步更新为「拉取与订阅归 MeshNodesResident」。

## 2 + 3. 离线判定改三态，侧栏复用 `isNodePaused`（should-fix 2、3）

- `apps/fe/src/node/node-offline.ts`：`isNodeOffline(snapshot, nodeId)` 改成
  `boolean | undefined`，入参换成 `{ nodes, entryNodeId, loaded }`：
  - `loaded` 为假（standalone、mesh 列表还没成功回来）→ `undefined`（状态未知，什么都不灰）；
  - 已加载但名单里没有这一行 → `true`（已撤销 / 已移除 / 路由 id 根本不是成员）；
  - 有行 → `!online`；`self` 仍查 entry 自身那条，entry id 未知时也返回 `undefined`。
  同文件新增 `useNodeOffline(nodeId)` hook（`loaded = mode?.mode === 'mesh' && loadedAt !== null`），
  `app-sidebar.tsx` 与 `use-sidebar-agent-sessions.ts` 里两份重复的私有 hook 删掉改调它。
- `isNodePaused` / `NODE_OFFLINE_ERROR` 从 `packages/panels/src/agent/agent-node-offline.ts`
  **移到 `packages/stores/src/agent-node-offline.ts`** 并从 `@tmex/stores` 导出。原因：侧栏必须复用
  同一份三态语义，而侧栏链路（`app-sidebar → sidebar-device-list → sidebar-agent-sessions`）是
  eager 的，直接 import `@tmex/panels/agent` 会把整个 agent 子系统拉回首屏 chunk（AgentTab 是
  `React.lazy` 的，不能破坏这个切分）。panels 侧删除该文件，`agent-tab-view.ts` 改从 `@tmex/stores`
  引入；原测试文件里的路由 pattern 用例迁到新文件 `agent-pane-route.test.ts`，`isNodePaused` 用例
  迁到 `packages/stores/src/agent-node-offline.test.ts`。
- `use-sidebar-agent-sessions.ts`：`isSessionPaused(session, nodeOffline)` 改为
  `isNodePaused(nodeOffline, session.lastError)`，`nodeOffline` 类型放宽成 `boolean | undefined`，
  本地那份重复的 `NODE_OFFLINE_ERROR` 常量删除。于是 node 回到在线后，残留
  `lastError === 'NODE_OFFLINE'` 的会话行重新可点；mesh 状态未知时才继续按会话错误兜底。
- Agent tab 的 `nodeOffline` 保持 `boolean | undefined`（`AgentTabHost.nodeOffline` 未改），
  `FilesTab` 的 `nodeOffline?: boolean` 是可选 prop，传 `undefined` 语义不变。

## 4. 活动会话与草稿按 node 分片（should-fix 4）

store 形状（`packages/stores/src/agent-state.ts`）：

- `activeSessionId: string | null` → `activeSessionIdByNode: Record<string, string | null>`
- `draft: DraftSession | null` → `draftByNode: Record<string, DraftSession | null>`
- `materializingDraft: boolean` → `materializingDraftByNode: Record<string, boolean>`
  （同属「当前草稿」的派生态，留成全局会让 A 的草稿物化把 B 的输入框一起禁用）

新增 `packages/stores/src/agent-node-state.ts`（从 `@tmex/stores` 导出）：
`agentNodeKey`（`null`/`''`/`self` → `self`）、`activeSessionIdOnNode`、`draftOnNode`、
`isDraftMaterializingOnNode`、`activeSessionIds`。`activeSessionIdOnNode` 除查分片外还会校验
会话确实绑在该 node 上（持久化恢复 / 被别端删除的残留一律视为未选中）。

动作签名（草稿动作必须知道自己属于哪个 node）：

- `setActiveSession(sessionId, nodeId?)`：node 优先取会话自身的 `nodeId`，只清**本 node** 的草稿，
  只退订**本 node** 上一个会话；别的 node 的选择、草稿、订阅一律不动。
- `startDraft(input)`：只清空 `input.nodeId` 分片的选中态与订阅（此前会把全局 `activeSessionId`
  清成 null 并退订别的 node 的会话——正是审查复现的第 3、5 步）。
- `updateDraft(nodeId, patch)` / `clearDraft(nodeId)` / `materializeDraft(nodeId)`。
- 内部新增 `clearActiveSession`（删除会话时清掉所有指向它的分片并退订）与
  `pruneMissingActiveSessions`（`loadSessions` 后清掉指向已消失会话的分片），替代原来那两处
  `setActiveSession(null)`。

组合根 `agent.ts`：`ensureInitialized` 与 WS `READY` 重连改为遍历 `activeSessionIds(state)`
逐个补订阅 / 补史（不再只认单个 activeSessionId）。

持久化：`partialize` 改存 `activeSessionIdByNode`，新增 `version: 1` 与
`migrate`（`packages/stores/src/agent-persist.ts`）——v0 的单值 `activeSessionId` 一定来自单 node
时期，整体迁到 `self` 分片，老用户刷新后的选中恢复不受影响。

消费侧：

- `use-agent-tab-state.ts` 删掉本地那份 `activeSessionIdOnNode`，三个切片（active / draft /
  materializing）改用 stores 的选择器。
- `use-agent-tab-actions.ts`：`updateDraft(nodeId, …)`、`materializeDraft(nodeId)`。
- `agent-composer.tsx` 的 `ChatInput` 原本用 `useAgentStore((s) => s.draft?.prompt)` 直读**路由
  runtime** 的 store（多 node 下读的是空 store，而且现在没有全局 draft 了）：改成由 `AgentTab`
  从 `model.draft?.prompt` 逐层传 prop，rsync 安装流程的预填 prompt 链路不变。
- `use-sidebar-agent-sessions.ts` 的高亮 `activeSessionId` 改成 `activeSessionIdOnNode(state, nodeId)`
  （此前读全局值，会把别的 node 的会话高亮在本分节上）。

复现路径「A 选中会话 → 导航到 B 的 pane → 回 A」现在：A 仍选中、A 的订阅没断、B 只多一个自己的
草稿，均由新测试覆盖。

## 5. 文案（nit）

`nodes.badge.icePlaceholder` 三语改为：zh「暂无直连详情。」/ en `Direct connection details unavailable.`
/ ja「直接接続の詳細はありません。」，并跑 `bun run build:i18n` 重新生成 `resources.ts` / `types.ts`
（未手改生成文件）。

## 改动文件

新增：
- `apps/fe/src/node/mesh-nodes-resident.tsx`
- `packages/stores/src/agent-node-state.ts`、`agent-node-offline.ts`、`agent-persist.ts`
- 测试：`packages/stores/src/agent-node-state.test.ts`（13 例）、`agent-node-offline.test.ts`（3 例）、
  `packages/panels/src/agent/agent-pane-route.test.ts`（路由 pattern 用例迁入）

修改：
- `apps/fe/src/main.tsx`（挂载 `MeshNodesResident`，1 import + 1 行）
- `apps/fe/src/node/node-offline.ts` + `node-offline.test.ts`
- `apps/fe/src/components/page-layouts/components/`：`app-sidebar.tsx`、`use-sidebar-agent-sessions.ts`
  （+ 测试）
- `packages/panels/src/agent/`：`use-agent-tab-state.ts`、`use-agent-tab-actions.ts`、`agent-tab-view.ts`、
  `agent-composer.tsx`、`agent-tab.tsx`
- `packages/stores/src/`：`agent-state.ts`、`agent-session-crud-actions.ts`、`agent-session-draft-actions.ts`、
  `agent.ts`、`index.ts`，测试 `agent-session-actions.test.ts`、`agent-session-crud-actions.test.ts`、
  `agent-session-node.test.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `nodes.badge.icePlaceholder` 一条）
  + 生成产物 `resources.ts` / `types.ts`

删除：`packages/panels/src/agent/agent-node-offline.ts` 及其测试（内容分别迁到 stores 与
`agent-pane-route.test.ts`）。

## 验证

| 包 | 测试 | tsc | 基线 |
|---|---|---|---|
| packages/stores | 317 pass / 0 fail | 1 error（`host-services.test.ts`，既有） | 282 / 1 |
| packages/panels | 566 pass / 0 fail | 0 | 507 / 0 |
| apps/fe (`bun test src/`) | 786 pass / 0 fail | 0 | 671 / 0 |
| packages/shared | 365 pass / 0 fail | 0 | 365 / 0 |
| packages/terminal-ui | 315 pass / 0 fail | 0 | — |

`bunx biome check` 覆盖全部 26 个改动/新增文件：只剩 `apps/fe/src/main.tsx` 里
`StatusBarSync` 的 `useExhaustiveDependencies` 一条——该文件在 HEAD 版本上跑同样报这一条，
属既有告警，未动那段代码。未跑 apps/gateway（后端 agent 仍在改）与 e2e。

## 遗留 / 风险

1. **`MeshDeviceList`（`sidebar-device-list.tsx`）仍自己 `useMeshNodes()`**，`DevicesPage` 与设置页
   同理，于是常驻所有者之外还有 1~2 个所有者：`refreshMeshNodes` 对在途请求去重，多出来的只是
   一条 30s 轮询定时器和一次幂等的事件投影（这在本轮之前就是既有形态）。要收敛成单一所有者只需
   把这几处改成 `{ enabled: false }`，但这些文件不在本任务 scope、且有并行 agent 在改，未动。
2. **常驻组件与 `useNodeOffline` 没有单元测试**：`apps/fe` 没有 DOM 测试环境（现有测试都走
   `react-dom/server` 静态渲染，effect 不执行），无法断言订阅生命周期。纯函数部分
   （`isNodeOffline` 6 例、`isNodePaused` 3 例）已覆盖。
3. **刷新后的自动起草竞态（既有，本轮未改变）**：带 pane 路由刷新时，若 `loadSessions` 还没回来，
   `useAutoDraft` 会为该 node 起草并清掉刚从 localStorage 恢复的选中态。改前是全局单值、改后是
   `self` 分片，行为一致；要根治需要在 `useAutoDraft` 里加「`sessionsLoaded` 前不起草」的判据，
   超出本次修复清单，未做。
4. `setActiveSession` 的第二参 `nodeId` 只在「会话还没进本地表」时才用得上，当前调用方都能从会话
   自身拿到 node，因此保持可选。
