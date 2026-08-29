# f4 结果：侧边栏设备可见性 + 远端 node 掀翻全局语言的修复

## 任务 A：侧边栏设备可见性（远端 node 设备默认隐藏，可在「管理设备」逐台开启）

### 对外 API（f3 按此编码）

`packages/stores/src/sidebar-device-visibility.ts`（新增，已从 `@tmex/stores` 主入口导出）：

```ts
export function sidebarDeviceVisibilityKey(runtimeNodeId: string, deviceId: string): string;
// => `${runtimeNodeId}:${deviceId}`

export function isSidebarDeviceVisible(
  map: Record<string, boolean>,
  runtimeNodeId: string,
  deviceId: string
): boolean;
// 有显式记录取记录值；否则 runtimeNodeId === 'self' 时 true，远端 node false
```

`packages/stores/src/ui.ts`（`UIState` 新增，持久化在 `tmex-ui`）：

```ts
sidebarDeviceVisibility: Record<string, boolean>;
setSidebarDeviceVisibility(key: string, visible: boolean): void;
```

持久化与 `sidebarDeviceExpanded` 同一套：进 `partialize`，`merge` 里经 `normalizeBooleanMap`
归一（原 `normalizeSidebarDeviceExpanded` 改名复用，两张表共用）。

### runtimeNodeId 怎么拿（重要，与预期不同）

**没有新增 `runtime.runtimeNodeId`**：`RuntimeCore`/`AppRuntime` 早就有
`nodeId: string`（`packages/stores/src/runtime.ts`，`resolveRuntimeCore` 缺省 `SELF_NODE_ID` = `'self'`，
`NodeConnectionManager.create()` 按 node 传真实 id）。再加一个同义字段属于重复定义，故沿用既有字段。

> **f3 请改用 `runtime.nodeId`**（`useRuntime().nodeId`）：self runtime 为 `'self'`，
> 远端 runtime 为 mesh node id。语义与 `toSidebarEntries` 里的 `runtimeNodeId` 完全一致。

### 过滤实现

- `packages/panels/src/device-tree/device-tree-selectors.ts` 新增纯函数
  `selectSidebarVisibleDevices(devices, visibility, runtimeNodeId, selectedDeviceId?)`。
- `packages/panels/src/device-tree/sidebar-device-list.tsx` 用它得到 `visibleDevices`，
  排序 / 渲染 / `ensureDeviceSubscribed` 订阅全部改走 `visibleDevices`（隐藏设备不再自动订阅）。
  `knownDeviceIds`（agent 孤立会话判定）仍用全量 `devices`，否则隐藏设备的会话会被误判为孤立。
- **当前路由选中的设备无条件保留**（已在选择器里实现并注释）：从「管理设备」点进一台
  未开启显示的远端设备后，侧边栏若把它一起滤掉，用户既看不到它、也没有窗口 / pane 树可点。
- 空态分三支：查询失败 → 原错误态；`devices.length > 0` 但全被滤掉 →
  新增 `hiddenEmptyLabel`（`data-testid="sidebar-devices-all-hidden"`）；真的没设备 → 原 `emptyLabel`。
- `apps/fe/.../sidebar-device-list-runtime.tsx` 透传新 prop `hiddenEmptyLabel`。
- `apps/fe/.../sidebar-node-section.tsx`：
  - 在线且已登录：传 `hiddenEmptyLabel={t('sidebar.noVisibleDevices')}`，即「分节头 + 一行灰字提示」。
  - **离线** node 的 inventory 灰显列表同样按可见性过滤（否则离线远端 node 仍会把全部设备倒进侧边栏），
    全隐藏时渲染 `data-testid="sidebar-node-hidden-<runtimeNodeId>"` 的同一句提示。
  - 该组件新增 `useUIStore` 读取（UI store 是宿主级共享实例，所有 node 同一份）。

### i18n

