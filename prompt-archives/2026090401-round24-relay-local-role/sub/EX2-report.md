# 结论

当前 wiring 已支持 `relay` 数据链路，但 UI 仍把中继操作挂在 `NodesManagement` 中；`LocalRole` 和角色文案已经包含 relay 角色，真正缺口是角色转换、standalone relay setup、状态字段与后端路由。

`nodes-management.tsx` 实际为 594 行（`wc -l`），已接近 600 行门槛；`local-machine-card.tsx` 为 502 行。建议将 uplink owner、uplink tabs、relay actions/dialogs 从节点管理组件中移出。

## A. 当前 wiring

### A1. Uplink、relay actions 与节点管理

整体入口：

```text
useSharedAuthMode()
        │
        └── NodesTab
              ├── useLocalStatus()
              ├── LocalMachineCard
              ├── standalone → HubSetupWizard
              └── mesh → NodesManagement
```

- [`useSharedAuthMode()`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-nodes.ts:364) 通过共享 mesh store 返回 `mode`、`loaded`、`meshEnabled`、`entryNodeId`；实现见 [`mesh-nodes.ts:372-382`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-nodes.ts:372)。
- [`NodesTab`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:18) 根据 `mode?.mode !== 'mesh'` 判定 standalone。它将 `mode`、`local.status`、`local.refresh` 传给 [`LocalMachineCard`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:42)；mesh 时再渲染 [`NodesManagement`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/nodes-tab.tsx:72)。
- [`useLocalStatus`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/use-local-status.ts:27) 调用 `GET /api/local/status`，401 被转换为 `loginRequired`。

本机卡当前职责：

- Props 定义见 [`local-machine-card.tsx:43-54`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:43)。
- 角色选择器只渲染 `standalone`、`node`、`hub,node`，见 [`local-machine-card.tsx:56-57`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:56)。
- 角色选择逻辑见 [`local-machine-card.tsx:67-95`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:67)；目前只支持 standalone setup、mesh leave、mesh-to-mesh switch。
- 卡片主体在 [`local-machine-card.tsx:152-257`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:152)，包含角色、`MachineHubRows`、直连、域名访问、账号安全、重启与 leave dialog。
- `MachineHubRows` 在 [`local-machine-card.tsx:291-350`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:291) 内部调用 `useMeshHubs({ enabled: enabled && meshRole })`。
- 当前 `meshRole` 只包括 `node`、`hub,node`，因此 `relay,node` 不会启用 Hub store，见 [`local-machine-card.tsx:315-316`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:315)。

节点管理当前拥有全部 uplink 状态：

- `useMeshNodes()`、`useHubNode()`、`useMeshHubs({ owner: true })`、`useMeshRelay({ owner: true })` 在 [`nodes-management.tsx:87-110`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:87) 创建。
- `useMeshHubs` 和 `useMeshRelay` 的 `owner: true` 表示节点管理页负责轮询；其它消费者只订阅共享 store。
- `refreshAll` 同时刷新节点、Hub、Hub 集合和 relay，见 [`nodes-management.tsx:132-140`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:132)。
- 写入权限计算见 [`nodes-management.tsx:148-154`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:148)：

  ```ts
  relay.relayMode
    ? relay.writable
    : hub.online && !hubs.writesBlocked
  ```

- `RelayActionsController` 在 [`nodes-management.tsx:142`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:142) 创建。
- 当前 `UplinkSection` 在 [`nodes-management.tsx:283-290`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:283) 渲染。
- `RelayEnrollDialog`、`RelayConfirmDialog` 和凭据 dialog 在 [`nodes-management.tsx:327-331`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:327) 渲染。
- 文件总长度为 594 行，已经是当前主要复杂度风险点。

`UplinkSection`：

- Props 为 `relay`、`hubs`、`hubOnline`、`hubNotice`、`actions`，见 [`relay/uplink-section.tsx:59-72`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:59)。
- `relay.relayMode` 时渲染 `RelayStrip`，否则渲染 `HubStrip`，见 [`uplink-section.tsx:75-92`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:75)。
- Relay 模式下展示：

  - kicked / reauth：[`uplink-section.tsx:95-114`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:95)
  - meta-key pending / retry：[`uplink-section.tsx:115-132`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:115)
  - 未连接中继：[`uplink-section.tsx:134-142`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:134)

- Hub 模式下展示 Hub offline 和 standby notice，见 [`uplink-section.tsx:144-165`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:144)。
- 当前 Network 图标菜单是 [`RelayActionsMenu`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:170)：

  - `add`：[`uplink-section.tsx:201-207`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:201)
  - 多条 kicked relay 的 reauth：[`uplink-section.tsx:209-225`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:209)
  - remove：[`uplink-section.tsx:227-236`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:227)
  - rotate：[`uplink-section.tsx:237-242`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:237)
  - leave：[`uplink-section.tsx:243-249`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:243)
  - 非 relay 模式下的 enroll / migrate：[`uplink-section.tsx:251-259`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx:251)

Relay 数据 hook：

