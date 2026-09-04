# “接入设备”侧栏调研报告

## 结论摘要

- 侧栏有两个入口：“移动设备（仅控制）”和“服务器或电脑”；默认打开服务器流程中的“让新机器加入”。
- 服务器流程默认推荐“地址/密码加入”，加入码被放在“高级”折叠区。
- Hub、Relay 加入由本机状态自动判断；Relay 节点使用中继地址和租户编号，Hub 节点使用 Hub 地址。
- “通过 SSH 添加远程设备”不是节点 Enrollment，而是向某个已存在节点创建 `Device` 记录，使用 `/api/devices`。
- 当前文案和 CLI 存在历史命名混用：运行时命令是 `tmex`，不是 `tmex-cli`；公开命令是 `tmex relay join`，不存在 `tmex relay password-join`。

## 1. 组件树、步骤渲染和 i18n

### 组件树

```text
SidePanelHost
└── SidePanelBody
    └── ConnectDevicesPanel
        ├── GuideTabList
        │   ├── 移动设备
        │   └── 服务器或电脑
        ├── MobileGuide
        └── ComputerGuide
            ├── GuideStep：安装 tmex
            │   ├── CommandBlock：安装命令
            │   └── CommandBlock：PATH 修复命令
            └── Tabs：选择接入方式
                ├── JoinSteps：让新机器加入
                │   ├── UplinkStep：准备接入信息
                │   ├── PasswordStep：密码加入
                │   └── TokenAdvanced
                │       ├── JoinTokenFields：生成加入码
                │       ├── CommandBlock：加入命令
                │       └── JoinConfirmStatus：确认加入
                └── HostSteps：把本机设为 Hub
                    ├── HostEntryStep：配置公网入口
                    ├── HostHubStep：设为 Hub
                    └── HostInviteStep：接入其他机器
```

入口和路由：

- 侧栏标题使用 `nav.connectDevices`，关闭按钮使用 `common.close`：[side-panel-host.tsx:44](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/side-panel-host.tsx:44)
- 侧栏内容加载 `ConnectDevicesPanel`：[side-panel-host.tsx:102](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/side-panel-host.tsx:102)
- 面板定义两个 tab，默认值为 `mobile`：[connect-devices-panel.tsx:13](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.tsx:13)
- `computer` tab 渲染 `ComputerGuide`：[connect-devices-panel.tsx:36](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.tsx:36)
- `GuideStep` 负责步骤编号、标题、描述、done/todo 状态；`GuideLink` 使用 React Router 跳转设置页，并且不带 `panel` 参数，因此会关闭侧栏：[guide-step.tsx:10](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/guide-step.tsx:10)
- `CommandBlock` 负责等宽展示和复制；复制状态复用节点设置的 `CopyLabel`：[command-block.tsx:7](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/command-block.tsx:7)

### “服务器或电脑”步骤逻辑

`ComputerGuide`：

1. 安装 tmex。
2. 选择“让新机器加入”或“把本机设为 Hub”。
3. 根据选择渲染对应分支：[computer-guide.tsx:164](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx:164)

“让新机器加入”：

- `JoinSteps` 根据 `useSharedAuthMode()` 和 `useMeshRelay()` 解析上级链路：
  - Relay 模式：使用已连接 Relay 的 URL 和租户编号。
  - 非 Relay 的 mesh 模式：使用 Hub 公开地址。
  - standalone：显示未知上级地址。
- 解析逻辑：[computer-join-guide.tsx:182](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx:182)

密码路径：

- Hub：生成 `tmex hub join <hub-url> --password`
- Relay：生成 `tmex relay join <relay-url> --tenant <tenant-id>`
- 命令只展示密码加入方式，密码由 CLI 交互输入：[computer-join-guide.tsx:93](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx:93)

高级加入码路径：

- `<details data-testid="connect-join-token-advanced">` 折叠显示。
- 创建加入码、复制 token、运行命令、确认加入分别是三个 `GuideStep`：[computer-join-guide.tsx:121](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx:121)
- Hub 加入码命令由 `joinCommand()` 生成，格式为：

  ```bash
  tmex hub join '<hub-url>' --token '<token>' --name '<name>'
  ```

