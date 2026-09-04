# T4a 结果：设置 → 多节点互联 → 本机（LocalMachineCard）重构

## 结论

按 plan-00「本机 tab 重构设计」把整张卡重排成「卡头 + 连接 / 中继服务 / 网络」四段；删掉两个上级 tab、
localStorage 偏好与重复的 standalone 中继向导；内部标识全部收进默认收起的「连接详情」；
hub 时代的错误文案按角色改正；`/api/local/status` 非 401 失败现在有明确的错误行与重试。

- `apps/fe` `bun test src/`：**2242 pass / 0 fail**（基线 2179/0；本目录净增 63 个用例）
- `apps/fe` `bunx tsc --noEmit -p .`：**0**（基线 0）
- `packages/shared` `bun test src/i18n`：7 pass / 0 fail（三语键一致、resources 与 generated 同步）
- `bunx biome check apps/fe/src/pages/settings/nodes packages/shared/src/i18n/locales`：干净
- `bun scripts/complexity/gate.ts`：本任务范围内 0 违规、0 stale。**仍有一条不属于本任务的违规**：
  `apps/gateway/src/mesh/forwarder.ts: 1042 lines > 964`（T3b 的文件）。

## 新版式

```
本机  [角色徽标(mesh)]  [唯一状态徽标]                                   [⋯ 更改角色 / 离开… / 账号安全]
├─ 连接
│   standalone → 单一设置向导（设为 Hub / 加入 Hub / 加入中继 / 本机作为中继）
│   中继模式   → 链路行（主机、在线徽标、延迟、当前挂载、kicked/最近错误内联红字）
│                提醒堆（kicked / readmit / metaPending / packPending / notAttached，各一个动作）
│                操作：主按钮「追加中继」｜次级菜单「重新输入口令 / 轮换元数据密钥 / 移除 <host>」｜危险区「离开中继」
│                下方一行灰字「要改回 Hub，先离开中继。」
│   Hub 模式    → 本机地址（hub,node）、当前 Hub 行、Hub chips(≥2)、提示分档、更换 Hub(纯 node)
│                 + 「改为接入中继 / 接入中继」入口（保留原迁移能力）
│   ▸ 连接详情（默认收起）：租户编号(复制)、元数据密钥代数、经中继可见节点、配额(Progress)、
│                          并发流上限、密钥日志、本机节点编号(复制)、每台 Hub 的优先级/纪元/授权/挂载/写者/最近错误
├─ 中继服务（仅 relay 角色）→ 公网地址(复制) + 口令徽标 + <RelayServiceMetrics>（T4b）+ 「接入本机中继」CTA
└─ 网络 → 直连插件行（状态徽标 + 开关 + 安装/删除；禁用开关挂 Tooltip）、重启提示内联、允许域名访问行
```

状态徽标唯一：`独立运行 / 已连接 Hub[· ms] / 未连接 Hub / 连接中 / 已连接中继[· ms] / 未连接中继 / 中继令牌已失效`
（`machineStatusBadge` 纯函数，hub 延迟取 `candidates[].rttMs`，中继延迟取挂载链路的 `rttMs`）。

## 文件

新增：
- `apps/fe/src/pages/settings/nodes/machine-status.ts`（状态徽标分档 + `SELECTABLE_ROLES` / `roleMenuTargets`）
- `.../card-parts.tsx`（`CardSection` 小节标题、`Notice`/`NoticeAction` 统一提醒）
- `.../local-machine-header.tsx`（卡头 + `LocalMachineMenuList`，无 hook 便于单测）
- `.../local-machine-body.tsx`（三段编排）
- `.../connection-details.tsx`（`ConnectionDetails` + 导出的 `ConnectionDetailsContent`）
- `.../relay-service-section.tsx`（含 `useOpenRelayConsole`：`?tab=relay`，与 SettingsPage 同一条 replace 路径）
- `.../network-section.tsx`
- `.../relay/relay-notices.ts`（提醒堆的纯函数）
- `.../relay/relay-rows.tsx`（原 `relay-strip.tsx` 重做为一行一条）
- `.../uplink/uplink-section.tsx`
- 测试：`machine-status.test.ts`、`local-machine-header.test.tsx`、`connection-details.test.tsx`