- [`useMeshRelay`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-relay.ts:197) 返回 `relayMode`、`mode`、`attached`、`ordered`、`writable`、`kicked`、`refresh`，实现见 [`mesh-relay.ts:207-252`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-relay.ts:207)。
- standalone 必须传 `enabled: false`，否则会访问 `/api/mesh/*`。
- [`useMeshHubs`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-hubs.ts:192) 返回 Hub 集合、`writerPublicUrl`、`writesBlocked`、`refresh`，实现见 [`mesh-hubs.ts:205-243`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-hubs.ts:205)。

Relay 展示：

- [`RelayStrip`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx:41) 渲染 relay chips、meta epoch、节点数和 quota。
- Relay chip 逻辑见 [`relay-strip.tsx:20-38`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx:20)。
- 测试 id 为 `nodes-relay-strip`、`nodes-relay-empty`、`nodes-relay-meta`、`nodes-relay-peers`、`nodes-relay-quota`、`nodes-relay-chip-${relayLabel}`，见 [`relay-strip.tsx:55-95`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx:55)。

`RelayActionsController`：

- 类型与状态见 [`use-relay-actions.ts:47-73`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:47)。
- `useRelayActions` 创建位置及状态见 [`use-relay-actions.ts:95-124`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:95)。
- enroll / migrate / add / reauth 最终调用 `enrollRelay`，见 [`use-relay-actions.ts:126-152`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:126)。
- rotate / remove / leave 通过 `prompt.withSigner` 执行，见 [`use-relay-actions.ts:156-172`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:156) 和 [`use-relay-actions.ts:211-223`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:211)。
- 自动补发 meta-key 的 hook 为 `useAutoRetryMetaKey`，见 [`use-relay-actions.ts:235-262`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:235)。
- pending 数据存储在 [`relay-meta-key-pending.ts`](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-meta-key-pending.ts:10)，使用 `sessionStorage` key `tmex.relay.metaKeyPending`。

Dialog：

- `RelayEnrollDialog` 和 `RelayEnrollForm` 见 [`relay-dialogs.tsx:78-183`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:78)。
- 表单字段：relay URL、relay password、当前本机 root password，见 [`relay-dialogs.tsx:111-148`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:111)。
- `RelayConfirmDialog` 处理 leave、rotate、remove，见 [`relay-dialogs.tsx:186-224`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:186)。

Meta-key admit follow-up：

- [`useRelayAdmitFollowUp`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-admit-follow-up.ts:23) 接收 `enabled`、`admittedIds`、`api`、`mode`。
- 节点 enrollment admit 成功后，从证书读取 node id，追加 `meta-key { op: 'admit' }`，见 [`use-relay-admit-follow-up.ts:45-65`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-admit-follow-up.ts:45)。
- 缺少 signer 或 append 失败时写入 pending store，见 [`use-relay-admit-follow-up.ts:67-114`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/use-relay-admit-follow-up.ts:67)。
- 当前由 `NodesManagement` 挂载，见 [`nodes-management.tsx:218-224`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:218)。

节点 enrollment 链路：

- `NodesManagement` 通过 `useEnrollmentEngine` 监听 enrollment、确认 admit、处理过期和取消，见 [`nodes-management.tsx:205-218`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:205)。
- Relay 模式使用 `defaultRelayEnrollmentApi`，否则使用 Hub API，见 [`nodes-management.tsx:209`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.tsx:209)。
- [`useCreateEnrollment`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/use-create-enrollment.ts:31) 同样根据 `relay.relayMode` 选择 Hub 或 relay。
- Relay enrollment channel 定义在 [`hub-api.ts:169-188`](/Users/konata/code/tmex-r24/apps/fe/src/node/hub-api.ts:169)。
- `createEnrollmentOnRelay` 生成 `r3.` join string，见 [`relay-join.ts:45-103`](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-join.ts:45)。

### A2. Standalone wizard、SetupIntent 与角色转换

当前 standalone 页面：

- [`HubSetupWizard`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:28) 只支持 `become-hub` 和 `join-hub`，类型见 [`hub-setup-wizard.tsx:16-26`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:16)。
- 非 standalone 时直接返回 `null`，见 [`hub-setup-wizard.tsx:47-48`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:47)。
- standalone 页面渲染两张路径卡，见 [`hub-setup-wizard.tsx:50-103`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:50)。

两个表单：

- `BecomeHubForm`：公开 Hub URL、用户名、密码、确认密码、直连开关，见 [`become-hub-form.tsx:53-80`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx:53)。
- `BecomeHubForm` 先调用 `POST /api/setup/precheck`，见 [`become-hub-form.tsx:89-99`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/become-hub-form.tsx:89)。
- `JoinHubForm`：Hub URL、Hub join token、节点名、直连、非 production 下的 insecure local，见 [`join-hub-form.tsx:35-63`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx:35)。
- 公共提交状态机在 [`use-hub-setup-submit.ts:35-82`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts:35)：提交前读取 `healthz.startedAt`，提交后等待进程重启，再刷新或跳转。
- 请求封装在 [`submit.ts:22-50`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/submit.ts:22)。
- API client 只暴露 `precheck`、`becomeHub`、`joinHub`，见 [`setup-api.ts:80-112`](/Users/konata/code/tmex-r24/packages/api-client/src/local/setup-api.ts:80)。

