# 前端代码异味清单

## 优先级排名

| 排名 | 文件与符号 | 行范围 | 行数 | 主要问题 |
|---|---|---:|---:|---|
| 1 | [`device-console.tsx`](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/device-console/device-console.tsx:109) `DeviceConsole` | 109–1471 | 1363 | 路由、终端选择、同步、快捷键、编辑器、响应式布局全部耦合 |
| 2 | [`agent.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent.ts:161) `createAgentStore` | 161–1109 | 949 | WebSocket 事件、历史同步、REST 操作、持久化和 UI 状态混合 |
| 3 | [`Terminal.tsx`](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/Terminal.tsx:160) `Terminal` | 160–1024 | 865 | 终端初始化、资源生命周期、输入、剪贴板、文件链接、布局全部集中 |
| 4 | [`sidebar-device-list.tsx`](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/device-tree/sidebar-device-list.tsx:1) 设备树模块 | 1–1383 | 1383 | 多层 DnD、路由、菜单、重命名、订阅、设备/窗口/面板渲染混合 |
| 5 | [`tmux.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux.ts:108) `createTmuxStore` | 108–885 | 778 | 传输层事件、多种订阅、连接状态、tmux 命令集中在一个 Store |
| 6 | [`SplitTerminalArea.tsx`](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/SplitTerminalArea.tsx:137) `SplitTerminalArea` | 137–748 | 612 | 分屏几何、拖拽、窗口尺寸同步、终端渲染和服务端操作耦合 |
| 7 | [`files-tab.tsx`](https://example.invalid) `DirNode` | 322–593 | 272 | 递归目录树同时负责查询、轮询、上传、错误处理和菜单 |
| 8 | [`SettingsPage.tsx`](/Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/SettingsPage.tsx:67) `SettingsPage` | 67–491 | 425 | 页面表单、站点设置、主题、语言、通知、AI、终端设置全部集中 |

> `files-tab.tsx` 的本地链接路径应为 [`files-tab.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/files/files-tab.tsx:322 )；上表中的 URL 仅表示该文件条目。

## 1. `DeviceConsole`：超大组件和终端控制器

- 文件：[`packages/panels/src/device-console/device-console.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/device-console/device-console.tsx:109 )
- 符号：`DeviceConsole`
- 行范围：109–1471
- 行数：1363
- 复杂度：路由参数解析、活动面板跟随、快照恢复、待创建窗口、远程尺寸同步、移动端行为、快捷键动作均通过多个 Effect 和条件分支完成。
- 重复逻辑：快捷键浮层在 1250–1260 和 1282–1295 两处重复渲染；编辑器整段发送和逐行发送在 1103–1170 之间存在重复的草稿、历史和发送状态处理。

这是当前区域内最明显的 God Component。任何一个终端选择或路由同步改动，都可能影响移动端布局、终端生命周期和 URL 状态。

安全重构建议：

- 提取 `useDevicePaneSelection`，负责 `resolveRouteTarget`、活动面板跟随、快照跟随、待创建窗口和远程尺寸同步。
- 提取 `useEditorInput`，统一处理 `handleEditorSend`、逐行发送、草稿清理、历史记录和发送反馈。
- 提取 `TerminalShortcutsSlot`，合并两处快捷键浮层渲染。
- 保持 `DeviceConsole` 作为组合组件，保留现有 Store、路由参数和终端组件接口不变。

现有验证入口：

- `packages/panels/src/device-console/selection-recovery.test.ts`
- `apps/fe/tests/ws-borsh-pane-route.spec.ts`
- `apps/fe/tests/ws-borsh-switch-barrier.spec.ts`
- `apps/fe/tests/ws-borsh-resize.spec.ts`
- `apps/fe/tests/split-*.spec.ts`
- `apps/fe/tests/terminal-*.spec.ts`
- 目前没有直接针对 `DeviceConsole` 组件或其 Effect 的单元测试，主要依赖 E2E。

## 2. `createAgentStore`：事件路由与业务状态混合

- 文件：[`packages/stores/src/agent.ts`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent.ts:161 )
- 符号：`createAgentStore`
- 行范围：161–1109
- 行数：949
- 相关长函数：`setupClientHandlers`，277–654，共 378 行。
- 复杂度：566–639 的事件类型 `switch` 覆盖同步、状态、文本增量、推理增量、工具调用、确认、错误、队列和完成事件。

该 Store 同时处理 WebSocket 解码、事件分发、增量缓冲、历史同步、REST CRUD、草稿、确认请求和持久化，违反单一职责，且事件协议变更会直接影响 Zustand 状态逻辑。

安全重构建议：

- `agent-event-router.ts`：按事件类型建立类型安全的 handler map。
- `agent-history-sync.ts`：承载增量合并、刷新防抖、in-flight 请求和历史重载。
- `agent-session-actions.ts`：承载创建、发送、队列、确认、草稿等操作。
- 保留 `createAgentStore` 作为组合根，保持公开的 `AgentState` 接口不变。

现有验证入口：

- `packages/stores/src/agent-thread.test.ts`
- `apps/fe/tests/agent-session.spec.ts`
- 当前没有直接覆盖 Agent Store WebSocket 事件路由、并发历史刷新和增量合并的单元测试。

## 3. `Terminal`：终端生命周期与 UI 交互全耦合

- 文件：[`packages/terminal-ui/src/components/Terminal.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/Terminal.tsx:160 )
- 符号：`Terminal`
- 行范围：160–1024
- 行数：865
- 复杂度：293–534 的异步终端资源初始化和恢复逻辑约 242 行；其余代码还混合输入、链接、选择、剪贴板、焦点和尺寸处理。

安全重构建议：

- `useTerminalBootSurface`：终端 Surface、字体、控制器初始化和释放。
- `usePaneSinkRegistration`：面板数据流、注册表、历史和快照。
- `useTerminalInput`：键盘输入、IME、鼠标和自定义快捷键。
- `useTerminalFileLinks`：文件链接解析和下载。
- `useTerminalClipboard`：选择、复制和剪贴板工具栏。
- 保留 `TerminalRef` 和现有渲染容器，避免改变终端实例生命周期。

现有验证入口：

- `packages/terminal-ui/src/components/normalization.test.ts`
- `packages/terminal-ui/src/components/terminal-diagnostics.test.ts`
- `packages/terminal-ui/src/components/utils/*.test.ts`
- `apps/fe/tests/terminal-ui.spec.ts`
- `apps/fe/tests/terminal-clipboard.spec.ts`
- `apps/fe/tests/terminal-focus.spec.ts`
- `apps/fe/tests/terminal-file-links.spec.ts`
- `apps/fe/tests/terminal-render-regressions.spec.ts`

## 4. 设备树模块：嵌套 DnD 与菜单逻辑重复

- 文件：[`packages/panels/src/device-tree/sidebar-device-list.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/device-tree/sidebar-device-list.tsx:1 )
- 符号：`SideBarDeviceList`、`DeviceSection`、`WindowItem`、`PaneRow`
- 模块范围：1–1383
- 行数：1383
- 主要函数：
  - `SideBarDeviceList`：139–657，共 519 行
  - `DeviceSection`：680–846，共 167 行
  - `WindowItem`：865–1152，共 288 行
  - `PaneRow`：1154–1383，共 230 行
- 重复逻辑：窗口菜单 972–1108 与面板菜单 1243–1355 大量重复，包括重命名、新建 Agent、拆分、Watch 和关闭操作。

该模块同时负责 URL 解析、待处理导航、设备订阅、排序 mutation、确认对话框以及三层设备/窗口/面板渲染。`DeviceSection` 和 `WindowItem` 中分别创建 DnD 上下文和传感器配置，也增加了维护难度。

安全重构建议：

- `device-tree-navigation.ts`：提取路由解析、待处理导航和窗口/面板跳转。
- `DeviceActionsMenu`：用动作模型和 handler map 统一窗口与面板菜单。
- `DeviceTreeDndContext`：集中拖拽传感器和激活约束。
- 分离 `DeviceRow`、`WindowRow`、`PaneRow` 的纯渲染部分，保留原有排序 mutation 和 URL 语义。

现有验证入口：

- `apps/fe/tests/sidebar-device-disclosure.spec.ts`
- `apps/fe/tests/sidebar-close-confirm.spec.ts`
- `apps/fe/tests/sidebar-rename.spec.ts`
- `apps/fe/tests/sidebar-click-no-pty-injection.spec.ts`
- `apps/fe/tests/sidebar-pane-menu-alignment.spec.ts`
- `apps/fe/tests/sidebar-resize.spec.ts`

## 5. `createTmuxStore`：传输层事件 God Store

- 文件：[`packages/stores/src/tmux.ts`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux.ts:108 )
- 符号：`createTmuxStore`
- 行范围：108–885
- 行数：778
- 相关长函数：
  - `setupTransportHandlers`：172–435，共 264 行
  - `handleTransportEvent`：247–410，共 164 行
- 复杂度：`handleTransportEvent` 的 `switch` 覆盖连接状态、终端数据、快照、历史、订阅、选择确认、剪贴板、主题和错误事件。

安全重构建议：

- `tmux-event-router.ts`：按 `GatewayTransportEvent['type']` 拆分事件处理器。
- `pane-subscriptions.ts`：管理挂载计数、手动订阅、生成号和历史/快照订阅。
- `tmux-selection-actions.ts`：管理选中设备、窗口、面板和 pending selection。
- 保持 `TmuxState` 对外结构不变，避免影响现有面板和终端组件。

现有验证入口：

- `packages/stores/src/tmux-shared-transport.test.ts`
- `packages/stores/src/tmux-sync-theme.test.ts`
- `packages/stores/src/tmux-host-managed-notifications.test.ts`
- `apps/fe/tests/ws-borsh-*.spec.ts`
- `apps/fe/tests/split-*.spec.ts`

## 6. `SplitTerminalArea`：布局、拖拽和网络命令混合

- 文件：[`packages/terminal-ui/src/components/SplitTerminalArea.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/SplitTerminalArea.tsx:137 )
- 符号：`SplitTerminalArea`
- 行范围：137–748
- 行数：612
- 复杂度：窗口尺寸上报、分屏几何、分隔条拖拽、标题栏拖拽、跨窗口移动和面板拆分均在一个组件中。
- 重点函数：`handleTitleBarPointerDown` 为 380–499，共 120 行，虽然未超过 120 行阈值，但包含较多命中测试、拖拽状态和条件分支。

安全重构建议：

- `useSplitGeometry`：管理尺寸解析、pane size 和布局计算。
- `useWindowResizeReporter`：管理 ResizeObserver、防抖和重试。
- `useSplitDragInteractions`：拆分分隔条拖拽和标题栏拖拽。
- `SplitPaneView`：只负责单个面板标题栏、终端和拖拽状态渲染。

现有验证入口：

- `packages/terminal-ui/src/components/splitLayoutGeometry.test.ts`
- `apps/fe/tests/split-screen-desktop.spec.ts`
- `apps/fe/tests/split-screen-mobile.spec.ts`
- `apps/fe/tests/split-content-persistence.spec.ts`
- `apps/fe/tests/split-selection-persistence.spec.ts`
- `apps/fe/tests/terminal-mouse-row-alignment.spec.ts`

## 7. `DirNode`：递归目录树中的业务控制器

- 文件：[`packages/panels/src/files/files-tab.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/files/files-tab.tsx:322 )
- 符号：`DirNode`
- 行范围：322–593
- 行数：272
- 复杂度：递归渲染、每目录查询和轮询、拖拽上传、分块上传取消、rsync 缺失提示、展开状态修正和右键菜单混合。

安全重构建议：

- `useDirectoryListing`：保留现有 query key、展开状态和 30 秒轮询。
- `useDirectoryUpload`：封装分块上传、AbortController 和 Toast。
- `useRsyncMissingToast`：独立处理安装提示。
- `DirectoryNodeView` 与 `FileNodeActions`：分别负责目录和文件的展示/菜单。

现有验证入口：

- `apps/fe/tests/files-context-menu.spec.ts`
- `apps/fe/tests/settings-files.spec.ts`
- `apps/fe/tests/terminal-file-links.spec.ts`
- 当前没有针对递归目录状态、上传取消和展开状态修正的直接单元测试。

## 8. `SettingsPage`：页面级表单 God Component

- 文件：[`apps/fe/src/pages/SettingsPage.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/SettingsPage.tsx:67 )
- 符号：`SettingsPage`
- 行范围：67–491
- 行数：425
- 复杂度：同时维护多个 Tab、站点设置查询/保存、主题、语言、通知、AI 和终端配置，包含约 12 个本地状态。

安全重构建议：

- `useSiteSettingsForm`：负责查询 hydrate、draft、payload、保存和错误处理。
- `GeneralSettingsTab`、`NotificationSettingsTab`、`AISettingsTab`、`TerminalSettingsTab`：各自管理字段展示。
- `SettingsTabs`：只负责 Tab 选择和内容组合。
- 表单抽象必须保留当前字段默认值、保存 payload 和响应式布局。

现有验证入口：

- `apps/fe/tests/settings.spec.ts`
- `apps/fe/tests/mobile-settings.spec.ts`
- `apps/fe/tests/settings-llm.spec.ts`
- `apps/fe/tests/settings-files.spec.ts`
- `apps/fe/tests/theme-broadcast.spec.ts`
- 当前没有 SSH 重连配置的回归测试。

## 补充候选：`ui/sidebar.tsx` 模块聚合过多

- 文件：[`packages/ui/src/components/sidebar.tsx`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/ui/src/components/sidebar.tsx:1 )
- 符号：`SidebarProvider` 及全部 Sidebar primitives
- 行范围：1–860
- 行数：860
- 异味：同一文件同时包含宽度持久化、响应式 Provider、布局、拖拽调整器、菜单、分组、输入框、徽标、底部和分隔线等 20 多个导出组件。`SidebarProvider` 本身为 71–224，共 154 行。
- 安全重构建议：
  - `sidebar-provider.tsx`：Context、宽度持久化、快捷键。
  - `sidebar-layout.tsx`：`Sidebar`、`SidebarResizer`、`SidebarInset`。
  - `sidebar-primitives.tsx`：菜单、分组、按钮和展示型包装组件。
  - 保留原有 barrel export，避免改变调用方导入路径。
- 现有验证入口：`apps/fe/tests/sidebar-resize.spec.ts`、`mobile-sidebar-safe-area.spec.ts`、`terminal-clipboard.spec.ts`。没有直接的 Sidebar 组件单元测试。

## 确认的 BUG

### BUG-1：SettingsPage 保存时会覆盖 SSH 重连配置

- 文件：[`apps/fe/src/pages/SettingsPage.tsx:90`]( /Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/SettingsPage.tsx:90 )、[`SettingsPage.tsx:117`]( /Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/SettingsPage.tsx:117 )、[`SettingsPage.tsx:130`]( /Users/konata/code/tmex-enhanced-wt-smell/apps/fe/src/pages/SettingsPage.tsx:130 )

`sshReconnectMaxRetries` 和 `sshReconnectDelaySeconds` 的本地初始值分别为 `2` 和 `10`，并且始终包含在保存 payload 中；但是加载站点设置的 Effect 没有调用对应的两个 setter。因此，当服务端已有非默认 SSH 重连配置时，用户打开设置页并保存任意设置，这两个字段会被静默重置为 `2` 和 `10`。安全修复是在 hydrate Effect 中同步设置这两个字段，并增加“加载非默认值后保存其他设置，SSH 配置保持不变”的测试。

### BUG-2：Agent 会话相同时间戳时排序比较器违反比较器契约

- 文件：[`packages/stores/src/agent.ts:140`]( /Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent.ts:140 )

`sortSessionOrder` 在 `a.updatedAt === b.updatedAt` 时仍返回 `-1`，导致 `sort` 比较器对两个方向都返回 `-1`，不满足反对称性。多个会话在同一时间戳创建或更新时，排序结果可能依赖运行时排序实现或原始数组顺序，表现为会话顺序不稳定。安全修复是先比较时间戳；时间戳相等时使用稳定的 `id` 作为 tie-breaker，并补充相同时间戳的排序测试。

## 测试覆盖结论

现有测试主要覆盖 E2E 行为和少量纯函数/Store 边界：

- 已覆盖：终端输入、尺寸同步、分屏几何、设备树导航、侧边栏拖拽、文件菜单、设置页主要 Tab、Agent 会话流程。
- 覆盖不足：`DeviceConsole`、`Terminal`、`SplitTerminalArea`、`DirNode`、`SettingsPage` 均缺少针对核心 Hook/状态机的直接单元测试。
- 明确缺失：Agent Store 事件路由和并发历史同步测试；SettingsPage SSH 重连配置 hydrate/保存回归测试。
- 未对生成文件提出任何修改建议。