删除：
- `.../uplink/local-uplink-tabs.tsx` + `.test.tsx`、`.../uplink/uplink-tab-preference.ts`（含 `tmex.nodes.uplink-tab` 偏好）
- `.../setup/standalone-relay-setup.tsx` + `.test.tsx`（与向导重复的第二份中继表单）
- `.../relay/relay-strip.tsx`（并入 `relay-rows.tsx`）
- `hub-strip.tsx` 的 `hubChipTitle`（`｜` 拼接的 chip 悬浮详情）、`relay-dialogs.tsx` 的 `RelayPackPendingNotice`（并入提醒堆）

改写：`local-machine-card.tsx`、`nodes-tab.tsx`、`direct-section.tsx`、`uplink/hub-uplink-panel.tsx`、
`uplink/relay-uplink-panel.tsx`、`uplink/relay-targets.ts`、`setup/hub-setup-wizard.tsx`、
`setup/become-relay-form.tsx`、`relay/relay-dialogs.tsx`、`uplink/hub-strip.tsx` 及对应测试。

## 行为修正

- `nodes.machine.localAddressHint`：指回「更改角色 → Hub 兼节点」；中继服务地址未设置时改用新的
  `relayServiceAddressUnsetHint`（指回「更改角色 → 中继兼节点」），不再对中继节点说 Hub 的话。
- `directRemoveConfirm`：新增 `descriptionRelay`，中继模式下说「经中继转发」。
- `BecomeRelayForm` 的直连提示改用 `directEnableRelayHint` / `directUnsupportedRelayHint`。
- `directSwitchHint` 常驻灰字 → 禁用开关上的 Tooltip（`directNeedsInstall`）。
- `useLocalStatus.error` 现在传进卡片：非 401 失败渲染 `local-machine-error` + `common.retry`。
- 「更换 Hub / 离开 / 角色切换 / 中继 prepare-sign / 域名访问确认 / 重启等待 / readmit」全部保持原逻辑，
  只搬了入口位置。

## 一处主动的设计调整（与 plan 略有出入，已验证更合理）

`PureRelayConfirm` 原本挂在 standalone 的角色下拉上（「展开表单前先确认」）。新版 standalone 没有角色菜单
（四条路径卡本身就是入口，再摆一份角色列表就是重复），该确认框会变成死代码。因此把它移到**真正不可逆的
那一刻**：`BecomeRelayForm` 提交且「本机也作为节点」关闭时，先弹确认再发 `POST /api/setup/relay`
（标题/按钮文案随之改成「设为纯中继？/ 创建并重启」）。mesh 侧切纯中继仍走 `LeaveDialog`
（`leaveToRelayConfirm.webGone` / `switchConfirm`），未受影响。

相应地，`LocalMachineCard` 的 `onSelectSetupPath` 属性与 `useRoleSwitch` 的 setup 分支一并删除
（mesh 角色的切换只会得到 `leave` / `switch`）。跨重启记号（`takeSetupIntent`）照旧由 `NodesTab` 消费。

## i18n

三语（zh_CN / en_US / ja_JP）同步增删，已跑 `bun run build:i18n`。

新增：`nodes.machine.menu.*`、`nodes.machine.status.*`、`nodes.machine.sections.*`、`nodes.machine.details.*`、
`nodes.machine.relayLeaveFirst`、`nodes.machine.directNeedsInstall`、`nodes.machine.loadFailed`、
`nodes.machine.relayServiceAddressUnsetHint`、`nodes.machine.directRemoveConfirm.descriptionRelay`、
`nodes.hubs.priority`、`nodes.hubs.epoch`。

删除（已全仓 grep 确认无引用）：`nodes.machine.uplinkTabHub/uplinkTabRelay/uplinkHubBlocked/uplinkRelayStandalone`、
`nodes.machine.general`、`nodes.machine.directSwitchHint`、`nodes.machine.relayServiceStats/relayServiceCounts`、
`nodes.hubs.title`、`nodes.hubs.machineRole`、`relay.tenant.strip.title/detail/meta/nodes/quota`。

