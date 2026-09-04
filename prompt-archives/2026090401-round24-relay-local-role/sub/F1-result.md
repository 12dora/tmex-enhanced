# F1 结果：上级链路两 tab 进本机卡，节点管理页瘦身

## 做了什么

把「本机接哪个上级」（Hub / 中继）整体从节点管理页搬进本机卡，做成两个 tab；节点管理页只剩节点表、加入码与节点动作。

### 新增目录 `apps/fe/src/pages/settings/nodes/uplink/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `local-uplink-controller.ts` | 98 | `useLocalUplinkController()`：`useMeshNodes` / `useHubNode` / `useMeshHubs({owner:true})` / `useMeshRelay({owner:true})` / `usePasskeys` / `useCredentialPrompt` / `useRelayActions` 唯一所有者，暴露 `refreshAll`（节点 + hub 管理面 + hub 集合 + 中继）。standalone 下整族 `enabled:false` |
| `local-uplink-tabs.tsx` | 106 | 两个 tab 的外壳、选中推导、中继两个对话框的挂载点 |
| `uplink-tab-preference.ts` | 57 | `deriveUplinkTab` / `readUplinkTab` / `writeUplinkTab`（`localStorage` 键 `tmex.nodes.uplink-tab`，读写全部 try/catch） |
| `hub-uplink-panel.tsx` | 413 | Hub tab：本机主备身份、本机地址、当前 Hub、合并后的 Hub 列表、两条上级提示、standalone 下的 `HubSetupWizard`（含滚入视野）、中继模式下的一句说明 |
| `relay-uplink-panel.tsx` | 238 | 中继 tab：`RelayStrip`、三条提示、一排明面上的操作按钮、非中继模式的单一入口、standalone 占位与 `relaySetup` 插槽 |
| `relay-targets.ts` | 28 | `reauthTarget` / `kickedRelays` / `uplinkBlockedHint`（原 `relay/uplink-section.tsx` 的纯函数） |
| `hub-strip.tsx` | 114 | 由 `management/hub-strip.tsx` 移入；只保留 chip 的文案与诊断助手 |

### 改动的既有文件

- `nodes-tab.tsx`：建 `useLocalUplinkController`，把它同时传给本机卡与节点管理页；standalone 下不再在卡外渲染 `HubSetupWizard`（改由 Hub tab 渲染），`wizardPath` 下传。
- `local-machine-card.tsx`：502 → 315 行。新增 `uplink` / `wizardPath` / `relaySetup` props；`MachineHubRows` 等一族搬去 `uplink/hub-uplink-panel.tsx`；角色下拉拆成 `RoleRow`（门禁 161 行限额）；`{uplink.prompt.dialog}` 挂在卡上（`loginRequired` 时也在）。
- `management/nodes-management.tsx`：594 → 275 行。删掉 `useMeshHubs` / `useMeshRelay` / `useHubNode` / `usePasskeys` / `useCredentialPrompt` / `useRelayActions` / `UplinkSection` / 两个中继对话框 / Network 图标菜单；改收 `uplink: Pick<LocalUplinkController,'hubs'|'hub'|'relay'|'prompt'|'refreshAll'>`。`useRelayAdmitFollowUp` 与 `useEnrollmentEngine` 留在本页。
- `management/bulk-actions-menu.tsx`（新，273 行）：多选助手 + 卡头「更多」从 `nodes-management.tsx` 拆出（为满足 ≤500 行）。
- `relay/uplink-section.tsx`：删除。
- `relay/relay-strip.tsx`：只改了过时的头注释。
- `management/nodes-table.tsx`、`management/node-detail-dialog.tsx`：各一行 import 路径跟随 `hub-strip` 移动（见「越界改动」）。

### test ids

