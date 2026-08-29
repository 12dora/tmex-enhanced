# 代码 MAP 报告

说明：当前会话文件系统为只读，且未提供具体输出文件路径，因此无法将报告写入文件。以下为完整报告正文。本轮未修改源码。

行号基于当前工作树。

## 1. 左侧终端侧栏

### 1.1 组件树

```text
/n/:nodeId
└─ NodeShell
   └─ NodeRuntimeBoundary
      └─ RootLayout
         └─ SidebarProvider
            └─ AppSidebar
               ├─ SidebarTitle
               └─ SidebarContent
                  └─ SideBarDeviceList
                     └─ MeshDeviceList
                        └─ SortableVerticalList
                           └─ SortableNodeSection
                              └─ SidebarNodeSection
                                 └─ NodeRuntimeScope
                                    └─ SideBarDeviceListForRuntime
```

关键文件：

- [app-sidebar.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/app-sidebar.tsx:26)
- [sidebar-device-list.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx:27)
- [sidebar-node-section.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx:180)
- [device-tree-dnd.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-tree/device-tree-dnd.tsx:52)

### 1.2 self 节点当前并未被固定

`toSidebarEntries()` 将 self 节点映射为普通可排序项：

```tsx
const isSelf = node.id === entryNodeId;

return {
  id: node.id,
  runtimeNodeId: isSelf ? SELF_NODE_ID : node.id,
  isSelf,
  ...
};
```

位置：`sidebar-device-list.tsx`，行 52–72。

随后所有节点都进入 `sortableIds`：

```tsx
const sortableIds = useMemo(
  () => entries.map((entry) => sidebarNodeSortableId(entry.id)),
  [entries]
);
```

位置：`sidebar-device-list.tsx`，行 85–103。

排序结束时保存的是 mesh node ID：

```tsx
setSidebarNodeOrder(nextIds.map(sidebarNodeIdFromSortableId))
```

位置：`sidebar-device-list.tsx`，行 97–101。

`SortableNodeSection` 也没有排除 self：

```tsx
const sortable = useSortableRow(sidebarNodeSortableId(node.id));
```

位置：`sidebar-device-list.tsx`，行 74–83。

现有测试明确验证了 self 可以被移动到其他位置：

```tsx
it('手工顺序用的是 mesh node id，self 也能被拖到别的位置', () => {
  const nodes = [
    makeNode('a', 'self', true),
    makeNode('b', 'remote'),
  ];
  ...
  expect(result.map((entry) => entry.id)).toEqual(['b', 'a']);
});
```

位置：`sidebar-device-list.test.tsx`，行 117–131。

因此，当前代码没有发现“self 被显式 pinned”或“self 被从 sortable items 排除”的逻辑。

### 1.3 最可能的排序问题

`sidebarNodeOrder` 为空时，代码直接使用 API 返回顺序：

```tsx
if (order.length === 0) return entries;
```

位置：`sidebar-device-list.tsx`，行 27–49。

mesh 节点排序函数确实把 self 放在第一位：

```tsx
if (a.id === entryNodeId) return -1;
if (b.id === entryNodeId) return 1;
```

位置：`mesh-nodes.ts`，行 66–75。

但刷新节点列表时没有调用 `sortNodes()`：

```tsx
const nodes = await api.listNodes();
setState({ nodes, loadedAt: Date.now(), loading: false });
```

位置：`mesh-nodes.ts`，行 255–270。

这会导致：

1. 初次加载或 `sidebarNodeOrder` 为空时，self 可能始终显示在 API 返回的第一位。
2. `mergeNodes()` 路径会排序，但 `refreshMeshNodes()` 路径可能保留后端顺序。
3. 用户拖拽如果没有产生有效 `over`，不会持久化新顺序。

排序容器使用：

```tsx
const nextIds = reorderIdsByDragEnd(ids, event);
if (nextIds) onReorder(nextIds);
```

位置：`device-tree-dnd.tsx`，行 52–74。

而 `reorderIdsByDragEnd()` 在以下情况直接返回 `null`：

- 没有 `event.over`
- 拖回原位置
- active/over ID 不存在
- active 和 over 不在同一有效列表中

所以当前根因优先级为：

1. `refreshMeshNodes()` 没有统一排序，导致 self 看起来像固定在顶部。
2. 拖拽范围离开侧栏列表时没有有效 `over`，排序不提交。
3. 旧的 `sidebarNodeOrder` 中缺少某些节点 ID，缺失节点会被追加到 API 顺序末尾。

`ui.ts` 中保存顺序的注释也确认其语义是“mesh node id”：

```tsx
/** 侧边栏 node 分节的手工顺序（mesh node id）；未列出的 node 按 API 顺序排在后面 */
sidebarNodeOrder: string[];
```

位置：`packages/stores/src/ui.ts`，行 95–105。

该状态会被持久化，位置在 `ui.ts` 行 223–265。

