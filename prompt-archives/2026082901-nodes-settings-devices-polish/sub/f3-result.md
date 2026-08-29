# f3 结果：管理设备页紧凑化 + 全局唯一「+」+「显示在侧栏」开关

## 改动文件

新增：

- `apps/fe/src/pages/devices/add-device-targets.ts` —— 模块级「可添加设备的 node」注册表（含 `useAddDeviceTargets`）
- `apps/fe/src/pages/devices/add-device-menu.tsx` —— 多节点时顶栏「+」的下拉菜单
- `packages/panels/src/device-management/device-card.test.tsx` —— 设备卡片静态渲染测试

修改：

- `apps/fe/src/pages/DevicesPage.tsx` —— `PageActions` 接注册表；mesh 分组容器 `gap-6` → `gap-3 sm:gap-4`
- `apps/fe/src/pages/devices/node-device-group.tsx` —— 删除每组的 `devices-node-add-*` 按钮；分组头改成单行紧凑排布（`gap-1.5`、chip 统一 10px）；section `gap-2` → `gap-1.5`；离线/未登录卡片 `p-3` → `px-3 py-2`；ready 分组在 `useEffect` 里把自己的 `openAddDevice` 登记进注册表
- `apps/fe/src/pages/DevicesPage.test.tsx` —— 去掉 per-node「+」断言，新增注册表与 `PageActions` 用例
- `packages/panels/src/device-management/device-card.tsx` —— 重写为紧凑两行卡片 + 侧栏开关
- `packages/panels/src/device-management/device-management-panel.tsx` —— 卡片栅格 `grid gap-3 md:grid-cols-2 xl:grid-cols-3`；空态 `py-14` → `py-8`（图标 10×10、标题 text-sm、按钮 size=sm）；加载/错误态 `py-16` → `py-10`；容器去掉 `sm:gap-4`
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` —— 仅在 `device` 对象内追加 4 个键

## 卡片紧凑化细节

`Card size="sm" py-2.5 gap-2`，两行：

1. 图标 7×7 + 名称（text-sm/leading-tight，truncate）+ 副标题（text-xs）+ 「连接」按钮（`size=sm`，行内）+ 「更多」菜单（icon-sm）
2. 类型/session 徽标（`px-1.5 py-0 text-[10px]`）+ 状态徽标，右侧 `ml-auto` 放「显示在侧栏」文字 + `Switch size="sm"`

原来的 `CardHeader/CardTitle/CardDescription/Separator` 与独立的动作行已去掉。移动端仍然是单列（`md:` 起才两列），第二行 `flex-wrap` 保证徽标多时不溢出。

保留的 testid：`device-card`、`device-card-connect-*`、`device-card-actions-*`、`device-card-edit/test/delete-*`；新增 `device-card-sidebar-*`。

## 全局「+」如何定位目标 node

`PageWrapper` 把 `PageActions` 和页面主体挂在**两棵互不相连的子树**里（`apps/fe/src/page-wrapper.tsx:44-49`），context / ref 传不上去，所以用模块级注册表 + `useSyncExternalStore`：

1. 每个 `state === 'ready'` 的 `NodeDeviceGroup` 在 `useEffect` 里 `registerAddDeviceTarget({ runtimeNodeId, name, isSelf, open: () => panelRef.current?.openAddDevice() })`，卸载/变为非 ready 时注销；快照按「self 在前，其余按名称」排序且引用稳定（`useSyncExternalStore` 要求）。
2. `PageActions`：
   - 0 个目标（standalone / 单面板 / mesh 列表未回来）→ `<DeviceManagementActions />` 不带回调，仍派发 `OPEN_ADD_DEVICE_EVENT`，旧路径与 `apps/fe/tests/devices.spec.ts` 的 `devices-add` 点击行为不变；
   - 1 个目标 → `<DeviceManagementActions onAddDevice={targets[0].open} />`，一次点击直接开该 node 的对话框；
   - >1 个目标 → `<AddDeviceMenu>`：触发器仍是 `data-testid="devices-add"` 的 ghost/icon-sm「+」，菜单项 testid `devices-add-to-<runtimeNodeId>`，self 项带「本机」标记，item title 复用既有 `devices.nodes.addDevice`。

面板侧仍保持 `listenOpenAddDeviceEvent={node.isSelf}`（多面板不会被一次事件全部弹开）。

## 侧栏可见性开关

`DeviceCard` 用 `useRuntime().nodeId`（`RuntimeCore.nodeId`，`NodeRuntimeScope` 挂的远端运行时为 mesh node id，本机为 `self`）作为 `runtimeNodeId`，另留 `runtimeNodeId?: string` prop 可显式覆盖。状态读 `useUIStore(state => isSidebarDeviceVisible(state.sidebarDeviceVisibility, nodeId, device.id))`，写 `setSidebarDeviceVisibility(sidebarDeviceVisibilityKey(nodeId, device.id), checked)` —— f4 的 store 改动已落地，接口完全对上，无缺失导出。默认值（self 开 / 远端关）由 helper 编码。

开关外层用 `<div title={t('device.sidebar.hint')}>` 而不是 `<label>`：base-ui 的 Switch 自带隐藏 input，biome 的 `useAltText`/label 关联规则静态看不到，会报「A form label must be associated with an input」。Switch 本身带 `aria-label`。

## 新增 i18n 键（仅 `device.*`）

| key | en_US | zh_CN | ja_JP |
| --- | --- | --- | --- |
| `device.sidebar.show` | Show in sidebar | 显示在侧栏 | サイドバーに表示 |
| `device.sidebar.hint` | Browser-local preference: whether this device appears in the sidebar device list on this browser. | 仅本浏览器生效的偏好：该设备是否出现在侧栏设备列表里。 | このブラウザーのみの設定です。… |
| `device.addTo.label` | Add device to | 添加设备到 | デバイスの追加先 |
| `device.addTo.self` | This machine | 本机 | このマシン |

按要求**没有**跑 `build:i18n`，`packages/shared/src/i18n/resources.ts` / `types.ts` 未动 —— 合并方需要跑一次生成脚本，否则运行时这 4 个键会回落成 key 字符串。

## 验证数字

- `packages/panels`：`bun test` **376 pass / 0 fail**（基线 372/0，新增 4 个用例）；`bunx tsc --noEmit -p .` **0 错误**。
- `apps/fe`：`bun test src/` **520 pass / 1 fail**（基线 511/0）。唯一失败是 `src/pages/settings/nodes/nodes-tab.test.tsx:151`「NodesTab mesh > 渲染本机区块 + 节点管理…」，属于并行 agent 正在改的 settings/nodes 文件，与本次改动无关。`bunx tsc --noEmit -p .` 报 3 个错误，全在 `src/pages/settings/nodes/{local-machine-card,nodes-tab,setup/hub-setup-wizard}.test.tsx`（`LocalTlsStatus` 缺 `listenerRunning`/`tlsPort`），同样属于并行 agent 的在途改动；我的文件 0 错误。
- 仓库根 `bunx biome check <改动文件>`：**通过，0 error**。
- 未跑 Playwright e2e。

## 遗留 / 风险

1. **必须补跑 `bun run build:i18n`**（合并方执行），否则新键不生效。
2. mesh 多 node 的 e2e 若要点「添加设备」，现在是「先点 `devices-add`，再点 `devices-add-to-<nodeId>`」两步；单 node（含 standalone）仍是一步。`apps/fe/tests/devices.spec.ts` 走 standalone，不受影响。
3. `devices.nodes.addDevice` 从「每组 + 的 aria-label」变成「下拉项 title」，仍在使用，未删除（`devices.*` 不在本任务的 i18n 改动范围）。
4. `device-card.test.tsx` 只覆盖默认值：静态渲染下 zustand 走 `getInitialState`，渲染前写进 store 的值读不到，「显式值优先」由 `packages/stores` 的单测覆盖。