- 没有可信 URL 时，预览会使用 `https://tmex.example.com`，避免把当前浏览器入口错误地当作 Hub 地址：[join-command-preview.ts:18](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/join-command-preview.ts:18)
- Hub 设置链接：`/settings?tab=nodes`
- 远程访问设置链接：`/settings?tab=remoteAccess`

“把本机设为 Hub”：

1. 配置公网入口：远程访问页。
2. 设为 Hub：节点设置页。
3. 接入其他机器：切回“让新机器加入”。

实现位置：[computer-guide.tsx:36](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx:36)

当前该分支只覆盖“设为 Hub”，没有“把本机设为 Relay”的侧栏分支。

### 侧栏直接使用的 i18n

源文件均为 `packages/shared/src/i18n/locales/zh_CN.json`，以下未列 generated `resources.ts`、`types.ts`。

#### 面板和 tab

- `nav.connectDevices`：`接入更多设备`
- `common.close`：`关闭`
- `connectDevices.tabs.mobile`：`移动设备（仅控制）`
- `connectDevices.tabs.computer`：`服务器或电脑`

#### 移动设备流程

位置：[zh_CN.json:69](/Users/konata/code/tmex-r27/packages/shared/src/i18n/locales/zh_CN.json:69)

- `connectDevices.mobile.intro`：`手机或平板只作为控制端：通过浏览器操作已接入的机器，不在本机运行终端。添加到主屏幕后可获得全屏、接近原生应用的体验。`
- `connectDevices.mobile.platform.ios`：`iOS`
- `connectDevices.mobile.platform.android`：`Android`
- `connectDevices.mobile.address.tunnel`：`隧道`
- `connectDevices.mobile.address.hub`：`Hub`
- `connectDevices.mobile.address.lan`：`局域网`
- `connectDevices.mobile.address.current`：`当前地址`
- `connectDevices.mobile.address.loopbackHint`：`本机只监听 127.0.0.1，其他设备无法直接访问。请配置远程访问，或安装时用 --host 0.0.0.0 监听所有地址。`
- `connectDevices.mobile.chooseAddress.title`：`选择访问地址`
- `connectDevices.mobile.chooseAddress.description`：`挑一个手机能连上的地址，下一步据此生成二维码。`
- `connectDevices.mobile.chooseAddress.single`：`手机可用的访问地址：`
- `connectDevices.mobile.scan.title`：`扫码打开`
- `connectDevices.mobile.scan.ios`：`用相机扫码，在 Safari 中打开（只有 Safari 能添加到主屏幕）。`
- `connectDevices.mobile.scan.android`：`用相机或 Chrome 扫码打开。`
- `connectDevices.mobile.scan.alt`：`访问地址二维码`
- `connectDevices.mobile.ios.open.description`：`iOS 仅 Safari 支持添加到主屏幕。在手机上访问：`
- `connectDevices.mobile.ios.add.title`：`添加到主屏幕`
- `connectDevices.mobile.ios.add.description`：`点按底部「分享」，选择「添加到主屏幕」，再点「添加」。`
- `connectDevices.mobile.ios.launch.title`：`从主屏幕打开`
- `connectDevices.mobile.ios.launch.description`：`点按主屏幕上的 tmex 图标启动。若已启用登录，首次打开需登录一次。`
- `connectDevices.mobile.android.open.description`：`在手机上访问：`
- `connectDevices.mobile.android.add.title`：`安装应用`
- `connectDevices.mobile.android.add.description`：`点按右上角菜单，选择「安装应用」（或「添加到主屏幕」），确认安装。`
- `connectDevices.mobile.android.launch.title`：`从主屏幕打开`
- `connectDevices.mobile.android.launch.description`：`在主屏幕或应用列表中打开 tmex。若已启用登录，首次打开需登录一次。`
- `connectDevices.mobile.remoteHint`：`当前地址若仅限局域网访问，手机需连接同一网络。需要随时随地访问，请先配置远程访问。`
- `connectDevices.mobile.remoteLink`：`前往远程访问设置`