### 1.4 切换节点导致侧栏重挂载的直接原因

直接原因是 `RuntimeProvider` 用 runtime 生成了 React key：

```tsx
<Fragment key={runtimeSubtreeKey(runtime)}>
  {children}
</Fragment>
```

位置：[react.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/stores/src/react.tsx:43)，行 43–55。

切换：

```text
/n/node-a/...
→ /n/node-b/...
```

会改变 `useNodeRuntime()` 得到的 runtime。`runtimeSubtreeKey(runtime)` 变化后，整个 Fragment 子树被 React 当成新树处理，包含：

- `RootLayout`
- `SidebarProvider`
- `AppSidebar`
- 侧栏中每个 `NodeRuntimeScope`
- 相关 QueryClient 和 provider

路由与布局链路位于：

- [main.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:198)，`NodeShell` 行 198–205
- `main.tsx`，`pageRoutes` 行 207–236
- `node-runtime-boundary.tsx`，行 22–47

`NodeRuntimeBoundary` 会同时切换 runtime、QueryClient 和登录状态 gate：

```tsx
<RuntimeProvider runtime={runtime}>
  <QueryClientProvider client={queryClient}>
    <GlobalDeviceProvider>
      <NodeRuntimeGate ... />
    </GlobalDeviceProvider>
  </QueryClientProvider>
</RuntimeProvider>
```

位置：`node-runtime-boundary.tsx`，行 28–47。

### 1.5 不是主要原因的地方

`AppSidebar` 中存在：

```tsx
<Reveal key={sidebarTab} ...>
```

位置：`app-sidebar.tsx`，行 69–85。

这个 key 只在 `panes`、`agent`、`files` 标签切换时变化，不会因为节点路由变化而变化。

`PageWrapper` 的 key 只用于动画页面：

```tsx
key={animateContent ? state.status : undefined}
```

位置：`page-wrapper.tsx`，行 59–71。

终端相关页面使用 `animateContent={false}`，因此不是节点切换时侧栏重挂载的主因。

当前也没有证据表明是 Suspense 直接造成侧栏重挂载。页面动态加载由 `use-page-module.ts` 管理，但它主要影响页面模块加载，不是侧栏本身的 key。

### 1.6 路由切换时发生的其他状态变化

切换节点时还会触发：

- `useRouteNodeId()` 重新读取路由参数。
- `useNodeRuntime()` 返回新的 runtime。
- `NodeRuntimeBoundary` 创建或取得新的 QueryClient。
- `useNodeLoginGate()` 重新判断远程节点是否需要登录。
- `GlobalDeviceProvider` 依赖 `location.pathname`，重新处理当前是否为设备/终端路由。
- 各节点 `NodeRuntimeScope` 重新创建对应 runtime 上下文。
- `useMeshNodes()` 可能重新拉取 `/api/mesh/nodes`。
- `GlobalDeviceProvider` 中的 `['devices']` 查询可能重新拉取设备。
- `SidebarTitle` 的站点设置和 `WsLatency` 相关状态可能重新初始化。

`GlobalDeviceProvider` 相关位置：

- `global-device-provider.tsx`，行 166–204
- `global-device-provider.tsx`，行 281–327

这些查询会造成列表短暂变空或内容更新，但“整个侧栏 remount”的根因仍是 `RuntimeProvider` 的 Fragment key。

---

## 2. Devices 管理页

### 2.1 组件树

```text
DevicesPage
└─ DevicesBody
   └─ DeviceFoldersView
      └─ DeviceFolderTree
         ├─ FolderSection
         ├─ NodeItem
         │  └─ NodeDeviceGroup
         │     └─ NodeDevicePanel
         │        └─ DeviceManagementPanel
         │           └─ DeviceCard
         └─ DragOverlay
```

关键文件：

- [DevicesPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/DevicesPage.tsx:51)
- [device-folders-view.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/device-folders-view.tsx:35)
- [node-device-group.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/devices/node-device-group.tsx:213)
- [device-folder-tree.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-folders/device-folder-tree.tsx:287)
- [device-management-panel.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-management-panel.tsx:177)
- [device-card.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-management/device-card.tsx:161)

### 2.2 DragOverlay 显示小条的原因

文件夹/节点树使用了 `DragOverlay`：

```tsx
<DragOverlay dropAnimation={null}>
  {activeNodeId ? (
    <DragPreview
      activeNodeId={activeNodeId}
      layout={layout}
      groupsById={groupsById}
    />
  ) : null}
</DragOverlay>
```

位置：`device-folder-tree.tsx`，行 471–473。

`DragPreview` 本身不是设备卡片，而是一个很窄的文本预览：

```tsx
<div className="flex max-w-xs items-center gap-2 rounded-lg border bg-popover px-2 py-1.5 text-sm shadow-lg scale-[1.02]">
  ...
</div>
```

