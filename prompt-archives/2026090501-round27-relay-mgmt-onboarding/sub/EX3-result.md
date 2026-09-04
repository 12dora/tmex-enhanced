# Settings → Relay（中继）代码审阅报告

以下结论基于只读审阅，未修改文件、未运行测试。

## 1. 设置页 Tab 注册、顺序与门禁

### 当前结构

设置页有两套顺序，不能混为一谈：

1. `SETTINGS_TABS`：普通 Tab 的懒加载/预热顺序。
2. `SETTINGS_TAB_BAR`：实际界面上的可见顺序。

普通 Tab 类型和预热列表位于：

- [`SettingsPage.tsx:73`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:73)：`SettingsTab` 联合类型。
- [`SettingsPage.tsx:83`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:83)：普通 Tab 列表：

```text
general
devicesAndFiles
nodes
notifications
ai
terminal
remoteAccess
```

`relay` 被单独放在可选 Tab 中：

- [`SettingsPage.tsx:94`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:94)
- [`SettingsPage.tsx:98`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:98)

原因是中继 Tab 只适用于启用了 relay 角色的机器，不应参与普通页面预热。

实际可见顺序在 [`SettingsPage.tsx:122`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:122)：

| 当前顺序 | value | i18n key | 简体中文 |
|---:|---|---|---|
| 1 | `general` | `settings.tabGroup.general` | 通用 |
| 2 | `terminal` | `settings.tabGroup.terminal` | 终端 |
| 3 | `devicesAndFiles` | `settings.tabGroup.devicesAndFiles` | 设备与文件 |
| 4 | `remoteAccess` | `settings.tabGroup.remoteAccess` | 远程访问 |
| 5 | `nodes` | `settings.tabGroup.nodes` | 多节点互联 |
| 6 | `notifications` | `settings.tabGroup.notifications` | 通知 |
| 7 | `ai` | `settings.tabGroup.ai` | AI |

这些 key 的中文源文本见 [`zh_CN.json:371`](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:371)。

中继 Tab 单独声明于：

- [`SettingsPage.tsx:137`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:137)
- value：`relay`
- label key：`relay.admin.tabLabel`
- 当前中文：[`zh_CN.json:2902`](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2902) 的 `"中继"`

它目前通过以下逻辑追加到最后：

- [`SettingsPage.tsx:161`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:161)
- [`SettingsPage.tsx:173`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:173)

```ts
const items = showRelay ? [...SETTINGS_TAB_BAR, RELAY_TAB_ITEM] : SETTINGS_TAB_BAR;
```

### 门禁条件

页面通过 `useRelayAvailability()` 查询 `/api/relay/status`：

- [`relay-status-store.ts:1`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-status-store.ts:1)
- [`SettingsPage.tsx:257`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:257)
- 只有 `relayAvailability === 'available'` 时传入 `showRelay={true}`，见 [`SettingsPage.tsx:300`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:300)。

当前行为：

- 未知状态：不显示。
- `/api/relay/status` 返回 404：不显示。
- 未登录/401：不显示。
- relay 状态可用：显示。
- `?tab=relay` 仍被视为合法参数，因为 `relay` 在 `OPTIONAL_SETTINGS_TABS` 中，见 [`SettingsPage.tsx:144`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.tsx:144)。

现有测试明确验证了这些行为：

- [`settings-tab-gating.test.tsx:48`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/settings-tab-gating.test.tsx:48)
- [`settings-tab-gating.test.tsx:72`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/settings-tab-gating.test.tsx:72)

### 改名与重新排序所需修改

要把“中继”改成“中继管理”，应修改三种语言文件中的同一个 key：

```json
"relay.admin.tabLabel": "中继管理"
```

中文源文件：

- [`zh_CN.json:2902`](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2902)

同时更新：

- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/ja_JP.json`

不要修改生成文件 `resources.ts`、`types.ts`。

要把它放在“多节点互联”右侧：

1. 将 `RELAY_TAB_ITEM` 放入 `SETTINGS_TAB_BAR`。
2. 插入在 `nodes` 项之后、`notifications` 项之前。
3. 不再使用 `[...]SETTINGS_TAB_BAR, RELAY_TAB_ITEM` 追加到末尾。
4. 保留 `OPTIONAL_SETTINGS_TABS = ['relay']`，否则会破坏门禁和 `?tab=relay` 深链。
5. `relay` 的 URL value 不需要改，仍然是 `/settings?tab=relay`。
6. 不要把 relay 加进 `SETTINGS_TABS`，否则普通机器会参与中继 chunk 预热。

预期可见顺序：

```text
通用 → 终端 → 设备与文件 → 远程访问 → 多节点互联 → 中继管理 → 通知 → AI
```

需要同步更新：

- [`settings-tab-gating.test.tsx:48`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/settings-tab-gating.test.tsx:48)：当前断言 relay 在最后。
- [`SettingsPage.test.tsx:61`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.test.tsx:61)：补充 relay 可见时的顺序测试。
- [`SettingsPage.test.tsx:127`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.test.tsx:127)：确认不要误改预热顺序。

路由和侧边栏不需要改名：

- 设置页路由是 [`main.tsx:289`](/Users/konata/code/tmex-r27/apps/fe/src/main.tsx:289) 的 `/settings`。
- 侧边栏只有顶层“设置”，使用 `sidebar.settings`，见 [`sidebar-title.tsx:48`](/Users/konata/code/tmex-r27/apps/fe/src/components/page-layouts/components/sidebar-title.tsx:48)。
- relay 只是设置页内部 Tab，不是独立侧边栏或独立路由。

---

## 2. `relay-format.ts` 的速率格式化与小数问题

核心代码在：

- [`relay-format.ts:104`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-format.ts:104)
- [`packages/api-client/src/format.ts:3`](/Users/konata/code/tmex-r27/packages/api-client/src/format.ts:3)

当前逻辑：

```ts
formatBytesPerSec(value)
  → formatRate(value)
  → formatBytes(value) + "/s"
```

`formatBytes` 的行为：

- 小于 1024 字节时直接插值原始数字：

```ts
if (n < 1024) return `${n} B`;
```

因此 `12.345678 B/s` 会原样显示很多小数。

- 达到 KB 以后最多两位小数：
  - `>=100`：0 位
  - `>=10`：1 位
  - 其他：2 位

后台速率本身是浮点数，由采样差分计算：

- [`relay-metrics.ts:168`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:168)

### 受影响的 UI 位置

成员表：

- [`relay-metrics-members.tsx:81`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-members.tsx:81)

总吞吐磁贴和入站/出站磁贴：

- [`relay-metrics-tiles.tsx:92`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx:92)
- [`relay-metrics-tiles.tsx:122`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx:122)
- [`relay-metrics-tiles.tsx:143`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx:143)

吞吐趋势图：

- [`relay-metrics-trends.tsx:100`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-trends.tsx:100)

节点/成员速率没有另一套格式化逻辑，均经过 `formatBytesPerSec`。

### 建议

在 `formatBytesPerSec` 内统一先舍入到两位：

```ts
const value = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0;
return formatRate(Number(value.toFixed(2)));
```

这样可以保证：

- `12.3456` → `12.35 B/s`
- `0.004` → `0 B/s`
- KB/MB 继续使用现有单位逻辑
- 不改变帧率、延迟、百分比等其他指标格式

当前 `formatFramesPerSec` 已经最多一位小数，见 [`relay-format.ts:109`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-format.ts:109)，不需要一并修改。

应补充小于 1024 字节的浮点测试。现有测试只覆盖了典型整数速率：

- [`relay-format.test.ts:132`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-format.test.ts:132)

---

## 3. 表格实现、现有能力与推荐方案

### 当前表格是否共享 primitive

四个表格都使用语义化 HTML：

```tsx
<table>
  <thead>...
  <tbody>...
