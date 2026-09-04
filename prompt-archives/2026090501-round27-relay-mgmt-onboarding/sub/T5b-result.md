# T5b 结果 —— 修复「服务器或电脑」指引的审查问题

worktree：`/Users/konata/code/tmex-r27`，分支 `feat/round27-relay-mgmt-onboarding`。
R3 报告的 7 个缺陷与全部文案问题已全部修完，未留 TODO。

## 一、缺陷修复

### 1（高）自建中继缺「接入本机中继」步骤

- `relay-host-steps.tsx`：在「设置接入密码」之后插入第 3 步 `EnrollStep`（testId `connect-step-relay-enroll`）。
  - 完成态判据抽成导出的 `relayHostEnrolled(machine) = machine.relayMode && machine.tenantId !== null`；完成后这步打勾并把租户编号做成可复制的 `CommandBlock`。
  - 未完成时给出设置页入口（`GuideLink → /settings?tab=nodes`，指向「连接」段里既有的 `SelfRelayEntry`，标题直接复用 `nodes.machine.relayServiceEnroll` 的原文「接入本机中继」）＋ CLI `tmex relay enroll '<中继地址>'`。
  - 命令由新加的 `relayEnrollCommand()`（`join-command-preview.ts`）拼，复用同一套 `isTrustedHubUrl` + `shellQuote`，地址不可信时退回示例地址，杜绝命令注入。
- 「让新机器加入」改为受 `relayHostEnrolled` 门控：未接入时只显示 `invite.blocked` 一行说明，不给「查看加入步骤」按钮。
- 三语 `join.uplink.tenantMissing` 改写：租户编号是本机接入中继后生成，而不是运营者在中继管理里创建。

### 2（中）SSH 跳转等待器被侧栏卸载提前取消

- `ssh-steps.tsx`：删掉 `useRef`/`useEffect` 卸载清理；新增导出的 `startAddDeviceFlow(navigate, options)`——**先登记等待器再导航**，收尾只交给超时与成功回调。
- `open-add-device.ts`：等待器改为模块级单例（`pending`），再点一次按钮撤掉上一个，避免多个等待器同时在跑；`stop()` 里把自己从单例位摘掉。
- 本仓库没有 DOM 测试环境（全部用 `renderToStaticMarkup`，跑不了 effect / 点击 / 卸载），所以覆盖做在 `startAddDeviceFlow` 这一层：断言导航发生的**那一刻**订阅数已是 1（即等待器先登记），随后跨两拍宏任务（模拟侧栏退场且无任何清理）订阅仍在，设备页迟到登记后对话框照开。

### 3（中）中继二级默认项用错状态字段

- `connect-path.ts`：`ConnectStatus` 增加 `tenantId`（从 `ConnectMachine` 上提，注释一并移过来）；`defaultConnectSide('relay')` 改判 `relayMode && tenantId !== null`，不再看 `isRelayRole(role) || relayAttached`。
- 补测三条：`relayMode=true/relayAttached=false` → `join`；`role='relay,node'/relayMode=false` → `host`；`role='relay'+relayAttached=true` → `host`；`relayMode=true` 但无租户编号 → `host`。

### 4（中）Hub 路径可能给出中继加入码

- `computer-join-guide.tsx`：`canIssueJoinToken` 改为 `variant === 'relay' ? machine.relayMode : !machine.relayMode`——所选 variant 与本机真实 uplink 模式不一致时整块折叠区隐藏（按任务允许的「simply hidden」，不新增文案）。
- 补测：`canIssueJoinToken('hub', RELAY_MACHINE) === false`，以及 `JoinSteps variant="hub"` + 走中继的本机渲染出来没有 `connect-join-token-advanced`。

### 5（中）普通节点误把上级 Hub 地址当本机入口

- `hub-host-steps.tsx`：`entryStatus()` 的第二个参数改成 `mode.hubNodeId && mode.hubNodeId === mode.nodeId ? mode.hubPublicUrl : null`；普通节点只剩隧道状态可依据。
- 在既有「本机只是节点」用例里补断言：入口步骤仍是待办（出 `entry.description`，无 `connect-host-entry-status`、无 `status.hubUrl`、全页无 `done`）。

### 6（中）中继接入信息缺租户编号仍打勾

- 新增导出的纯函数 `uplinkReady(uplink)`：Hub 只要 `url`，中继要 `url && tenantId`；`UplinkStep` 的 `state` 改用它。
- 「本机是中继但没有租户编号」用例补断言这步不是 `done`；另加 `uplinkReady` 的单测。

### 7（低）预期的 `/api/local/status` 404 仍按错误处理

- `use-connect-machine.ts` 改为自带一份「允许缺失」的查询模式，**未改动 `use-local-status.ts`**：
  - 自己的查询键 `GUIDE_LOCAL_STATUS_QUERY_KEY = [...LOCAL_STATUS_QUERY_KEY, 'guide']`，不往设置页共用的那份缓存写指引特有的口径；
  - `queryFn` 内捕获 `isLocalStatusMissing`（`LocalApiError` 且 401 / 404）→ 返回 `null`，因此既不重试也不产生 error，更不会被映射成 `loginRequired`；
  - 其余失败按原样抛出，`retry: 1`。