位置：`device-folder-tree.tsx`，行 260–284。

因此当前表现是代码预期结果：

- `max-w-xs`
- 没有 `w-full` 或固定卡片宽度
- 只有文件夹图标/名称/数量，或节点 Server 图标/名称
- 没有复用 `DeviceCard`
- `dropAnimation={null}`
- 没有传入 `modifiers`
- 没有显式设置 overlay 偏移或 transform

该 DnDContext 的碰撞检测和定位交给 dnd-kit 默认机制。当前 overlay “远离指针”如果不是内容宽度造成的视觉错觉，需要进一步检查浏览器中的 transform、父级 CSS 和实际 active rect；源代码中没有额外的 overlay transform。

需要特别区分：设备卡片本身没有 `DragOverlay`。

`device-management-panel.tsx` 的设备卡片使用：

```tsx
const { attributes, listeners, setActivatorNodeRef, transform, transition } =
  useSortable({ id: device.id });
```

位置：`device-management-panel.tsx`，行 127–175。

所以：

- 拖文件夹/节点 handle：使用 `DeviceFolderTree` 的 `DragOverlay`，当前预览是小文本条。
- 拖设备卡片 handle：当前只有 sortable transform，没有 overlay 卡片克隆。

精确改动位置应优先是：

1. `device-folder-tree.tsx` 的 `DragPreview`。
2. 若设备卡片也需要 overlay，则是 `device-management-panel.tsx`，因为目前该处没有 `DragOverlay`。

### 2.3 设备卡片布局和名称截断

卡片第一行：

```tsx
<CardContent className="flex items-center gap-2">
  ...
  <div className="min-w-0 flex-1">
    ...
  </div>
  <DeviceCardConnectToggle ... />
  <Link ...>
    <ArrowUpRight />
  </Link>
  <DropdownMenu ... />
</CardContent>
```

位置：`device-card.tsx`，行 200–230。

连接按钮：

```tsx
<Button
  className="min-w-[5.5rem] shrink-0 justify-start"
  ...
>
```

位置：`device-card.tsx`，行 77–87。

名称区域虽然设置了 `min-w-0 flex-1`，但右侧固定占用包括：

- 连接/断开按钮最小宽度 `5.5rem`
- 箭头按钮
- 菜单按钮
- 各控件之间的 `gap-2`

所以可供设备名称使用的空间被固定控制项压缩，最终触发文本 truncate。

连接按钮使用 `justify-start`，因此按钮内部右侧会保留明显空白；这与用户看到的“toggle 右侧有大块空白”相符。

相关卡片根节点是 `Card`，本身为纵向 flex：

```tsx
<div className={cn("rounded-xl border bg-card text-card-foreground shadow-sm", className)}>
```

位置：`packages/ui/src/components/card.tsx`，行 14 附近。

准确改动点：

- `device-card.tsx`，第一行 `CardContent` 的宽度、gap 和右侧控件排列。
- `device-card.tsx`，设备名称包装器 `min-w-0 flex-1`。
- `device-card.tsx`，`DeviceCardConnectToggle` 的 `min-w-[5.5rem]` 与 `justify-start`。
- 如果节点名称指的是组标题，则检查 `node-device-group.tsx` 行 106–147 的 `GroupHeader`，以及 `NodeBadge` 的文本宽度处理。

### 2.4 点击右上角箭头的导航路径

箭头是普通 React Router `Link`：

```tsx
<Link
  to={hostAppPath(runtime.host, `/devices/${device.id}`)}
  data-testid="device-open"
  ...
>
  <ArrowUpRight />
</Link>
```

位置：`device-card.tsx`，行 216–229。

目标页面是：

```text
/devices/:deviceId
```

路由位于 `main.tsx`，行 218–226：

```tsx
{
  path: 'devices/:deviceId',
  element: <PageWrapper loader={deviceModule} animateContent={false} />,
}
```

目标页面 `DevicePage.tsx` 只渲染 `DeviceConsole`，没有设备列表。

因此在正常导航成功时，当前 `DevicesPage` 应被卸载，不应继续显示文件夹树。

### 2.5 当前并不存在 snapshot + live 设备合并

`device-snapshot-store.ts` 的职责是：

- 保存最近一次在线设备快照。
- 仅在离线场景读取快照。
- 提供 offline fallback。
- 不提供响应式 Zustand store。
- 不把 snapshot 与在线查询结果合并。

`NodeDevicePanel` 在设备加载后只写快照：

```tsx
onDevicesLoaded={(devices) => {
  writeDeviceSnapshot(runtimeNodeId, devices);
}}
```

位置：`node-device-group.tsx`，行 171–189。

`DeviceManagementPanel` 的在线设备来源是：

```tsx
const devices = data?.devices ?? (offline ? fallbackDevices : undefined);
```

位置：`device-management-panel.tsx`，行 230–233。

所以当前代码路径是：

