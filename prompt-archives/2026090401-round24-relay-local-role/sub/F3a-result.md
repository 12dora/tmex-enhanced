# F3a 结果：密码加入表单（Hub / 中继）、租户编号展示、接入设备指引重排、中继模式改名

## 做了什么

用户侧的加入路径整体从「加入码」翻成「账号密码」：Hub 加入表单默认密码方式，新增「加入已有中继」表单与向导路径卡，接入设备面板按本机上级形态给出接入信息与 CLI 命令，加入码降级为折叠的「高级」区。另外补上中继模式下的改名通道（`rename-node` 记录）。

### 1. 加入 Hub：密码为默认方式

- `setup/validation.ts`：`JoinHubValues` 加 `method: 'password' | 'token'` 与 `password`；`validateJoinHub` 按方式二选一校验（密码只判非空——账号是在别处建的，长度规则本机无从得知，错了由 Hub 回 401）。`KNOWN_ERROR_CODES` 加 `invalid_body` / `invalid_password`。
- `setup/submit.ts`：`submitJoinHub` 发 `method`，并且 **token 与 password 只发当前那一个**（后端见到两个都带会直接 400）。
- `setup/join-hub-form.tsx`：默认密码方式（`setup-join-password-input` + `setup-join-method-token`「改用加入码」），切过去是原来的加入码多行输入（`setup-join-token-input` 保持不变）+ `setup-join-method-password`。

### 2. 加入中继（新）

- `setup/join-relay-form.tsx`（新）：中继地址、租户编号、账号密码、本机名称、直连开关，CA 指纹收在 `setup-relay-advanced-toggle` 后面。提交走 `SetupApi.relayJoin()`，复用 `useHubSetupSubmit` 的等重启 → 跳登录页。为过复杂度门禁拆成 `JoinRelayResult` / `JoinRelayFields` 两个子件。
- 校验 `validateJoinRelay`：租户编号 32 位十六进制（`normalizeTenantId` 去空白转小写）、CA 指纹 64 位十六进制（可空）、地址按 `classifyRelayUrl`。
- `setup/standalone-relay-setup.tsx`（新）：standalone 中继 tab 里并排两块——`setup-relay-choice-join`（加入已有中继，在前）与 `setup-relay-choice-host`（本机作为中继，在后），各带小标题。由 `nodes-tab.tsx` 塞进本机卡的 `relaySetup` 插槽。
- `hub-setup-wizard.tsx`：第四张路径卡 `setup-path-join-relay`（网格改 `sm:grid-cols-2 lg:grid-cols-4`），选中即展开 `JoinRelayForm`。
- `membership/intent.ts`：`SetupIntent` 增 `'join-relay'`（`isSetupIntent` 同步放行）。`nodes-tab.tsx` 的 `routeSetupIntent` 把 `join-relay` 与 `become-relay` 一起归到「不进 Hub 向导、落中继 tab」。
- **`membership/role-transition.ts` 未改**：那里没有对 intent 做穷尽匹配（`HUB_INTENT` 是子集 Record，`setupIntentForRole` 只产 `become-relay`），角色矩阵语义按要求原样保留。

### 3. 租户编号展示

`relay/relay-strip.tsx` 加可选 `tenantId`：链路条下方多一行「租户编号」+ `CopyableValue`（testid `nodes-relay-tenant-id`）+ 一句「另一台机器用中继地址、租户编号与账号密码即可加入同一租户」。`uplink/relay-uplink-panel.tsx` 把 `relay.tenantId` 传进去。原 `nodes-relay-strip` 那一行的 test id 与内容不变（外面多包了一层 flex-col）。

### 4. 接入设备面板

- `computer-join-guide.tsx`（新，从 `computer-guide.tsx` 拆出 `JoinSteps`）：
  - 纯函数 `resolveJoinUplink()` 按 `/api/auth/mode` + `useMeshRelay` 折出 `hub | relay | unknown`。
  - 步骤 3 `connect-step-join-uplink`：hub 模式给 Hub 地址；中继模式给中继地址 + 可复制的租户编号（`command-block-join-tenant-id`）。
  - 步骤 4 `connect-step-join-password`：网页路径文案（「设置 → 多节点互联」→「加入已有 Hub」/「加入中继」）+ CLI 命令块 `command-block-join-password`（`tmex hub join <url> --password` / `tmex relay join <url> --tenant <id>`）。
  - `<details data-testid="connect-join-token-advanced">`「使用加入码（高级）」内保留原来的三步（`connect-step-join-token` / `-run` / `-confirm` 与 `command-block-join` 全部沿用）。
- `join-command-preview.ts` 增 `passwordJoinCommand()` / `relayJoinCommand()`（地址仍过 `isTrustedHubUrl` + shell 引用，畸形地址退回示例地址）。
- 顺手做了一轮术语订正（`connectDevices.computer.*` 里把指 Hub 的「中继」全部改掉）：tab 改成「让新机器加入」/「把本机设为 Hub」，`host.hub.title`「设为中继」→「设为 Hub」等。移动端指引未涉及加入码，未改。