#### 服务器流程

- `connectDevices.computer.intro`：`在另一台服务器或电脑上安装 tmex 后，可以让它加入本机所在的网络，也可以把本机设为 Hub。`
- `connectDevices.computer.install.title`：`安装 tmex`
- `connectDevices.computer.install.description`：`在目标机器上执行安装脚本（自动安装 Bun，Linux 需 tmux ≥ 3.0）。安装完成后终端会输出访问地址。`
- `connectDevices.computer.install.command`：`安装命令`
- `connectDevices.computer.install.pathHint`：`安装脚本会提供 tmex 命令。若提示找不到命令，重新打开终端或执行：`
- `connectDevices.computer.mode.title`：`选择接入方式`
- `connectDevices.computer.mode.join`：`让新机器加入`
- `connectDevices.computer.mode.host`：`把本机设为 Hub`

加入码分支：

- `connectDevices.computer.join.token.title`：`生成加入码`
- `connectDevices.computer.join.token.description`：`在已加入的机器上打开「设置 → 多节点互联 → 节点管理」，点「添加」→「生成加入码」，复制加入命令。加入码 10 分钟内有效。`
- `connectDevices.computer.join.token.meshDescription`：`在此生成加入码并复制下一步的命令。加入码 10 分钟内有效。`
- `connectDevices.computer.join.token.unavailable`：`本机未加入多节点互联，无法在此生成加入码。`
- `connectDevices.computer.join.token.label`：`加入码（有效期 {{minutes}} 分钟）`
- `connectDevices.computer.join.token.link`：`前往多节点互联设置`
- `connectDevices.computer.join.run.title`：`在新机器上加入`
- `connectDevices.computer.join.run.description`：`在新机器的终端执行加入命令（以下为示例，请以复制的命令为准）：`
- `connectDevices.computer.join.run.ready`：`在新机器的终端执行以下命令：`
- `connectDevices.computer.join.run.tokenPlaceholder`：`<加入码>`
- `connectDevices.computer.join.run.namePlaceholder`：`<节点名称>`
- `connectDevices.computer.join.confirm.title`：`确认加入`
- `connectDevices.computer.join.confirm.description`：`回到节点管理页，点「确认加入」。新机器重启后即出现在设备列表。`
- `connectDevices.computer.join.confirm.meshDescription`：`新机器执行命令后在此确认加入，重启后即出现在设备列表。`
- `connectDevices.computer.join.confirm.done`：`新机器已加入，重启后出现在设备列表。`

Hub/Relay 上级信息：

- `connectDevices.computer.join.uplink.title`：`准备接入信息`
- `connectDevices.computer.join.uplink.hubDescription`：`新机器需要 Hub 地址与本账号的密码。`
- `connectDevices.computer.join.uplink.relayDescription`：`新机器需要中继地址、租户编号与本账号的密码。`
- `connectDevices.computer.join.uplink.unknownDescription`：`本机尚未加入多节点互联，请先完成本机设置。`
- `connectDevices.computer.join.uplink.missingUrl`：`本机的上级地址未知，无法给出接入地址。`
- `connectDevices.computer.join.uplink.hubUrl`：`Hub 地址`
- `connectDevices.computer.join.uplink.relayUrl`：`中继地址`
- `connectDevices.computer.join.uplink.tenantId`：`租户编号`

密码加入：

- `connectDevices.computer.join.password.title`：`在新机器上加入`
- `connectDevices.computer.join.password.hubDescription`：`在新机器上打开「设置 → 多节点互联」，选「加入已有 Hub」，填 Hub 地址与密码。`
- `connectDevices.computer.join.password.relayDescription`：`在新机器上打开「设置 → 多节点互联」，选「加入中继」，填中继地址、租户编号与密码。`
- `connectDevices.computer.join.password.command`：`也可以在新机器的终端直接执行`
- `connectDevices.computer.join.password.tenantPlaceholder`：`<租户编号>`