```text
在线：React Query devices
离线：snapshot/fallback
```

不是：

```text
snapshot + live devices
```

### 2.6 当前文件夹视图也没有同时渲染两套设备列表

`DeviceFoldersView` 将 node group 按 `runtimeNodeId` 建索引：

```tsx
const groupsById = new Map(groups.map((group) => [group.runtimeNodeId, group]));
```

位置：`device-folders-view.tsx`，行 54–60。

每个 node 只渲染一次：

```tsx
return (
  <NodeDeviceGroup
    key={nodeId}
    group={group}
    ...
  />
);
```

位置：`device-folders-view.tsx`，行 62–76。

`toNodeDeviceGroups()` 也是每个 mesh node 生成一个 group：

```tsx
return nodes.map((node) => ({
  nodeId: node.id,
  runtimeNodeId: node.id === entryNodeId ? SELF_NODE_ID : node.id,
  ...
}));
```

位置：`node-device-group.tsx`，行 53–77。

因此当前源码没有直接证据表明文件夹视图会把 snapshot 设备和 live 设备各渲染一次。

### 2.7 重复卡片的可能根因

可以排除或降低优先级的原因：

- `device-snapshot-store.ts` 当前没有合并渲染逻辑。
- `DeviceFoldersView` 没有同时渲染 snapshot 和 live 两棵树。
- 卡片 key 是 `device.id`，但每个 `NodeDeviceGroup` 有独立 runtime/provider；跨节点相同 device ID 不会直接构成同一个兄弟列表中的 key 冲突。
- 同一个 `runtimeNodeId` 在 `groupsById` 中重复时更接近“后者覆盖前者”，而不是同时显示两份。

仍需要验证的假设：

1. 点击 `Link` 时路由没有真正变化，旧的 DevicesPage 仍然存在。
2. `hostAppPath()` 对远程 host 生成了错误路径，导致点击后仍落在设备列表。
3. 动态页面加载期间，`PageWrapper` 的旧页面状态与新页面状态发生短暂混合。
4. 外层已有重复的 `NodeRuntimeScope` 或重复的页面挂载点。
5. React Query mutation/路由切换时旧 subtree 未及时卸载，造成短暂视觉重叠。

“测试”文件夹更可能来自设备文件夹布局数据：

```text
useDeviceFolders()
→ layout.folders
→ DeviceFolderTree
→ FolderSection
```

而不是 snapshot store。`useDeviceFolders` 的布局是 self 节点的站点配置，`DeviceFoldersView` 会直接根据该布局渲染文件夹。

精确检查点：

- `device-card.tsx`：确认箭头点击时实际生成的 href。
- `main.tsx`：确认 `/devices/:deviceId` 是否命中。
- `page-wrapper.tsx` 与 `use-page-module.ts`：观察动态模块加载期间旧页面是否保留。
- `device-folders-view.tsx`：确认 groups 和 layout 是否被重复传入。
- `device-management-panel.tsx`：观察同一个 QueryClient 中是否出现重复 device ID。
- 浏览器 React DevTools：确认是否同时存在两个 `DevicesPage` 实例。

### 2.8 “移到最外层”当前实现

根级拖放 ID 在：

- `folder-tree-model.ts`，行 15–69
- root ID：`root`
- folder ID：`folder:*`
- node ID：`node:*`
- folder drop zone：`drop:*`
- folder body drop zone：`dropin:*`

当前根 drop area 只在拖动一个已经位于文件夹中的 node 时显示：

```tsx
const showRootDropArea =
  activeNodeId !== null &&
  findNodeFolderId(layout, activeNodeId) !== null;
```

位置：`device-folder-tree.tsx`，行 331–334。

渲染位置：

```tsx
{showRootDropArea ? (
  <FolderDropArea
    containerId={ROOT_CONTAINER_ID}
    label={t('device.moveToRoot')}
  />
) : null}
```

位置：`device-folder-tree.tsx`，行 462–469。

碰撞检测优先使用 pointerWithin：

```tsx
const pointerHits = pointerWithin(args);
return pointerHits.length > 0 ? pointerHits : closestCenter(args);
```

位置：`device-folder-tree.tsx`，行 147–167。

拖拽结束时如果没有 `event.over`，直接结束：

```tsx
if (!event.over) return;
const drop = resolveDrop(...);
if (drop) onDrop(drop);
```

位置：`device-folder-tree.tsx`，行 348–362。

因此“拖到所有虚线区域之外自动移动到 root”当前不成立：离开所有 droppable 后，`event.over` 为空，不会触发 root drop。

不过数据模型已经支持 root：

```tsx
materializeRootNodes(...)
applyDrop(...)
```

位置：`folder-tree-model.ts`，行 234–267。

所需变更位置是：