`SetupIntent`：

- 当前类型只有 `'become-hub' | 'join-hub'`，见 [`intent.ts:15-27`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/intent.ts:15)。
- 存储 key 为 `tmex.setup.intent`，使用 `sessionStorage`，TTL 为 10 分钟，见 [`intent.ts:10-13`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/intent.ts:10)。
- 写入、读取一次后清除、过期检查见 [`intent.ts:57-95`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/intent.ts:57)。

角色转换：

- [`ROLE_LABEL_KEY`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/role-transition.ts:14) 已经包含五个角色，包括 `relay` 与 `relay,node`。
- 当前 `MeshRole` 是 `Exclude<LocalRole, 'standalone' | 'relay'>`，即只包括 `node`、`hub,node`、`relay,node`，见 [`role-transition.ts:10-12`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/role-transition.ts:10)。
- `setupPathForRole` 只识别 `hub,node`，其余一律返回 `join-hub`，见 [`role-transition.ts:36-38`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/role-transition.ts:36)。
- 因此当前错误包括：

  - standalone → relay：错误变成 `join-hub`
  - standalone → relay,node：错误变成 `join-hub`
  - node / hub,node → relay：只 leave 到 standalone，不会继续进入 relay setup
  - node / hub,node → relay,node：错误进入 `join-hub`
  - relay → node / hub,node：纯 relay 被当作非 mesh，错误进入 Hub setup
  - relay,node → relay：只会 leave 到 standalone，无法保留 relay 角色

- 分类实现见 [`role-transition.ts:40-45`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/role-transition.ts:40)。

`r3.` relay join string：

- `JoinHubForm` 不接受 `r3.`。
- 前端校验正则只接受 128 位 base64url，或追加 `.64 位小写 hex`，见 [`validation.ts:10-16`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/validation.ts:10)。
- `validateJoinHub` 还要求 Hub URL，见 [`validation.ts:103-123`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/validation.ts:103)。
- `r3.` 解码器在 [`packages/shared/src/relay/join-token.ts`](/Users/konata/code/tmex-r24/packages/shared/src/relay/join-token.ts:221)。
- 当前所谓 relay enroll mode 是 [`RelayEnrollDialog`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:78)，由 mesh 下的 `NodesManagement` 渲染；它不是 standalone 流程。
- 结论：standalone 当前没有 relay enrollment。现有 `migrate` / `enroll` 只适用于已有本机账号和 key log 的 mesh 节点。

### A3. i18n

主要 namespace：

- `nodes.machine.*`：角色、本机地址、当前 Hub、账号安全，见 [`zh_CN.json:1796-1852`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:1796)。
- `nodes.hubs.*`：Hub 集群、主备、writer、Hub chip 诊断，见 [`zh_CN.json:1716-1794`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:1716)。
- `nodes.membership.*`：离开、切换角色、更换 Hub，见 [`zh_CN.json:1854-1889`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:1854)。
- `nodes.setup.*`：standalone setup wizard，见 [`zh_CN.json:2274-2320`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:2274)。
- 其它相关节点命名空间：`nodes.enrollment.*`、`nodes.actions.*`、`nodes.selection.*`、`nodes.upgrade.*`、`nodes.https.*`。
- `relay.tenant.*`：relay strip、enroll、reauth、leave、remove、meta-key、错误，见 [`zh_CN.json:2421-2523`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:2421)。
- `relay.admin.*` 是公共 relay 运营页面，不是节点 uplink UI。

源 locale 文件：

- [`packages/shared/src/i18n/locales/en_US.json`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/en_US.json:1706)
- [`packages/shared/src/i18n/locales/zh_CN.json`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:1706)
- [`packages/shared/src/i18n/locales/ja_JP.json`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/ja_JP.json:1706)
- [`packages/shared/src/i18n/locales/manifest.json`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/manifest.json)

生成文件：

- `locales/generated/en_US.core.json`
- `locales/generated/en_US.rest.json`
- `locales/generated/zh_CN.core.json`
- `locales/generated/zh_CN.rest.json`
- `locales/generated/ja_JP.core.json`
- `locales/generated/ja_JP.rest.json`
- [`resources.ts`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/resources.ts)
- [`types.ts`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/types.ts)

生成方式：

- [`packages/shared/package.json:21-23`](/Users/konata/code/tmex-r24/packages/shared/package.json:21)
- 执行 `bun run build:i18n`
- 脚本读取 locale JSON、生成资源和类型，见 [`build-i18n.ts:38-76`](/Users/konata/code/tmex-r24/packages/shared/scripts/build-i18n.ts:38)。
- core/rest 拆分见 [`core-keys.ts:43-74`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/core-keys.ts:43)。

