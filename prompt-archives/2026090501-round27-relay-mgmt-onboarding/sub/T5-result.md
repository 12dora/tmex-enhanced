# T5 结果 —— 接入设备侧栏「服务器或电脑」指引重做

## 结论

「服务器或电脑」页已按新结构重写：第 1 步选接入方式（经中继 / 经 Hub / SSH 直连），二级再分「加入现成上级 / 本机自建上级」，每条路径自成一套连续编号。默认路径与默认二级选择由本机现状（`/api/local/status` 角色 + `/api/mesh/relay/status` + `/api/auth/mode`）推导，用户改过之后以其选择为准。`connectDevices.computer.*` 全量重写并同步三语。

## 改动文件

### 新增（均在 `apps/fe/src/components/side-panels/connect-devices/`）

- `connect-path.ts` —— 纯逻辑：`ConnectPath`/`ConnectSide` 类型、`isRelayRole`/`isHubRole`、`defaultConnectPath`、`defaultConnectSide`。
- `use-connect-machine.ts` —— `useConnectMachine()`：把 `useSharedAuthMode` + `useMeshRelay` + `useLocalStatus`（复用设置页的 hook，401/404 已被它摘干净）折成一份扁平快照 `ConnectMachine`（role / relayMode / relayAttached / relayUrl / tenantId / hubUrl / relayPublicUrl / relayHasPassword）。
- `install-step.tsx` —— 从旧 `computer-guide.tsx` 抽出的「安装 tmex」步骤，带 `index`。
- `hub-host-steps.tsx` —— 旧 `HostSteps`（公网入口 / 设为 Hub / 让新机器加入）迁出，新增 `startIndex`（默认 2）。逻辑与 `host-status.ts` 未改。
- `relay-host-steps.tsx` —— 新的「本机自建中继」三步：本机设为中继（角色含 relay 即打勾并给中继地址）→ 设置接入密码（`relay.hasPassword` 打勾，否则给 `/settings?tab=relay` 入口，且仅在本机确实是中继时才给，避免死链）→ 让新机器加入（按钮切到「加入已有中继」）。
- `ssh-steps.tsx` —— SSH 直连：一句说明 + 「添加 SSH 设备」步骤（按钮 → 跳 `/devices` 并打开新建设备对话框）+ 「设备保存后即出现在设备列表」。
- `open-add-device.ts` —— `openSelfAddDevice()`：订阅 `@/pages/devices/add-device-targets` 注册表，导航后等设备页把 self 目标登记上再打开对话框；带超时与取消，注入 source 可单测。
- 测试：`connect-path.test.ts`、`open-add-device.test.ts`。

### 修改

- `computer-guide.tsx` —— 重写为 `ComputerGuide`（一级 Tabs + 第 1 步「选择接入方式」卡片：分段选择器 + 三行说明 + `IconTooltip` 长说明）与 `RelayPath` / `HubPath`（二级 Tabs，`line` 变体更轻）。
- `computer-join-guide.tsx` —— `JoinSteps` 改为 `{ variant: 'relay' | 'hub'; machine: ConnectMachine; startIndex? }`；`resolveJoinUplink(variant, machine)` 返回 `{kind,url,tenantId,standalone}`；地址缺失时按路径给「向中继运营者索取」/「向 Hub 管理员索取」，仅在本机未组网时才补一条多节点互联入口；中继路径有地址但无租户编号时给说明；新增 `canIssueJoinToken()`——中继路径只有本机自己挂在中继上才渲染「加入码（高级）」折叠区。
- `guide-tabs.tsx` —— `GuideTabList` 新增 `variant: 'pill' | 'line'`，二级用 line（下划线、无边框）。
- `connect-devices-panel.test.tsx` / `computer-join-guide.test.tsx` —— 按新结构重写相关 describe。
- 语言包 `connectDevices.computer.*`（zh_CN / en_US / ja_JP 三语同步，86 键，键集完全一致），随后在仓库根跑 `bun run build:i18n`（`resources.ts`/`types.ts`/`generated/*.rest.json` 为其产物）。

### 语言包键变化