1. `device-folder-tree.tsx`：让 root 成为持续有效的 droppable，或在没有命中其他容器时将拖放解析为 root。
2. `device-folder-tree.tsx`：调整 collision detection 与 `handleDragEnd` 的 no-over 行为。
3. `folder-tree-model.ts`：确认 root drop 的 `DropIntent` 始终能被 `resolveDrop()` 和 `applyDrop()` 处理。
4. 不能简单把所有 `over === null` 都视为 root，否则拖到应用外部也会触发移动。

### 2.9 同级卡片是否已有动画

设备卡片列表已经使用 sortable 策略：

```tsx
<SortableContext
  items={deviceIds}
  strategy={rectSortingStrategy}
>
```

位置：`device-management-panel.tsx`，行 354–395。

每张卡片使用：

```tsx
style={{
  transform: CSS.Translate.toString(transform),
  transition,
}}
```

位置：`device-management-panel.tsx`，行 127–175。

因此同一设备列表内的 sibling cards 已经具备 dnd-kit transform/transition 动画。

文件夹树中的 node 也不是普通 `useDraggable`，而是：

```tsx
useSortable({ id: nodeElementId(nodeId) })
```

位置：`draggable-item.tsx`，行 27–43。

但每个 folder/container 都有自己的 `SortableContext`：

```tsx
<SortableContext
  items={container.nodeIds}
  strategy={verticalListSortingStrategy}
>
```

位置：`device-folder-tree.tsx`，行 219–232。

所以：

- 同一容器内：已有 sibling transform/transition。
- 跨容器移动：不会天然获得“目标容器 sibling 全局动画”。
- `FolderDropArea` 只是 `useDroppable`，本身不参与 sibling 排序。
- 根级 drop 是否产生邻居动画，取决于 root 是否被建模成有效 sortable container。

---

## 3. 设置页语言切换

### 3.1 当前表单行为

语言选择器位于：

[general-settings-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/general-settings-tab.tsx:55)

```tsx
<Select
  value={draft.language}
  onValueChange={(nextValue) => updateDraft({ language: nextValue })}
>
```

这里仅修改本地 draft，没有调用 `i18n.changeLanguage()`。

保存后的逻辑位于：

[use-site-settings-form.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/use-site-settings-form.ts:55)

```tsx
await api.updateSiteSettings(buildSiteSettingsPayload(draft));

if (
  controlsBrowserPrefs &&
  loadedSettings?.language !== draft.language
) {
  void i18n.changeLanguage(draft.language);
  setShowRefreshNotice(true);
}
```

位置：`use-site-settings-form.ts`，行 55–79。

因此当前行为是：

```text
选择语言
→ 只改 draft
→ 页面不变

点击保存
→ PATCH /api/settings/site
→ 成功后才 changeLanguage()
```

### 3.2 store 层行为

站点 store 在提交设置时也会同步全局 i18next：

```tsx
set({ settings });

if (settings.controlsBrowserPrefs) {
  void i18next.changeLanguage(settings.language);
}
```

位置：`packages/stores/src/site.ts`，行 116–126。

这里有一个重要约束：

```text
controlsBrowserPrefs === true
```

只有控制当前浏览器偏好的 self 节点才应该改变全局语言。远程节点的 site settings 不应切换浏览器全局语言。

该字段来源于：

- `runtime.ts`，`AppRuntimeOptions` 行 122–143
- `node-connection-manager.ts`，行 161–175

### 3.3 根因

根因是 General Settings 的 `Select.onValueChange` 只更新 draft：

```tsx
updateDraft({ language: nextValue })
```

没有实时调用 i18n。

因此当前代码没有“编辑即预览”的逻辑。保存后才调用 `changeLanguage`，并且还会触发：

- PATCH 请求
- settings query invalidate
- `refreshSettings()`
- 可能的语言资源异步加载
- `Reveal key={activeTab}` 或页面组件重新渲染

精确变更位置：

1. `general-settings-tab.tsx`：语言 select 的实时行为。
2. `use-site-settings-form.ts`：保存后语言同步和刷新提示策略。
3. `packages/stores/src/site.ts`：浏览器偏好控制规则，避免远程节点错误切换全局语言。

---

## 4. 节点设置与账号安全

### 4.1 路由关系

路由位于 [main.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:239)：

```tsx
{
  path: '/account/security',
  element: (
    <PageWrapper
      loader={accountSecurityModule}
      withSidebar={false}
    />
  ),
},
{
  path: '/nodes',
  element: <Navigate to="/settings?tab=nodes" replace />,
}
```

位置：`main.tsx`，行 239–258。

因此：

```text
/nodes
→ /settings?tab=nodes

/account/security
→ 独立页面，无侧栏
```

Settings 页面中的 tab：

- `SettingsPage.tsx`，`SettingsTab` 行 40–55
- Nodes tab item 行 111–115
- `NodesTab` 渲染行 154–169

### 4.2 “多节点互联”页面

[ nodes-tab.tsx ](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:17) 根据 auth mode 和 local status 分流：

