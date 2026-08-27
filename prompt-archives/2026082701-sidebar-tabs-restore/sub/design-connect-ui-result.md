# 设备连接 UI 恢复实现规格

## 范围与原则

- 基于当前 `packages/panels/src/device-tree/*` 架构恢复连接 UI。
- 不使用、不新增对 `sidebarSections` 的依赖；保留 `sidebarTab` / `setSidebarTab`。
- 保留 URL 驱动的 `data-active`、`sidebarDeviceExpanded` 持久化，以及“不显示 tmux active 高亮”。
- 连接意图由宿主 `GlobalDeviceProvider` 管理，`TmuxStore` 只管理实际订阅和运行态。

## 1. 连接适配器与连接意图

### 新增类型

新增 `packages/panels/src/device-connection.ts`：

```ts
export type DeviceConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export interface DeviceConnectionAdapter {
  isConnected(deviceId: string): boolean;
  status(deviceId: string): DeviceConnectionStatus;
  isIntentionallyDisconnected(deviceId: string): boolean;
  connect(deviceId: string): void;
  disconnect(deviceId: string): void;
}
```

从 `packages/panels/src/device-tree/index.ts` 导出上述类型。

`isConnected` 表示收到网关连接确认；`connecting` 由“已加入 `connectedDevices` 但尚未确认”派生。`isIntentionallyDisconnected` 必须只表示用户主动断开，不表示网络错误。

### `apps/fe/src/components/global-device-provider.tsx`

修改 `GlobalDeviceContextValue`：

```ts
{
  ensureDeviceSubscribed(deviceId: string): void;
  connection: DeviceConnectionAdapter;
}
```

Provider 增加以下状态：

- `persistedConnectedDeviceIds: Set<string>`
- `explicitlyDisconnectedDeviceIds: Set<string>`

持久化：

- `${storagePrefix}tmex:connectedDevices`：JSON 字符串数组，兼容旧实现。
- `${storagePrefix}tmex:disconnectedDevices`：JSON 字符串数组，记录主动断开设备。

其中默认 `storagePrefix` 为空，旧 key 仍为 `tmex:connectedDevices`。

行为约定：

- `ensureDeviceSubscribed(id)`：若 `explicitlyDisconnectedDeviceIds.has(id)`，直接返回；否则若 `connectedDevices` 不含该 ID，调用 tmux store 的 `connectDevice(id)`。
- `connection.connect(id)`：移除断开标记、加入持久化连接集合、调用 `clearDeviceError(id)`，再调用 `connectDevice(id)`。
- `connection.disconnect(id)`：加入断开标记、从持久化连接集合移除，调用 tmux store 的 `disconnectDevice(id)`。
- Provider 加载设备列表后，恢复持久化连接集合中的已知设备；已删除设备从两个集合中清理。
- 当前路由自动订阅和设备树展开自动订阅继续调用 `ensureDeviceSubscribed`，不能直接调用 `connectDevice`。

状态派生优先级：

1. 主动断开：`disconnected`
2. `deviceReconnecting[id]`：`reconnecting`
3. `deviceErrors[id]`：`error`
4. `deviceConnected[id] === true`：`connected`
5. `connectedDevices.has(id)`：`connecting`
6. 其他：`disconnected`

### `packages/stores/src/tmux.ts`

不新增持久化连接字段。保留：

- `connectedDevices`
- `deviceConnected`
- `connectDevice`
- `disconnectDevice`

修改 `disconnectDevice`：除移除 `connectedDevices`、清理选择状态和 pane 订阅外，立即设置：

```ts
deviceConnected[id] = false;
deviceReconnecting[id] = undefined;
```

这样主动断开后页面无需等待网关事件即可进入断开态。现有 `onReady` 仍仅重连 `connectedDevices` 中的设备。

## 2. 侧边栏设备树

### `packages/panels/src/device-tree/sidebar-device-list.tsx`

`SideBarDeviceListProps` 增加：

```ts
connection?: DeviceConnectionAdapter;
```