改写：`nodes.machine.localAddressHint`、`nodes.machine.directRemoveConfirm.description`、
`nodes.setup.pureRelayConfirm.title/confirm`。

**保留** `nodes.hubs.detail`：`management/nodes-table.tsx`（不在本任务范围）仍通过 `hubDetailText` 使用它。
本机卡自身已不再出现 `｜` 拼接的详情。

## 测试覆盖

`nodes/**` 下的用例：`local-machine-card` 39、`nodes-tab` 16、`hub-uplink-panel` 21、`relay-uplink-panel` 11、
`relay-ui` 19、`hub-strip` 6、`machine-status` 7、`local-machine-header` 5、`connection-details` 8、
`hub-setup-wizard` 25（+3）。每个条件分支至少一条：standalone / hub / relay 三种形态、中继服务段的四种状态、
提醒堆五档、次级菜单三种组合、连接详情的中继/Hub 两组、状态徽标七档、读取失败、直连四态、域名访问四态。

Base UI 的菜单走 portal、Collapsible 收起不挂载面板，静态渲染都看不到，因此
`LocalMachineMenuList` / `RelayActionsMenuList` / `ConnectionDetailsContent` 均单独导出且不带 hook，
测试直接对元素树断言（与仓库既有的 `BulkActionsMenuList` 同一套做法）。

## 遗留 / 提醒

1. `apps/gateway/src/mesh/forwarder.ts` 的复杂度门禁违规不属于本任务，需由 T3b 收尾。
2. 本轮未起临时实例、未跑 Playwright e2e（按 common rules）。四段版式的换行与截断建议在
   合并后的开发实例上截图核对一次（文案规范的流程要求）。
3. `RelayServiceMetrics`（T4b）已由其提交实现，本卡按 `publicUrl / hasPassword / onOpenConsole` 三个入参挂载，
   `onOpenConsole` 走 `?tab=relay`（replace）。

---

## 截图评审后的两处收尾（2026-09-04）

1. **允许域名访问改成与直连插件同一套行版式**（`domain-access-row.tsx`）：`Switch` 挪进 `Row` 内、与标签同一行，
   说明与错误另起一行占满宽度（不做左缩进——390px 下缩进到标签右侧只会把说明压成窄窄一列），
   整块包在 `flex flex-col gap-1` 里，与上面的直连行保持 gap-3 的段内间距。
2. **`nodes.machine.domainAccess.description` 缩短**（三语同步，`{{hosts}}` 与 `noHosts` 变体保留）：
   - zh_CN：`关闭后拒绝来自公网的网页与 API 访问，局域网、本机与节点互联不受影响。公开域名：{{hosts}}`
   - en_US：`When off, web and API access from the public internet is refused; LAN, local and node-mesh traffic is unaffected. Public domains: {{hosts}}`
   - ja_JP：`オフにすると公開インターネットからのウェブと API アクセスを拒否します。LAN・本機・ノード間の通信は影響を受けません。公開ドメイン：{{hosts}}`
3. **中继服务段在 `RelayServiceMetrics` 什么都不渲染时**（旧后端 → store `unavailable` 返回 `null`）：
   已确认无多余空隙与分隔线——该段是 `flex flex-col gap-3`，返回 `null` 的子节点不占盒子也不产生 gap；
   本段与 `card-parts.tsx` / `local-machine-body.tsx` 全程没有用过 `Separator`。此时段内只剩地址行（含口令徽标），
   与设计一致。（首帧仍会短暂出现 T4b 的瓦片骨架，属其组件内部的 loading 态。）

新增 2 条用例（开关/说明的先后次序、文案不含括号长句）。复核：
`apps/fe bun test src/` **2243 pass / 0 fail**；`tsc --noEmit` 0；
`biome check apps/fe/src/pages/settings/nodes packages/shared/src/i18n/locales` 干净；
`packages/shared bun test src/i18n` 7/0；复杂度门禁本任务范围 0 违规、0 stale
（仍只剩 `apps/gateway/src/mesh/forwarder.ts` 那条，属 T3b）。已重跑 `bun run build:i18n`。