</table>
```

它们只共享横向滚动容器：

- [`wide-table.tsx:1`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/components/wide-table.tsx:1)
- [`wide-table.tsx:16`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/components/wide-table.tsx:16)

`WideTableScroll` 负责：

- `overflow-x-auto`
- 边框
- 滚动条样式
- 右侧 sticky action column

它不是表格组件，也没有排序、筛选、分页或搜索状态。

具体情况：

- `tenant-table.tsx`：普通 table、行内备注编辑、按钮操作，见 [`tenant-table.tsx:34`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/tenant-table.tsx:34)。
- `relay-metrics-members.tsx`：普通 table，见 [`relay-metrics-members.tsx:26`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-members.tsx:26)。
- `nodes-table.tsx`：普通 table，带复选框批量选择，见 [`nodes-table.tsx:46`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:46)。
- `wide-table.tsx` 是它们之间唯一明确共享的展示 primitive。

### 当前是否支持排序、筛选、搜索

没有用户可操作的：

- 搜索框
- 列排序
- 条件筛选
- 分页

成员表只有一个固定排序函数：

- [`relay-metrics-model.ts:80`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-model.ts:80)

当前排序是：

1. 在线优先。
2. 入站+出站速率降序。
3. 名称排序。

这不是可交互的表格排序。

### `packages/ui` 中是否有 Table primitive

没有。

`packages/ui` 依赖 `@base-ui/react`：

- [`packages/ui/package.json:15`](/Users/konata/code/tmex-r27/packages/ui/package.json:15)

但入口只导出基础工具：

- [`packages/ui/src/index.ts:1`](/Users/konata/code/tmex-r27/packages/ui/src/index.ts:1)

没有 `Table`、`TableRow`、`TableCell` 等组件。当前表格全部由应用层的 HTML + Tailwind 实现。

lockfile 中也没有：

- `@tanstack/react-table`
- `antd`
- `@ant-design/*`

存在的 `@tanstack/react-query` 不属于表格库。

### 推荐的最小改动方案

不要引入 TanStack Table 或 antd。对 relay 成员表做局部增强：

1. 保留 `<table>`、`WideTableScroll` 和现有 Tailwind 样式。
2. 在 `relay-metrics-model.ts` 增加纯函数：
   - `filterMembers`
   - `sortMembersBy`
   - 明确的 `MemberSortKey`
   - 明确的排序方向
3. 在 `RelayMembersTable` 内增加本地状态：
   - 搜索词
   - 排序列
   - 排序方向
   - 在线/离线筛选
   - 当前选中的租户 ID
4. 搜索范围建议包括：
   - 显示名称
   - 完整 `nodeId`
   - `tenantId`
   - 若父级提供租户映射，也可搜索租户备注。
5. 默认排序改成：
   - `memberTitle(member)` 升序。
   - 第二排序键使用 `nodeId`。
   - 最终使用 `tenantId + nodeId` 保证稳定排序。
6. 保留原有表格密度、`text-xs`、`tabular-nums`、sticky action 样式。
7. 搜索无结果时增加独立空状态文案，不要复用“还没有节点接入”。

重要数据问题：后端当前构造成员行时固定返回 `name: null`：

- [`relay-metrics.ts:471`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:471)
- [`relay-metrics.ts:489`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:489)

因此“按节点名称排序”实际应按：

```text
name ?? nodeId 前缀
```

如果产品要求真实节点名称，必须另行修改后端 metrics payload；前端目前只能按 `memberTitle` 排序。

筛选器可以使用现有 UI 组件：

- `Input`
- `Button`
- `DropdownMenu`
- `DropdownMenuCheckboxItem` 或普通菜单项

现有 DropdownMenu 样式参考：

- [`relay-uplink-panel.tsx:142`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.tsx:142)
- [`local-machine-header.tsx:80`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/local-machine-header.tsx:80)
- [`bulk-actions-menu.tsx:242`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/management/bulk-actions-menu.tsx:242)

必须遵守 Base UI 的分组约束：`DropdownMenuLabel` 必须位于 `DropdownMenuGroup` 内。已有明确说明和示例：

- [`add-device-menu.tsx:33`](/Users/konata/code/tmex-r27/apps/fe/src/pages/devices/add-device-menu.tsx:33)
- [`add-device-menu.tsx:47`](/Users/konata/code/tmex-r27/apps/fe/src/pages/devices/add-device-menu.tsx:47)

---

## 4. “接入口令”卡片、全部文案与“令牌下限”语义

### 当前使用的 relay password key

中文源文件位于 [`zh_CN.json:2930`](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:2930)。

| key | 当前中文 |
|---|---|
| `relay.admin.password.title` | 接入口令 |
| `relay.admin.password.state` | 状态 |
| `relay.admin.password.set` | 已设置 |
| `relay.admin.password.unset` | 未设置 |
| `relay.admin.password.unsetWarning` | 未设置口令，任何人都能接入本中继。 |
| `relay.admin.password.epoch` | 口令 |
| `relay.admin.password.minTokenEpoch` | 令牌下限 |
| `relay.admin.password.change` | 修改口令 |
| `relay.admin.password.dialogTitle` | 修改接入口令 |
| `relay.admin.password.newPassword` | 新口令 |
| `relay.admin.password.newPasswordHint` | 至少 8 个字符。 |
| `relay.admin.password.clear` | 清除口令 |
| `relay.admin.password.clearHint` | 清除后任何人都能接入本中继。 |
| `relay.admin.password.modeLabel` | 现有租户 |
| `relay.admin.password.modeKeep` | 保留现有租户 |
| `relay.admin.password.modeKeepHint` | 新口令只对新接入生效。 |
| `relay.admin.password.modeKick` | 作废旧令牌 |
| `relay.admin.password.modeKickHint` | 所有租户须重新输入口令。 |
| `relay.admin.password.tooShort` | 口令至少 8 个字符。 |
| `relay.admin.password.saved` | 接入口令已更新。 |
| `relay.admin.password.failed` | 口令更新失败：`{{message}}` |
| `relay.admin.password.dialogDescription` | 设置新口令，或清除口令改为任何人可接入。 |

卡片直接使用的 key 见：

- [`relay-cards.tsx:34`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-cards.tsx:34)
- [`password-dialog.tsx:49`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/password-dialog.tsx:49)

保存成功和失败文案分别由 controller 和父组件使用：

- [`use-relay-controller.ts:69`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/use-relay-controller.ts:69)
- [`relay-tab.tsx:174`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-tab.tsx:174)

此外使用共享 key：

- `common.cancel`
- `common.save`

### “令牌下限”实际是什么

它不是：

- 用户可手动调整的配置；
- 新令牌的最小长度；
- 令牌生成时的数值下限；
- 密码强度设置。

它是 relay 服务端接受令牌时使用的最低 token epoch。

配置结构见：

- [`relay-config-store.ts:7`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-config-store.ts:7)

修改密码时：

- `passwordEpoch` 总是递增。
- `keep`：只递增当前密码代次，不提高 `minTokenEpoch`。
- `kick`：将 `minTokenEpoch` 提高到新的 `passwordEpoch`。

具体逻辑：

- [`relay-config-store.ts:78`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-config-store.ts:78)
- [`relay-admin-routes.ts:85`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin-routes.ts:85)

认证时，如果：

```text
tenant.tokenEpoch < config.minTokenEpoch
```

令牌会被拒绝：

- [`relay-routes.ts:176`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-routes.ts:176)

`kick` 模式还会主动断开在线旧连接：

- [`relay-uplink-server.ts:224`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:224)

清除密码同样会经过这套 epoch 逻辑；如果选择 `kick`，旧令牌仍会失效。

### 密码 join 的真实流程

`packages/app` 不会把明文密码直接作为普通密码字段发送给 relay：

1. 使用密码派生根密钥。
2. 生成 KDF proof。
3. 以 `mode: 'join'` 请求加入。
4. relay 返回加密 pack。
5. 客户端解包并持久化 relay token。

相关代码：

- [`relay-password-join-flow.ts:208`](/Users/konata/code/tmex-r27/packages/app/src/lib/relay-password-join-flow.ts:208)
- [`relay-routes.ts:131`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-routes.ts:131)
- [`relay-store.ts:18`](/Users/konata/code/tmex-r27/packages/app/src/lib/relay-store.ts:18)

`relay-store` 只负责保存 relay URL、tenant ID、token 等本地 uplink 信息，不处理 `minTokenEpoch`：

- [`relay-store.ts:7`](/Users/konata/code/tmex-r27/packages/app/src/lib/relay-store.ts:7)
- [`relay-store.ts:18`](/Users/konata/code/tmex-r27/packages/app/src/lib/relay-store.ts:18)

### 文案建议

建议从普通管理卡片中移除 `minTokenEpoch`，因为它是内部诊断值。

如果仍然保留，建议改成：

```text
旧令牌最低代次
```

并加说明：

```text
使用“作废旧令牌”时，低于此代次的接入令牌会失效。
```

`relay.admin.password.epoch` 当前显示为“口令”，但值是“第 N 代”，也建议改成：

```text
口令代次
```

---

## 5. 租户表、默认配额、成员关系与布局改造

### 数据结构

`RelayTenantSummary` 定义于：

- [`admin-api.ts:47`](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.ts:47)

字段包括：

```text
id
label
createdAt
lastSeenAt
nodes
nodesRevoked
nodesOnline
streams
bytesIn
bytesOut
quota: RelayQuota | null
tokenEpoch
kicked
```

租户状态来自 `/api/relay/status`，后端在：

- [`relay-admin-routes.ts:26`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin-routes.ts:26)

成员数据是另一份 `/api/relay/metrics` payload。`RelayMetricsMember` 包含：

```text
tenantId
nodeId
name
online
lastSeenAt
connectedAt
rttMs
reconnects
activeStreams
bytesInPerSec
bytesOutPerSec
```

定义见：

- [`metrics-types.ts:55`](/Users/konata/code/tmex-r27/packages/api-client/src/relay/metrics-types.ts:55)

答案是：成员行有明确的 `tenantId`。

前端使用复合 key：

```text
tenantId + ":" + nodeId
```

见 [`relay-metrics-members.tsx:40`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-members.tsx:40)。

后端也是按租户和节点组合识别成员：

- [`relay-metrics.ts:369`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:369)
- [`relay-metrics.ts:471`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-metrics.ts:471)

租户状态接口不会直接嵌套成员数组；前端需要用 `member.tenantId` 和租户列表自行关联。

### 当前操作

租户表支持：

- 编辑备注及租户配额；
- 踢出租户；
- 删除租户；
- 行内编辑备注；
- 复制完整租户 ID。

props 和回调见：

- [`tenant-table.tsx:21`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/tenant-table.tsx:21)
- [`tenant-table.tsx:71`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/tenant-table.tsx:71)

删除和踢出有独立确认流程：

- 踢出可逆，重新输入口令可再次接入；
- 删除会删除注册表和密钥日志，不可恢复。

见：

- [`tenant-confirms.tsx:1`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/tenant-confirms.tsx:1)
- [`tenant-confirms.tsx:37`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/tenant-confirms.tsx:37)
- [`tenant-confirms.tsx:121`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/tenant-confirms.tsx:121)

### 默认配额行为

配额字段为：

```text
maxNodes
maxStreams
bandwidthBytesPerSec
```

默认配额表单由 `QuotaFields` 复用：

- [`quota-fields.tsx:10`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/quota-fields.tsx:10)
- [`default-quota-card.tsx:20`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/default-quota-card.tsx:20)

租户 `quota === null` 时继承默认配额：

- [`relay-format.ts:70`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-format.ts:70)
- [`relay-uplink-server.ts:155`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:155)

在线租户的配额变化会立即通知并更新带宽桶：

- [`relay-uplink-server.ts:175`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink-server.ts:175)

### 当前布局

当前顺序实际上是：

1. 指标面板；
2. 接入口令卡片和默认配额表单；
3. 租户表；
4. 成员表位于指标面板内部。

具体位置：

- [`relay-tab.tsx:121`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-tab.tsx:121)
- [`relay-tab.tsx:128`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-tab.tsx:128)
- [`relay-tab.tsx:138`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-tab.tsx:138)
- [`relay-metrics-panel.tsx:127`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-panel.tsx:127)

`RelayMetricsPanel` 自己拥有 `useRelayMetrics`：

- [`relay-metrics-panel.tsx:93`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-panel.tsx:93)

### 推荐的布局改造方式

建议把 metrics 数据所有权上移到 `RelayTabBody`，或者把 `RelayMetricsPanel` 拆成：

```text
RelayMetricsOverview
RelayMembersCard
```

保证页面只有一个 metrics hook owner。

推荐流程：

1. 租户表放在成员表之前。
2. `RelayTabBody` 增加：

```ts
const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
```

3. 租户表增加 `selectedTenantId` 和 `onSelectTenant`。
4. 选择租户后：

```ts
members.filter((member) => member.tenantId === selectedTenantId)
```

5. 选择“全部租户”时显示完整成员列表。
6. 租户被删除或刷新后不存在时，清除选中状态。
7. 行选择应使用显式按钮、单选框或“查看节点”，不要让整行点击和编辑/踢出/删除按钮冲突。

租户列表只有统计数据，没有成员 ID，因此不能直接从租户的 `nodes` 字段过滤；必须使用成员行中的 `tenantId`。

### 将接入口令和默认配额移到三点菜单

当前：

- 接入口令卡片有显式“修改口令”按钮，见 [`relay-cards.tsx:43`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-cards.tsx:43)。
- 默认配额卡片直接展示完整表单，见 [`default-quota-card.tsx:36`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/default-quota-card.tsx:36)。
- `PasswordDialog` 已经是受控对话框。
- 默认配额目前没有对话框，只是 Card 内表单。

最小侵入方案：

1. 在 [`RelayTabHeader.tsx` 对应区域](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-tab.tsx:80) 的刷新按钮旁增加三点按钮。
2. 菜单项：
   - 修改接入口令
   - 修改默认配额
3. 接入口令菜单项直接调用现有 `controller.openPassword()`。
4. 为默认配额增加 `defaultQuotaOpen` 状态和 `DefaultQuotaDialog`。
5. 把 `DefaultQuotaCard` 中的草稿逻辑和 `QuotaFields` 提取为可复用 Dialog body。
6. 成功保存默认配额后关闭 Dialog，并沿用现有 `refresh()`。
7. 可保留 `DefaultQuotaSummary` 作为菜单或页面标题下的摘要；它目前已导出但没有当前调用点，见 [`relay-cards.tsx:73`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-cards.tsx:73)。

下拉菜单必须类似现有实现：

```tsx
<DropdownMenuGroup>
  <DropdownMenuLabel>...</DropdownMenuLabel>
  ...
</DropdownMenuGroup>
```

不要把 `DropdownMenuLabel` 直接放在 `DropdownMenuContent` 下。

---

## 6. 现有测试覆盖与需要补充的测试

### 已有前端测试

| 范围 | 测试文件 | 当前覆盖 |
|---|---|---|
| 设置页 Tab 顺序 | [`SettingsPage.test.tsx:61`](/Users/konata/code/tmex-r27/apps/fe/src/pages/SettingsPage.test.tsx:61) | 普通 Tab 顺序、深链、chunk 预热 |
| relay Tab 门禁 | [`settings-tab-gating.test.tsx:48`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/settings-tab-gating.test.tsx:48) | available、404、401、未知状态、relay 深链 |
| 格式化 | [`relay-format.test.ts:1`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-format.test.ts:1) | 时间、配额、速率、帧率、延迟、百分比、中位数 |
| 指标 UI | [`relay-metrics-ui.test.tsx:80`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-ui.test.tsx:80) | 指标计算、磁贴、趋势、成员表、空状态 |
| 指标数据轮询 | [`relay-metrics-store.test.ts:42`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-metrics-store.test.ts:42) | 刷新、轮询、错误和旧数据 |
| relay 状态轮询 | [`relay-status-store.test.ts:60`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-status-store.test.ts:60) | 状态门禁和轮询 |
| relay Tab 集成 | [`relay-tab.test.tsx:76`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-tab.test.tsx:76) | 加载、错误、密码卡、配额卡、租户表及部分操作 |
| 表单纯函数 | [`relay-forms.test.ts:22`](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/relay/relay-forms.test.ts:22) | 密码长度、配额字段校验 |

没有找到以下组件的独立测试文件：

- `relay-cards.tsx`
- `password-dialog.tsx`
- `default-quota-card.tsx`
- `quota-fields.tsx`
- `tenant-table.tsx`
- `relay-metrics-members.tsx`
- `tenant-editor-dialog.tsx`

它们主要通过 `relay-tab.test.tsx` 或 `relay-metrics-ui.test.tsx` 间接覆盖。

### 已有后端和 CLI 测试

- 管理 API：
  - [`admin-api.test.ts:62`](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.test.ts:62)
- relay 管理接口、默认配额、租户操作、密码代次：
  - [`relay-admin.test.ts:51`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin.test.ts:51)
  - [`relay-admin.test.ts:279`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-admin.test.ts:279)
- 密码 kick/keep、旧连接断开：
  - [`relay-uplink.test.ts:540`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-uplink.test.ts:540)
- 真实成员关系和重新认证：
  - [`relay-membership.integration.test.ts:49`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/integration/relay-membership.integration.test.ts:49)
- enroll 密码验证和令牌：
  - [`relay-routes.test.ts:69`](/Users/konata/code/tmex-r27/apps/gateway/src/relay/relay-routes.test.ts:69)
- CLI 密码 join：
  - [`relay-password-join.test.ts:8`](/Users/konata/code/tmex-r27/packages/app/src/lib/relay-password-join.test.ts:8)
  - [`commands/relay-password-join.test.ts:48`](/Users/konata/code/tmex-r27/packages/app/src/commands/relay-password-join.test.ts:48)

### 本次改造应补充或更新

1. 更新 relay Tab 顺序测试：断言它位于 `nodes` 后、`notifications` 前。
2. 更新中文、英文、日文 label 的快照或渲染断言。
3. 增加速率格式化测试：
   - `12.3456` → `12.35 B/s`
   - `512.999` → `513 B/s`
   - 小于 1024 字节的浮点值不再原样输出。
4. 为成员表增加纯函数测试：
   - 默认按节点名称升序；
   - 无名称时按 node ID；
   - 在线/离线筛选；
   - 搜索名称、node ID、tenant ID；
   - 多个相同名称时排序稳定。
5. 为 `RelayMembersTable` 增加交互测试：
   - 点击列标题切换升降序；
   - 搜索；
   - 状态筛选；
   - 租户筛选；
   - 无筛选结果空状态。
6. 为租户选择增加集成测试：
   - 选择租户后只显示对应 `tenantId` 的成员；
   - 删除选中租户后恢复全部成员或清空选择。
7. 为三点菜单和 Dialog 增加测试：
   - 菜单能打开密码 Dialog；
   - 菜单能打开默认配额 Dialog；
   - `DropdownMenuLabel` 始终位于 `DropdownMenuGroup` 内；
   - 默认配额 Dialog 复用现有校验和保存路径。
8. `minTokenEpoch` 如果只是改展示文案或隐藏，不需要修改后端测试；如果改变 keep/kick 行为，则必须继续覆盖已有的 `relay-admin`、`relay-uplink` 和 membership integration 测试。