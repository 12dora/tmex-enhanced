# Prompt

两个相互独立但同批实施的改造：

A. gateway 增加 tmux 树快照 REST 端点，供脚本/CLI 等非 WS 客户端消费：

- 新增 `GET /api/tmux/tree`，返回 device→session→window→pane 树快照。
- 数据源必须与 WS 快照同源：复用 gateway 内部现有 snapshot 结构（`StateSnapshotPayload`），不发明第二套树模型。
- 鉴权语义与相邻 `/api` 端点（`GET /api/devices`、`GET /api/devices/{id}/tree-order`）保持一致。
- 按 gateway 既有端点测试模式补测试。

B. 侧边栏三 Tab 互斥改并列分区（平铺）：

- `apps/fe` 的 `app-sidebar.tsx` 去掉 `<Tabs>` 互斥切换，panes / agent / files 三区块改为 Collapsible 分区、默认全部展开；折叠时卸载内容（保留 React.lazy 首屏优化的一部分）。
- `AgentTab` 根节点 `h-full` 改 `flex-1`，与 DeviceList / FilesTab 的 `flex-1` 协作分高。
- 全部 `setSidebarTab` 调用点（agent-tab.tsx、sidebar-device-list.tsx、rsync-install-flow.ts、DevicePage.tsx）改为展开/聚焦对应分区；`ui.ts` 的 `sidebarTab` 状态与相关 i18n key 清理（改源后跑 `build:i18n`）。
- 首页、设备管理页（/devices）及相关入口一概不动；footer NavMain 的设备管理入口保留原样。
- e2e 更新 4 个 spec（「点 Tab」改「分区常驻可见」）：agent-session.spec.ts、mobile-agent-watch.spec.ts、files-context-menu.spec.ts、sidebar-pane-menu-alignment.spec.ts；并修正 agent-session.spec.ts 中「sidebarTab 持久化」的过时注释。

门禁：`bun test` 全绿；上述 4 个 e2e spec 全绿（独立 tmux socket / 专用端口）；`bun run build:fe` 通过。
