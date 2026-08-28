# device-tree 行组件：性能订阅收敛 + 圈复杂度拆分

## 背景

`packages/panels/src/device-tree` 的侧边栏设备树存在两类问题：

1. **性能**：`SideBarDeviceList` 订阅整张 `snapshots` 大表，任何一台设备的 `metadata-patch` 都会让根组件重渲染，并重新遍历全部 device/window/pane；`DeviceRow` / `WindowRow` / `PaneRow` 均未 memo，传下去的 handler 与 id 数组每次渲染都是新引用。
2. **圈复杂度**：`WindowRow`（157 行，CC≈20）与 `PaneRow`（115 行，CC≈17）把拖拽手柄、菜单、响应式样式、内容分支混在一个函数里。

## 改动清单

### 新增

| 文件 | 作用 |
| --- | --- |
| `device-tree-selectors.ts` | 按设备切片的纯选择器 `selectDeviceWindows` / `selectDeviceOnline` + 对应的 `useDeviceWindows` / `useDeviceOnline` hook |
| `device-tree-selectors.test.ts` | 选择器单测（引用稳定性、跨设备隔离、原型键防护） |
| `device-tree-row-shell.tsx` | 窗口行/pane 行共用外壳：sortable 容器、拖拽手柄（表驱动的响应式尺寸）、行内绝对定位锚点、`actions` 菜单槽、`footer` 子树槽；另导出 `rowActionVisibilityClass` |
| `device-tree-row-props.ts` | `DeviceRowProps` / `WindowRowProps` / `PaneRowProps` 集中定义，避免分段文件反向 import 行组件形成循环 |
| `use-row-action-items.ts` | `useWindowActionItems` / `usePaneActionItems`，把菜单 action model 的构造从行组件里挪走 |
| `window-row-header.tsx` | `WindowRowHeader`（可点击主体 + 铃铛 + 标题分支，memo）、`WindowRowMenu` |
| `window-pane-list.tsx` | `WindowRowFooter`（多 pane→pane 列表，单 pane→Agent 会话分支）与内部 `WindowPaneList` |
| `pane-row-content.tsx` | `PaneRowContent`（memo）、`PaneRowActions`、`PaneCloseButton` |
| `device-row-header.tsx` | 设备行标题条（拖拽手柄 / 名称 / 状态徽标 / 连接开关 / 展开箭头） |
| `device-window-list.tsx` | 展开态设备子树（加载中 / 空窗口 / 窗口列表 / 新建窗口按钮） |

### 修改

- `sidebar-device-list.tsx`：删除 `snapshots` / `deviceConnected` / `deviceErrors` / `deviceReconnecting` 四个 store 订阅；`ids` 数组改 `useMemo`（`sortedDeviceIds`），`onReorder` 改 `useCallback`；`DeviceRow` 不再接收 `windows` / `isOnline`。
- `device-row.tsx`：`React.memo`；自身用 `useDeviceWindows(deviceId)` / `useDeviceOnline(deviceId)` 只订阅本设备切片；只保留外层容器 + 两个分段（39 行）。
- `window-row.tsx`：`React.memo`；只保留派生态与外壳组装（66 行，函数体 53 行）。
- `pane-row.tsx`：`React.memo`；只保留点击回调与外壳组装（33 行，函数体 23 行）。

## 性能设计说明（为什么没用 `useShallow`）

- `@tmex/stores/react` 的 `useTmuxStore` 签名是 `<T>(selector: (state: TmuxState) => T): T`，**没有 equalityFn 参数**（zustand v5 已移除该重载）；且 `zustand` 只装在 `packages/stores/node_modules`，`@tmex/panels` 无法 import `zustand/react/shallow`。仓库内也不存在任何 `useShallow` 使用。
- 因此改用「只选引用天然稳定的切片」的方案，无需相等性比较：
  - `selectDeviceWindows` 返回 `snapshots[deviceId]?.session?.windows ?? null` —— 只随该设备快照变化；
  - `selectDeviceOnline` 返回布尔值。
  两者都配 `useCallback([deviceId])` 保证 selector 本身引用稳定。**不需要 store 层新增选择器**，`packages/stores` 未做任何改动。
- 收敛效果链路（已核对 `packages/shared/src/ws-borsh/legacy-snapshot-draft.ts` 的写时复制语义：未被 diff 触碰的 window / pane 保持原引用）：
  - 设备 A 的 patch → 只有 A 的 `DeviceRow` 重渲染；
  - A 内部只有被 diff 触碰的 window / pane 的 `WindowRow` / `PaneRow` 重渲染，其余靠 memo + 稳定引用短路。