不要直接修改生成文件。

### A4. 测试与 test ids

直接相关的 `*.test.tsx`：

- [`local-machine-card.test.tsx`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.test.tsx:388)：角色、Hub 归属、多 Hub、本机地址；文件共 832 行。
- [`management/nodes-management.test.tsx`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx:145)：节点表、Hub offline、节点管理卡；Hub 集群相关断言在 [`:328-440`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx:328)。
- [`management/hub-strip.test.tsx`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/management/hub-strip.test.tsx:38)：Hub 候选诊断、chip、writer/attached 状态。
- [`relay/relay-ui.test.tsx`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx:29)：RelayStrip、relay enroll 校验、错误映射、blocked hint、reauth target。
- [`setup/hub-setup-wizard.test.tsx`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx:35)：wizard 路径、BecomeHubForm、JoinHubForm、字段和 test ids。
- [`nodes-tab.test.tsx`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx:112)：standalone / mesh 分支、HTTPS、wizard、pending enrollment。

相关逻辑测试：

- [`apps/fe/src/node/mesh-hubs.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-hubs.test.ts:48)
- [`apps/fe/src/node/mesh-relay.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/node/mesh-relay.test.ts:53)
- [`apps/fe/src/node/relay-enroll.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-enroll.test.ts:76)
- [`apps/fe/src/node/relay-join.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-join.test.ts:55)
- [`apps/fe/src/node/relay-meta-key-pending.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/node/relay-meta-key-pending.test.ts:49)
- [`membership/intent.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/intent.test.ts:42)
- [`membership/role-transition.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/role-transition.test.ts:6)
- [`membership/use-leave-mesh.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.test.ts:10)
- [`membership/leave-controller.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/leave-controller.test.ts:97)
- [`membership/self-revoke.test.ts`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/self-revoke.test.ts:53)

现有 e2e：

- 只有 [`apps/fe/tests/mesh-passkey.spec.ts:169-180`](/Users/konata/code/tmex-r24/apps/fe/tests/mesh-passkey.spec.ts:169) 触及设置页节点 tab。
- 使用的 test ids：

  - `nodes-management`
  - `nodes-row-${hubNodeId}`
  - `nodes-row-${remoteNodeId}`
  - `nodes-hub-offline`
  - `nodes-hub-login-rejected`

- 当前没有 relay、Network 菜单或 local machine card 的 e2e spec。

相关 test ids：

- 本机卡：`local-machine-card`、`local-machine-role`、`local-machine-role-${role}`、`local-machine-local-address`、`local-machine-current-hub`、`local-machine-change-hub`、`local-machine-hub-list`、`local-machine-hub-item-${nodeId}`、`local-machine-hub-offline-${nodeId}`。
- Hub uplink：`nodes-hub-strip`、`nodes-hub-chip-${id}`、`nodes-hub-warning-${id}`、`nodes-hub-standby`。
- Relay uplink：`nodes-relay-strip`、`nodes-relay-empty`、`nodes-relay-meta`、`nodes-relay-peers`、`nodes-relay-quota`、`nodes-relay-chip-${host}`。
- Relay actions：`nodes-relay-menu`、`nodes-relay-enroll`、`nodes-relay-add`、`nodes-relay-reauth`、`nodes-relay-reauth-action`、`nodes-relay-reauth-menu`、`nodes-relay-remove-${host}`、`nodes-relay-rotate`、`nodes-relay-leave`。
- Relay dialogs：`nodes-relay-enroll-dialog`、`nodes-relay-url`、`nodes-relay-password`、`nodes-relay-root-password`、`nodes-relay-enroll-submit`、`nodes-relay-confirm-dialog`、`nodes-relay-confirm-ok`。
- Setup：`hub-setup-wizard`、`setup-path-become-hub`、`setup-path-join-hub`、`setup-become-hub-form`、`setup-join-hub-form`、`setup-join-token-input`。

### A5. `MachineHubRows` 与 `useMeshHubs`

`MachineHubRows` 的数据含义：

- `hubUrl` 只是入会时写入的拨号 seed，不一定是当前实际连接的 Hub。
- 当前实际挂载 Hub 从 `useMeshHubs` 的 `attached` 解析。
- Hub 主备角色从 Hub 集合中按 `selfNodeId` 查找。
- `hub,node` 显示本机公开地址。
- `node` 显示当前 Hub 和更换 Hub。
- Hub 集合不少于两台时显示本机 Hub 列表。

实现见 [`local-machine-card.tsx:291-350`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/local-machine-card.tsx:291)。

当前启用条件：

```ts
useMeshHubs({ enabled: enabled && (role === 'node' || role === 'hub,node') })
```

因此：

- `LocalMachineCard` 是 `owner: false` 的共享 store consumer。
- `NodesManagement` 是唯一 `owner: true` 的 Hub/relay polling owner。
- standalone 下通过 `enabled: false` 避免访问 mesh API。
- `relay,node` 不会启用此 Hub 视图。

## B. 建议的两 Tab 重构

### B1. 目标组件树

```text
NodesTab
├── LocalMachineCard
│   └── LocalUplinkTabs
│       ├── TabsTrigger: 接入 Hub
│       │   ├── HubUplinkPanel
│       │   │   ├── 当前 Hub
│       │   │   ├── Hub 列表
│       │   │   ├── 更换 Hub
│       │   │   └── standalone: become/join Hub
│       │   └── standalone: HubSetupWizard
│       └── TabsTrigger: 接入中继
│           ├── RelayUplinkPanel
│           │   ├── RelayStrip
│           │   ├── enroll/add/reauth
│           │   ├── remove/rotate/leave
│           │   ├── quota
│           │   └── kicked/meta-key notices
│           └── standalone: BecomeRelayForm
└── NodesManagement
    ├── EnrollmentSection
    └── NodesTable
```

`@tmex/ui/tabs` 已存在：

- [`packages/ui/src/components/tabs.tsx:10-86`](/Users/konata/code/tmex-r24/packages/ui/src/components/tabs.tsx:10)
- 入口应使用 `@tmex/ui/tabs`，不是重新实现。
- 设置页已有使用范例，[`SettingsPage.tsx:24-37`](/Users/konata/code/tmex-r24/apps/fe/src/pages/SettingsPage.tsx:24)。

### B2. 组件拆分

建议：

1. `local-machine-card.tsx`

   保留角色、直连、域名访问、账号安全、重启和通用 dialog；移除 `MachineHubRows` 的大部分实现。目标控制在约 300 行。

2. 新建 `local-uplink-tabs.tsx`

   Props 建议：

   ```ts
   interface LocalUplinkTabsProps {
     mode: AuthModeResponse | null;
     status: LocalStatusResponse | null;
     initialSetupIntent: SetupIntent | null;
     uplink: LocalUplinkController;
     onRefresh: () => void;
     onSelectSetupPath: (intent: SetupIntent) => void;
   }
   ```

   负责 Tabs 状态、Hub/relay 两个面板和 standalone setup 的路由。

3. 新建 `local-uplink-controller.ts`

   集中创建一次：

   ```ts
   interface LocalUplinkController {
     hubs: UseMeshHubsResult;
     relay: UseMeshRelayResult;
     relayActions: RelayActionsController;
     prompt: CredentialPromptHandle;
     refresh: () => void;
   }
   ```

   `useMeshHubs({ owner: true })`、`useMeshRelay({ owner: true })` 和 `useRelayActions` 从 `NodesManagement` 移到这里，避免重复 owner polling。

4. 新建 `local-hub-section.tsx`

   负责 `MachineHubRows`、`CurrentHubRow`、当前 Hub、Hub 列表、change Hub。

5. 将：

   ```text
   management/hub-strip.tsx
   management/hub-strip.test.tsx
   ```

   移到：

   ```text
   local-hub-strip.tsx
   local-hub-strip.test.tsx
   ```

   `HubStrip` 只保留一份。不要同时渲染旧的 `HubListRow` 和 `HubStrip`，否则本机卡中会出现重复 Hub 列表。建议保留 `HubStrip` 的诊断能力，并让 `local-machine-hub-list` 作为外层兼容 test id。

6. `relay/uplink-section.tsx`

   保留 relay branch，改名为 `RelayUplinkSection` 或拆出 `relay-actions-menu.tsx`。它不再渲染 Hub branch，也不再位于 `NodesManagement`。

7. `relay-dialogs.tsx`、`use-relay-actions.ts`

   改由 `LocalUplinkTabs` 或 `RelayUplinkPanel` 挂载。Network 菜单随之进入“接入中继” tab。

8. `useRelayAdmitFollowUp`

   继续挂在节点 enrollment 所在的管理侧即可。它是 enrollment 的副作用，不是 uplink UI；`metaPending` 告警仍由 relay tab 的 `RelayActionsController` 展示。

### B3. NodesManagement 新职责

`NodesManagement` 应只保留：

- `useMeshNodes`
- `useHubNode`
- 节点表
- enrollment engine
- `EnrollmentSection`
- 重命名、吊销、升级、卸载、批量操作
- 节点表所需的 `writable`、`writerPublicUrl`、`blockedHint`

移除：

- `useMeshHubs({ owner: true })`
- `useMeshRelay({ owner: true })`
- `useRelayActions`
- `UplinkSection`
- `RelayEnrollDialog`
- `RelayConfirmDialog`
- Network 图标菜单

可接收 `LocalUplinkController` 的只读状态：

```ts
interface NodesManagementProps {
  mode: AuthModeResponse;
  uplink: Pick<
    LocalUplinkController,
    'hubs' | 'relay' | 'prompt' | 'refresh'
  >;
}
```

`useRelayAdmitFollowUp` 和 `useEnrollmentEngine` 继续位于管理组件，因为它们属于“添加节点”完成后的处理。

### B4. active tab 规则

建议使用以下优先级：

1. `relay.relayMode === true` → 强制“接入中继”。
2. `relay.mode === 'hub'` → 强制“接入 Hub”。
3. standalone → 使用用户最近选择的 tab。
4. standalone 且 `SetupIntent` 为 `become-relay` → 初始切到“接入中继”。
5. standalone 且 `become-hub` / `join-hub` → 初始切到“接入 Hub”。

用户主动选择后记忆到非敏感的 `localStorage`：

```text
tmex.nodes.uplink-tab
```

强制模式只覆盖当前渲染，不要覆盖用户记忆；离开 relay 后可回到用户上次选择的 tab，默认回到 Hub。

### B5. 流程映射

| 场景 | Tab 行为 | 现有/建议动作 |
|---|---|---|
| Hub 模式 | Hub tab | 当前 Hub、Hub 列表、writer、change Hub |
| Hub → relay uplink | 自动切到 relay tab | 保留现有 `openEnroll('migrate')` |
| relay 模式 | relay tab | RelayStrip、quota、reauth、add、remove、rotate、leave |
| leave relay | 保持本机 mesh 角色 | `leaveRelay` 清空 relay set，不调用 `/api/local/leave` |
| standalone → Hub | Hub tab | 现有 HubSetupWizard |
| standalone → relay | relay tab | 新增 BecomeRelayForm 与新 setup route |
| mesh role → relay role | 先确认离开 mesh | 写入 `become-relay` SetupIntent，重启后进入 relay setup |
| relay → Hub/node | 需要新角色重配置 | 现有 Hub setup 只接受真正 standalone，不能直接复用 |

`leaveRelay` 和 `/api/local/leave` 必须明确区分：

- `/api/local/leave`：离开 mesh membership，重启为 standalone。
- `leaveRelay`：只移除 relay uplink，保留本机账号和 mesh membership。

### B6. 必须更新的测试

必须更新：

- `local-machine-card.test.tsx`：新增 relay / relay,node 角色 selector，验证 tabs。
- `nodes-tab.test.tsx`：standalone wizard 从节点 tab 外部移动到本机卡内部。
- `management/nodes-management.test.tsx`：删除 UplinkSection/HubStrip 在 management DOM 下的断言，只保留节点表和 enrollment。
- `management/hub-strip.test.tsx`：随文件移动。
- `relay/relay-ui.test.tsx`：更新 import 和 relay tab/menu 归属。
- `hub-setup-wizard.test.tsx`：新增 BecomeRelayForm 和新的 setup path。
- `membership/intent.test.ts`：新增 `become-relay` 及 `alsoNode` / target role。
- `membership/role-transition.test.ts`：覆盖五角色转换矩阵。
- `membership/use-leave-mesh.test.ts`、`leave-controller.test.ts`：覆盖 mesh → relay 和 relay,node → standalone。
- `apps/fe/src/node/mesh-hubs.test.ts`、`mesh-relay.test.ts`：确认 owner 从 management 移到 uplink controller 后行为不变。
- `apps/fe/src/node/relay-enroll.test.ts`、`relay-join.test.ts`、`relay-meta-key-pending.test.ts`：继续作为 relay 行为回归。

e2e：

- [`mesh-passkey.spec.ts`](/Users/konata/code/tmex-r24/apps/fe/tests/mesh-passkey.spec.ts:169) 当前只验证 `nodes-management` 和节点行，现有 selector 不需要改变。
- 应新增本机卡两 Tab 的 e2e；当前仓库没有 relay/local-card e2e。
- `nodes-management` 应保持稳定，新增 `local-uplink-tabs`、`local-uplink-tab-hub`、`local-uplink-tab-relay` test ids。

## C. Relay 角色与后端缺口

### C1. 类型和现有角色定义

`LocalRole` 已经正确包含五个值：

```ts
'standalone' | 'node' | 'hub,node' | 'relay' | 'relay,node'
```

见 [`packages/api-client/src/local/types.ts:3`](/Users/konata/code/tmex-r24/packages/api-client/src/local/types.ts:3)。

共享角色解析也已支持五种角色，见 [`packages/shared/src/roles.ts:1-34`](/Users/konata/code/tmex-r24/packages/shared/src/roles.ts:1)。

`ROLE_LABEL_KEY` 已包含：

- `nodes.machine.roleRelay`
- `nodes.machine.roleRelayNode`

见 [`role-transition.ts:14-20`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/role-transition.ts:14)。

需要修改的不是类型，而是：

- `SELECTABLE_ROLES`
- `MeshRole`
- `classifyRoleChange`
- `SetupIntent`
- `LeaveDialogRequest`
- leave / reconfigure 语义
- relay setup 表单和后端 API

### C2. LeaveDialog 当前问题

当前 leave dialog：

- `from` 类型基于 `MeshRole`，因此包含 `relay,node`，但不包含纯 `relay`。
- consequences 映射对 `relay,node` 复用了普通 node 文案，见 [`leave-dialog.tsx:35-47`](/Users/konata/code/tmex-r24/apps/fe/src/pages/settings/nodes/membership/leave-dialog.tsx:35)。
- 现有文案仍全部称为“退出 Hub”，见 [`zh_CN.json:1854-1889`](/Users/konata/code/tmex-r24/packages/shared/src/i18n/locales/zh_CN.json:1854)。

建议增加：

- relay role 的独立标题、描述和 consequences。
- `relay,node → relay`：保留公共 relay，移除 node membership。
- `relay,node → standalone`：移除 relay 和 node。
- `mesh → relay / relay,node`：明确旧 Hub 和下级节点影响。
- 纯 relay 不应调用现有 `/api/local/leave`。

### C3. `/api/local/status` 当前 relay 返回值

后端 `getLocalStatus` 使用 `roleNameFromFlags`，因此角色字段理论上会返回 `relay` 或 `relay,node`，见 [`setup-service.ts:462-480`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-service.ts:462)。

当前返回结构只有：

```ts
{
  role,
  nodeEnv,
  hubUrl,
  hubPublicUrl,
  direct,
  tls,
  domainAccess
}
```

FE 类型见 [`local/types.ts:26-34`](/Users/konata/code/tmex-r24/packages/api-client/src/local/types.ts:26)。

对 relay 角色：

- `role`：`relay` 或 `relay,node`
- `hubUrl`：通常为 `null`
- `hubPublicUrl`：通常为 `null`
- 没有 `relayPublicUrl`
- 没有 relay operator password 状态
- 没有 relay tenant uplink 状态；该状态必须读 `/api/mesh/relay/status`

另外，`/api/local/status` 先经过鉴权，见 [`local-routes.ts:60-92`](/Users/konata/code/tmex-r24/packages/app/src/runtime/local-routes.ts:60)。`isStandaloneRoles` 对纯 relay 返回 false，见 [`roles.ts:25-26`](/Users/konata/code/tmex-r24/packages/shared/src/roles.ts:25)。因此纯 relay 没有本机用户 session 时，当前请求可能直接 401，FE 无法显示本机卡。

这意味着纯 relay 角色需要额外决定：

- 为 relay operator 提供本机管理 session；或
- 允许受保护的 local status 通过 relay operator auth 读取；或
- 把 relay role/config 信息放入独立的 operator API。

### C4. 现有后端路由

Hub setup：

- `POST /api/setup/precheck`
- `POST /api/setup/hub`
- `POST /api/setup/join`

路由限制在 [`setup-routes.ts:10-20`](/Users/konata/code/tmex-r24/packages/app/src/runtime/setup-routes.ts:10)，只接受 standalone。

本机 leave：

- `POST /api/local/leave`
- 只接受 `node`、`hub,node`、`relay,node`
- 纯 `relay` 返回 `400 not_member`

见 [`local-routes.ts:35-58`](/Users/konata/code/tmex-r24/packages/app/src/runtime/local-routes.ts:35) 和 [`membership-reset.ts:21-25`](/Users/konata/code/tmex-r24/packages/app/src/runtime/membership-reset.ts:21)。

Relay tenant API：

- `GET /api/mesh/relay/status`
- `POST /api/mesh/relay/enroll/proof-material`
- `POST /api/mesh/relay/enroll`
- `POST /api/mesh/relay/leave/prepare`
- `POST /api/mesh/relay/remove/prepare`
- `POST /api/mesh/relay/meta-key/prepare`
- `GET /api/mesh/relay/join-material`
- `POST /api/mesh/relay/enrollments`
- `GET /api/mesh/relay/enrollments/:id`

FE API 定义见 [`tenant-api.ts:286-379`](/Users/konata/code/tmex-r24/packages/api-client/src/relay/tenant-api.ts:286)，后端路由见 [`relay-routes.ts:89-105`](/Users/konata/code/tmex-r24/apps/gateway/src/mesh/relay-routes.ts:89)。

Relay operator API：

- `GET /api/relay/status`
- `POST /api/relay/password`
- `PATCH /api/relay/config`
- `/api/relay/tenants/:id/*`

路由见 [`relay-runtime.ts:284-305`](/Users/konata/code/tmex-r24/apps/gateway/src/relay/relay-runtime.ts:284)。

当前缺少：

```text
POST /api/setup/relay
```

以及对应的 API client 方法。

### C5. BecomeRelayForm 与后端建议

建议增加：

```text
BecomeRelayForm
├── relayPublicUrl
├── operatorPassword
└── alsoNode
```

注意现有概念有两个不同密码：

- relay admission password：现有 relay tenant enroll 使用，存为 hash，接口为 `/api/relay/password`。
- relay admin token：`TMEX_RELAY_ADMIN_TOKEN`，是管理 API bearer token，不应由用户在普通表单中输入。

当前安装逻辑只要求 relay public URL，并自动生成 admin token，见：

- [`init.ts:185-218`](/Users/konata/code/tmex-r24/packages/app/src/commands/init.ts:185)
- [`install.ts:86-100`](/Users/konata/code/tmex-r24/packages/app/src/lib/install.ts:86)
- [`assemble-relay.ts:34-62`](/Users/konata/code/tmex-r24/packages/app/src/runtime/assemble-relay.ts:34)

因此新 API 必须明确 `operatorPassword` 的含义，不能把它误写成 `TMEX_RELAY_ADMIN_TOKEN`。建议新服务：

1. 校验公开 HTTPS URL。
2. 校验 operator/admission password。
3. 写入 `TMEX_ROLES=relay` 或 `relay,node`。
4. 写入 `TMEX_RELAY_PUBLIC_URL`。
5. 生成或保留 admin token。
6. 清理 Hub URL。
7. 持久化 relay password hash。
8. 安排重启。
9. 返回 `restarting: true`，不要返回任何 secret。

### C6. 可非重叠分派的文件集合

#### Task 1：本机卡与 uplink tabs

生产文件：

```text
apps/fe/src/pages/settings/nodes/nodes-tab.tsx
apps/fe/src/pages/settings/nodes/local-machine-card.tsx
apps/fe/src/pages/settings/nodes/local-uplink-controller.ts          [新建]
apps/fe/src/pages/settings/nodes/local-uplink-tabs.tsx               [新建]
apps/fe/src/pages/settings/nodes/local-hub-section.tsx               [新建]
apps/fe/src/pages/settings/nodes/management/hub-strip.tsx            [移动]
apps/fe/src/pages/settings/nodes/relay/uplink-section.tsx
apps/fe/src/pages/settings/nodes/relay/relay-strip.tsx
apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx
apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts
```

测试文件：

```text
apps/fe/src/pages/settings/nodes/local-machine-card.test.tsx
apps/fe/src/pages/settings/nodes/nodes-tab.test.tsx
apps/fe/src/pages/settings/nodes/management/hub-strip.test.tsx       [随源文件移动]
apps/fe/src/pages/settings/nodes/relay/relay-ui.test.tsx
apps/fe/src/pages/settings/nodes/local-uplink-tabs.test.tsx          [新建]
```

#### Task 2：节点管理清理

```text
apps/fe/src/pages/settings/nodes/management/nodes-management.tsx
apps/fe/src/pages/settings/nodes/management/nodes-management.test.tsx
apps/fe/tests/mesh-passkey.spec.ts
```

该任务只保留节点表、enrollment、节点动作；不修改 Task 1 拥有的 relay UI 文件。

#### Task 3：角色转换与 standalone relay setup

FE 文件：

```text
apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx
apps/fe/src/pages/settings/nodes/setup/become-relay-form.tsx          [新建]
apps/fe/src/pages/settings/nodes/setup/submit.ts
apps/fe/src/pages/settings/nodes/setup/use-hub-setup-submit.ts
apps/fe/src/pages/settings/nodes/setup/validation.ts
apps/fe/src/pages/settings/nodes/membership/intent.ts
apps/fe/src/pages/settings/nodes/membership/role-transition.ts
apps/fe/src/pages/settings/nodes/membership/leave-dialog.tsx
apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.ts
```

API 与后端：

```text
packages/api-client/src/local/types.ts
packages/api-client/src/local/setup-api.ts
packages/app/src/runtime/setup-routes.ts
packages/app/src/runtime/setup-service.ts
packages/app/src/runtime/relay-setup-service.ts                         [新建]
packages/app/src/runtime/membership-reset.ts
packages/app/src/runtime/local-routes.ts
packages/app/src/runtime/assemble-routes.ts
packages/app/src/lib/install.ts
```

测试：

```text
apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.test.tsx
apps/fe/src/pages/settings/nodes/setup/validation.test.ts
apps/fe/src/pages/settings/nodes/setup/submit.test.ts
apps/fe/src/pages/settings/nodes/membership/intent.test.ts
apps/fe/src/pages/settings/nodes/membership/role-transition.test.ts
apps/fe/src/pages/settings/nodes/membership/use-leave-mesh.test.ts
apps/fe/src/pages/settings/nodes/membership/leave-controller.test.ts
apps/fe/src/pages/settings/nodes/membership/self-revoke.test.ts
packages/api-client/src/local/local-api.test.ts
packages/api-client/src/local/setup-api.test.ts
packages/app/src/runtime/local-routes.test.ts
packages/app/src/runtime/membership-reset.test.ts
packages/app/src/runtime/setup-routes.test.ts
packages/app/src/runtime/setup-service.test.ts
```

#### Task 4：i18n

源文件：

```text
packages/shared/src/i18n/locales/en_US.json
packages/shared/src/i18n/locales/zh_CN.json
packages/shared/src/i18n/locales/ja_JP.json
packages/shared/src/i18n/locale-consistency.test.ts
```

生成文件只通过 `bun run build:i18n` 更新，不应手工编辑或分派给 lint/format 任务。

补充：`packages/app/src/runtime/setup-service.ts` 当前已经是 746 行，`assemble-routes.ts` 为 598 行；如果 600 行门槛适用于整个后端，需要进一步拆分既有 setup/direct 逻辑，不能继续向这两个文件堆 relay setup 逻辑。