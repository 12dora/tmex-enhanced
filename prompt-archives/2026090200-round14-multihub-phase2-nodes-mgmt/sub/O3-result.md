# O3 结果 — 节点表里的 Hub 主备切换

## 做了什么

节点表 hub 徽标右侧新增一个 `ArrowLeftRight` 图标按钮：备 Hub 上写「设为主 Hub」，当前写者上写「设为备 Hub」。点下去先弹一个把整套计划摊开的确认框，确认后按「签授权 → 降原主 → 升目标 → 跨重启轮询」四步跑完，全过程可在页面刷新后续跑。

### 1. `HubApi.role` / `HubApi.roleStatus`（`apps/fe/src/node/hub-api.ts`）

- 两个方法都**显式收 `hubNodeId`**，打 `/n/<hubNodeId>/api/hub/role[...]`，与实例自身绑定的那台 hub 无关——切换的常态就是「站在备 Hub 那一行把它升成主」。
- 目标回 **404 / 405** 一律折成 `HubApiError('HUB_ROLE_UNSUPPORTED', status)`（旧版本没有这套接口）；其余错误原样带出后端 `code`。
- 新增 `defaultHubApi = new HubApi(SELF_NODE_ID)`：角色接口的目标由参数给，这里只借它的 `ApiClient`，`path()` 退化成入口自身的旧路径，不会指向一台猜出来的 hub。

### 2. `buildAdmitHubRecord`（`apps/fe/src/node/enrollment.ts`）

紧挨 `buildRevokeNodeRecord`，用 shared 的 `buildAdmitHubPayload` 构造并签 `admit-hub`。**publicUrl 必填传入**：入口应用 `admit-hub` 时若 payload 与集合里都没有地址，记录会被 `hub-authorization.ts` 静默丢掉。

### 3. `use-hub-role-switch.ts`（新）

纯逻辑 + io 接缝 + React 绑定三段。

- **计划** `planHubRoleSwitch`：`intent` 由「这一行是不是当前 writer」决定；`newEpoch = max(所有 hubs.writerEpoch) + 1`；`needsAdmit = target.authorization !== 'signed'`；`fromUnreachable = 原 writer 离线`。「设为备 Hub」时 `pickSuccessorHub` 挑接管者（**签名授权优先 → priority 小者 → nodeId**，只认在线且已授权的），挑不出来则 `leavesNoWriter = true`，仍允许切换但确认框写明「之后将没有可写 Hub」。
- **按钮态** `hubRoleButtonState` / `hubRoleBlockReason`，禁用原因按优先级唯一：`unknownHub`（集合未加载）→ `unknownAuth`（旧后端不下发 `authorization`）→ `offline` → `switching` → `rowBusy`（升级 / 卸载）→ `notWritable`（**只在需要签 admit 时才拦** `hubWritable`）。
- **`submitAdmitHubRecord`**：不走 `AuthApi.appendKeyLog`（那条路只回一个 code）。直接 `POST /api/auth/keylog?hub=sync`，读得到 409 的 `{minVersion, nodes}`，`force` 时补 `X-Tmex-Force-Keylog: 1`。`hubAck !== true` 一律判失败——hub 没确认等于一条都没落库，绝不能接着升主。
- **`admitHubWithForce`**：命中 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` → 弹列出老节点的对话框，勾了「仍然继续」才补强制头重发一次；强制过一次还被挡就不再重试。
- **`runHubRoleSwitch`**：admit（必要时）→ 轮询 `/api/mesh/hubs` 等 `authorization === 'signed'`（20 s 上限，超时判失败，**不**接着升主）→ 原主可达才 demote（不可达则跳过，靠更高纪元 fence）→ promote → 交给 `awaitHubRoleSwitch`。demote / promote 的 `failed` 就地失败；`unreachable` 视为「202 回包丢在重启里」，继续往下回读。
- **`awaitHubRoleSwitch`**（跨重启的尾段，续跑也用它）：轮询目标 `roleStatus` 到 `complete` / `failed`，期间不可达（含 `HUB_ROLE_UNSUPPORTED` —— 重启窗口里入口转发不到目标就是 404）按「重启中」计时，**连续 90 s** 打不通判 `unconfirmed`；随后等 `/api/mesh/hubs` 的 `writerHubId` 换成目标（60 s 上限）。四种结论 `done / unconfirmed / cancelled / failed`，**不谎报成功**。
- **续跑**：`{operationId, targetHubId, fromHubId, startedAt}` 落 sessionStorage `tmex.nodes.hub-role-switch`（TTL 30 分钟，脏数据 / 隐私模式一律安全降级）。挂载时读一次接上尾段——effect 依赖走 ref、依赖数组为空，避免节点列表每刷新一次就把还在轮询的续跑掐掉。
- `admitHubSigned` 把 `head → 签名 → append` 整段放进 `withKeyLogLock`，等用户勾选的对话框留在锁外（与 `revokeNodeRecord` 同一套理由）。凭据走 `prompt.withSigner({purpose:'admit'})`，强制重发复用同一个签名者，用户不必再输一次密码。

### 4. UI

- `nodes-table.tsx`：`HubTag` 旁的 `icon-xs` ghost 按钮（`data-testid="nodes-hub-role-<id>"`，带 `data-role-intent`），禁用原因进 `title`；`StatusCell` 新增 `switching` 档，显示「切换中」并**压过在线态**（目标重启期间它同时是「离线」，照原样显示会让人以为切换把机器弄挂了）。
- `hub-role-dialog.tsx`（新）：主确认框（步骤有序列表 + 「原主不可达」/「之后没有可写 Hub」警示行）与强制确认框（老节点清单 + 勾选框，未勾时确认按钮禁用）。正文组件单独导出，供静态渲染测试。
- `nodes-management.tsx`：接上 `useHubRoleSwitch`，把 controller 透给 `NodesTable`，并在 `UninstallDialog` 旁渲染 `HubRoleDialog`。

### 5. 文案

`translation.nodes.hubs.role.*` 三语同步（zh 源 → en → ja），含 `promote/demote/stateSwitching`、确认框标题与步骤、两条警示、`started/done/failed`、强制框四条、`blocked.*` 六条、`errors.*`（6 个 `HubRoleErrorCode` + `unknown/unreachable/authTimeout/restartTimeout/writerTimeout`）。已跑 `bun run --filter @tmex/shared build:i18n`（未对生成文件做 lint/format）。

## 文件

新建：

- `apps/fe/src/node/hub-api.test.ts`
- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts`
- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.test.ts`
- `apps/fe/src/pages/settings/nodes/management/hub-role-dialog.tsx`

修改：

- `apps/fe/src/node/hub-api.ts`、`apps/fe/src/node/enrollment.ts`
- `apps/fe/src/pages/settings/nodes/management/{nodes-table.tsx,nodes-management.tsx,nodes-management.test.tsx}`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` + 生成物 `packages/shared/src/i18n/{resources.ts,types.ts}`