- standalone：显示 `LocalMachineCard`
- mesh：显示 HTTPS 设置和 `NodesManagement`

位置：`nodes-tab.tsx`，行 17–97。

`LocalMachineCard` 在启用 mesh 时显示账号安全入口：

```tsx
<Link to="/account/security" data-testid="local-machine-account-security">
  {t('nodes.machine.accountSecurity')}
</Link>
```

位置：`local-machine-card.tsx`，行 389–399。

所以账号安全不是 Nodes tab 的子路由，而是独立的 `/account/security` 页面。

### 4.3 AccountSecurityPage 组件树

[AccountSecurityPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/AccountSecurityPage.tsx:43)

```text
AccountSecurityPage
└─ AccountSecurity
   ├─ PasswordSection
   ├─ TotpSection
   ├─ PasskeySection
   └─ CredentialPrompt
```

页面入口：

- `AccountSecurityPage`，行 43–60
- `AccountSecurity`，行 103–169

当前外层布局：

```tsx
<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-5">
```

位置：`AccountSecurityPage.tsx`，行 142–167。

### 4.4 TOTP 当前流程

`TotpSection` 位于 `AccountSecurityPage.tsx`，行 294–480。

状态包括：

```tsx
const [password, setPassword] = useState('');
const [code, setCode] = useState('');
const [draft, setDraft] = useState<TotpSetupDraft | null>(null);
```

位置：行 309–316。

开始设置 TOTP：

```tsx
const next = beginTotpSetup({
  uid,
  issuer: 'tmex',
});
```

位置：行 326–331。

`beginTotpSetup()` 是本地生成 secret 和 otpauth URI，不发网络请求。

确认 TOTP：

```tsx
const result = await confirmTotpSetup({
  api,
  uid,
  password,
  currentKdfParams,
  secret: draft.secret,
  code,
});
```

位置：`AccountSecurityPage.tsx`，行 333–373。

当前只有一个输入框：

```tsx
<Input
  inputMode="numeric"
  autoComplete="one-time-code"
  placeholder="000000"
  value={code}
  onChange={(event) =>
    setCode(event.target.value.replace(/\D/g, '').slice(0, 8))
  }
/>
```

位置：`AccountSecurityPage.tsx`，行 449–456。

验证码校验允许 6–8 位：

```tsx
if (!/^\d{6,8}$/.test(code)) {
  ...
}
```

位置：行 338–341。

### 4.5 TOTP 使用的 API

动作实现位于 [account-security-actions.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/auth/account-security-actions.ts:111)。

确认流程：

1. 本地校验 TOTP code。
2. 调用 `api.keyLogHead()` 获取当前 keylog head。
3. 派生 root key 和 TOTP key。
4. 构造 `set_totp` 记录。
5. 调用 `api.appendKeyLog({ bytes, sig })` 写入签名记录。

关键位置：

- `confirmTotpSetup()`：行 139–197
- `api.keyLogHead()`：行 171
- `append()`：行 35–40、行 192

清除 TOTP：

```tsx
const head = await api.keyLogHead();
const record = buildClearTotpRecord(...);
await append(api, record);
```

位置：`account-security-actions.ts`，行 199–215。

`AuthApi` 对应 endpoint：

- `GET /api/auth/keylog/head`：`auth-api.ts`，行 215–222
- `POST /api/auth/keylog`：`auth-api.ts`，行 224–259

其他账号安全请求：

- `GET /api/auth/passkeys`：列出 passkeys，`auth-api.ts` 行 205–213
- `POST /api/auth/passkey/register/options`
- `POST /api/auth/passkey/register/verify`

位置：`auth-api.ts`，行 159–180。

### 4.6 当前已有的 Dialog、Sheet 和 motion

`packages/ui` 已经有 Base UI Dialog：

[dialog.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/dialog.tsx:3)

```tsx
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
```

Dialog overlay 是固定全屏：

- Portal：行 18–20
- Overlay：行 26–37
- Content：行 39–78

也有 Sheet：

[sheet.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/sheet.tsx:3)

```tsx
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
```

Sheet 默认从右侧出现，Content 位于行 38–79。

但账号安全当前没有使用这些组件，而是自己实现了凭据输入 overlay。`credential-prompt.tsx` 中明确说明原因：

```tsx
// custom no-portal overlay because Base UI dialog portal SSR tests
```

位置：`credential-prompt.tsx`，行 224–226。

当前自定义 overlay：

```tsx
<div className="tmex-fade fixed inset-0 z-50 flex ... bg-black/40">
  <div className="tmex-scale-in ... max-w-sm ...">
```

位置：`credential-prompt.tsx`，行 228–335。

motion 相关：

- `packages/ui/src/components/motion.tsx`
  - duration：100/150/200/300ms
  - `Reveal`
  - `Stagger`
  - `useReducedMotion`
