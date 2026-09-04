# F2 结果：本机卡五角色选择器、「本机作为中继」表单、口令生成按钮、退出 / 切换语义

## 做了什么

本机卡的角色下拉从三档扩到五档，配上完整的 5×5 转换矩阵；standalone 可以在「接入中继」tab 里直接把本机设成中继（纯中继 / 中继兼节点两档）；新增一个带「生成」按钮的口令输入组件并铺到三处。

### 1. 跨重启记号：`membership/intent.ts`

- `SetupIntent` 扩成 `'become-hub' | 'join-hub' | 'become-relay'`；新增 `SetupIntentRecord { path, role? }`（`role` 只在 `become-relay` 时有值）。
- 落盘格式 `{ path, at, role? }`。**向后兼容**：老记录没有 `role` 照样能读；`role` 是脏值时只丢 `role`、路径仍然生效。
- `writeSetupIntent(record)` / `takeSetupIntent()` 的入参与返回值都换成 record（不是字符串）。全部调用点已跟改。

新增 `setup/self-relay-followup.ts`：`enroll-self-relay` 一次性记号（sessionStorage 键 `tmex.setup.followUp`，值 `{path:'enroll-self-relay', at}`，TTL 10 分钟，读一次即清）。`relay,node` 设置成功时写入，重启后 `NodesTab` 读到就把中继 tab 顶到前面并高亮「接入本机中继」。

### 2. 5×5 转换矩阵：`membership/role-transition.ts`

`RoleTransition` 改成五种：`none` / `setup{intent}` / `leave{from,targetRole}` / `switch{from,targetRole,intent}` / `unsupported`。

| from \ to | standalone | node | hub,node | relay,node | relay |
|---|---|---|---|---|---|
| standalone | none | setup join-hub | setup become-hub | setup become-relay(relay,node) | setup become-relay(relay) |
| node | leave→standalone | none | switch become-hub | switch become-relay(relay,node) | switch become-relay(relay) |
| hub,node | leave→standalone | switch join-hub | none | switch become-relay(relay,node) | switch become-relay(relay) |
| relay,node | leave→standalone | switch join-hub | switch become-hub | none | **leave→relay** |
| relay | unsupported | unsupported | unsupported | unsupported | none |

- 新增 `isRelayRole()`；`setupPathForRole()` → `setupIntentForRole()`（返回 record）。
- `relay` 行全部 `unsupported`，`useRoleSwitch` 直接忽略——纯中继没有网页，这条路走不到。

### 3. leave 链路带 `targetRole`

- `membership/leave-api.ts`：`LocalLeaveRequest.targetRole?: 'standalone' | 'relay'`。
- `membership/leave-controller.ts`：`LeaveRequest.targetRole?`；**只有 `relay` 才把字段发出去**（standalone 是后端默认值，多发一个字段只会让日志难读，也不必改既有测试期望）。`writeIntent` 收 record。
- `use-leave-mesh.ts` 无需改（依赖注入的类型自动跟上）。

### 4. 退出对话框文案分档：`membership/leave-dialog.tsx`

`LeaveDialogRequest` 加 `targetRole`。导出两个纯函数供测试：

- `leaveDialogTitleKey`：`leave + targetRole:'relay'` → 新键 `leaveToRelayConfirm.title`「退出所属 mesh？」，其余沿用原三档。
- `leaveDialogConsequencesKey`：
  - `node` → `consequencesNode`（原）
  - `hub,node` → `consequencesHub`（原）
  - `relay,node` + `targetRole:'relay'` → 新键 `consequencesRelayKeepService`（中继服务、租户、日志**保留**）
  - `relay,node` + `targetRole:'standalone'`（含切到 node / hub,node）→ 新键 `consequencesRelayReset`（中继服务、租户、日志**全部清除，不可恢复**）
- 原来 `relay,node` 复用普通 node 文案的谎话已消除。

### 5. `PasswordFieldWithGenerate`（新）

`apps/fe/src/components/forms/password-field-with-generate.tsx`（145 行）：

