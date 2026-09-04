# T3 结果 — 设置页「中继管理」标签重构

分支 / 工作区：`/Users/konata/code/tmex-r27`（`feat/round27-relay-mgmt-onboarding`）

## 一、改了什么

### 1. 标签位置与命名（需求 1）

- `apps/fe/src/pages/SettingsPage.tsx`
  - 新增导出的纯函数 `settingsTabBarItems(showRelay)`：`showRelay` 为真时把 `RELAY_TAB_ITEM` 插在 `nodes`（多节点互联）**右侧**、`notifications` 左侧，不再追加到末尾。`SettingsTabBar` 改用它。
  - `OPTIONAL_SETTINGS_TABS = ['relay']` 与「relay 不进 `SETTINGS_TABS`（不预热 chunk）」保持原样。
- i18n `relay.admin.tabLabel`：中继 → **中继管理** / Relay → **Relay Management** / リレー → **中継管理**。

### 2. 速率两位小数（需求 2）

- `relay-format.ts` 的 `formatBytesPerSec` 先把值收到两位小数再交给 `formatRate`（1 KB 以下 `formatBytes` 直接摆原值，之前会出 `12.345678 B/s`）。
  - `12.345678 → 12.35 B/s`、`0 → 0 B/s`、`1023.999 → 1.00 KB/s`；1 KB 以上的读数不变（`16.0 KB/s` 等）。
  - 未动 `packages/api-client/src/format.ts`。

### 3. 页面结构（需求 3）

新增文件（均在 `apps/fe/src/pages/settings/relay/`）：

| 文件 | 作用 |
| --- | --- |
| `relay-menus.tsx` | 页头「更多」（`RelayAdminMenu` / `RelayAdminMenuList`）与租户卡「更多」（`TenantsMenu` / `TenantsMenuList`）。两个 `*MenuList` 不带 hook、文案由 props 传入，单测可当普通函数调用后对元素树断言（portal 规避，同 `BulkActionsMenuList`） |
| `default-quota-dialog.tsx` | `DefaultQuotaDialog` + 导出的 `DefaultQuotaDialogBody`，复用 `QuotaFields` / `parseQuotaDraft` / `quotaToDraft` |
| `tenants-card.tsx` | 租户卡：标题 + 总数 + 「全部」（有选中时出现） + 「更多」→「默认配额…」 |
| `members-card.tsx` | 接入节点卡：检索框 + 状态分段（全部 / 在线 / 离线）+ 计数 + 选中租户的范围标签，内部持有 query/state/sort |

删除：`default-quota-card.tsx`、`relay-cards.tsx`（`RelayPasswordCard` 与已无人引用的 `DefaultQuotaSummary` 一并撤掉）。

改动文件：

- `relay-tab.tsx`：页头加三点菜单（「修改接入密码」→ 现有 `PasswordDialog`）；未设密码时页头下摆一条紧凑 `Notice`（`relay-password-unset-warning`）；正文顺序改为 指标面板 → 租户卡 → 接入节点卡；`RelayTabBody` 成为 `useRelayMetrics({ api })` 的**唯一持有者**（`api` 注入照旧），选中租户 id 也存在这里，`status.tenants.find(...)` 派生 → 租户刷新后消失即自动取消选中（不用 effect）；`RelayTabDialogs` 加 `DefaultQuotaDialog`。指标还没拉到（`metrics.data === null`）时不摆接入节点卡，免得空表被误读成「没有节点」。
- `relay-metrics-panel.tsx`：`RelayMetricsPanel` 改收 `metrics: UseRelayMetricsResult`（不再自己调 hook），成员卡从面板里搬走。对外仍导出 `RelayMetricsRetryLine`（`nodes/relay/relay-service-metrics.tsx` 在用）。
- `relay-metrics-members.tsx`：表头改成可点排序按钮（`aria-sort` + 箭头图标），空态区分「没有匹配」/「还没有节点接入」，行数据由调用方筛好排好。
- `relay-metrics-model.ts`：新增纯函数 `filterMembers` / `sortMembersBy` / `toggleMemberSort` 与 `MemberSort`、`MemberSortKey`、`MemberStateFilter`、`DEFAULT_MEMBER_SORT`（node 升序，`memberTitle` 比较，`nodeId` 稳定收尾）；缺值（离线的 RTT、从未连接的时间）恒排在最后，不随升降序翻面。删掉已无人使用的 `sortMembers`（在线优先那版）。
- `tenant-table.tsx`：行可选（`aria-selected`、`tabIndex=0`、Enter/Space、选中态高亮 + `ring`、`data-selected`、`title` 用 `relay.admin.tenants.selectHint`）。点行内的 `button / input / a`（复制、备注就地编辑、编辑/踢出/删除）不切换选中——用行级 `event.target.closest(...)` 守卫，而不是给单元格挂 `onClick`（后者过不了 `useKeyWithClickEvents`）。为过复杂度门禁（`TenantRow` 曾 140 行 > 120）把节点数 / 配额 / 令牌 / 动作四个单元格拆成独立小组件。
- `use-relay-controller.ts`：加 `quotaOpen` / `openQuota` / `closeQuota`，`submitDefaultQuota` 成功后关框（与改密码同一条路径）。

`wide-table.tsx` 未改（不需要）。

### 4. 文案（需求 4）