高级加入码：

- `connectDevices.computer.join.advanced.title`：`使用加入码（高级）`
- `connectDevices.computer.join.advanced.description`：`新机器不便输入密码时改用加入码：在本机签发，10 分钟内有效。`

Hub 设置分支：

- `connectDevices.computer.host.entry.title`：`配置公网入口`
- `connectDevices.computer.host.entry.description`：`打开「设置 → 远程访问」：选择 Cloudflare Tunnel（命名隧道）可直接获得固定 HTTPS 地址；选择直接连接则需自行准备固定的 HTTPS 入口。`
- `connectDevices.computer.host.entry.link`：`前往远程访问设置`
- `connectDevices.computer.host.entry.status.named`：`已配置 Cloudflare Tunnel：{{url}}（{{state}}）`
- `connectDevices.computer.host.entry.status.quick`：`当前是临时隧道 {{url}}，地址会变化，不适合作为 Hub 地址；请改用命名隧道或直接连接。`
- `connectDevices.computer.host.entry.status.hubUrl`：`已有公开地址：{{url}}`
- `connectDevices.computer.host.hub.title`：`设为 Hub`
- `connectDevices.computer.host.hub.description`：`打开「设置 → 多节点互联」，选择「把本机设为 Hub」，将上一步的地址填入「Hub 公开地址」，创建首个账号并重启。`
- `connectDevices.computer.host.hub.warning`：`Hub 公开地址设定后不可修改，请先确定最终域名。`
- `connectDevices.computer.host.hub.link`：`前往多节点互联设置`
- `connectDevices.computer.host.hub.status.self`：`本机已是 Hub，公开地址：{{url}}`
- `connectDevices.computer.host.hub.status.node`：`本机已作为节点加入 {{url}}，不能再作为 Hub。`
- `connectDevices.computer.host.hub.status.mismatch`：`Hub 公开地址与当前隧道主机名不一致，其他机器可能无法接入。`
- `connectDevices.computer.host.hub.hintUseEntry`：`把上一步的地址 {{url}} 填入「Hub 公开地址」。`
- `connectDevices.computer.host.invite.title`：`接入其他机器`
- `connectDevices.computer.host.invite.description`：`在其他机器上安装 tmex 后，按「让新机器加入」的步骤接入。`
- `connectDevices.computer.host.invite.ready`：`其他机器安装 tmex 后，切到「让新机器加入」照着做即可。`
- `connectDevices.computer.host.invite.gotoJoin`：`去看加入步骤`

#### 间接使用的共享 i18n

- `common.unknown`：`未知`
- `common.cancel`：`取消`
- `nodes.actions.copy`：`复制`
- `nodes.actions.copied`：`已复制`
- `nodes.setup.fields.name`：`节点名称`
- `nodes.uplinkOffline`：`上级链路未连接，暂时不能生成加入码。`
- `nodes.hubOffline`：`无法连接到 Hub，节点管理暂不可用。`
- `nodes.hubs.notWriter`：`备用 Hub 不接受管理操作，请通过主 Hub {{url}} 操作。`

Enrollment 状态和错误：