- `generatePassword(length = 20)`：`crypto.getRandomValues` + **拒绝采样**（256 不是 56 的整数倍，直接取模会让前 32 个字符概率高约 14%）。字母表 `PASSWORD_ALPHABET` 去掉 `0 O 1 l I`。
- `shouldAutoGenerate(defaultGenerate, value)`：只在字段空着时自动生成，手填过的值绝不覆盖。
- 组件：输入框（`id` 同时作 `data-testid`）、显示 / 隐藏切换 `<id>-reveal`、生成按钮 `<id>-generate`、有值时才出现的复制按钮 `<id>-copy`（自带 `aria-live` 播报）。`defaultGenerate` 走挂载时的 `useEffect`。

接入三处，输入框上原有的 `id` / test id 全部保留：

| 位置 | id | defaultGenerate |
|---|---|---|
| 中继接入口令 | `setup-relay-password` | 是 |
| 中继兼节点的账号密码 | `setup-relay-account-password` | 否 |
| become-hub 的账号密码 | `setup-password` | 否 |
| 运营者改口令 | `relay-password-new` | 是 |

### 6. `BecomeRelayForm`（新）

`setup/become-relay-form.tsx`（244 行）。字段：公网地址 / 接入口令（预生成）/「本机也作为节点」开关（默认开）/ 开着时的用户名 + 密码 + 确认密码 + 直连开关。

- 校验在 `setup/validation.ts`：新增 `classifyRelayUrl`（复用 `@tmex/shared` 的 `normalizeRelayUrl`，再叠一条 production 禁 http 回环）、`validateBecomeRelay`、`defaultRelayPublicUrl`；`KNOWN_ERROR_CODES` 加 `invalid_role`。纯中继不校验账号三件。
- 提交在 `setup/submit.ts` 的 `submitBecomeRelay`：空口令统一发 `null`；纯中继不发账号字段。
- `use-hub-setup-submit.ts` 加 `waitForRestart?: boolean`。**纯中继提交后不等重启**（重启后没有网页可回，等下去只会等到超时告警），改为显示「网页即将不可用」+ `tmex relay status`。中继兼节点照旧等重启 → 跳登录页，并在成功时写 `enroll-self-relay` 记号。

两个入口：

1. `nodes-tab.tsx` 在 standalone 时把它塞进中继 tab 的 `relaySetup` 插槽（F1 留的口子）。
2. `hub-setup-wizard.tsx` 加第三张路径卡 `setup-path-become-relay`，选中即在向导下方展开同一个表单。Base UI 的 `Tabs.Panel` 默认 `keepMounted={false}`，两处不会同时进 DOM，test id 不会重复。

### 7. 纯中继确认框

`setup/pure-relay-confirm.tsx`（新）：standalone 选「纯中继」时先弹确认，讲明重启后没有网页、只能命令行管理、网页里改不回来。`relay,node → relay` 那一档由 `LeaveDialog` 的新文案覆盖同一件事。

### 8. 中继 tab（`uplink/relay-uplink-panel.tsx`）

新增两块，只在 `status.role` 含 relay 时出现：

- 顶部「本机中继」快照 `local-relay-service`：公网地址（可复制 / 未设置）、`租户 N · 在线 N · 节点 N`、口令已设置 / 未设置。数据来自 `status.relay`。
- `relay.mode === 'none'` 时的 `nodes-relay-self-entry`：一句「本机尚未接入自己的中继，接入时须再次输入刚设置的接入口令」+ `nodes-relay-enroll-self` 按钮，调 `openEnroll('enroll', status.relay.publicUrl)`。**不落任何秘密**。刚设置完（follow-up 记号）时整块高亮。通用的「接入中继」按钮照旧并存。

`local-uplink-tabs.tsx` 增加 `requestedTab`（上层要求切 tab，变一次生效一次，之后用户照样能切回去）、`selfRelayFollowUp`，并把 `status.role` / `status.relay` 下传。

### 9. `nodes-tab.tsx`

新增导出的纯函数 `routeSetupIntent(intent, selfRelayFollowUp)` → `{ wizardPath, relayRole, requestedTab }`：`become-relay` 不进 Hub 向导（表单住在中继 tab），并把 tab 切到中继；老记号没带角色时退回 `relay,node`。抽出来同时是为了把 `NodesTab` 的 CC 压回门禁内。

### 10. i18n（三语同步，已跑 `bun run build:i18n`）

