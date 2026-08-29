## 现状结论

- 节点标签的内部值保持 `'nodes'`，包括 `?tab=nodes`、路由跳转和测试选择器；只需修改展示文案。
- 当前节点文案入口只有两个：设置页标签和侧栏网络图标的无障碍名称/tooltip。
- 通知页没有独立表单 hook 或组件单测；它接收 `SettingsPage` 创建的站点设置表单。
- `packages/ui`、`packages/panels` 没有通用 `FormRow`；通知页目前使用内联 JSX，视觉模式与 `webhooks-tab.tsx` 的开关行最接近。

## 1. 节点标签与导航

### 设置页标签

[SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:40)（40–55 行）定义：

- `SettingsTab` 联合类型包含 `'nodes'`。
- `SETTINGS_TABS` 保留 `'nodes'`。
- [SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:86)（86–128 行）构造 `tabItems`：
  - `value: 'nodes'`
  - `label: t('settings.tabGroup.nodes')`
  - `icon: Network`
  - `testId: 'settings-tab-nodes'`
- [SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:135)（135–151 行）使用 `Tabs`、横向滚动的 `TabsList` 和：
  - `TabsList`: `w-full gap-1 !justify-start overflow-x-auto rounded-xl border border-border/60 p-1.5 ...`
  - `TabsTrigger`: `cn(pillTabTriggerClassName, 'min-w-max gap-2 px-3.5')`
- 内容分派位于 [SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:157)（157–169 行）：`activeTab === 'nodes' && <NodesTab />`。

### Locale 文案入口

| i18n key | 使用位置 | 当前 locale JSON 路径 |
|---|---|---|
| `settings.tabGroup.nodes` | 设置页可见标签 | `translation.settings.tabGroup.nodes` |
| `sidebar.nodes` | 侧栏 Network 图标的 `aria-label`、`title` | `translation.sidebar.nodes` |

三种语言的源文件位置：

- `settings.tabGroup.nodes`
  - [zh_CN.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/zh_CN.json:219)：`节点`
  - [en_US.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:219)：`Nodes`
  - [ja_JP.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/ja_JP.json:219)：`ノード`
- `sidebar.nodes`
  - [zh_CN.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/zh_CN.json:709)：`节点`
  - [en_US.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/en_US.json:709)：`Nodes`
  - [ja_JP.json](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/locales/ja_JP.json:709)：`ノード`

### 侧栏、标题、面包屑

- [sidebar-title.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:45)（45–55 行）：
  - 仅在 `meshEnabled` 时渲染 Network 图标入口。
  - 链接：`/settings?tab=nodes`
  - 类名：`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground`
  - 文案只出现在 `aria-label={t('sidebar.nodes')}` 和 `title={t('sidebar.nodes')}`，没有可见文字。
- [SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:174)（174–177 行）的 `PageTitle` 始终返回 `t('sidebar.settings')`，所以顶栏标题是“设置 / Settings”，不是节点标签。
- [page-wrapper.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/page-wrapper.tsx:36)（36–57 行）只渲染页面标题和操作区，没有 Breadcrumb 组件。
- `/nodes` 是兼容重定向：[main.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/main.tsx:246)（246–247 行）跳转到 `/settings?tab=nodes`。
- 退出 mesh 后的回跳也只写 URL：[browser-location.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/nodes/setup/browser-location.ts:39)（39–40 行）。
- `nodes.management.title`、`nodes.machine.title`、`nodes.setup.title`、`nodes.https.title` 是内容卡片标题，不是该标签文案，不应批量替换整个 `nodes.*` 命名空间。

生成文件：

- [types.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/types.ts:225) 和 `:691` 仅保存 key 类型。
- [resources.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/i18n/resources.ts:225) 和 `:715` 等位置保存生成后的资源。
- [build-i18n.ts](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/scripts/build-i18n.ts:19)（19–20、42–69 行）说明应修改 locale JSON 后运行生成脚本，不能直接编辑生成文件。

