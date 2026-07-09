# 执行结果

## 落地内容

### A. `GET /api/tmux/tree`（feat(gateway)）

- `apps/gateway/src/api/tmux-tree.ts`：新端点，返回 `{ devices: [{ deviceId, deviceName, session: TmuxSession | null }] }`；支持 `?deviceId=` 单设备过滤（不存在 404）。挂载于 `api/index.ts`，鉴权语义与相邻 `/api` 端点一致（无独立鉴权）。
- 数据源同源：`getDeviceSnapshot()`（wsServer lastSnapshot，snapshot-directory 注册表）优先，`pushSupervisor.getLastSnapshot()`（新增公开方法，常驻连接快照）兜底；无快照设备 `session: null`。
- overlay 与 WS 下发同链：`applyDeviceTreeOverlay`（排序，复用）+ 新增纯函数 `applyCustomNamesOverlay`（ws/overlay-utils.ts，自定义 window/pane 名，无 stale 清理副作用——那是 wsServer 内存 overlay 的职责）。
- 测试 `api/tmux-tree.test.ts`：7 用例（空快照 null、快照树、排序 overlay、自定义名 overlay、deviceId 过滤与 404、非 GET 忽略、路由挂载）。注意：同进程测试共享 `:memory:` 库，断言不假设设备全集。

### B. 侧边栏平铺（feat(fe)）

- `app-sidebar.tsx`：去 `<Tabs>` 互斥，panes/agent/files 改三个受控 `Collapsible` 分区（`data-testid="sidebar-section-{panes,agent,files}"`，分区头 `sidebar-section-toggle-*`），默认全展开；展开分区 `flex-1 min-h-0` 分高、折叠 `shrink-0` 只留分区头；折叠即卸载（base-ui Panel 默认 `keepMounted=false`）。AgentTab/FilesTab 维持 React.lazy。Footer（NavMain 设备管理入口）常驻。
- 高度分配修正（e2e 实测暴露）：三区均分会把 Agent 聊天区压到 0（确认卡片被输入区遮挡、点击被拦截）。解法：agent-tab 根 `h-full`→`flex-1` + `min-h-[360px]`，`CollapsibleContent` 用 `overflow-y-auto`——分区高度不足时内容在分区内滚动（小屏/移动 Sheet 下输入框滚动可达）。
- stores：`sidebarTab/SidebarTab/setSidebarTab` → `sidebarSections/SidebarSection/setSidebarSectionOpen/expandSidebarSection`（默认全 true、不持久化，persist merge 同时丢弃旧 `sidebarTab` 残留）。5 处程序化切 Tab 调用点改 `expandSidebarSection`（幂等展开）。
- i18n：`sidebar.tab.*`→`sidebar.section.*`（三语言，值不变），`bun run build:i18n` 重建 resources.ts/types.ts。
- SettingsPage 内联原从 app-sidebar 导入的 `tabTriggerClassName`（唯一消费者，行为零变化）。
- 首页、设备管理页（/devices）及入口未动。
- e2e：4 spec 从「点 Tab」改「分区常驻可见」断言；修正 agent-session.spec.ts 中「sidebarTab 持久化」过时注释。

## 验证证据

- `apps/gateway` `bun run test`：836 pass / 0 fail。
- 各 packages `bun run test`：api-client 7、app 72、ghostty-terminal 108、notifications 16、shared 91、stores 30、terminal-ui 89、theme 3、ui 4、ws-client 23，全部 0 fail（panels 无测试文件，基线现状）。
  - 说明:从仓库根裸跑 `bun test` 会把 playwright spec 吞进 bun test 并产生跨 workspace 资源冲突,基线即有 ~110 fail,与本次改动无关;门禁以 per-workspace `bun run test` 口径为准。
- e2e（`bun run test:e2e`，独立 tmux socket `tmex-e2e`、动态端口）：
  - 门禁 4 spec 一次性跑：12 passed（agent-session 6、mobile-agent-watch 2、files-context-menu 3、sidebar-pane-menu-alignment 1）。
  - 回归面补跑：sidebar-rename / sidebar-close-confirm / sidebar-click-no-pty-injection / sidebar-resize / mobile-nav / mobile-sidebar-safe-area / watch 共 13 passed。
- `bun run build:fe`：通过（vite build Exited with code 0）。
- 目检：一次性 spec 截桌面（三分区并列 + agent 折叠卸载）与移动 Sheet（三分区并列）截图，布局正常。

## 性能影响（PR 标注）

三分区默认全展开使 AgentTab/FilesTab 的 lazy chunk 在首屏即被请求，抵消 Tab 互斥时代的按需加载收益；entry chunk 体积不变（仍动态 import 分包），变化仅是请求时机提前。用户折叠分区后内容卸载，「折叠后不再展开」场景下懒加载仍有效。

## commit 清单

- de5d5a9 docs(archives) 计划存档
- c13ceb6 feat(gateway) GET /api/tmux/tree 树快照 REST 端点
- 8db44aa test(gateway) tmux-tree 测试去除设备全集断言
- 465c94b feat(fe) 侧边栏三 Tab 互斥改并列 Collapsible 分区
- 8c4dc4d test(e2e) 侧边栏并列分区后更新交互路径
- 0706f73 fix(fe) 并列分区高度分配——Agent 分区最小高度与分区内滚动

## 遗留

- 移动端三分区并列时 Agent 输入框需分区内滚动才可见（`min-h-[360px]` 超出小屏分区高度）；若体验反馈不佳，可考虑分区差异化 flex 权重或移动端默认折叠部分分区。
- `sidebar-section-toggle-*` 折叠交互目前仅一次性目检 spec 覆盖过（agent 折叠→`agent-tab` 卸载），未沉淀常驻 e2e 用例。