- `packages/theme/src/motion.css`
  - motion tokens：行 1–16
  - keyframes：行 18–47
  - `.tmex-reveal`、`.tmex-fade`、`.tmex-scale-in`：行 49–65
  - reduced motion：行 67–77

### 4.7 TOTP 页面无法滚动的原因

全局页面样式：

```css
html {
  overflow: hidden;
}

body {
  height: 100dvh;
  overflow: hidden;
}
```

位置：`apps/fe/src/index.css`，行 1–13。

带侧栏页面通过 `MainInset` 建立滚动高度链：

```tsx
<SidebarInset className="h-dvh overflow-hidden ...">
```

位置：`main.tsx`，行 152–188。

`PageWrapper` 内部虽然有：

```tsx
<div className="flex min-h-0 flex-1 flex-col ...">
  ...
  <div className="min-h-0 flex-1 overflow-auto ...">
```

位置：`page-wrapper.tsx`，行 59–71。

但 `/account/security` 使用 `withSidebar={false}`，不经过 `MainInset`，因此缺少稳定的：

```text
100dvh
→ flex column
→ min-h-0
→ flex: 1
→ overflow-auto
```

同时 `AccountSecurityPage` 的外层容器只有 `max-w-3xl`、padding 和 flex column，没有 `min-h-0` 或自身滚动约束。

根因假设：

1. `html/body` 禁止滚动。
2. no-sidebar 的 `PageWrapper` 没有获得和 `MainInset` 相同的高度约束。
3. AccountSecurity 内容增长后，overflow owner 没有被限制在可滚动高度内。

精确检查/变更位置：

- `page-wrapper.tsx`：为 no-sidebar 页面建立完整高度链。
- `main.tsx`：`withSidebar={false}` 的页面壳。
- `AccountSecurityPage.tsx`：外层 flex/min-height 约束。
- `index.css`：全局 body overflow 规则。

---

## 5. 终端空状态与 “Panes” 文案

### 5.1 当前代码已经使用 i18n

Agent tab 的空状态：

```tsx
<ChatThread
  emptyText={
    model.hasContext
      ? t('agent.panel.empty')
      : t('agent.session.selectPaneHint')
  }
/>
```

位置：[agent-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/agent/agent-tab.tsx:39)，行 39–48。

因此当前源码中没有发现该提示直接硬编码在 TSX 内。问题实际在中文 locale 文案：

```json
"selectPaneHint": "请在 Panes 标签中选择一个 pane 来开启会话"
```

位置：[zh_CN.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/zh_CN.json:771)。

这里存在两个问题：

- `Panes` 没有翻译成“终端”。
- 第二个 `pane` 没有首字母大写，且仍是英文。

同一个 key 还被 `agent-binding-status.tsx` 使用，位置为行 66–78，因此修改 locale 会同时影响禁用状态提示。

### 5.2 “Panes” tab 的实际翻译

侧栏 tab 使用：

```tsx
{t('sidebar.tab.panes')}
```

位置：`app-sidebar.tsx`，行 42–49。

中文 locale 已经是：

```json
"panes": "终端"
```

位置：`zh_CN.json`，行 718 附近。

所以：

- 侧栏真正的 tab label 已经是“终端”。
- Agent 空提示中的 `"Panes 标签"` 仍是错误英文。
- 如果用户看到的是空提示，应修改 `agent.session.selectPaneHint`，不是修改 `app-sidebar.tsx`。

### 5.3 TerminalStage 的另一个空状态

`terminal-stage.tsx` 的无 pane/window 选择状态使用的也是 i18n：

```tsx
t('window.noWindowSelected')
t('window.selectWindowToStart')
```

位置：`terminal-stage.tsx`，行 50–64。

该文件没有找到硬编码的 `Panes` 文案。因此用户描述的字符串更匹配 Agent tab 的 `selectPaneHint`。

### 5.4 i18n 文件和生成机制

源 locale 文件：

```text
packages/shared/src/i18n/locales/en_US.json
packages/shared/src/i18n/locales/zh_CN.json
packages/shared/src/i18n/locales/ja_JP.json
packages/shared/src/i18n/locales/manifest.json
```

这些 JSON 顶层是嵌套对象：

```json
{
  "translation": {
    "sidebar": {
      "tab": {
        "panes": "终端"
      }
    },
    "agent": {
      "session": {
        "selectPaneHint": "..."
      }
    }
  }
}
```

构建脚本：

```text
packages/shared/scripts/build-i18n.ts
```

生成：

```text
packages/shared/src/i18n/resources.ts
packages/shared/src/i18n/types.ts
```

生成流程：

- 读取 `manifest.json` 中的 locale。
- 读取各 locale JSON。
- 生成 `resources.ts`。
- 从第一份 locale 的 `translation` 递归生成 dotted key 类型。
- `types.ts` 中会出现：
  ```ts
  'agent.session.selectPaneHint'
  ```

前端动态加载位于：