## 2. NotificationSettingsTab 布局

[notification-settings-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/notification-settings-tab.tsx:9)（9–15 行）：

```tsx
interface NotificationSettingsTabProps {
  form: SiteSettingsForm;
}

export function NotificationSettingsTab({ form }: NotificationSettingsTabProps) {
  const { t } = useTranslation();
  const { draft, updateDraft } = form;
```

整体 JSX 位于 17–150 行：

```tsx
<>
  <Card className="border-0 ring-0">
    <CardContent className="space-y-6 pt-6">
      <div className="space-y-3">
        {/* 4 个 toggle row */}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* 4 个 input field */}
      </div>

      <SettingsSaveButton onSave={form.save} isSaving={form.isSaving} />
    </CardContent>
  </Card>

  <TelegramBotsTab />
  <WeixinAccountsTab />
  <WebhooksTab />
</>
```

### 顶部四个开关

当前四行均为 [notification-settings-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/notification-settings-tab.tsx:22)（22–70 行）：

```tsx
<div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
  <div className="min-w-0 pr-2">
    <div className="text-sm font-medium">{/* label */}</div>
  </div>
  <Switch ... />
</div>
```

| 顺序 | i18n key | draft 字段 | test id |
|---|---|---|---|
| 1 | `settings.enableNotificationPush` | `enableNotificationPush` | `settings-enable-notification-push` |
| 2 | `settings.enableBellPush` | `enableBellPush` | `settings-enable-bell-push` |
| 3 | `settings.enableBellSound` | `enableBellSound` | `settings-enable-bell-sound` |
| 4 | `settings.enableBrowserNotificationToast` | `enableBrowserNotificationToast` | `settings-enable-browser-notification-toast` |

每个开关：

- `checked={draft.<field>}`
- `onCheckedChange={(checked) => updateDraft({ <field>: Boolean(checked) })}`
- 当前没有给 `Switch` 设置 `id`。
- 行间距由父级 `space-y-3` 控制。
- 行本身由 `flex ... justify-between ... min-h-10 ... px-4 py-2.5` 控制。

目标两列布局可直接把外层改为：

```tsx
<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
```

保留每个 row 的现有类名，窄屏 `<sm` 自动单列。

### 下方四个输入

当前外层位于 [notification-settings-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/notification-settings-tab.tsx:73)（73–141 行）：

```tsx
<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
  <div className="space-y-2">
    <label className="block text-sm font-medium" htmlFor="...">
    <Input className="min-h-10" ... />
  </div>
  {/* 共 4 个 */}
</div>
```

| 输入 ID | i18n key | draft 字段 | 范围 |
|---|---|---|---|
| `bell-throttle-input` | `settings.bellThrottle` | `bellThrottleSeconds` | `0–300` |
| `notification-throttle-input` | `settings.notificationThrottle` | `notificationThrottleSeconds` | `0–300` |
| `ssh-reconnect-retries-input` | `settings.sshReconnectRetries` | `sshReconnectMaxRetries` | `0–20` |
| `ssh-reconnect-delay-input` | `settings.sshReconnectDelay` | `sshReconnectDelay` | `1–300` |

所有输入：

- `type="number"`
- `value={draft.<field>}`
- `onChange={(event) => updateDraft({ <field>: Number(event.target.value) })}`
- 外层字段类：`space-y-2`
- label 类：`block text-sm font-medium`
- 输入覆写类：`min-h-10`

目标四列布局：

```tsx
<div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
```

这样窄屏单列，`sm` 及以上为一行四列。`Input` 基础样式还包含 `w-full min-w-0`，见 [input.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/ui/src/components/input.tsx:6)（6–20 行）。

### 状态与保存流程