`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 各加一个 `sidebar.noVisibleDevices`
（定点插入，未重排未跑 `build:i18n`；`resources.ts` 由脚本重建，FE 直接读 locale JSON 不受影响）：

- en：`No devices shown — enable them in Manage devices`
- zh：`未选择显示的设备，可在“管理设备”中开启`
- ja：`表示するデバイスが選択されていません。「デバイス管理」で有効にしてください`

## 任务 B：远端 node 把整页 UI 掀成英文

诊断确认：`SidebarTitle` 挂载时对**当前 runtime** 调 `fetchSettings()`；进入 `/n/<id>/...` 后那是远端
node 的 site store，`commitSettings` 无条件 `i18next.changeLanguage(settings.language)`，
而 i18next 是浏览器级单例 → 远端站点的 `en_US` 覆盖全局语言。

修复：

- `AppRuntimeOptions.controlsLanguage?: boolean` / `RuntimeCore.controlsLanguage: boolean`
  （`resolveRuntimeCore` 缺省 `true`，保持单实例宿主与既有测试不变）。
- `createSiteStore` 的 core 参数加上 `'controlsLanguage'`；`commitSettings` 里
  `if (core.controlsLanguage) void i18next.changeLanguage(...)`。
  `fetchSettings` / `refreshSettings` / `handleSettingsUpdate('site')` 全部经 `commitSettings`，
  一处守住即三条路径都守住。
- `NodeConnectionManager.create()` 传 `controlsLanguage: nodeId === SELF_NODE_ID`。

`changeLanguage` 全仓调用点复查：`packages/stores/src/site.ts`（已守）、
`apps/fe/src/pages/settings/use-site-settings-form.ts:76`（**不在本任务文件范围**，见「遗留问题」）、
`apps/gateway/src/db/site-settings.ts`（后端独立 i18next 实例，与浏览器无关）。

## 改动文件

- `packages/stores/src/sidebar-device-visibility.ts`（新）
- `packages/stores/src/sidebar-device-visibility.test.ts`（新）
- `packages/stores/src/site-language.test.ts`（新）
- `packages/stores/src/ui.ts`、`ui.test.ts`
- `packages/stores/src/site.ts`
- `packages/stores/src/runtime.ts`
- `packages/stores/src/node-connection-manager.ts`、`node-connection-manager.test.ts`
- `packages/stores/src/index.ts`
- `packages/panels/src/device-tree/device-tree-selectors.ts`、`device-tree-selectors.test.ts`
- `packages/panels/src/device-tree/sidebar-device-list.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.test.tsx`
- `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（仅 `sidebar.noVisibleDevices`）

## 验证

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `packages/stores` `bun test` | 261 pass / 0 fail | **271 pass / 0 fail**（+10） |
| `packages/stores` `bunx tsc --noEmit -p .` | 1 既有错误 | **1 既有错误**（`src/host-services.test.ts(93,23)`，与本次无关） |
| `packages/panels` `bun test` | 372 / 0 | **381 pass / 0 fail**（+9） |
| `packages/panels` tsc | 0 | **0** |
| `apps/fe` `bun test src/` | 511 / 0 | **520 pass / 1 fail**（见下） |
| `apps/fe` tsc | 0 | **3 错误**（全部来自他人在途改动，见下） |
| `bunx biome check <改动文件>` | — | **全部通过，0 error** |

其他 agent 在途文件导致、**未修**的问题：

- `apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx` — `NodesTab mesh > 渲染本机区块…` 断言
  `href="/nodes"` 未出现（nodes tab 改造在途）。
- tsc：`src/pages/settings/nodes/local-machine-card.test.tsx(38,5)`、
  `src/pages/settings/nodes/nodes-tab.test.tsx(83,5)`、
  `src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx(29,5)` —
  `LocalTlsStatus` 新增 `listenerRunning` / `tlsPort` 后测试桩未补字段。

## 遗留问题 / 需要别人接手

1. **f3 用 `runtime.nodeId`，不是 `runtime.runtimeNodeId`**（见上文，字段本来就存在，未加同义别名）。
2. `apps/fe/src/pages/settings/use-site-settings-form.ts:76` 保存站点设置后仍无条件
   `i18n.changeLanguage(draft.language)`。在 `/n/<id>/settings` 保存远端 node 的站点设置时，
   同样会掀翻全局 UI 语言。该文件在 `apps/fe/src/pages/**`，不在本任务文件范围，未改。
   建议同样按 `useRuntime().controlsLanguage` 判定。
3. **同一类缺陷仍存在于主题**：`createSiteStore.syncThemeToUIStore` 把远端 node 的
   `settings.theme` 写进共享 UI store 并 toggle `<html>.dark`，进入远端 node 子树会连带切换全局亮/暗。
   本次只按任务要求处理了语言；若要一并修，`controlsLanguage` 可扩成
   `controlsGlobalAppearance`（会牵动 `site-theme.test.ts`）。
4. 设备排序 DnD 现在只对**可见**设备生效：`PUT /api/devices/order` 只会收到可见设备的 id，
   隐藏设备保留旧 `sortOrder`（排序退化为 `sortOrder || name` 兜底，不会报错，但可能出现交错）。
   若不可接受，需要在提交前把隐藏设备按原位置补回完整序列。
5. `apps/fe` 的侧边栏测试用 `react-dom/server` 静态渲染，而 zustand 在
   `useSyncExternalStore` 的 server 快照走的是**建店时的初始 state**，建店后 `setState` 读不到。
   因此 `sidebar-device-list.test.tsx` 的 `render(ui, visibility)` 注入的是一个只带 ui 选择器面的
   最小 runtime 桩，而不是真 store——后续给该文件加用例时注意这一点。
