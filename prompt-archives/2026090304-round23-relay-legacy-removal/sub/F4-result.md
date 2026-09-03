# F4 结果：中继 UI 文案统一 + 表格可达性 + 吊销节点计数

worktree `/Users/konata/code/tmex-r23`，分支 `feat/round23-relay-legacy-removal`，基线 `b03af8b7`。
输入是 LT §3.2 / §3.3 / §3.4 的真实截图结论与 `/Users/konata/code/tmex-copy-guidelines.md`
（规范文件属仓库主人，未改动；本轮按新义执行：「中继」= relay 角色，「Hub」保持 Hub）。

八条全部落地，未留 TODO，未加豁免名单。

---

## 1. reauth 对话框有了自己的说明（LT §3.3.2）

原来只有 `migrate` 有专属说明，`reauth` 回落到 `relay.tenant.dialog.urlHint`「填中继的公网 HTTPS
地址。」——可地址框已锁定并预填，答非所问。

- `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:44` 新增 `ENROLL_NOTICES`
  （四种来意各一条），`:108` 的 `DialogDescription` 改成查表，去掉原来的三元回落。
- 新 key `relay.tenant.dialog.reauthNotice`：
  - zh_CN「中继口令已变更，重新输入以恢复接入。」
  - en_US "The relay password changed. Enter the new one to restore the link."
  - ja_JP「中継のパスワードが変更されました。再入力して接続を回復してください。」

## 2. 代次 / 世代 统一成「第 N 代」（LT §3.3.3）

一个概念原来有三种说法（链路条「第 N 代」、运营者页「口令代次 / 最低令牌代次 / 令牌代次」、
文档「世代」）。做法：值一侧统一走一条格式串，标签只留名词。

- 新 key `relay.admin.epochValue`：zh「第 {{epoch}} 代」/ en "Gen {{epoch}}" / ja「第 {{epoch}} 世代」。
- `apps/fe/src/pages/settings/relay/relay-format.ts:96` 新增 `epochText(t, epoch)`。
- 用它的三处：`relay-cards.tsx:108`（口令代）、`:111`（令牌下限）、
  `tenant-table.tsx:139`（租户表令牌列）。
- 标签改短（三语同步）：
  - `relay.admin.password.epoch` 口令代次 → 「口令」/ "Password" /「パスワード」
  - `relay.admin.password.minTokenEpoch` 最低令牌代次 → 「令牌下限」/ "Token floor" /「トークン下限」
  - `relay.admin.tenants.columns.tokenEpoch` 令牌代次 → 「令牌」/ "Token" /「トークン」
- 英文链路条跟着统一：`relay.tenant.strip.meta` "Metadata key epoch {{epoch}}" →
  "Metadata key gen {{epoch}}"（zh/ja 本来就是「第 N 代」/「第 N 世代」，未动）。

## 3. 接入对话框的密码字段去术语（LT §3.3.4）

- `relay.tenant.dialog.rootPassword`：「当前密码」→「当前密码（本机账号密码）」/
  "Current password (this machine's account password)" /「現在のパスワード（本機アカウントのパスワード）」
- `relay.tenant.dialog.rootPasswordHint`：「接入证明须用根密钥签名，通行密钥无法代签。」→
  「接入必须用密码签名，通行密钥无法代签。」/ "Joining must be signed with the password; a passkey
  cannot sign it." /「参加はパスワードで署名する必要があり、パスキーでは代替できません。」
  （「根密钥」「接入证明」两个内部实现词从界面上消失；`relay-dialogs.tsx:1` 的文件头注释一并跟改。）

## 4. 口令对话框的单选项说明只写后果 + 需 → 须（LT §3.3.5）

- `relay.admin.password.modeKeepHint`：「保留现有租户，新口令只对新接入生效。」→「新口令只对新接入生效。」
  / "The new password applies to new joins only." /「新しいパスワードは新規参加にのみ適用されます。」
- `relay.admin.password.modeKickHint`：「作废旧令牌，所有租户需重新输入口令。」→「所有租户须重新输入口令。」
  / "Every tenant has to enter the password again." /「全テナントがパスワードを再入力する必要があります。」
