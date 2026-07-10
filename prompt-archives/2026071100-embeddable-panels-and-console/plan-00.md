# Plan 00：面板与控制台的嵌入宿主适配（T1–T7）

## 背景与注意事项

- 基线：`vibex/tmex-sidebar-device-management` @ 86aa974。若无本分支上下文重启本任务：先读
  `docs/frontend/packages.md`（九包结构、两层工厂、RuntimeProvider 语义）与
  `prompt-archives/2026071000-ws-client-socket-factory/`（transport 注入先例）。
- 兼容性铁律：所有新增均为「缺省 = 现状」的增量选项；`apps/fe` 单实例形态在每一步之后行为零回归
  （`bun test` + fe Playwright e2e）。
- 测试红线：tmux 相关测试一律独立 socket（`tmux -L …`）；不碰默认 socket 与生产 session。

## 分步实施

### T1 panels 运行时化
- `packages/panels/src/**` 内所有 `from '@tmex/stores'` 的 store hook import 改
  `from '@tmex/stores/react'`（`useTmuxStore/useUIStore/useSiteStore/useFileTreeStore/useAgentStore`
  → context 版；缺省 context 值 = defaultRuntime，语义不变）。
- 裸 `fetch('/api/...')` → `useRuntime().apiClient.fetch(...)`（或经 `@tmex/api-client` 端点函数传
  client）。涉及 settings 各 tab、files-tab、watch-rule-form、version-tab 等。
- `connection-indicator.tsx`：`getBorshClient().reconnect()` → `useRuntime().client.reconnect()`。
- `watch/watch-events-init.tsx`：弃 `defaultRuntime`/`navigateToAppUrl`/模块级布尔防重/全局 client，
  改 `useRuntime()` + `runtime.host.navigate` + `WeakSet<BorshWebSocketClient>` 防重。

### T2 HostServices.appPath
- `packages/stores/src/runtime.ts`：`HostServices` 增 `appPath(path: string): string`，
  `defaultHost.appPath = (p) => p`；`resolveRuntimeCore` 合并时同样兜底。
- 消费点：`stores/src/tmux.ts` 通知 paneUrl、`terminal-ui/src/components/Terminal.tsx` fileRoute、
  `panels/src/files/files-tab.tsx` fileRoute 与 `matchPath('/file/:ref')`、
  `panels/src/watch/watch-events-init.tsx` buildPaneUrl。
- `stores/src/app-navigation.ts`：`PANE_URL_RE` 去 `^` 锚定（使带前缀路径命中派发）。

### T7 AppRuntimeOptions.uiStore
- `runtime.ts` options 增 `uiStore?: UIStore`；`app-runtime.ts`：
  `const ui = options.uiStore ?? createUIStore(core)`；dispose 时宿主注入的 store 不由 runtime 销毁。

### T3 api-client devices 端点
- 新增 `packages/api-client/src/devices.ts`：`fetchDevices/createDevice/updateDevice/deleteDevice/
  testDeviceConnection/reorderDevices`，`client: ApiClient = defaultApiClient` 尾参惯例。
- fe `DevicesPage.tsx`、`global-device-provider.tsx`、`sidebar-device-list.tsx` 切换到端点函数。

### T4 features.agentUi
- `runtime.ts` options 增 `features?: { agentUi?: boolean }`（resolve 后默认 `{ agentUi: true }`），
  `RuntimeCore`/`AppRuntime` 透出。
- `files-tab.tsx` 「发送到 Agent」菜单两处、`rsync-install-flow.ts` 编排入口按 `features.agentUi`
  gating；关断时 rsync 缺失走中性 toast 文案（新 i18n key，`bun run build:i18n`）。

### T5 设备树下沉 `@tmex/panels/device-tree`
- 新 `packages/panels/src/device-tree/`；package.json 增 `./device-tree` 子出口。
- 顶层 props（初稿，落地时按实际收敛）：
  `devices` 数据源（或 `queryKey`+client 注入）、`selectedDeviceId/WindowId/PaneId`、
  `onNavigate(path)`（path 已是应用内形状，宿主经 appPath 化的 navigate 消费）、
  `ensureDeviceSubscribed(deviceId)`、`expansionKeyFor?(deviceId)`（缺省恒等）、
  `agent?: SidebarAgentAdapter`（可选装饰 slot：usePaneSessions/activeSessionId/会话回调/renderPaneBranch）。
- agent 装饰实现整体迁 fe 新文件 `apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx`，
  经 adapter 注入；包内零 agent import。
- fe `sidebar-device-list.tsx` 改薄壳。回归：fe e2e 侧边栏用例全绿（含 agent 会话路径）。

### T6 设备控制台下沉 `@tmex/panels/device-console`
- 新 `packages/panels/src/device-console/`；导出 `DeviceConsole`、`DeviceConsoleActions`、标题构造。
- 参数化：`{deviceId, windowId, paneId}` 宿主传入；navigate 模板经 appPath；devices fetch 走 T3；
  `ShortcutsBar` 增 `supportedShortcutActions` 过滤（`newAgentSession` 在 `features.agentUi=false`
  时过滤，避免服务端快捷键配置出现死按钮）；window/pane 深链失效回落增加 settle 宽限（~2.5s，
  覆盖 select ack 与快照传播）。
- fe `DevicePage.tsx` 改薄壳。

## 验收

- 每步：`bun test`（受影响包）+ `bun run build:check`（如有）+ fe e2e 相关用例。
- 全量完成后：fe 完整 e2e 一轮；`bun run build` 产物正常。