现有 `ensureDeviceSubscribed` 保留，作为自动订阅入口。

修改 `handleDeviceExpandedChange`：

- `expanded === true` 且提供 `connection`：调用 `connection.connect(id)`，再持久化展开状态。
- `expanded === true` 且未提供 `connection`：继续调用 `ensureDeviceSubscribed(id)`。
- `expanded === false`：只收起树，不自动断开；断开必须由 Power 按钮触发。
- Power 断开时调用 `connection.disconnect(id)`，并写入 `setSidebarDeviceExpanded(id, false)`。

将 `connection` 传给 `DeviceRow`。自动路由订阅、默认展开订阅仍只调用 `ensureDeviceSubscribed`，因此主动断开标记不会被覆盖。

### `packages/panels/src/device-tree/device-row.tsx`

`DeviceRowProps` 增加：

```ts
connection?: DeviceConnectionAdapter;
```

状态展示：

- 绿色：`connected`
- 灰色：`disconnected`
- 琥珀色：`connecting`、`reconnecting`、`error`

保留现有 `DeviceStatusBadge`，用于重连文案和错误详情；其红色错误 Badge 语义不改。设备圆点使用 adapter 状态，避免把错误误显示成绿色。

保留现有测试节点：

```text
device-online-status-{id}
```

并增加：

```text
data-status="connected|connecting|disconnected|reconnecting|error"
data-online="true|false"
```

新增 Power 按钮：

- `connected`、`connecting`、`reconnecting`：显示断开按钮，testid 为 `device-disconnect-{id}`。
- `disconnected`、`error`：显示连接按钮，testid 为 `device-connect-{id}`。
- 使用 `Power` 图标。
- `onPointerDown`、`onMouseDown`、`onClick` 均阻止冒泡，不能触发展开、拖拽或导航。
- `aria-label` / `title` 使用 `device.connect` 或 `device.disconnect`。

设备展开区域增加主动断开保护：

```tsx
isExpanded && !connection?.isIntentionallyDisconnected(device.id)
```

断开后必须隐藏 `device-tree-{id}`，连接后重新显示 loading 或窗口树。

保留现有 URL 选择逻辑；设备行高亮只能由 `isSelected` 派生，不能由连接状态或 tmux active 状态派生。设备名称如恢复为可点击按钮，应只导航到设备路由，不直接修改连接意图。

### `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`

从 `useGlobalDevice()` 同时取出：

```ts
const { ensureDeviceSubscribed, connection } = useGlobalDevice();
```

传入 `DeviceTreeSideBarDeviceList`。不得读取或传递 `sidebarSections`。

## 3. `/devices` 管理页面

### `packages/panels/src/device-management/device-card.tsx`

恢复旧的卡片底部连接入口：

- 增加 `CardContent`、`Separator`、`Link`、`buttonVariants`。
- `to` 使用：

```ts
hostAppPath(runtime.host, `/devices/${device.id}`)
```

- testid：`device-card-connect-{id}`
- 文案：`t('device.connect')`
- 这是导航链接，不直接调用 `connectDevice`；进入设备路由后由 Provider 的 `ensureDeviceSubscribed` 处理。

`apps/fe/src/pages/DevicesPage.tsx` 无需业务逻辑修改。

## 4. 设备页断开占位

### `apps/fe/src/pages/DevicePage.tsx`

调用 `useGlobalDevice()`，将 `connection` 传入：

```tsx
<DeviceConsole
  deviceId={deviceId}
  windowId={windowId}
  paneId={paneId}
  connection={connection}
/>
```

### `packages/panels/src/device-console/device-console.tsx`

`DeviceConsoleProps` 增加可选：

```ts
connection?: DeviceConnectionAdapter;
```

派生：

```ts
const isIntentionallyDisconnected =
  Boolean(deviceId) && Boolean(connection?.isIntentionallyDisconnected(deviceId));
```

传给 `TerminalStage`。

### `packages/panels/src/device-console/terminal-stage.tsx`

`TerminalStageProps` 增加：