- `nodes.enrollment.create`：`生成加入码`
- `nodes.enrollment.pending`：`等待新节点加入`
- `nodes.enrollment.confirmPending`：`确认加入`
- `nodes.enrollment.hubNotConfirmed`：`Hub 未确认，本次没有写入任何内容，可直接重试。`
- `nodes.enrollment.relayNotConfirmed`：`中继未确认，本次没有写入任何内容，可直接重试。`
- `nodes.enrollment.retryHub`：`重试`
- `nodes.enrollment.admitted`：`节点已加入`
- `nodes.enrollment.unknownCertificate`：`收到未知节点的响应，已忽略。`
- `nodes.enrollment.badCertSig`：`节点响应的签名校验失败，已忽略。`
- `nodes.enrollment.expired`：`加入码已过期，请重新生成。`
- `nodes.enrollment.noCertificateYet`：`新节点尚未响应，请稍后重试。`
- `nodes.enrollment.missingHubUrl`：`Hub 未设置公开地址，无法生成加入命令。`
- `nodes.enrollment.missingRelayUrl`：`中继地址不可用，无法生成加入命令。`
- `nodes.enrollment.staleRecord`：`账号信息已变化，请重新确认。`
- `nodes.enrollment.relayNoneAccepted`：`中继未接受加入码，请检查中继连接后重试。`
- `auth.errors.UNKNOWN_USER`：`用户不存在。`
- `auth.errors.ROOT_KEY_MISMATCH`：`密码不正确。`
- `auth.errors.PASSKEY_ABORTED`：`通行密钥授权已取消。`
- `auth.credential.title`：`确认身份`
- `auth.credential.hint`：`请输入密码或使用通行密钥以继续。`
- `auth.credential.usePassword`：`使用密码`
- `auth.credential.usePasskey`：`使用通行密钥`
- `auth.credential.passkeySelect`：`选择通行密钥`
- `auth.credential.purpose.enroll`：`添加节点`
- `auth.credential.purpose.admit`：`确认新节点加入`
- `auth.security.currentPassword`：`当前密码`

`enrollment-engine` 还会动态使用 `auth.errors.<code>`；没有固定 key，具体 key 取决于服务端错误码并有原始码兜底。

## 2. 面板可用的数据、角色和动作

### 本机状态来源

- `useSharedAuthMode()` 从 `/api/auth/mode` 获取当前认证/mesh 模式；standalone 不继续请求 mesh API：[mesh-nodes.ts:249](/Users/konata/code/tmex-r27/apps/fe/src/node/mesh-nodes.ts:249)
- `useMeshRelay()` 从 `/api/mesh/relay/status` 获取 Relay 状态、租户编号、连接 Relay：[mesh-relay.ts:221](/Users/konata/code/tmex-r27/apps/fe/src/node/mesh-relay.ts:221)
- `useHubNode()` 获取 Hub 节点列表及 Hub 是否在线：[mesh-nodes.ts:605](/Users/konata/code/tmex-r27/apps/fe/src/node/mesh-nodes.ts:605)
- `useHostStatus()` 根据远程访问入口和 Hub 信息计算“入口状态”和 Hub 角色：[computer-guide.tsx:23](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-guide.tsx:23)

### 角色判断

项目支持的角色组合见：[2026082800-hub-node-operations.md:7](/Users/konata/code/tmex-r27/docs/hub/2026082800-hub-node-operations.md:7)

| 角色 | 面板可见表现 |
|---|---|
| standalone | `meshEnabled=false`，Hub 状态为 `standalone`，不能在面板生成加入码 |
| node | Hub 状态通常为 `node`；可以是加入 Hub 的节点，也可以是 `relay,node` |
| hub,node | Hub 状态为 `self`，显示本机已是 Hub |
| relay | 纯 Relay 不提供正常前端，主要由命令行管理 |
| relay,node | `useMeshRelay().relayMode=true`，有 Relay 上联；Hub 状态仍可能显示为 `node` |

Hub 与 Relay 不能同时作为本机的上级角色；纯 Hub 也不是独立角色，Hub 必须和 node 组合存在。

### 是否已加入 Hub 或 Relay

- 是否有 Hub 上级：看 `mode.hubNodeId`、Hub URL、Hub 节点列表。
- 是否有 Relay 上级：看 Relay 状态中的 `attached` 链路和 `tenantId`。
- 加入码按钮的可用条件：
  - 本机必须是 mesh 模式；
  - Hub 模式需要 Hub API 可用；
  - Relay 模式需要已连接且可写的 Relay；
  - 必须有可信的 Hub/Relay 公网地址。
- 代码将 `hubOnline` 定义为：Relay 模式取 `relay.writable`，否则取 `hub.online`：[join-token.tsx:300](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/join-token.tsx:300)

### 加入码生成 API

加入码实现复用了设置页的 `useCreateEnrollment`，其注释明确说明这是侧栏和设置页共用的实现：[use-create-enrollment.ts:1](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/management/use-create-enrollment.ts:1)