- [SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:66)（66–74 行）调用 `useSiteSettingsForm()`。
- [SettingsPage.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.tsx:164) 将同一个 `form` 传给 `NotificationSettingsTab`。
- [use-site-settings-form.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/use-site-settings-form.ts:24)（24–99 行）：
  - `useState` 保存 `draft`。
  - `useQuery(['site-settings'])` GET `/api/settings/site`。
  - `useEffect` 用 `siteSettingsToDraft()` 注水。
  - `updateDraft` 合并局部 patch。
  - `useMutation` PATCH `/api/settings/site`。
  - 成功后 invalidate query、调用 `useSiteStore().refreshSettings` 并显示 toast。
- [site-settings-form.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/site-settings-form.ts:8)（8–20、29–76 行）定义 draft、默认值和完整 payload。
- [SettingsSaveButton](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/settings-save-button.tsx:11)（11–25 行）不拥有表单状态，只调用 `form.save`。
- 实际后端目录是 `apps/gateway`，不是 `packages/gateway`；[settings-routes.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/settings-routes.ts:20)（20–35、65–75 行）处理 GET/PATCH。

## 3. 共享 FormRow 检查

- `packages/ui/src` 没有通用 `FormRow`、`FieldRow` 或表单布局组件；只有基础 `Input`、`Switch` 等 primitives。
- [apps/fe/.../form-parts.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/nodes/setup/form-parts.tsx:46)（46–107 行）有本地 `FormField`、`SwitchRow`，但只被 `become-hub-form.tsx` 和 `join-hub-form.tsx` 使用。
- `NotificationSettingsTab` 没有使用该本地组件。
- [webhooks-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/settings/webhooks-tab.tsx:167)（167–190 行）使用了与通知页相同的开关行模式：`flex min-h-10 items-center justify-between ... rounded-lg border ... px-3 py-2`。
- `packages/panels/src/settings/index.ts:19–23` 只导出 Telegram、Weixin、Webhook 等面板，不提供表单行抽象。

## 4. 相关测试

- [SettingsPage.test.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/SettingsPage.test.tsx:43)（43–56 行）检查节点标签存在、排序，并断言 fallback key `settings.tabGroup.nodes`。如果 key 不变、只改 locale value，该断言无需改；测试描述中的“节点”可同步更新。
- 同文件 78–90 行测试 `'nodes'` 的 URL 参数解析；不应改内部值。
- [sidebar-title.test.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx:60)（60–76 行）检查 Network 入口显示/隐藏和 URL。文案值改变不会影响行为断言。
- [mobile-settings.spec.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/mobile-settings.spec.ts:130)（130–137 行）仅验证移动端通知标签和第四个开关可见、可点击；适合扩展为四个开关及四个输入的窄屏布局覆盖。
- [settings.spec.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/settings.spec.ts:143)（143–181 行）验证通知页 Telegram/Webhook CRUD；保留现有 test id 即不需修改。
- [site-settings-form.test.ts](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/site-settings-form.test.ts:29)（29–113 行）覆盖默认值、注水和 payload；布局改动不影响。
- 当前没有 `notification-settings-tab.test.tsx`；若需要锁定网格布局，建议新增专门的静态渲染测试。

## Recommended change points

1. 文案：修改三份 locale JSON 中的 `translation.settings.tabGroup.nodes` 与 `translation.sidebar.nodes`；中文目标值为 `多节点互联`，英文/日文应补充对应产品译文。
2. 文案生成：运行 `bun run build:i18n`，由脚本更新 `resources.ts`/`types.ts`。
3. 节点导航：保留 `value: 'nodes'`、`?tab=nodes`、`settings-tab-nodes` 和 `/nodes` 重定向，不改内部路由契约。
4. 通知开关布局：修改 [notification-settings-tab.tsx](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/notification-settings-tab.tsx:21) 外层为 `grid grid-cols-1 gap-3 sm:grid-cols-2`。
5. 通知输入布局：修改同文件 73 行外层为 `grid grid-cols-1 gap-4 sm:grid-cols-4`，保留四个字段的 ID、范围、`draft` 字段和 test id。
6. 测试：扩展 `mobile-settings.spec.ts` 覆盖四个开关/四个输入的响应式可用性；如需单元级布局断言，新增 `notification-settings-tab.test.tsx`。