```text
apps/fe/src/i18n/index.ts
```

该文件通过 glob 加载 locale JSON，`useSuspense: false`。`apps/fe/src/main.tsx` 会等待 `i18nReady` 后创建 React root。

修改 locale 后必须运行：

```bash
bun run build:i18n
```

不要直接修改 `resources.ts` 或 `types.ts`，也不要对这些生成文件单独执行 lint/format/fix。

---

## 6. 左上角品牌文本

### 6.1 当前显示逻辑

品牌组件：

[brand.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/brand.tsx:17)

```tsx
const readName = () =>
  siteStore?.getState().settings?.siteName || PRODUCT_NAME;
```

位置：`brand.tsx`，行 17–26。

渲染时：

```tsx
const siteName = useBrandName();
```

并显示：

```tsx
<span
  className="truncate text-sm font-semibold tracking-tight"
  data-testid="brand-name"
>
  {siteName}
</span>
```

位置：`brand.tsx`，行 56–79。

因此当前品牌主文本是：

```text
site settings.siteName
```

而不是固定的 `tmex`。

如果没有 site settings，才 fallback 到：

```tsx
export const PRODUCT_NAME = 'tmex';
```

位置：`packages/shared/src/brand.ts`，行 1–7。

### 6.2 siteName 来源

站点默认配置位于：

```text
packages/stores/src/site.ts
```

默认值包含：

```tsx
siteName: PRODUCT_NAME
```

站点设置接口类型位于：

```text
packages/shared/src/contracts/site-settings.ts
```

远程站点设置由 `siteStore.fetchSettings()` 获取。`NodeRuntimeBoundary` 会为当前 runtime 注册站点设置读取器，但 `Brand` 特意使用 `useOptionalRuntime()`，以便在这些位置也能渲染：

- `/login`
- `/account/security`
- 带 runtime 的主页面

### 6.3 当前本地节点名称的来源

mesh 节点信息来自：

```text
apps/fe/src/node/mesh-nodes.ts
```

其中：

- `entryNodeId` 表示当前入口/self node。
- `nodes[]` 中的 `MeshNode.name` 是节点名称。
- `useMeshNodes()` 提供节点列表。

对应 API 类型：

```tsx
type MeshNode = {
  id: string;
  name: string;
  ...
}
```

位置：`packages/api-client/src/auth/types.ts`，行 140–156。

`AuthModeResponse` 只有 `nodeId` 等身份信息，没有节点 name：

位置：`auth/types.ts`，行 23–42。

`LocalStatusResponse` 也没有 hostname/name 字段：

位置：`auth/types.ts`，行 20–27。

浏览器 hostname 可以从：

```text
apps/fe/src/pages/settings/nodes/setup/browser-location.ts
```

读取，但它是浏览器地址的 hostname，不一定等于业务上的本地节点名称。

### 6.4 精确改动位置

品牌需求涉及 `brand.tsx`：

1. 主标题固定使用 `PRODUCT_NAME`。
2. 新增小字号副标题。
3. 副标题订阅当前本地节点名称。
4. 调整 `title`、`alt` 与 `data-testid` 的语义。

本地节点名称的来源需要区分：

- mesh 模式：`entryNodeId + nodes[].name` 已可用。
- standalone 模式：当前已发现的 auth/local status API 没有节点 name，需要后端补字段，或明确采用 hostname fallback。
- `/login`、`/account/security` 不在 `RuntimeProvider` 内，品牌组件不能无条件依赖 runtime store。

当前 `Brand` 只订阅 site store：

```tsx
const siteStore = useOptionalRuntime()?.stores.site;
```

位置：`brand.tsx`，行 17–26。

所以新增本地节点副标题时，要考虑其在 runtime 外部页面的可用性。

---

## 7. 测试、tsc、Biome 和 i18n 命令

### FE 源码测试

在 `apps/fe` 下：

```bash
cd apps/fe
bun test src/
```

注意：`apps/fe/package.json` 的默认 `test` 脚本实际上是：

```json
"test": "bun run test:e2e"
```

也就是说，`bun run test` 运行的是 E2E 测试；源码单元测试应使用用户指定的：

```bash
bun test src/
```

### FE TypeScript 检查

只执行 tsc：

```bash
cd apps/fe
bunx tsc --noEmit
```

FE 现有 build 脚本是：

```bash
cd apps/fe
bun run build
```

该命令会执行：

```text
tsc
→ vite build
```

### Biome

仓库根目录 package script：

```json
"lint": "biome check ."
```

运行：

```bash
bun run lint
```

或直接：

```bash
bunx biome check .
```

生成文件如：

```text
packages/shared/src/i18n/resources.ts
packages/shared/src/i18n/types.ts
resources/fe-dist/*
dist/*
node_modules/*
```

不应手工 lint、format 或 fix；i18n 生成文件应通过：

```bash
bun run build:i18n
```

重建。