### 5. 中继模式改名

- `node/rename-node.ts`（新）：`buildRenameNodeRecord()` + `renameNodeViaKeyLog()`——取 head → 签 `rename-node` → `appendKeyLog({hubSync:true})`，整段在 `withKeyLogLock` 里；上级未确认折成 `RENAME_UNCONFIRMED`；`renameRetryable()` 复用 `classifyKeyLogFailure`。
- `management/use-node-row-actions.ts`：`rename` 先 `fetchRelayMode()`（当场问网关，与吊销同一条判据，不吃 30 秒陈旧快照），中继模式走 `prompt.withSigner` + `renameNodeViaKeyLog`，hub 模式照旧打 `hubApi.rename`。节点详情框经 `createNodeDetailIo(rename)` 自动跟着走。
- `use-node-rename-channel.ts`：`NodeRenameChannel` 从 `{hubApi}` 改成 `{renameNode, canRenameNode, refreshHub, dialog}`。中继模式自带 `useCredentialPrompt`，`canRenameNode` 改判「有没有挂上中继」（hub 模式仍判 writer hub 在线且未被拒写）。
- `use-site-settings-save.ts`：选项 `hubApi` → `renameNode`。

### 6. i18n

三语同步后跑了 `bun run build:i18n`。新增/改动的键：

- `nodes.setup.*`：`path.joinRelay.*`、`joinHub.{passwordDescription,useToken,usePassword}`、`joinRelay.{title,description,advanced,hideAdvanced}`、`fields.{joinPassword,joinPasswordHint,relayUrl,relayUrlHint,relayUrlPlaceholder,tenantId,tenantIdHint,caFingerprint,caFingerprintHint,directEnableRelayHint,directUnsupportedRelayHint}`、`submit.joinRelay`、`toast.relayJoined`、`result.{relayJoinDescription,relayUrl,tenantId}`、`errors.{invalid_body,invalid_password,invalid_tenant_id,invalid_ca_fingerprint}`、`introDetail`（「两种方式」→「任选一种」）。
- `nodes.rename.cancelled`。
- `relay.tenant.strip.{tenantId,tenantIdHint}`。
- `connectDevices.computer.*`：新增 `join.uplink.*`、`join.password.*`、`join.advanced.*`；删掉 `join.hub.*`（那一步被 uplink 取代）；改写 `intro`、`mode.*`、`join.token.description`、`join.confirm.description`、`host.entry.status.quick`、`host.hub.title`、`host.hub.status.node`、`host.invite.*`。

三语键集合一致（差异只有 en 既有的 `_one`/`_other` 复数变体）。

## 新增 / 修改的文件

**新增**

- `apps/fe/src/pages/settings/nodes/setup/join-relay-form.tsx`（249）
- `apps/fe/src/pages/settings/nodes/setup/standalone-relay-setup.tsx`（48）
- `apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx`（201）+ `.test.tsx`
- `apps/fe/src/node/rename-node.ts`（94）+ `.test.ts`

**修改**

`setup/{validation,submit,join-hub-form,hub-setup-wizard}`(+test)、`nodes-tab.tsx`(+test)、`membership/intent.ts`(+test)、`relay/relay-strip.tsx`、`relay/relay-ui.test.tsx`、`uplink/relay-uplink-panel.tsx`(+test)、`connect-devices/{computer-guide.tsx,join-command-preview.ts,connect-devices-panel.test.tsx}`、`settings/{use-node-rename-channel.ts(+test),use-site-settings-save.ts}`、`management/use-node-row-actions.ts`(+test)、三份 locale JSON（+ `build:i18n` 产物）。

## 测试

- `validation.test.ts`：两种加入方式的分档校验；`validateJoinRelay` 的合法/租户编号大小写与空白/密码与名称必填/地址/CA 指纹；`normalizeTenantId`；新错误码查表。
- `submit.test.ts`：`submitJoinHub` 密码方式只发 `password`；`submitJoinRelay` 的归一化与「指纹空则不发字段 / 填了转小写」。
- `hub-setup-wizard.test.tsx`：四张路径卡、选中 `join-relay` 渲染新表单、`JoinHubForm` 默认密码版式、`JoinRelayForm` 字段与中继版直连文案。
- `nodes-tab.test.tsx`：`routeSetupIntent('join-relay')`；standalone 中继 tab 里两块的存在与先后顺序。
- `intent.test.ts`：`join-relay` 往返。
- `relay-ui.test.tsx`：租户编号可复制 + 提示，未接入时整格不出现。
- `computer-join-guide.test.tsx`（新，161 行）：`resolveJoinUplink` 三种形态；两条密码命令（含不可信地址退回示例）；`JoinSteps` 在 hub / 中继 / 未加入三种情形下的渲染。
- `connect-devices-panel.test.tsx`：步骤集合改为 `uplink/password/token/run/confirm` + 折叠区。
- `rename-node.test.ts`（新）：记录类型 / seq / payload（node_id + trim 后的名字）/ `hubSync:true`；未确认；失败码原样带回；非法 node id 与空名字不发请求；`renameRetryable`。
- `use-node-row-actions.test.ts`：静态渲染探针取出 `rename`，验证 hub 模式打控制面、中继模式签 `rename-node` 且不碰控制面。
- `use-node-rename-channel.test.tsx`：改成断言 `renameNode` 实际打到哪台 hub；新增中继模式两条（挂上时可用且不打控制面、一条都没挂上时不可用）。