Hub 模式：

```text
POST /n/<hub-node-id>/api/hub/enrollments
```

请求包含：

- `enroll_pk`
- `authorization`
- `authorization_sig`
- `exp`

实现：[hub-api.ts:200](/Users/konata/code/tmex-r27/apps/fe/src/node/hub-api.ts:200)

Relay 模式：

1. `GET /api/mesh/relay/join-material`
2. `POST /api/mesh/relay/enrollments`

Relay enrollment 使用中继上已有的租户加入材料，生成 r3 加入码：[tenant-api.ts:427](/Users/konata/code/tmex-r27/apps/fe/src/node/relay-join.ts:56)

加入码生成需要用户进行一次密码或 Passkey 身份确认：

- 生成阶段使用 `purpose: 'enroll'`
- 手动确认新节点时使用 `purpose: 'admit'`
- 生成后的 pending/enroll 私钥只在浏览器内存和会话关联中存在，加入码有效期为 10 分钟。

### Relay password 生成和管理

项目没有一个“生成 Relay 密码”的后端 API。

当前生成器是浏览器端 `crypto.getRandomValues()` 随机生成 20 位口令：[password-field-with-generate.tsx:25](/Users/konata/code/tmex-r27/apps/fe/src/components/forms/password-field-with-generate.tsx:25)

已有 Relay 的密码管理 API 是：

```text
POST /api/relay/password
```

用于设置、清除或修改当前 Relay 的接入口令，不负责生成随机值：[admin-api.ts:180](/Users/konata/code/tmex-r27/packages/api-client/src/relay/admin-api.ts:180)

### “通过 SSH 添加远程设备”流程

这条流程不是 mesh 节点加入，也不使用加入码或 Relay/Hub enrollment。

真实链路：

```text
DevicesPage
└── AddDeviceMenu
    ├── “添加远程节点” → /settings?tab=nodes
    └── 某个现有节点 → node-device-group 的 panel ref
        └── DeviceManagementPanel
            └── DeviceDialog
                └── DeviceBasicFields：选择 SSH 设备
```

关键位置：

- 页面加号菜单：[add-device-menu.tsx:37](/Users/konata/code/tmex-r27/apps/fe/src/pages/devices/add-device-menu.tsx:37)
- 页面根据已有节点注册菜单目标：[DevicesPage.tsx:161](/Users/konata/code/tmex-r27/apps/fe/src/pages/DevicesPage.tsx:161)
- 节点面板通过 ref 暴露 `openAddDevice()`：[node-device-group.tsx:270](/Users/konata/code/tmex-r27/apps/fe/src/pages/devices/node-device-group.tsx:270)
- `DeviceManagementPanel` 管理 `showAddModal` 并渲染对话框：[device-management-panel.tsx:112](/Users/konata/code/tmex-r27/packages/panels/src/device-management/device-management-panel.tsx:112)
- 对话框本体：[device-dialog.tsx:29](/Users/konata/code/tmex-r27/packages/panels/src/device-management/device-dialog.tsx:29)
- 类型选择“本地设备 / SSH 设备”：[device-basic-fields.tsx:22](/Users/konata/code/tmex-r27/packages/panels/src/device-management/device-basic-fields.tsx:22)

保存 SSH 设备调用：

```text
POST /api/devices
```

请求包含 host、port、username、auth mode 以及密码/私钥/agent/configRef 等字段：[devices.ts:41](/Users/konata/code/tmex-r27/packages/api-client/src/devices.ts:41)

因此，实现改写时应称为“向当前节点添加 SSH 设备”或“创建远程设备”，不要称为“节点 enrollment”。

## 3. 安装和 CLI 命令

### 安装命令