`relay.admin.password.*` 三语统一 接入口令 → **接入密码**（title / dialogTitle / change / newPassword / clear / modeKeepHint / modeKickHint / tooShort / saved / failed / dialogDescription / unsetWarning）。en_US 用 Access Password，ja_JP 用 接続パスワード。

- 删除 `relay.admin.password.minTokenEpoch`（令牌下限行整个撤掉）。
- `relay.admin.password.epoch` 值改为 密码代次 / Password generation / パスワード世代。
- `relay.admin.password.set` / `unset` 值未动（`nodes/relay-service-section.tsx`、`setup/become-relay-form.tsx` 仍在用）。

新增 key（三语齐全）：`relay.admin.more`、`relay.admin.quota.menuItem`、`relay.admin.tenants.clearSelection`、`relay.admin.tenants.selectHint`、`relay.metrics.members.noMatch` / `searchPlaceholder` / `stateFilter` / `all`。

只动了 `relay.admin.*`、`relay.metrics.*` 两个子对象（`settings.tabGroup.*` 无需改动），未碰 `relay.tenant.*` / `nodes.*` / `connectDevices.*`。改完在仓库根跑了 `bun run build:i18n`（`resources.ts`、`types.ts`、`locales/generated/*` 为其产物）。

## 二、测试

- `cd apps/fe && bun test src/pages/settings/relay src/pages/SettingsPage.test.tsx` → **170 pass / 0 fail**（基线 138）。
- `cd apps/fe && bun test src/pages/settings src/pages/SettingsPage.test.tsx` → 1226 pass / 0 fail。
- `cd apps/fe && bun test src` → **2331 pass / 0 fail**（131 文件）。
- `bunx tsc --noEmit -p apps/fe` → 0 error。
- `bun scripts/complexity/gate.ts` → ok（1518 文件 / 13610 函数）。
- `bunx biome check apps/fe/src/pages/settings/relay apps/fe/src/pages/SettingsPage.tsx apps/fe/src/pages/SettingsPage.test.tsx` → 0 error。

新增/改写的用例：

- `relay-mgmt-ui.test.tsx`（新，12 例）：两个菜单的项 id 与 onClick 回调；`DefaultQuotaDialogBody` 的三个字段与错误条；接入节点卡的检索框/状态分段/计数、选中租户后只留该租户的行且卡头写明范围、「没有匹配」与「还没有节点接入」两种空态、默认按名字升序、分段按下态、`tenantScopeLabel`。
- `relay-metrics-ui.test.tsx`：新增 `filterMembers`（租户 / 状态 / 关键词 / 叠加）、`sortMembersBy`（七列、方向、缺值恒最后、稳定收尾、不改原数组）、`toggleMemberSort` 三组；成员表用例改成注入 `sort`/`onSort`，新增表头可点 + `aria-sort` 与两种空态；`RelayMetricsPanel` 用例改用注入 `metrics` 的壳组件，并加一条「成员表已挪出面板」。删掉旧 `sortMembers`（在线优先）用例——该函数已删。
- `relay-format.test.ts`：新增「1 KB 以下最多两位小数」。
- `relay-tab.test.tsx`：正文断言改为 页头/租户卡菜单在、口令卡与配额卡不在、接入节点卡在租户卡之后且带检索与状态分段、指标未到时不摆节点卡、有/无密码两种页头、租户行可选（`aria-selected="false"` / `tabindex="0"` / `selectHint` / 未选中时无「全部」）；api 注入用例改成钉 `useRelayMetrics({ api })` 且全文件只出现一次（回路唯一）。
- `settings-tab-gating.test.tsx`：中继标签「紧挨多节点互联右侧、通知左侧」。
- `SettingsPage.test.tsx`：新增 `settingsTabBarItems` 两例（无中继角色 = 七个常规标签；有中继角色时插在 nodes 之后、notifications 之前）。

## 三、遗留 / 需要注意

1. **`packages/shared` 的 i18n 一致性测试当前为红，与本任务无关**：另一个 agent 正在改 `relay.tenant.*`（`linkErrors.*` / `switch.*` 新增、`metaKey.rotate*` 删除等），三语当前不齐。我已核对**自己的子对象**（`relay.admin.*` / `relay.metrics.*` / `settings.tabGroup.*`，共 181 个 key）在三语完全一致，缺口全在 `relay.tenant.*`。等该 agent 收尾并重跑 `bun run build:i18n` 即可。我最后一次 `build:i18n` 跑在他们的中间态上，产物需要他们再生成一次。
2. **保留了三个当前无引用的 key**：`relay.admin.password.title` / `state` / `epoch`。任务书点名要把 `title`、epoch 标签改名（已改），故没有顺手删除；在并行改同一批 JSON 的情况下删 key 风险更高。若之后确认无人使用，可一并清掉（`minTokenEpoch` 已删）。
3. **交互路径无法在单测里驱动**：仓库无 DOM 测试环境（`bun test` + `react-dom/server`），所以「点行选中租户 → 下方节点表跟着变」「点表头翻排序」「配额存成功后关框」只能拆成纯函数测（`filterMembers` / `sortMembersBy` / `toggleMemberSort`）+ 静态渲染断言 + 一条源码级断言（控制器 `setQuotaOpen(false)`）。端到端行为建议在 e2e 或人工验证时过一遍。
4. **未跑 e2e、未起 dev server**（按任务约束）。
5. 页头「更多」目前只有一项（「修改接入密码」）——中继运营侧原本也只有这一个页面级动作；后续若有新动作直接往 `RelayAdminMenuList` 里加即可。
