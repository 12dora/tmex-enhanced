## 审查结论

需要修改后再合入。未发现新的鉴权绕过、路径注入或密钥泄漏，但存在 4 个实际状态错误，其中 3 个会直接破坏远端节点 Agent 的离线与切换体验。以下行号按 diff 新文件侧计算。

### 1. should-fix — 切到 Agent/文件标签后，离线状态停止更新

`apps/fe/src/components/page-layouts/components/app-sidebar.tsx:39-45,108-123`

`useRouteNodeOffline()` 使用 `useMeshNodes({ enabled: false })`，并假设 `SideBarDeviceList` 负责拉取和订阅；但选择 Agent 或文件标签时，`SideBarDeviceList` 会被条件卸载。常见的远端终端 `DevicePage` 也没有其他 `useMeshNodes()` 所有者，因此后续 NODE_EVENT 无人投影，缓存会一直保持“在线”。

这还会压过后端的可靠信号：Agent 收到 `lastError=NODE_OFFLINE` 后，`isNodePaused(false, 'NODE_OFFLINE')` 仍返回 false，因为传入的陈旧 `false` 被视为权威状态。结果是输入框继续可用、离线横幅不出现；文件树也继续展示陈旧内容。

最小修复：在不会随侧栏标签卸载的宿主层常驻一个 mesh 列表/事件订阅所有者，并仅在 mesh 模式启用。Agent/文件组件继续只读该共享快照。

### 2. should-fix — 节点恢复后，离线会话仍永久无法从侧栏打开

`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:120-123`

```ts
return nodeOffline || session.lastError === NODE_OFFLINE_ERROR;
```

后端在节点掉线时会把运行中的会话持久化为 `error + NODE_OFFLINE`，上线事件不会清除此字段。Agent 主面板已经明确采用“mesh 在线态优先”的语义：`isNodePaused(false, 'NODE_OFFLINE') === false`；但侧栏仍根据残留错误禁用会话按钮。用户上线后无法从侧栏重新进入该会话并重试。

最小修复：侧栏复用 `isNodePaused()` 的三态语义；明确在线时不看残留错误，只有 mesh 状态未知时才以 `NODE_OFFLINE` 兜底。

### 3. should-fix — 已加载列表中的缺失节点被误判为在线

`apps/fe/src/components/page-layouts/components/app-sidebar.tsx:28-36`  
`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:107-118`

两个离线判定都对“找不到节点行”返回 false。这只适用于 standalone 或首次列表尚未返回；列表加载完成后，缺失通常意味着节点已撤销、移除，或路由 ID 根本不是成员。

撤销事件会主动从 `nodes` 删除该行，因此当前代码会把刚撤销的节点从“离线”重新判成“在线”，启用 Agent 输入并挂载文件树，随后所有操作才以请求错误失败。

最小修复：把 `mode`/`loadedAt` 纳入判定：

- standalone 或初次加载前：`undefined`；
- 已加载且远端行缺失：不可用/离线；
- 行存在：使用 `online`。

同时让 Agent 的 `nodeOffline` 保留 `boolean | undefined`，不要提前压成 false。

### 4. should-fix — 切换节点会静默清除另一节点的活动会话和草稿

`packages/panels/src/agent/use-agent-tab-state.ts:97-115,171-189`  
`packages/stores/src/agent-session-draft-actions.ts:46-55`

会话列表已改成跨节点共享，但 `activeSessionId` 和 `draft` 仍是全局单值。复现路径：

1. 节点 A 已选中一个会话；
2. Agent 标签保持打开并导航到节点 B 的 pane；
3. `activeSessionIdOnNode()` 把 A 的活动会话过滤成 null；
4. `useAutoDraft()` 为 B 调用 `startDraft()`；
5. `startDraft()` 取消 A 的事件订阅，并把全局 `activeSessionId` 清空。

返回 A 后原会话不再选中，系统还会再创建 A 的新草稿；未发送的跨节点草稿也会互相覆盖。这不是单纯显示过滤，而是路由切换引发的破坏性状态转换。

最小修复：按规范化 nodeId 保存活动会话和草稿，例如 `activeSessionIdByNode`、`draftByNode`；切路由只切当前视图和订阅，不覆盖其他节点的选择或草稿。

### 5. nit — 诊断浮层文案与实际内容矛盾

`apps/fe/src/node/device-node-badges.tsx:194-196`

无 ICE 数据时，浮层已经展示“到达路径”和“承载”，随后英文却写着：

> Direct connections are off, so there is nothing to show.

这与屏幕上已有的两行信息直接矛盾，日文含义相同。建议改成“Direct connection details unavailable.”；中文可用“暂无直连详情。”。

## 验证

定向测试全部通过：FE 79、Panels 17、Stores 51、i18n 2；`apps/fe` 与 `packages/panels` 的 `tsc --noEmit` 也通过。这些测试主要覆盖纯函数矩阵，没有覆盖 mesh 订阅卸载和跨节点路由生命周期，因此未能发现上述问题。

## 最重要的 3 项

1. Agent/文件标签挂载时没有常驻 mesh 状态更新。
2. 节点恢复后，`NODE_OFFLINE` 会话仍被侧栏永久禁用。
3. 全局单值 `activeSessionId`/draft 导致切节点清除其他节点状态。