# 执行结果

分支 `chore/merge-hub-tabs`，07fd162a → 6e50907c（6 个 commit），已 push；本机生产用 `tmex-cli-1.0.2.tgz` `upgrade --apply-current-package` 升级并确认 `/healthz` 与新 bundle hash。

## 落地

| 任务 | 结果 |
|---|---|
| 1.1 节点拖排 | 用户确认原本可用，排除；顺带把侧栏 node 列表碰撞检测改为 pointer 优先并补齐滚动容器 |
| 1.2 侧栏闪烁 | 单棵 `RootLayout` 路由树 + 外壳常驻 self 运行时 + 门闸只包页面区，实测跨 node 导航侧栏 DOM 身份不变 |
| 2.1 拖动预览 | 卡片形态 overlay，`fit-content` + `snapCenterToCursor`，在把手处生成并跟随指针 |
| 2.2 卡片布局 | 连接开关去空白，网格 `auto-fill minmax(24rem,1fr)`，超长 truncate + tooltip |
| 2.3 重复卡片/「测试」文件夹 | 根因：`useDeviceFolders` 走路由 runtime，在 `/n/<id>/devices` 下渲染远端节点的分组布局；固定打 self，并按 id 去重 |
| 2.4 拖出即回根层 + 退避 | 整树 root droppable，分层碰撞（放置区 → 指针所在容器 → 同级 closestCenter），跨容器只插占位块（原节点不重挂），键盘可回根层 |
| 3 语言即时生效 | `createLanguagePreviewController`：选中即切、未保存离开回退（记录在途请求）、保存落定；`<html lang>` 同步 |
| 4 侧滑面板 | `?panel=nodes|security`，`SidePanelHost` 挂 `RootLayout`；应用内打开 push+state、关闭回退历史；正文独立滚动；`/account/security` 页删除并重定向 |
| 4.1 六格 OTP | `@tmex/ui/otp-input`，登录页同款；实测连续输入/退格/粘贴 |
| 5 空态提示 i18n | zh/ja 文案修正，en `sidebar.tab.panes` → Terminals |
| 6 品牌 | 固定 `tmex` + entry 节点名小字（等于产品名时不显示） |

## 审查处理

- review1：修 3/4/6（语言在途竞态、e2e 断言、面板历史重复）；1（门闸外 runtime 级请求）与 5（后台 refetch 覆盖草稿）为既有行为，2（NavLink 不再带 `/n/<id>` 前缀）判定为可接受。
- review2：修 1/2/3/4/6（间隙落点、跨容器预览重挂、键盘回根层、self 失效订阅、弱测试）；5（tooltip 不可聚焦）不改。

## 验证

- 单测：apps/fe 668、packages/panels 496、packages/ui 47、packages/shared 358，全绿；tsc 0 错误（main.tsx 的 `useExhaustiveDependencies` 为既有）。
- 实测：`sub/live-mesh.ts` 临时 hub+node（21500/21501），Playwright 截图见会话；未跑 e2e 全量（`settings.spec` / `mobile-settings.spec` 语言断言已同步改为选中即生效）。

## 已知限制

- standalone 无节点名 API，品牌副行退回站点名。
- `packages/panels` 无 DOM 测试环境，跨容器「不重挂」用容器 id 列表不变的结构断言代替。
- 远端节点的设置齿轮 / 管理设备入口现在指向本机（`/settings`、`/devices`）。