- 新增：`local-uplink-tabs`、`local-uplink-tab-hub`、`local-uplink-tab-relay`、`local-uplink-hub-blocked`、`local-uplink-relay-panel`、`local-uplink-relay-standalone`、`local-machine-hub-warning-<id>`。
- 保持不变：`nodes-management`、`nodes-row-*`、`nodes-hub-offline`、`nodes-hub-login-rejected`（改在本机卡里渲染，e2e 的两条 `toHaveCount(0)` 断言不受影响，`mesh-passkey.spec.ts` 未改动）、`local-machine-*`、`nodes-relay-*`（`nodes-relay-menu` 随图标菜单一起消失）。
- 消失：`nodes-hub-strip`、`nodes-hub-chip-<id>`、`nodes-hub-warning-<id>`、`nodes-uplink-section`、`nodes-relay-menu`。

### i18n

只动了 `nodes.machine.*` 四个新键（三语同步），随后跑了 `bun run build:i18n`：

- `uplinkTabHub`：接入 Hub / Connect to Hub / Hub に接続
- `uplinkTabRelay`：接入中继 / Connect to relay / 中継に接続
- `uplinkHubBlocked`：「本机当前接入中继；要改回 Hub，先在「接入中继」里离开中继。」
- `uplinkRelayStandalone`：「中继提供公网入口，本机与各节点经它互联，无需公网地址。」

hub 模式下中继 tab 的说明复用既有 `relay.tenant.dialog.migrateNotice`。未碰 `nodes.setup.*` / `nodes.membership.*` / `nodes.enrollment.*`。

## 测试

- 新增 `uplink/local-uplink-tabs.test.tsx`（313 行）：推导规则、记忆值读写与「记的是中继就落在中继那边」、hub 模式 / 中继模式 / 多条链路 / 多条被踢 / standalone 各自的面板内容、中继模式下 Hub tab 的说明、standalone 中继 tab 的插槽。
- 新增 `uplink/hub-uplink-panel.test.tsx`（172 行）：`hubFailureNotice`、`resolveAttachedHub`、`orderHubs`、合并后 Hub 列表的 chip 诊断（warning / 离线 / writer / attached）。
- `uplink/hub-strip.test.tsx`：随文件移动，删掉 `HubStrip` 渲染那一组（组件已并入 Hub 列表），只留纯函数。
- `local-machine-card.test.tsx`、`management/nodes-management.test.tsx`：各加一个调用 `useLocalUplinkController` 的 Harness（行为与原来完全一致）；管理页里三条上级链路断言改为「不再渲染」，`hubFailureNotice` 的断言随函数搬到 `hub-uplink-panel.test.tsx`。
- `relay/relay-ui.test.tsx`：import 改指 `../uplink/relay-targets`。

## 验证

- `bunx tsc --noEmit -p apps/fe`：我的文件 0 错。剩余两处不是本任务的：`packages/shared/src/auth/key-log.ts`（另一任务在加 `rename-node`，缺两处 `Record<KeyLogType,…>` 分支）、`apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx`（另一任务把 `LocalStatusResponse.relay` 改成必填后该 fixture 未补 `relay: null`）。
- `bun test src/`（apps/fe）：**1899 pass / 0 fail**（基线 1883）。
- `bun test`（packages/shared，因改了 locale）：631 pass / 0 fail。
- `bunx biome check`：我的全部文件干净（含三份 locale JSON）。
- `bun scripts/complexity/gate.ts`：我的两处曾超标（`LocalMachineCard` 166>161、`HubMembershipRows` CC 19>15）已通过拆分消除，**未改 allowlist**。当前仍失败的两条属于其它任务：`apps/gateway/src/mesh/relay-uplink-client.ts` 605>600、`apps/gateway/src/auth/user-store.ts` 965>960。
- 仓库根 `bun run lint` 目前仍红，全部来自其它任务的文件（gateway `key-log-store.ts` / `user-key-persistence.ts` / `relay-dial.ts` / `relay-uplink-client.ts` / `uplink-client.ts` / `key-log-projection.ts`，packages/app 的 setup/membership/relay-setup 一族，`packages/shared/src/auth/encoding.test.ts`）。

## 与 EX2 建议的偏差