- 新增：`path.{title,relay,hub,ssh,hint.*,tip.*}`、`side.{relay,hub}.{join,host}`、`relayHost.{setup,password,invite}.*`、`ssh.{description,title,stepDescription,button,note}`、`join.uplink.{relayMissing,hubMissing,tenantMissing}`。
- 删除：`mode.{title,join,host}`、`join.uplink.{unknownDescription,missingUrl}`。全仓已确认无残留引用（含 e2e、testid）。
- 其余键（`install.*`、`join.*`、`host.*`）保留键名，文案按规范重写（一句一事、无第二人称、全角标点）。`mobile.*` / `tabs.*` 未动。
- 引用界面名称已与实际标签逐字对齐：「本机作为中继」（`nodes.setup.path.becomeRelay.title`）、「加入已有 Hub」、「加入中继」、「把本机设为 Hub」、「中继管理 → ⋯ → 修改接入密码」；ja 统一用「接続パスワード」（与 `relay.admin.password.*` 一致），en 统一用 access password。

## 测试

- `cd apps/fe && bun test src/components/side-panels/connect-devices` → **100 pass / 0 fail**（6 文件，313 断言）。
- `bun test src/components/side-panels` → **141 pass / 0 fail**（9 文件）。
- 回归：`bun test src/components src/pages/devices` → **434 pass / 0 fail**（30 文件）。
- `bunx tsc --noEmit -p apps/fe` → 我方文件 0 错。仍有 7 行错误全部落在 `src/pages/settings/nodes/**`（`RelayQuotaUsage.bandwidthBytesPerSec`、`UseMeshRelayResult.switchRelay` 等），属其他 agent 并行改动。
- `bunx biome check --write` 仅对本目录跑过，无待修项。
- `bun scripts/complexity/gate.ts`：本目录文件全部远低于阈值（最大 `hub-host-steps.tsx` 约 175 行）；门禁当前 2 条违规均在 `apps/gateway/src/mesh/`（relay-routes.ts / relay-uplink-client.ts 超 600 行），非本任务范围。

新增/更新的关键测试点：默认路径与二级默认选择（`connect-path.test.ts`，覆盖 relay / relay,node / hub,node / node / standalone / 角色缺失）；三条路径各自的步骤与 done|todo（含中继自建三步的打勾条件、缺地址告警）；`JoinSteps` 两个 variant 的地址块、CLI 命令、租户编号与折叠区出现条件；步骤编号连续性（marker 文本断言）；`openSelfAddDevice` 的等待/只开一次/取消/超时。

## 未做与需要注意

1. **SSH 对话框无法预选类型**。`DeviceManagementPanelHandle.openAddDevice()` 与 `OPEN_ADD_DEVICE_EVENT` 都不接参数，`createDefaultFormValues()` 默认 `type: 'local'`，所以从面板打开时类型仍是「本地」。当前做法是跳 `/devices` 后打开对话框，并在文案里明确「在设备对话框中把类型选为 SSH」。若要真正预选，需要在 `packages/panels`（本任务只读）改成 `openAddDevice(options?: { type })` 并让事件带 `detail`，同时 `apps/fe/src/pages/devices/add-device-targets.ts` 的 `AddDeviceTarget.open` 透传该参数。
2. **打开时机依赖注册表**。设备页的 self 分组挂载时才 `registerAddDeviceTarget`，因此按钮先导航再等注册（最多 15 秒）。若用户在 `/devices` 页打开面板，导航会关掉面板、对话框推迟一拍再弹（`setTimeout 0`），实测未做浏览器验证（按规则未起 dev server / e2e）。
3. **未做真机/截图核对**。文案规范要求新增 UI 步骤后在开发实例截图核对换行与截断；本轮按任务限制未启动开发服务器，建议合并后由整合方在临时实例里过一遍面板（尤其二级 line 标签与三行说明在窄屏的换行）。
4. **引用的设置页标签可能被并行任务改名**。文案里引用的「本机作为中继」「加入中继」「中继管理 → ⋯ → 修改接入密码」取自当前 `zh_CN.json`；若 T1–T4 在本轮重命名了这些标签，需要回来同步这几处引用。
5. `useConnectMachine()` 会在面板打开时拉一次 `/api/local/status`（与设置页共用 `LOCAL_STATUS_QUERY_KEY` 缓存）。旧节点 404 / 未登录 401 由 `useLocalStatus` 吞掉，指引退回纯静态文案（角色 null → 默认经中继，与 standalone 表现一致）。