- 顺带把 relay 文案里剩下的「需」全部改「须」（zh 三处）：
  - `relay.admin.unavailableHint` 「中继角色需在安装时选择」→「须在安装时选择」
  - `relay.tenant.errors.RELAY_META_KEY_NEEDS_SIGNER` 「需要重新验证身份…」→「须重新验证身份…」
  - `relay.tenant.errors.RELAY_PASSWORD_REQUIRED` 「这个中继需要接入口令。」→「这个中继须提供接入口令。」

## 5. 「发送 / 接收」合并成一个「中转流量」（LT §3.3.6）

中继每转发一帧同时计进 `bytesIn` 与 `bytesOut`（B2 §六.11），实测读数逐字节相等
（`bytesIn: 6078, bytesOut: 6078`），摆两个永远一样的数字像统计坏了。

- 总量卡：`apps/fe/src/pages/settings/relay/relay-cards.tsx:76` 两行合成一行
  `relay.admin.totals.traffic`（testId `relay-totals-traffic`，取 `bytesOut`）；
  删掉 `relay.admin.totals.inbound` / `.outbound` 三语。新文案：「中转流量」/ "Relayed traffic" /
  「中継トラフィック」。
- 租户表：`relay-format.ts:91` 的 `trafficText` 由 `(t, bytesIn, bytesOut)` 改成 `(bytes)`，
  直接回 `formatBytes`；`tenant-table.tsx:124` 跟改；删掉 `relay.admin.tenants.trafficValue`
  （原「↑ {{out}}｜↓ {{in}}」）。列头仍是既有的 `columns.traffic`「流量」。
- **api-client 的类型未动**：`RelayTenantSummary.bytesIn/bytesOut` 与 `RelayTotals` 原样保留。

## 6. HTTPS 卡片改成模式中性的「上级」（LT §3.3.7）

`nodes.https.nodeRoleHint`（`apps/fe/src/pages/settings/nodes/https/https-section.tsx:80` 使用，
key 名未变）：

- zh「只有本机作为 Hub 时才需要 HTTPS；节点经 Hub 访问，无需配置。」→
  「只有本机作为上级时才需要 HTTPS；节点经上级访问，无需配置。」
- en "…acts as a hub. Nodes are reached through the hub." → "…acts as an upstream. Nodes are
  reached through their upstream."
- ja 「ハブとして…ハブ経由で…」→「上位として…上位経由で…」（与既有的
  `nodes.uplinkOffline`「上位リンク」、`relay.tenant.leave.description`「上位リンク」一致）

`nodes.https.hubUrlHint` 未动——那句确实只讲 Hub 的公开地址，不是模式错配。
`nodes.enrollment.*` 里没有这句话（那组 key 讲的是加入码流程本身，Hub 是真实主语），故未改。

## 7. 运营者租户表的节点数不再把 revoked 挂着（LT §3.4）

- `apps/gateway/src/relay/relay-admin-routes.ts:32-33` 改成一次 `listNodes` + 一次过滤
  （不再多打一次 `countActiveNodes` 的查询），`:46-47` 输出
  `nodes: nodeRecords.length - nodesRevoked` 与新字段 `nodesRevoked`。
  口径与 `RelayTenantStore.countActiveNodes`（配额口径，`revoked` 不占位）一致，
  也就与 R4 §一.9 一致：吊销 B 之后运营者看到的是「1 / 1」+ 灰色「已吊销 1」，不再永远「1 / 2」。
- `packages/api-client/src/relay/admin-api.ts:46` 加 `nodesRevoked: number`（带注释说明两者关系）。
- `apps/fe/src/pages/settings/relay/tenant-table.tsx:111-118`：`nodesRevoked > 0` 时在节点数后面
  挂一个 `text-muted-foreground` 后缀，testId `relay-tenant-nodes-revoked-<id>`。
  新 key `relay.admin.tenants.nodesRevoked`：「已吊销 {{count}}」/ "{{count}} revoked" /「失効 {{count}}」。
- 测试：**路由测试的实际文件名是 `apps/gateway/src/relay/relay-admin.test.ts`**
  （任务里写的 `relay-admin-routes.test.ts` 不存在）。改了 `StatusBody` 类型（`:32`）、
  在既有断言里加 `nodesRevoked === 0`（`:131`），并新增一条
  “counts revoked nodes separately instead of leaving them in the tenant total”：
  两个节点连上 → 断言 `2 / 0` → 走 `appendMember('revoke')` 真吊销 B → 断言 `1 / 1`。