- `nodes.machine.roleRelay`：「中继」→「纯中继（无网页）」/ `Relay only (no web UI)` /「中継のみ（Web なし）」
- `nodes.machine.relayService{Address,Stats,Counts,Enroll,EnrollHint}`（5 个新键）
- `nodes.membership.leaveToRelayConfirm.{title,description}`、`consequencesRelayKeepService`、`consequencesRelayReset`（4 个新键）
- `nodes.setup.*`：`path.becomeRelay.*`、`becomeRelay.{title,description,pureNotice}`、`fields.relay{PublicUrl,PublicUrlHint,Password,PasswordHint,AlsoNode,AlsoNodeHint}`、`password.{generate,show,hide}`、`pureRelayConfirm.*`、`submit.becomeRelay`、`toast.relayCreated`、`result.{relayDescription,relayNodeDescription,relayPublicUrl,relayPassword,relayWebGone}`、`errors.invalid_role`（共 24 个新键）
- `relay.admin.password.*`：**没有新增**——组件复用了已有的 `title/set/unset`。

`fixture` 修正：`setup/hub-setup-wizard.test.tsx` 的 `status()` 补 `relay: null`（G1 把 `LocalStatusResponse.relay` 改成必填留下的）。

## 新增 / 修改的文件

**新增**

- `apps/fe/src/components/forms/password-field-with-generate.tsx`（145）+ `.test.tsx`
- `apps/fe/src/pages/settings/nodes/setup/become-relay-form.tsx`（244）
- `apps/fe/src/pages/settings/nodes/setup/pure-relay-confirm.tsx`（52）
- `apps/fe/src/pages/settings/nodes/setup/self-relay-followup.ts`（53）+ `.test.ts`
- `apps/fe/src/pages/settings/nodes/membership/leave-dialog.test.tsx`
- `apps/fe/src/pages/settings/nodes/uplink/relay-uplink-panel.test.tsx`

**修改**

`nodes/local-machine-card.tsx`(+test)、`nodes/nodes-tab.tsx`(+test)、`membership/{intent,role-transition,leave-api,leave-controller,leave-dialog}`(+test)、`setup/{validation,submit,use-hub-setup-submit,hub-setup-wizard,become-hub-form}`(+test)、`uplink/{local-uplink-tabs,relay-uplink-panel}`、`relay/password-dialog.tsx`、三份 locale JSON（+ `locales/generated/*.rest.json` 由 `build:i18n` 重建）。

## 测试

新增 / 扩写：

- `role-transition.test.ts`：5×5 全矩阵逐格断言 + `isMeshRole` / `isRelayRole` / `setupIntentForRole`。
- `intent.test.ts`：`become-relay` 带角色往返、老记录无 `role` 兼容、`role` 脏值只丢 role。
- `leave-controller.test.ts`：`targetRole` 省略 / `relay` / 显式 `standalone` 三种请求体，以及切中继时记号里带角色。
- `leave-dialog.test.tsx`（新）：标题与后果的分档路由 + 中文文案把后果讲全（保留 / 不可恢复 / 先退出）。
- `password-field-with-generate.test.tsx`（新）：长度、字母表、无易混字符、每次不同；`shouldAutoGenerate` 的三种情形（默认生成 / 手填不覆盖 / 关掉）；静态版式（空值无复制按钮、有值出现、可关显示切换、禁用）。
- `validation.test.ts`：`classifyRelayUrl`（https / 回环 http 按 env / 非回环 http）、`validateBecomeRelay`（合法 / 地址错 / 空口令合法 / 账号三件错 / 纯中继不校验账号）、`defaultRelayPublicUrl`、`invalid_role`。
- `submit.test.ts`：`submitBecomeRelay` 两档的请求体（trim、空口令发 null、纯中继不发账号）。
- `self-relay-followup.test.ts`（新）：写读清、TTL、时钟回拨、脏值 / 别人的路径、无 storage。
- `hub-setup-wizard.test.tsx`：三张路径卡、选中 become-relay 渲染中继表单、`BecomeRelayForm` 两档字段与地址预填。
- `relay-uplink-panel.test.tsx`（新）：运营快照四种情形、自接入入口的出现 / 高亮 / 已接中继时消失 / 非中继角色不给、standalone 只渲染插槽。
- `nodes-tab.test.tsx`：`routeSetupIntent` 四组、standalone 中继 tab 里摆出表单、mesh 下不摆。
- `local-machine-card.test.tsx`：五个角色候选与文案（Select 选项只在展开时渲染，改为断言导出的 `SELECTABLE_ROLES` 与 `ROLE_LABEL_KEY`）。

