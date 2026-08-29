# 侧栏 / 设备页 / 设置 第二轮打磨 计划

## 背景

接续 `2026082903-sidebar-devices-settings-polish`（分支 `chore/merge-hub-tabs`，base 07fd162a）。用户实测反馈六项问题，按角色分派：codex（gpt-5.6-luna）只读探索出代码 MAP（`sub/explore-result.md`），Opus 前端 agent 按互不重叠的文件范围并行编码，codex（gpt-5.6-sol）分批审查（`sub/review1-result.md`、`sub/review2-result.md`），指挥官接线、实测、拍板修复项。本轮无后端改动。

## 任务与落点

1. 侧栏
   - 1.1 节点拖排：用户后来确认原本就可以，排除。
   - 1.2 切换不同 node 的终端时侧栏闪烁：根因是 `/` 与 `/n/:nodeId` 两棵独立路由树各挂一份 `NodeShell`，且 `RuntimeProvider` 按 runtime key 重挂子树。改成单棵 `RootLayout` 路由树，外壳常驻 self 运行时，`NodeRuntimeBoundary` 只包页面区（`MainInset` 内 `<Outlet/>`），登录门闸也只挡页面区；智能体/文件标签按路由 node 单独套 `NodeRuntimeScope`。
2. 设备管理页
   - 2.1 拖动把手预览：`DragOverlay` 改卡片形态，`fit-content` + 本地 `snapCenterToCursor` 修正 overlay 落在整节矩形左上角的问题。
   - 2.2 卡片布局：连接开关去 `min-w`/`justify-start`，网格 `auto-fill minmax(24rem,1fr)`，名称 truncate + tooltip。
   - 2.3 重复卡片 / 「测试」文件夹：`useDeviceFolders` 原用路由 runtime，在 `/n/<id>/devices` 下渲染的是远端节点的分组布局；固定打 self；节点/设备/快照按 id 去重。
   - 2.4 去掉「移到最外层」落点条与「移出分组」按钮：整树成为 root droppable，分层碰撞检测，拖动中乐观布局让目标容器同级实时退避。
3. 语言下拉即时生效：`createLanguagePreviewController`（预览 / 保存落定 / 未保存离开回退，记录在途请求），去掉「刷新后生效」提示。
4. 多节点互联 / 账号安全改右侧滑出面板（`?panel=nodes|security`，`SidePanelHost` 挂在 `RootLayout`），删除 `/account/security` 页（老链接重定向）；面板正文独立滚动修复 TOTP 展开后滚不动；六格 OTP 输入（`@tmex/ui/otp-input`）登录页同款。
5. 智能体空态提示 i18n：`agent.session.selectPaneHint` 等文案修正，英文 `sidebar.tab.panes` 改 Terminals。
6. 品牌区：主行固定 `tmex`，副行显示 entry 节点名（mesh 节点列表中 self 的名字；standalone 退回站点名，等于产品名时不显示）。

## 验收

- 单测：apps/fe、packages/panels、packages/ui、packages/shared 全绿；tsc 0 错误。
- 实测：`sub/live-mesh.ts` 起临时 hub(hub,node)+node 双实例（production 模式、独立 tmux socket、随机端口），Playwright 脚本验证面板开关/滚动、OTP 连续输入与退格、语言即时切换与离开回退、侧栏跨 node 导航 DOM 不重挂、节点拖入分组 / 拖到根层。
- 本机生产用 `npm pack` tarball + `upgrade --apply-current-package` 升级。

## 注意事项

- `useParams()` 在父路由拿不到子路由的 `:nodeId`，`useRouteNodeId` 改为解析 pathname。
- `RuntimeProvider` 的 runtime key 是 react-query observer 绑定所必需，不能去掉，只能把外壳挪到 keyed 子树之外。
- 侧栏常驻 self 后 `NavLink` 生成的 `/devices`、`/settings` 不再带 `/n/<id>` 前缀（审查提出，判定为可接受：设备页已是全局视图、设置齿轮即本机设置）。