---

## R4 代码审查后的两处修复（2026-09-04）

### 1. mesh + 本机状态未知时的卡头（死菜单）

问题属实：`meshEnabled=true` 而 `/api/local/status` 还没回来 / 401 / 失败时，卡头按
`status?.role ?? 'standalone'` 摆出「独立运行」徽标与「更改角色 / 离开」菜单，而 `useRoleSwitch`
在 `status === null` 时直接返回，菜单每一项都点了没反应；新的错误 + 重试态让它稳定复现。

修法：
- `LocalMachineHeaderProps.role` 改成 `LocalRole | null`，卡片传 `status?.role ?? null`。
- 角色徽标只在 `meshEnabled && role` 时渲染；菜单再多一道 `isMeshRole(role)`——纯 `relay`
  没有网页、`standalone` 的下一步在向导里，两者都不该有菜单（`menuRole` 为 `null` 即整块不挂）。
- `machineStatusBadge` 新增入参 `roleKnown` 与新档位 `unknown`：mesh 且角色未知时只说
  「状态未知」（muted），不再拿上级链路快照猜出「未连接 Hub」这种看着像故障的结论；
  `standalone` 由 `/api/auth/mode` 直接给出，不受本机状态影响，仍照常显示。
- 新 i18n 键 `nodes.machine.status.unknown`（zh 状态未知 / en Status unknown / ja 状態不明）。

测试：`local-machine-card.test.tsx` 新增 loading / loginRequired / error 三条分支（各断言
`data-status-state="unknown"`、无角色徽标、无菜单）、状态回来后徽标与菜单才出现、纯中继不摆菜单；
`machine-status.test.ts` 新增 `roleKnown=false` 的三种组合。

### 2. 纯中继提交闸门的真实覆盖

原来只断言了「确认框初始是关的」。把判定与状态迁移抽成新文件
`setup/become-relay-gate.ts`（与 `DirectMutationController` 同一套「脱离 DOM 可测」的做法）：

- `pureRelaySubmitPlan(values, nodeEnv) → 'invalid' | 'confirm' | 'submit'`
- `becomeRelayGate(event) → { confirming, submit }`，事件为 `submit(plan) / confirm / cancel`

`BecomeRelayForm` 的三个入口（表单 onSubmit、确认、取消）现在全部走这两个函数，组件里不再有
内联判断。新测试 `setup/become-relay-gate.test.ts`（9 条）按组件真实顺序驱动闸门，`submit` 为真时
**真的**调用 `submitBecomeRelay`，用记账的 `ApiClient` 数请求条数：

- 草稿有错 → 不弹框、0 请求（纯中继与中继兼节点缺账号两种）
- 纯中继字段齐全 → 弹框、0 请求
- 取消 → 框关掉、仍 0 请求
- 确认 → 正好 1 次 `POST /api/setup/relay`，`role: 'relay'`
- 中继兼节点 → 不弹框、直接 1 次 POST，`role: 'relay,node'`

### 复核

- 我的范围（`src/pages/settings/nodes/**`，排除 T4b 自有的 `relay/relay-service-metrics*`）：
  **685 pass / 0 fail**（35 个文件）。
- `apps/fe bun test src/` 整体 2259 pass / 3 fail、`tsc --noEmit` 1 条错误——**全部落在
  `pages/settings/relay/relay-metrics-store.*`（T4b 正在改 `unavailable` 的那次重构，工作区里
  4 个 relay-metrics 文件是脏的）**，与本任务无关；我改过的文件 tsc 干净。
- `biome check apps/fe/src/pages/settings/nodes packages/shared/src/i18n/locales`：干净。
- `bun scripts/complexity/gate.ts`：**complexity gate ok**（forwarder.ts 那条已由 T3b 修掉）。
- 已重跑 `bun run build:i18n`。
