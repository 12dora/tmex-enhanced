# f1 结果：移除独立 `/nodes` 页 + 节点管理合并为一张卡片

## A. 移除独立 `/nodes` 页

- `apps/fe/src/main.tsx`
  - 删除 `nodesModule` 懒加载；`react-router` 增加 `Navigate` 导入。
  - `/nodes` 路由保留但改为兼容重定向：`{ path: '/nodes', element: <Navigate to="/settings?tab=nodes" replace /> }`（老书签、`packages/app` 的 SPA deep-link 测试都不受影响）。
- `apps/fe/src/pages/SettingsPage.tsx`
  - 新增 `SETTINGS_TABS` / `isSettingsTab()`；`activeTab` 初值取自 `useSearchParams()` 的 `?tab=`，非法值退回 `general`。
  - 新增一个 `useEffect` 跟随 `tab` query 变化（已停在 `/settings` 时再点侧栏「节点」入口只换 query、组件不重挂载，必须同步）。
  - 切换标签走 `selectTab()`：`setSearchParams(..., { replace: true })`，不往历史里塞记录。
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`
  - mesh 专属的 `Network` 入口由 `/nodes` 改为 `/settings?tab=nodes`；仍走 `NavLink`，`hostAppPath` 为纯前缀拼接，`/n/<id>/settings?tab=nodes` 正常。
- 删除：`apps/fe/src/pages/NodesPage.tsx`、`apps/fe/src/pages/NodesPage.test.tsx`。
- 注释更新（原文描述 `/nodes` 是无侧栏页）：`apps/fe/src/page-wrapper.tsx`、`apps/fe/src/page-wrapper.test.tsx`、`apps/fe/src/components/brand.tsx`。

## B. 节点管理合并成一张卡片

- 目录移动：`apps/fe/src/pages/nodes/**` → `apps/fe/src/pages/settings/nodes/management/**`
  （`enrollment-section.tsx`、`nodes-management.tsx`、`nodes-table.tsx`、`types.ts`、`use-admit-action.ts`）。
  外部唯一引用方 `apps/fe/src/pages/settings/nodes/nodes-tab.tsx` 改为 `import { NodesManagement } from './management/nodes-management';`，JSX 改为 `{mode && <NodesManagement mode={mode} />}`（只动了这两行）。
- `nodes-management.tsx`：整块改成一张 `Card`（与 `LocalMachineCard` 同款：裸 `<Card>` + `CardHeader`/`CardTitle` + `CardContent className="flex flex-col gap-3"`，新增 `data-testid="nodes-management"`）。
  - 卡头标题 `nodes.management.title`；右侧 `CardAction`：ghost `icon-sm` 刷新按钮（`RefreshCw`，`aria-label`/`title` = `nodes.actions.refresh`，`nodesLoading || hub.loading` 时旋转）+ primary `sm` 的「添加」按钮（`nodes.actions.add`，hub 离线禁用，切换内联加入码表单）。
  - 卡体顺序：hub 离线提示 → 内联加入码表单 → join 串 → 待确认列表 → 节点表 → 凭据对话框。
  - 删掉非 compact 的页级页头与 `compact` / `showAccountSecurityLink` 两个 prop（唯一调用方是设置页，标准页已不存在）；随之删掉管理主体自带的「账号安全」链接（`LocalMachineCard` 里那个入口仍在）。
  - 无 uid/kdfParams 时也渲染同一张卡片，仅卡体给 `auth.errors.UNKNOWN_USER`，不再渲染任何管理动作。
- `enrollment-section.tsx`：不再自己画边框与标题，改为返回 fragment；展开态由父组件 `open` prop 控制。删掉旧的「添加节点」按钮与说明段落。表单本身包一层 `rounded-lg border border-border/60 p-3`。
- `nodes-table.tsx`：外层由 `rounded-xl border border-border bg-background` 改为内层 `rounded-lg border border-border/60`（保留横向滚动容器），视觉上与卡片是同一个盒子。

## 测试

- 新增 `apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx`，迁移 `NodesPage.test.tsx` 里仍有价值的静态断言（mesh 表格渲染/self 在前/指纹/登录按钮、hub 离线时 `nodes-add`/rename/revoke 禁用、缺凭据不渲染管理动作，以及 `canAutoSignAdmit`、`resolveHubPublicUrl` 两组纯函数用例），并加了一条「整块只有一张 card（`data-slot="card"` 只出现一次）+ 刷新/添加在卡头 + 表单默认收起」。
- `apps/fe/src/pages/SettingsPage.test.tsx`：渲染包进 `MemoryRouter`（`useSearchParams` 需要 router），新增「`?tab=` 选中对应面板」「非法 `?tab=` 退回通用」两条；深链正例用「通知」面板验证（额外 `mock.module('./settings/notification-settings-tab')`，该模块只有 SettingsPage 引用，替身不会漏到别的测试文件），**没有**直接渲染 `NodesTab`——它依赖 React Query provider，且 mock 它会污染 `nodes-tab.test.tsx`。
- `sidebar-title.test.tsx`：断言由 `href="/nodes"` 改为 `href="/settings?tab=nodes"`。

## i18n（三语同步，未跑 `build:i18n`，由指挥方统一生成）

新增：

- `nodes.management.title` = 「节点管理」/ "Node management" /「ノード管理」
- `nodes.actions.add` = 「添加」/ "Add" /「追加」

删除（grep 确认无其它引用）：

- `nodes.title`、`nodes.subtitle`（原独立页页头与 PageTitle）
- `nodes.actions.addNode`（被 `nodes.actions.add` 取代）
- `nodes.actions.accountSecurity`（管理主体里的入口已删；`nodes.machine.accountSecurity` 保留）
- `nodes.enrollment.title`、`nodes.enrollment.description`（区块标题与说明段落已合进卡头）

三个 locale 文件都只做定点行替换，未整体重排。

## 验证数字

- `cd apps/fe && bun test src/`：**519 pass / 2 fail**（521 tests / 40 files）。两个失败都在我的范围之外：
  1. `settings/nodes/nodes-tab.test.tsx:151` 期望 `href="/nodes"` —— f2 已从 `local-machine-card.tsx` 删掉该链接，测试待 f2 更新；
  2. `components/page-layouts/components/sidebar-device-list.test.tsx` 的 `SidebarNodeSection`（`useRuntime must be used within <RuntimeProvider>`），来自另一 agent 正在改的 `sidebar-device-list-runtime.tsx`。
- `cd apps/fe && bunx tsc --noEmit -p .`：**3 errors，全部在我范围之外**——`local-machine-card.test.tsx:38`、`nodes-tab.test.tsx:83`、`setup/hub-setup-wizard.test.tsx:29`，都是 `LocalTlsStatus` 新增 `listenerRunning`/`tlsPort` 字段导致（其它 agent 的改动）。我改动的文件 0 error。
- `bunx biome check <改动文件>`：干净（`Checked 14 files … No fixes applied`）。`main.tsx` 单独 check 会报一条 `useExhaustiveDependencies`（第 81 行主题相关 effect），是既有问题，与本次改动无关，未动。

## 遗留

- `nodes.machine.openNodesPage` key 与 `local-machine-card.tsx` 里的链接归 f2；f2 删链接后该 key 也应从三语删掉。
- 两处注释仍写着「与 NodesPage 测试同一套做法」：`settings/nodes/nodes-tab.test.tsx:2`、`settings/nodes/https/https-section.test.tsx:2`（均不在我的文件范围内，未改）。
- 需要指挥方跑一次 `bun run build:i18n` 重新生成 `packages/shared/src/i18n/{resources,types}.ts`。