当前侧栏展示的不是 `tmex-cli install`，而是：

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash
```

来源：[source.ts:7](/Users/konata/code/tmex-r27/packages/shared/src/release/source.ts:7)

安装脚本本身会安装并提供 `tmex` 命令：[install.sh:4](/Users/konata/code/tmex-r27/install.sh:4)

当前 CLI help 没有 `tmex-cli install` 子命令。`tmex-cli` 是包/发行层名称，不是当前运行时的命令语法。

### 当前权威命令

CLI 总览：[help.ts:47](/Users/konata/code/tmex-r27/packages/app/src/cli/help.ts:47)

```bash
tmex init [--role standalone|node|hub,node|relay|relay,node]
```

```bash
tmex enroll [--ttl 10m]
```

```bash
tmex hub join <https-url> --token <token> [--name <name>]
```

```bash
tmex hub join <https-url> --password [<password>] [--totp <code>] [--name <name>]
```

```bash
tmex relay enroll <url> [--password <password>] [--username <name>]
```

```bash
tmex relay join <url> --tenant <tenant-id> [--password <password>] [--name <name>]
```

```bash
tmex relay passwd [--clear] [--kick|--keep]
```

### Hub join

实现位于：[hub.ts:575](/Users/konata/code/tmex-r27/packages/app/src/commands/hub.ts:575)

注意：

- `--token` 和 `--password` 互斥。
- `hub join` 如果识别到 Relay token，会转发到 Relay join 流程。
- 当前密码路径会提示用户输入隐藏密码。

加入码命令生成器位于：[enrollment.ts:765](/Users/konata/code/tmex-r27/apps/fe/src/node/enrollment.ts:765)

### Relay join / relay password join

实现文件：[relay-password-join.ts:27](/Users/konata/code/tmex-r27/packages/app/src/commands/relay-password-join.ts:27)

文件名叫 `relay-password-join.ts`，但 CLI 暴露的命令仍然是：

```bash
tmex relay join <url> --tenant <tenant-id> --password <password>
```

不存在公开的：

```bash
tmex relay password-join
```

Relay token/r3 加入流程位于：[relay-join.ts:397](/Users/konata/code/tmex-r27/packages/app/src/commands/relay-join.ts:397)

### `tmex enroll` 与历史文案

`tmex enroll` 用于在已加入的节点上生成加入码：[enroll.ts:451](/Users/konata/code/tmex-r27/packages/app/src/commands/enroll.ts:451)

但 CLI 密码 enrollment 对启用 Passkey 二次验证的账号不可用，源码提示应改用 Web 设置页生成加入码后执行 join 命令：[enroll.ts:55](/Users/konata/code/tmex-r27/packages/app/src/commands/enroll.ts:55)

设置向导源码注释仍写着 `tmex-cli enroll`：

- Hub 设置向导：[join-hub-form.tsx:1](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx:1)
- Relay 设置向导注释写的是 `tmex relay join <relayUrl> --tenant <id>`：[join-relay-form.tsx:1](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/setup/join-relay-form.tsx:1)

实际 UI 字段：

- Hub：默认“账号密码”，可切换“加入码”：[join-hub-form.tsx:98](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/setup/join-hub-form.tsx:98)
- Relay：填写中继地址、租户编号、接入口令：[join-relay-form.tsx:148](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/setup/join-relay-form.tsx:148)
- standalone 设置向导提供四条路径：成为 Hub、加入 Hub、成为 Relay、加入 Relay：[hub-setup-wizard.tsx:1](/Users/konata/code/tmex-r27/apps/fe/src/pages/settings/nodes/setup/hub-setup-wizard.tsx:1)

## 4. Hub 与 Relay 的现有解释，五行总结

1. Hub 是账号、根密钥日志、节点成员关系和节点控制操作的信任中心，适合需要集中管理的网络。[hub-node-architecture.md:281](/Users/konata/code/tmex-r27/docs/hub/2026082700-hub-node-architecture.md:281)
2. Relay 是公共入口和盲转发器，只转发加密流量，不读取节点名称、设备列表、命令或密钥日志内容。[relay-role.md:7](/Users/konata/code/tmex-r27/docs/relay/2026090304-relay-role.md:7)
3. 需要账号管理、节点批准和成员变更时使用 Hub。
4. 需要多租户公网接入、希望中继不掌握控制面内容时使用 Relay。
5. `hub,node` 和 `relay,node` 都保留网页与节点能力；纯 Relay 不提供网页，Hub 与 Relay 不能同时作为同一机器的角色。[hub-node-operations.md:15](/Users/konata/code/tmex-r27/docs/hub/2026082800-hub-node-operations.md:15)

## 5. 测试覆盖和重写注意事项

### 侧栏主测试

`connect-devices-panel.test.tsx` 覆盖：

- 默认移动 tab、两个 tab 的数量和互斥显示：[connect-devices-panel.test.tsx:74](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx:74)
- 移动端地址选择、二维码、Loopback 提示和远程访问链接。
- 服务器安装命令、PATH 命令、join/host 两种分支：[connect-devices-panel.test.tsx:185](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/connect-devices-panel.test.tsx:185)
- standalone 无法生成加入码。
- mesh 模式显示节点名称输入、生成按钮、Hub 地址和加入命令。
- Hub URL 无效时显示 `nodes.enrollment.missingHubUrl`。
- host 分支无公网入口时显示入口、Hub、邀请三个 todo 步骤。
- Hub self、node 两种状态下的不同文案和按钮。
- 加入状态：pending、certificate ready、Hub 未确认、admitted、证书签名错误和过期。
- sessionStorage 中 pending 的有效性、用户/Hub/node 身份变化、24 小时 admitted 保留期。

测试使用未初始化 i18n 的静态渲染，因此很多断言直接检查 key 字符串，而不是中文翻译。改 key 或改变层级时需要同步调整这些断言。

### Join 专项测试

`computer-join-guide.test.tsx` 覆盖：

- standalone、Hub、Relay 三种上级解析：[computer-join-guide.test.tsx:66](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/computer-join-guide.test.tsx:66)
- Hub 密码命令和 Relay 密码命令。
- Relay 租户编号及 `missingRelayUrl`。
- 恶意 URL 的 shell quoting 和未知 URL 的安全 fallback。
- Hub/Relay/standalone 下的不同描述、链接和高级加入码折叠区。

`access-addresses.test.ts` 覆盖地址优先级：

```text
命名 Tunnel > Hub 地址 > 局域网地址 > 当前地址
```

也覆盖去重、临时 Tunnel、停止/降级状态和 Loopback fallback。

`host-status.test.ts` 覆盖：

- 命名 Tunnel、临时 Tunnel、Hub URL、无入口。
- Tunnel 与 Hub 公开地址不一致。
- Hub self、node、standalone 判断：[host-status.test.ts:267](/Users/konata/code/tmex-r27/apps/fe/src/components/side-panels/connect-devices/host-status.test.ts:267)

### 相关 SSH 设备测试

- `device-management-panel.test.tsx`：加载、空状态、离线状态、添加按钮和设备列表：[device-management-panel.test.tsx:78](/Users/konata/code/tmex-r27/packages/panels/src/device-management/device-management-panel.test.tsx:78)
- `device-management-events.test.ts`：全局打开添加对话框事件的注册、清理和 callback 行为：[device-management-events.test.ts:42](/Users/konata/code/tmex-r27/packages/panels/src/device-management/device-management-events.test.ts:42)
- `device-form.test.ts`：本地/SSH payload、认证模式、字段校验。
- `use-device-dialog-submit.test.ts`：创建和更新时的 payload、SSH 凭据清理、错误处理。
- `device-node-context.test.ts`：self/node 上的 `local`、`ssh`、`nodeLocal`、`nodeSsh` 类型映射。
- `DevicesPage.test.tsx`：有一个或多个 ready 节点时，加号显示下拉菜单而不是旧的全局按钮：[DevicesPage.test.tsx:404](/Users/konata/code/tmex-r27/apps/fe/src/pages/DevicesPage.test.tsx:404)

实现重写时应分别维护两组测试语义：

1. “加入 tmex 节点”：Hub/Relay enrollment、加入码、密码、确认加入。
2. “添加 SSH 设备”：现有节点上下文中的 `/api/devices` 创建，不涉及 Hub/Relay enrollment。