- 前端测试：`relay-tab.test.tsx` 的 fixture 补 `nodesRevoked`，另加两条（有后缀 / 无后缀）。

## 8. 布局：宽表横向可达 + 移动端标签滚进视口（LT §3.2）

**新文件** `apps/fe/src/pages/settings/components/wide-table.tsx`（32 行）：仓库里原本没有共用的
宽表滚动壳，两张表各自内联一份 `overflow-x-auto`，在 macOS 的浮层滚动条下看不出还能滚。
这里合成一份并解决两件事：

- `WideTableScroll`：`overflow-x-auto` + 强制常驻细滚动条
  （`[&::-webkit-scrollbar]:h-1.5` 与 `[scrollbar-width:thin]` 两套都写），滚动提示看得见。
- `stickyActionColumn`：`sticky right-0 z-10 bg-card` + 一条 `inset` 阴影当左分隔线
  （用 box-shadow 而非 border，避开 `border-collapse: collapse` 下 sticky 单元格丢边框的老问题）。
  「操作」列钉在右侧，1280 + 侧栏展开时不滚也点得到。

接入两张表（列表壳 + 表头 + 行内动作格三处）：

- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:25,51,78,101,200`
  （`Th`/`Td` 加可选 `className`，走 `cn`）
- `apps/fe/src/pages/settings/relay/tenant-table.tsx:11,38,51,67,147`（同上）

移动端标签条：

- `apps/fe/src/pages/SettingsPage.tsx:174,181-186,192` —— `TabsList` 挂 ref，
  `activeTab` 变化后把 `[data-testid="settings-tab-<tab>"]` 滚进视口
  （`scrollIntoView({ inline: 'nearest', block: 'nearest' })`，带 `typeof` 守卫，
  无 DOM 的测试环境不炸）。`showRelay` 进依赖并在体内真用上：中继标签是门禁结论回来之后才挂的，
  结论没回来时先不找（否则 `?tab=relay` 深链首帧找不到 trigger 就再也不滚了）。

---

## 验收

| 项 | 结果 |
|---|---|
| `cd apps/fe && bun test src/pages/settings src/node` | **1229 pass / 0 fail**，58 文件，3720 断言 |
| `cd apps/gateway && bun test src/relay/relay-admin.test.ts` | **14 pass / 0 fail**（新增 1 条） |
| `cd apps/gateway && bun test src/relay`（全量回归） | 100 pass / 0 fail |
| `cd packages/api-client && bun test src/relay` | 26 pass / 0 fail |
| `cd packages/shared && bun test src/i18n` | 7 pass / 0 fail（三语一致性） |
| `bunx tsc --noEmit -p apps/fe` | 0 |
| `bunx tsc --noEmit -p apps/gateway` | 0 |
| `bunx biome check <改动文件>` | 0 |
| `bun run lint`（biome + 复杂度门禁） | 通过，未加豁免；新文件 32 行，改动文件均 < 600 行 |
| `bun run build:i18n` | 干净；连跑两次生成物不再变化 |

`apps/fe` 全量 `bun test` 的 53 个 fail 是 e2e（Playwright）文件被 `bun test` 扫到的既有噪音
（"Playwright Test did not expect test() to be called here"），与本次改动无关；按要求未跑 Playwright。

## 未做 / 需要指挥官拍板

1. **LT §3.3.1 的术语冲突没法在本轮内闭环**：`/Users/konata/code/tmex-copy-guidelines.md` 仍写
   「中继（Hub）」= hub，与本轮的新义直接打架。那个文件属仓库主人，按约束未改。
   建议尽快把那一行改成「中继 = relay 角色；Hub 保持 Hub」，否则下一个 agent 会把 relay 又翻回去。
2. **布局改动没有截图核对**：任务禁止跑 Playwright，`stickyActionColumn` 与常驻滚动条是按
   LT 的截图结论 + CSS 推理做的，建议下一次起临时实例时补一张 1280×800（侧栏展开）与
   390×844 `?tab=relay` 的截图确认。风险点两个：sticky 单元格用的是 `bg-card`
   （两张表都在 `Card` 里，底色一致），以及 `border-collapse: collapse` 下 sticky 行的下边框
   在滚动中可能有 1px 抖动。
3. **`RelayTenantSummary.bytesIn` 现在前端没人读**（按要求保留了 api-client 类型）。
   若后续要清理，删的时候记得中继侧的计量口径本身不变。