未改 `types.ts`：controller 类型留在 `use-hub-role-switch.ts`，`roleSwitch` 作为 `NodesTableProps` 的额外字段传入（与 `selection` / `uninstall` 同一套做法）。未改 `packages/api-client`（`MeshHubEndpoint.authorization` 由 O1b 加好了，直接用）。

## 测试 / tsc

| 项 | 基线 | 现在 |
|---|---|---|
| `cd apps/fe && bun test src/` | 1346 pass / 0 fail | **1400 pass / 0 fail**（+54 用例，81 文件） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 | **0** |
| `cd packages/shared && bun test src/i18n` | — | 2 pass / 0 fail |
| `bunx biome check <改动文件>` | — | 12 files 全部通过（`--write` 过一次格式化 + 两处 lint 修正：`AdmitHubStep` 改函数类型别名、强制框的 `label` 补 `htmlFor`） |

覆盖：计划（纪元、接管者挑选、原主离线、无人接管、集合未知）、按钮态优先级矩阵、`submitAdmitHubRecord`（hubAck / 409 解析 / 强制头 / 网络异常）、`admitHubWithForce`（不问 / 勾了重发 / 不勾取消）、`runHubRoleSwitch`（免 admit、需 admit 且授权延迟生效、凭据取消、授权超时、原主不可达跳过 demote、demote 被拒、promote 被拒、只降备）、`awaitHubRoleSwitch`（穿越重启、预算耗尽判 unconfirmed、目标自报 failed、writer 超时、卸载即停）、续跑记录（读写 / TTL / 脏数据 / 无 sessionStorage / 刷新后只轮询不重发）、表内按钮渲染与六种禁用原因、「切换中」状态列、两个对话框正文。

## 注意事项 / 留给别人

- **未做实机验证**：本轮只跑单测与 tsc，没有起临时实例走真实的两台 hub 切换（需要 G3/G4 的后端一起在跑，且要两台带 hub 角色的机器）。合流后建议按 `docs/hub/2026090104-multi-hub-standby.md` 的「远程切换（UI）」实测一遍，重点看目标重启窗口内 `roleStatus` 的 404 是否确实落在 90 s 预算内。
- `hubs()` 的默认实现走 `refreshMeshHubs()` + `getMeshHubsState()`，因此轮询期间集群条与 hub 徽标也会跟着刷新；这是有意的（用户能看到 writer 换人的过程）。
- 后端若给 `GET /api/mesh/hubs` 补上 `roleTransition`（G3 未做），可以省掉「等 writerHubId 换人」那一段的猜测，把 `unconfirmed` 收窄。
- 切换记录只在发起的那个标签页里（sessionStorage），换标签页看不到、也不构成互斥——两个标签页同时切同一台 hub 靠目标机的 `HUB_ROLE_BUSY` 兜底。