```ts
isIntentionallyDisconnected: boolean;
```

新增断开占位：

```text
🔌
device.disconnected
device.connectToStart
```

判定顺序：

1. `isIntentionallyDisconnected && !deviceConnected && !isReconnecting`：显示断开占位。
2. 已有 `isSelectionInvalid`：保持现有失效提示。
3. 连接中、未收到 snapshot 或重连：显示 loading。
4. 连接成功但未选中窗口：保持现有窗口空态。

`LoadingPlaceholder` 文案恢复为 `terminal.connecting`，不要使用 `common.loading` 替代。

其他宿主不传 `connection` 时保持现有行为，不显示主动断开占位，也不显示 Power 控件。

## 5. i18n

当前三种 locale 中已存在：

- `device.connect`
- `device.disconnect`
- `device.disconnected`
- `terminal.connecting`

当前三种 locale 均缺少：

- `device.connectToStart`

需要修改：

- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/ja_JP.json`

建议文案：

```text
en_US: Connect to this device to get started.
zh_CN: 连接设备后即可开始使用。
ja_JP: デバイスに接続して開始してください。
```

修改 locale JSON 后运行 `bun run build:i18n`，由脚本更新：

- `packages/shared/src/i18n/resources.ts`
- `packages/shared/src/i18n/types.ts`

生成文件禁止手工编辑、lint 或 format。

## 6. 测试更新

### 必须更新的现有测试

- `apps/fe/src/components/global-device-provider.test.ts`
  - 保留现有路由设备校验。
  - 增加主动断开抑制自动订阅、connect 清除抑制、disconnect 持久化、旧 `tmex:connectedDevices` 迁移测试。
- `packages/stores/src/tmux-reselect-retry.test.ts`
  - 增加断开后 `deviceConnected[id] === false` 的即时断言。
  - 保留取消 reselect retry 的断言。
- `packages/stores/src/ui.test.ts`
  - 当前测试仍引用 `sidebarSections`，应按并行 Tabs 变更改为 `sidebarTab` / `setSidebarTab`。
  - 保留 `sidebarDeviceExpanded` 的持久化测试。
  - 不为连接状态增加 UI store 字段。
- `packages/panels/src/device-tree/device-tree-navigation.test.ts`
  - 若新增设备路由构造 helper，增加默认路径和宿主前缀测试。
- `packages/panels/src/device-tree/device-tree-dnd.test.ts`
  - 连接功能不影响拖拽逻辑，原则上无需行为修改。
- 当前没有 `DeviceRow` / `SideBarDeviceList` 组件单测；应新增连接状态派生和 Power 行为测试，或由下述 Playwright 覆盖。

### Playwright 影响

命令扫描结果只有：

```text
apps/fe/tests/sidebar-device-disclosure.spec.ts:53
apps/fe/tests/sidebar-device-disclosure.spec.ts:109
apps/fe/tests/sidebar-device-disclosure.spec.ts:110
```

需要更新该文件：

- 删除“without connection controls”断言。
- `device-card-connect-{id}` 应为 1 个并可导航到 `/devices/{id}`。
- 连接设备后断言 `device-disconnect-{id}` 可见。
- 点击断开后断言：
  - `device-connect-{id}` 可见；
  - `device-disconnect-{id}` 消失；
  - `device-tree-{id}` 和窗口节点隐藏；
  - 刷新后仍保持断开；
  - 进入设备页显示断开占位。
- 点击 Power 连接或展开一个断开设备后，断言恢复连接并显示窗口树。
- 该测试同时包含旧的 `sidebar-section-*` 断言，应随 Tabs 变更改为 `sidebar-tab-*`，不要重新引入 `sidebarSections`。

建议新增或补充：

- `apps/fe/tests/devices.spec.ts`：卡片 Connect 链接导航。
- `apps/fe/tests/sidebar-device-disclosure.spec.ts`：主动断开持久化和连接恢复。
- 设备页断开占位的 testid 建议为 `device-disconnected-placeholder`，便于稳定断言。