## 验证

- `bun test src/`（apps/fe）：**1968 pass / 0 fail**（F1 交接基线 1899）。
- `bun test`（packages/shared，因改 locale）：637 pass / **1 fail**——`src/relay/relay-pack.test.ts` 找不到 `../auth/encoding` 的 `generateKdfParams`，是另一任务的在途改动，与本 diff 无关。
- `bunx tsc --noEmit -p apps/fe`：本任务文件 0 错。仅剩 2 条属其它任务：`pages/settings/relay/relay-status-store.test.ts` 与 `relay-tab.test.tsx` 的 `RelayTotals` 缺 `nodes` 字段。
- `bunx tsc --noEmit -p packages/shared`：仅 `relay-pack.test.ts` 的 `generateKdfParams`（同上，非本任务）。
- `bunx biome check`：本任务全部文件 + 三份 locale JSON 干净。
- `bun scripts/complexity/gate.ts`：本任务文件 0 违规，**未改 allowlist**。中途两处曾超标已就地拆掉：`LocalMachineCard` 165 > 161（把两个对话框抽成 `RoleDialogs`）、`NodesTab` CC 16 > 15（把记号路由抽成纯函数 `routeSetupIntent`）。当前仍失败的 10 条全部属于其它任务（gateway relay-pack / relay-runtime / hub-password-enroll、packages/app 的 hub-password-join / relay-password-join / setup-service、packages/shared 的 hub-enroll-proof / relay-pack）。
- 未跑 Playwright e2e（按规则）。

## 与需求的偏差

1. **纯中继确认框在两条路径上表现不同**：standalone → relay 走新的 `PureRelayConfirm`；`relay,node → relay` 走 `LeaveDialog`（因为它要真的调 `/api/local/leave`），后果文案里同样讲清中继保留、mesh 身份清除。没有为后者再套一层确认框。
2. **`PasswordFieldWithGenerate` 的 `defaultGenerate` 用 `useEffect` 实现**，仓库的 fe 测试没有 DOM（`react-dom/server` 静态渲染），effect 跑不到。因此「默认生成 / 重新生成 / 手动覆盖」这三条是通过导出的纯件 `generatePassword` 与 `shouldAutoGenerate` 覆盖的，组件本身只测静态版式。
3. **组件的通用文案挂在 `nodes.setup.password.*`**（生成 / 显示 / 隐藏）。它被 `pages/settings/relay/password-dialog.tsx` 复用，属于跨命名空间引用。原因：我的 i18n scope 只有 `nodes.*` 与 `relay.admin.password.*` 两块，新开一个 `forms.*` 顶层命名空间超出 scope。若指挥官希望，后续可整体挪到通用命名空间（只改三份 locale 与两处 `t()`）。
4. **`nodes.machine.roleStandalone` 仍是「独立运行」**，没有按需求描述里的「单机」改名——该文案在多处复用，且不属于本轮要解决的问题。

## 需要指挥官处理

1. `apps/fe/src/pages/settings/relay/relay-status-store.test.ts:27` 与 `relay-tab.test.tsx:45` 的 `RelayTotals` 缺 `nodes` 字段（另一任务加的字段），当前让 `tsc -p apps/fe` 报 2 条错。`relay-tab.test.tsx` 在我 scope 内「if affected」，但这条错与 `password-dialog` 改动无关，未动。
2. `packages/shared/src/relay/relay-pack.test.ts` 引用了不存在的 `generateKdfParams`，让 shared 的 `bun test` / `tsc` 各挂一条。属另一任务。
3. **e2e**：`hub-setup-wizard` 的路径卡从两张变三张（`sm:grid-cols-2` → `sm:grid-cols-3`），新增 test id `setup-path-become-relay`；`mesh-passkey.spec.ts` 用到的四个 id 未受影响。
4. **未截图核对**（规范要求新增面板要在开发实例里看换行）：本任务未起临时实例。中继表单、快照行与三个新对话框建议在合版后统一截一次。
5. `SELECTABLE_ROLES` 现在从 `local-machine-card.tsx` 导出（测试要用）；若后续有人想收回私有，记得同步改 `local-machine-card.test.tsx`。