## 验证

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit -p apps/fe` | 只剩 1 条**非本任务**错误（见下「需要指挥官处理」1） |
| `bunx tsc --noEmit -p packages/shared` | 0 |
| `bun test src/`（apps/fe） | **2029 pass / 0 fail**（交接基线 1968，其间另有并行任务的用例） |
| `bun test`（packages/shared） | 646 pass / 0 fail |
| `bunx biome check`（本任务全部文件 + 三份 locale） | 干净 |
| `bun scripts/complexity/gate.ts` | **complexity gate ok**（`JoinRelayForm` 曾 186 > 120，已拆成 `JoinRelayResult` + `JoinRelayFields`；未改 allowlist） |

未跑 Playwright e2e（按规则）。`apps/fe/tests` 里没有引用我改动的任何 test id。

## 与需求的偏差

1. **中继 tab 的两块没做成 `relay-uplink-panel.tsx` 的两个插槽**，而是由 `nodes-tab.tsx` 把 `StandaloneRelaySetup`（内含两块 + 小标题）塞进既有的单个 `relaySetup` 插槽。原因：插槽的传递链是 `nodes-tab → local-machine-card → local-uplink-tabs → relay-uplink-panel`，中间两个文件不在我的 scope 里，加第二个插槽必然越界。`relay-uplink-panel.tsx` 因此只改了传 `tenantId` 那一处。顺序与分隔按需求：「加入已有中继」在前，「本机作为中继」在后。
2. **`NodeRenameChannel.renameNode` 不为 null**（通道不通时调用会抛已本地化的原因），与原来 `hubApi` 总是给出、由 `canRenameNode` 单独控制禁用态的语义保持一致。
3. **`nodes.detail.renameUnavailable`（「当前 Hub 不可写入，暂时无法改名。」）在中继模式下文案不准**——那里表示「一条中继都没挂上」。该键不在我的 i18n scope（`nodes.detail.*`），未改，见下。

## 越界改动（已做，请复核）

中继模式改名要一次凭据交互，凭据对话框必须挂进「通用」标签的组件树里；这条链路上有两个文件不在我的 scope，不改则「设置 → 通用」里的自改名在中继模式下会永远挂起。改动共 5 行：

- `apps/fe/src/pages/settings/use-site-settings-form.ts`：`useNodeRenameChannel(linkage, { t })` 取 `renameNode` / `dialog`，把 `dialog` 以 `renameDialog` 加进 `SiteSettingsForm`，并把 `renameNode` 传给 `useSiteSettingsSave`（原本传 `hubApi`）。
- `apps/fe/src/pages/settings/general-settings-tab.tsx`：末尾渲染 `{form.renameDialog}`。

## 需要指挥官处理

1. **`apps/fe/src/pages/settings/nodes/uplink/local-uplink-tabs.test.tsx:64` 的 `RelayActionsController` fixture 缺 `packPending` / `retryPack`**（F3b 给 `use-relay-actions.ts` 加的字段），当前让 `tsc -p apps/fe` 报 1 条错。该文件不在我 scope，未改；我 scope 内的同类 fixture（`relay-uplink-panel.test.tsx`）已补齐。
2. **G3 遗留的 409 未解决**：`apps/gateway/src/hub/hub-authorization.ts` 的 `inspectHubAuthRecordCompat` 只对 `RELAY_RECORD_TYPES` 在空注册表时豁免，中继租户提交 `rename-node` 仍会吃 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`。见 G3-result「需要指挥官处理」1——不做这一步，本任务的中继改名在真实中继上会被拒。
3. `nodes.detail.renameUnavailable` 与 `settings.general.nameLinkedLocked` 两条文案在中继模式下都还写着「Hub」，建议后续按上级形态分档（不在我的 i18n scope）。
4. **未截图核对**：新增的「加入中继」表单、standalone 中继 tab 的两块、接入设备面板的新版式都没在开发实例里看过换行，建议合版后统一截一次。
5. e2e：接入设备面板的 test id 有变（`connect-step-join-hub` 消失，新增 `connect-step-join-uplink` / `connect-step-join-password` / `connect-join-token-advanced`），向导路径卡从三张变四张（新增 `setup-path-join-relay`）。当前 `apps/fe/tests` 未引用这些 id。
