审查结论：本轮没有足够证据评为 HIGH。发现 5 项 MED；未修改代码，也未执行会生成产物的 build。

## 排名发现

### [MED] 离线节点仍触发全局 `/api/devices` 请求

- 证据：`apps/fe/src/pages/devices/node-device-group.tsx:242-249` 保持 offline 节点的运行时子树挂载；`apps/fe/src/node/node-runtime-scope.tsx:18-24` 无条件挂载 `GlobalDeviceProvider`；`apps/fe/src/components/global-device-provider.tsx:310-314` 无条件执行 `useQuery(['devices'])`。对比之下，`packages/panels/src/device-management/use-device-management-state.ts:41-46` 已使用 `enabled: !offline`。
- 热点原因：每个 node 有独立 QueryClient；多个离线节点会各自尝试访问 `/api/devices`。默认还会 retry 一次，见 `apps/fe/src/node/node-runtimes.ts:260-267`。
- 预计影响：离线 mesh 节点数量为 N 时产生最多 N 个无效请求及失败等待，增加网络、日志和页面切换延迟。
- 修复方向：给 `GlobalDeviceProvider` 增加 offline/enabled 条件，或把设备列表查询移至仍需要在线数据的子树；节点恢复在线时重新启用查询。
- 风险：中。需确认路由订阅和设备对账逻辑在 offline → online 转换时仍能正确恢复。

### [MED] Settings 页面所有标签都挂载站点设置表单，并与 Sidebar 竞争同一请求

- 证据：`apps/fe/src/pages/SettingsPage.tsx:86-95` 无条件调用 `useSiteSettingsForm()`；实际只有 `general` 和 `notifications` 使用它，见 `apps/fe/src/pages/SettingsPage.tsx:191-203`。
- `apps/fe/src/pages/settings/use-site-settings-form.ts:31-63` 同时创建 draft、语言预览控制器和 React Query 请求。
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx:24-29` 挂载时调用 `useSiteStore.fetchSettings()`；该请求在 `packages/stores/src/site.ts:133-147` 没有 in-flight 去重。
- 热点原因：打开任意设置标签都会创建完整表单状态；首次打开设置页时，React Query 与 site store 还可能同时请求 `/api/settings/site`。
- 预计影响：额外一次完整设置请求、JSON 解析和表单初始化；设置页首屏会增加无用工作。
- 修复方向：仅在 General/Notifications 需要时启用表单数据查询；统一 React Query 与 site store 的缓存或共享 in-flight Promise。
- 风险：中。需要保留标签切换时的未保存 draft 和语言预览行为。

### [MED] 保存站点设置后对同一端点执行两次重拉

- 证据：`apps/fe/src/pages/settings/use-site-settings-form.ts:90-96` 在保存成功后并行执行 `invalidateQueries(['site-settings'])` 与 `refreshSettings()`；后者在 `packages/stores/src/site.ts:158-168` 再次请求，实际端点见 `packages/api-client/src/site.ts:6-14`。
- 热点原因：当前表单查询始终处于 active 状态，因此 invalidate 会触发一次重拉；store refresh 又独立发起一次 GET。
- 预计影响：每次保存产生两次响应、两次状态更新链路，增加设置页网络开销和不必要重渲染。
- 修复方向：选择一个权威缓存源；例如用一次查询结果同时更新 React Query 与 site store，或只 invalidate 后由 store 从查询缓存读取。
- 风险：中。需保留保存后的主题、语言及其他消费者的即时同步。

### [MED] 侧栏孤立 Agent 会话区对任意 metadata 事件做全量扫描

- 证据：`apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:124-136` 订阅完整 `snapshots`，并对全部 sessions 计算孤立状态；`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:112-125` 每次重新遍历所有设备、窗口和 pane。
- `packages/stores/src/tmux-event-router.ts:81-98` 每个设备的 `metadata-snapshot`/`metadata-patch` 都替换顶层 `snapshots` 引用；组件始终挂载见 `packages/panels/src/device-tree/sidebar-device-list.tsx:298-303`。
- 热点原因：单个设备的 metadata 变化会触发全体 pane 集合重建，并对全体 Agent session 过滤；复杂度约为 O(P + S)，其中 P 是所有 pane 数，S 是 session 数。
- 预计影响：大规模 mesh 或 metadata 批量更新时产生明显对象分配和主线程计算；与终端输出路径无关。
- 修复方向：维护按 device 增量更新的 pane 索引，或只订阅与当前 Agent session 集合相关的设备快照。
- 风险：中。需要覆盖 pane 删除、设备离线和快照尚未到达时的挂载语义。

### [MED] 设备卡片逐张订阅 file roots，产生 O(D×R) 派生扫描

- 证据：`packages/panels/src/device-management/device-grid.tsx:121-128` 为每个设备渲染卡片；`packages/panels/src/device-management/device-card.tsx:270-276` 每张卡片都订阅 `['files', 'roots']` 并执行 `.some()`。
- 热点原因：React Query 会去重网络请求，但不会消除 D 个 observer 及 D 次 roots 数组扫描。D 为设备数、R 为 roots 数，refetch 或文件根目录变更时成本为 O(D×R)。
- 预计影响：设备和根目录数量较大时增加设备页渲染、查询通知和临时对象分配。
- 修复方向：将 roots query 提升到 `DeviceGrid` 或设备管理面板，预先构建 `Set<deviceId>`，再向卡片传递 `hasRoots` 布尔值。
- 风险：低到中。需保留离线节点和文件功能开关的现有条件。

## Bugs

### [MED] `useHubNode` 存在轮询、手动刷新之间的响应竞态

- 证据：`apps/fe/src/node/mesh-nodes.ts:416-436` 每次调用 `loadHub` 都直接发起请求，没有共享 in-flight 或请求序号；`apps/fe/src/node/mesh-nodes.ts:439-457` 同时存在初始请求、定时轮询和手动 `refresh`。
- `apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:70-73` 的 `refreshAll` 会调用 `hub.refresh()`，按钮也直接绑定它，见 `:117-124`。
- 问题：慢请求重叠时，较早响应可能覆盖较新响应的 `hubNodes/error/loading` 状态；手动刷新也可能与 interval 同时发起重复请求。
- 修复方向：增加请求 generation 或 AbortController，并对 polling/manual refresh 做 single-flight 合并。
- 风险：中。需区分组件卸载取消与“旧请求不可覆盖新请求”两种语义。