- 引用稳定化：`sortedDeviceIds`、`windowIds`、`paneIds` 全部 `useMemo`（keyed on 对应数组）；`handleReorderDevices` / `handleReorderWindows` / `handleReorderPanes` / `handleCreateWindow` / `handleHeaderClick` / `handleClick` 全部 `useCallback`（keyed on ids）。sidebar 下发给行的 `requestCloseWindow` 等已是稳定 `useCallback`，`nav` 已是 `useMemo`。

## 行为等价性核对

- 全部 `data-testid` 原样保留：`device-item-*` / `device-expand-*` / `device-tree-*` / `device-online-status-*` / `device-{connect,disconnect}-*` / `window-create-*` / `window-item-*` / `window-menu-*`（含子项 `window-menu-{rename,close,split-*,watch,new-session}-*`）/ `pane-item-*` / `pane-menu-*` / `pane-close-*` / `pane-{split-*,watch}-*`。
- `data-active` 的取值时机不变；`isPaneSelected` 由 `Boolean(panes.find(...))` 改为 `panes.some(...)`，语义等价。
- 菜单/关闭按钮的显隐 class 由 `rowActionVisibilityClass` 生成，输出字符串与原文逐字一致（`opacity-100` / `opacity-0 group-hover[/pane]:opacity-100 [@media(any-pointer:coarse)]:opacity-100`）。
- 拖拽：三层仍走同一个 `SortableVerticalList` / `useSortableRow`；手柄的 `setActivatorNodeRef` + `dragHandleProps` + `touch-none cursor-grab` 与各档尺寸完全保留（表驱动 `DRAG_HANDLE_STYLES`）。
- 菜单/关闭按钮的 `absolute` 锚点仍只包住行本身（`children` 与 `actions` 同层，`footer` 在锚点之外），`sidebar-pane-menu-alignment.spec.ts` 关心的错位回归点不变，原注释已迁到 `device-tree-row-shell.tsx` 顶部。
- 单 pane 窗口的 Agent 分支容器 `ml-[36px] pl-2 border-l` 与多 pane 的 `ml-4 pl-2 border-l` 均保留。
- 选择/跟随链路未动：`navigateToPane` 仍派发 `tmex:user-initiated-selection`，`use-pane-active-follow.ts` 未修改。

## 验证

```
cd packages/panels && bun test src/device-tree   # 57 pass / 0 fail（5 文件）
cd packages/panels && bun test                   # 331 pass / 0 fail（24 文件）
cd packages/panels && bunx tsc --noEmit -p .     # 无输出
cd apps/fe && bunx tsc --noEmit -p .             # 无输出
bunx biome check packages/panels/src/device-tree # Checked 31 files, no fixes
```

已知的、与本次改动无关的既有报错：

- `packages/app` 的 `bunx tsc --noEmit -p .` 报 `TS2688: Cannot find type definition file for 'node'`（该包 tsconfig 的 types 配置问题，与 device-tree 无关）。
- 期间一度看到 `packages/shared/src/ws-borsh/legacy-snapshot-draft.ts` 缺 `panesDirty` 属性的两条报错，属其他 agent 在飞的文件，稍后已自行消失。

## 遗留 / 建议（不在本次 scope）

1. **`device-tree-navigation.ts` 仍订阅整张 `snapshots`**：`useDeviceTreeNavigationApi` 里有
   `const snapshots = useTmuxStore((state) => state.snapshots);`，仅用于 pending 导航的 effect。
   这条订阅使 `SideBarDeviceList` 根组件在任意设备的 metadata patch 上仍会重渲染（子行已被 memo 挡住，代价从 O(全树) 降到 O(设备数)，但没归零）。
   建议改法：pending 导航的 effect 改为只订阅目标设备的 windows（`pendingNavigation.get()?.deviceId`），或改用 `runtime.stores.tmux.subscribe` 在 effect 内自管订阅。该文件不在本次 scope，未改。
2. `SideBarDeviceList` 本身仍是单个约 230 行的函数（react-query mutation、两个自动展开 effect、排序、渲染混在一起），本次只做了订阅收敛与引用稳定化，未做函数拆分。
3. `DeviceConnectionAdapter`（`apps/fe/src/components/global-device-provider.tsx`）的 `useMemo` 依赖包含 `deviceConnected` / `deviceErrors` 等整表，任一设备连接态变化都会换掉 adapter 引用，从而击穿所有 `DeviceRow` 的 memo。这是**故意保留**的（连接态必须实时反映到每一行），且连接态变更频率远低于终端输出，不构成热路径；若日后要进一步优化，应把 adapter 拆成「稳定动作面 + 按设备状态 hook」。
