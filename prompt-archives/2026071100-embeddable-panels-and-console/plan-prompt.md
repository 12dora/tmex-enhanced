# Prompt 存档

日期：2026-07-11
分支：`vibex/tmex-sidebar-device-management`（基于 86aa974，侧边栏/设备管理与分屏视觉修复已完成）

## 背景

A1 拆包后，`@tmex/terminal-ui` 已经通过 `@tmex/stores/react` 的 `RuntimeProvider` context 解析 runtime
（缺省值 = `defaultRuntime`，开源 fe 单实例形态零改动），`@tmex/ws-client` 也已支持 `socketFactory`
transport 注入。但面向嵌入宿主（embedding hosts，多 runtime 并存、应用路由前缀不同、部分功能不装配）
还残留四类障碍：

1. **`@tmex/panels` 未 context 化**：全部面板从 `@tmex/stores` 主入口 import store hooks（即
   `defaultRuntime.stores.*` 模块级单例），并有约 29 处裸 `fetch('/api/...')` 不走可注入的
   `ApiClient`。在多 runtime 宿主里这些面板会读错 store、打错端点。
2. **URL 构造硬编码应用路由形状**：包内 `/devices/…`、`/file/…` 的构造与 `matchPath` 假设应用挂在
   根路径且路由形状与 fe 完全一致，宿主无法改写。
3. **UI 偏好 store 无法跨 runtime 共享**：`createAppRuntime` 无条件新建 ui store；宿主若并存多个
   runtime，主题/字体/侧边栏展开等纯浏览器本地偏好会分裂成多份。
4. **外壳级 UI 无法复用**：侧边栏设备树（`apps/fe/.../sidebar-device-list.tsx`，~1760 行）与设备终端
   主体（`apps/fe/pages/DevicePage.tsx`，~1600 行）住在 fe 外壳里，嵌入宿主只能整页复制，难以回流。
   另外 agent 相关入口（Files 的「发送到 Agent」、快捷键 `newAgentSession` 等）在不装配 agent 面板的
   宿主里需要可关断，否则出现死入口。

## 任务

按以下顺序落地中性机制（每步 fe 行为零回归）：

- T1 panels 运行时化：store hooks 切 `@tmex/stores/react`；裸 fetch 改 `useRuntime().apiClient`；
  `ConnectionIndicator` 的 reconnect 改 `runtime.client`；`WatchEventsInit` 的四处默认单例硬绑
  runtime 化（初始化防重改 `WeakSet<BorshWebSocketClient>`）。
- T2 `HostServices.appPath(path)`（缺省恒等）：包内 URL 构造/matchPath 经其前缀化；
  `app-navigation.ts` 的 `PANE_URL_RE` 去 `^` 锚定。
- T7 `AppRuntimeOptions.uiStore`：宿主可传入共享 UI store，缺省行为不变。
- T3 `@tmex/api-client` 补 devices 端点函数（`client = defaultApiClient` 尾参惯例），fe 页面切换
  消灭裸 fetch。
- T4 `AppRuntimeOptions.features?: { agentUi?: boolean }`（默认 true）：Files「发送到 Agent」两处与
  rsync→Agent 编排按开关隐藏，rsync 缺失降级为中性提示。
- T5 设备树下沉 `@tmex/panels/device-tree`：订阅回调、选中态 props、导航回调、`expansionKeyFor`、
  devices 数据源参数化；agent 装饰收敛为可选 adapter（实现整体留在 fe 新文件
  `sidebar-agent-sessions.tsx`），包内零 agent import；fe 改薄壳消费。
- T6 设备终端主体下沉 `@tmex/panels/device-console`：`{deviceId, windowId, paneId}` 宿主传入；导航
  经 appPath；快捷键按支持的 action 过滤；深链失效时的 settle 宽限并入组件。