- 新增 `use-connect-machine.test.ts` 覆盖 `isLocalStatusMissing`（401/404 为真，500 / 普通 Error / null 为假）与查询键的分离。

## 二、文案

八个超长键全部收到 40 字以内（中文实测最长 39），英日同步改写：

| key | 新中文 | 字数 |
| --- | --- | --- |
| `path.tip.relay` | 中继只转发加密流量，不保存账号与密钥。适合都在 NAT 或防火墙后的机器。 | 37 |
| `path.tip.hub` | Hub 是信任中心，保存账号与节点成员，需要固定的公网 HTTPS 地址。 | 37 |
| `join.password.relayDescription` | 在新机器上打开「设置 → 多节点互联 → 加入中继」。 | 27 |
| `join.password.hubDescription` | 在新机器上打开「设置 → 多节点互联 → 加入已有 Hub」。 | 31 |
| `join.token.description` | 在已接入的机器上打开「节点管理」，点「添加」→「生成加入码」。 | 31 |
| `relayHost.setup.description` | 打开「设置 → 多节点互联」，选择「本机作为中继」。 | 26 |
| `host.entry.description` | 打开「设置 → 远程访问」，为本机配置固定的公网 HTTPS 入口。 | 34 |
| `host.hub.description` | 打开「设置 → 多节点互联」，选择「把本机设为 Hub」。 | 29 |

- `path.hint.ssh` 补上施动者：「SSH 直连：本机可通过 SSH 访问新机器，无需安装 tmex。」
- 被裁掉的必要信息没有丢，各落到一句短说明里：
  - 新增 `relayHost.setup.requirement`（「中继需要固定的公网 HTTPS 地址。」），在「本机设为中继」待办态下作 `GuideNote` 渲染；
  - `host.hub.hintUseEntry` 扩成「把上一步的地址 {{url}} 填入「Hub 公开地址」，创建首个账号后重启。」，接住原 description 里的「创建首个账号并重启」。
- 新增键（三语齐全）：`relayHost.enroll.{title,description,link,command,tenantId}`、`relayHost.setup.requirement`、`relayHost.invite.blocked`。
- locale JSON 只改自己那几行（无重排、无重格式化），改完在仓库根跑了 `bun run build:i18n`，`resources.ts` / `types.ts` / `generated/*.rest.json` 为脚本重建产物。

## 三、改动文件

前端（scope 内）：

- `apps/fe/src/components/side-panels/connect-devices/relay-host-steps.tsx`
- `apps/fe/src/components/side-panels/connect-devices/computer-join-guide.tsx`
- `apps/fe/src/components/side-panels/connect-devices/connect-path.ts`
- `apps/fe/src/components/side-panels/connect-devices/hub-host-steps.tsx`
- `apps/fe/src/components/side-panels/connect-devices/ssh-steps.tsx`
- `apps/fe/src/components/side-panels/connect-devices/open-add-device.ts`
- `apps/fe/src/components/side-panels/connect-devices/use-connect-machine.ts`
- `apps/fe/src/components/side-panels/connect-devices/join-command-preview.ts`
- 测试：`connect-path.test.ts`、`computer-join-guide.test.tsx`、`connect-devices-panel.test.tsx`、`open-add-device.test.ts`、新增 `use-connect-machine.test.ts`

i18n：`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（仅 `connectDevices.computer.*` 子对象）＋ 生成产物 `resources.ts` / `types.ts` / `locales/generated/*.rest.json`。

未编辑 `apps/fe/src/pages/settings/**`（只读参考 `uplink/uplink-section.tsx` 的 `SelfRelayEntry`、`use-local-status.ts`、`use-protected-status-query.ts`、`mesh-relay.ts`、`packages/app/src/cli/help.ts`）。

## 四、验证

| 命令 | 结果 |
| --- | --- |
| `cd apps/fe && bun test src/components/side-panels` | 152 pass / 0 fail（453 assertions，10 files） |
| `cd apps/fe && bun test src` | 2400 pass / 0 fail（135 files） |
| `bun test packages/shared/src/i18n` | 7 pass / 0 fail（含三语键一致性） |
| `bunx tsc --noEmit -p apps/fe` | 0 error |
| `bunx biome check <本任务文件 + 三个 locale>` | clean |
| `bun scripts/complexity/gate.ts` | 本任务文件无违规 |

## 五、遗留 / 备注

- `bun scripts/complexity/gate.ts` 全仓仍有 2 处超限：`apps/gateway/src/mesh/relay-routes.ts`（646 行）、`apps/gateway/src/mesh/relay-uplink-client.ts`（609 行）。均在网关侧、非本任务 scope，未动。
- 缺陷 2 的组件级覆盖受限于仓库没有 DOM 测试环境：无法真正 mount/unmount `SshSteps`，只能在其导出的 `startAddDeviceFlow` 上断言「导航时等待器已在位、之后不再有任何清理点」。若后续引入 happy-dom，可补一条真卸载的用例。
- 缺陷 7 采用「指引专用查询键」而非在共享键上映射 404：好处是设置页 `useLocalStatus` 的 404 口径完全不受影响；代价是指引面板与设置页同时打开时会各拉一次 `/api/local/status`（两者几乎不会同屏，且有 10s staleTime）。
- `git status` 里出现的未跟踪目录 `packages/app/native/` 非本任务产生。