1. **`useHubNode` 上提到 controller**（EX2 §B3 建议留在节点管理页）。原因：`nodes-hub-offline` / `nodes-hub-login-rejected` 这两条提示按需求 3 要渲染在 Hub tab 里，而它们只能来自 `useHubNode` 的 `online` / `failure`；两处各建一份会重复轮询 `/n/<hub>/api/hub/nodes`。因此 controller 里加了一份非 owner 的 `useMeshNodes({enabled})` 只为喂给 `useHubNode`，节点管理页继续用自己的 `useMeshNodes()` 读同一份 store（`refreshMeshNodes` 单飞，不产生额外请求）。副作用是不再需要 EX2 设想的「注册额外刷新源」机制，`refreshAll` 一处全包。
2. **`HubStrip` 组件删除**（scope 写的是「keep exports」）。需求 3 要求 Hub 列表只保留一份且 test id 用 `local-machine-hub-list` / `local-machine-hub-item-<id>`，`HubStrip` 的 `nodes-hub-strip` / `nodes-hub-chip-*` 无法同时挂在同一元素上；保留它就是留一段死代码。诊断能力（候选失败警告、悬浮详情）全部并入新的 `MachineHubList`；`hub-strip.tsx` 里的纯函数导出（`hubModeLabel` / `hubDetailText` / `hubLabel` / `HubModeTag` / `hubChipTitle` / `indexCandidates` / `candidateFailure` / `normalizeHubUrl` / `CANDIDATE_ERROR_MAX`）一个没少。
3. **`relay/` 下的 `relay-strip.tsx` / `relay-dialogs.tsx` / `use-relay-actions.ts` / `use-relay-admit-follow-up.ts` 没有移进 `uplink/`**（scope 说「you may」）。`use-relay-admit-follow-up.ts` 被 `apps/fe/src/components/side-panels/connect-devices/join-token.tsx`（越界文件）引用，移动会连带改它；为把越界面积压到最小，这一族原地不动，只删了 `uplink-section.tsx`。
4. **`HubUplinkPanel` 的角色 prop 命名为 `localRole` 而不是 `role`**：biome 的 `lint/a11y/useValidAriaRole` 会把测试里字面量 `role="node"` 当成非法 ARIA role 报错。

## 越界改动（已做，请复核）

`management/hub-strip.tsx → uplink/hub-strip.tsx` 的移动强制要求更新两处 import，各一行，均在我 scope 之外：

- `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:26`
- `apps/fe/src/pages/settings/nodes/management/node-detail-dialog.tsx:34`

不改会直接编译失败，且 scope 里写明「move …（keep exports; update imports）」，故照做。除这两行外没有碰任何越界文件。

## 需要指挥官处理

1. **误用了一次 `git mv`**：`apps/fe/src/pages/settings/nodes/management/hub-strip.tsx → uplink/hub-strip.tsx` 这条重命名已被暂存进 index（`git status` 显示 `RM`）。其余改动全部未暂存。若指挥官按文件挑选暂存，请留意这一条已经在 index 里。
2. `apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx` 的 fixture 需要补 `relay: null`（`LocalStatusResponse.relay` 由另一任务改成必填）——该文件不在我 scope 内，未改。
3. `packages/shared/src/auth/key-log.ts` 的两处 `Record<KeyLogType, …>` 缺 `rename-node` 分支，当前让 `tsc -p apps/fe` 报 2 条错。
4. **standalone 的中继 setup 表单还没人填**：`nodes-tab.tsx` 目前不传 `relaySetup`（缺省 `null`），中继 tab 在 standalone 下只有一句说明。负责「本机作为中继 / 用密码加入」的任务把表单塞进 `LocalMachineCard` 的 `relaySetup` prop 即可（`data-testid="local-uplink-relay-standalone"` 容器内）。
5. **`relay` / `relay,node` 角色的 Hub tab**：`HubUplinkPanel` 目前按 `localRole === 'node' | 'hub,node'` 判定是否渲染 Hub 版式，纯 relay 角色落在「什么都不渲染」上；真正接入中继（`relay.mode === 'relay'`）时会走「本机当前接入中继」那句说明。角色转换任务如果给 `relay` 角色定义了新的 Hub tab 文案，需要在这里加分支。
6. 未跑 Playwright e2e（按规则）；`mesh-passkey.spec.ts` 未改动，其使用的四个 test id 均保持稳定。
