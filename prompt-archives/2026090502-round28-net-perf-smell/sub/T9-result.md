# T9 前端清理结果（B3 / C6 局部 / C2 / A1 fe 子集 / A3 局部 / D9 fe / D7）

全部 7 项均已落地。验收命令全绿：`apps/fe` `bun test src/`（2401 pass / 0 fail）、`packages/panels`
`bun test`（949 pass）、`packages/ui` `bun test`（414 pass）；`bunx biome check` 对 21 个改动文件零问题。
`bunx tsc --noEmit` 在 `apps/fe` / `packages/ui` / `packages/panels` 均未引入新错误（收尾时看到的
`packages/shared/src/uplink/codec-mesh.ts` 未定义符号与 `use-node-upgrade.ts:78 MAX_BUDGET_MS` 属其它
并行任务的在途改动，不在本任务范围内）。

## 1. B3 去掉 barrel 重复测试

`apps/fe/src/components/global-device-provider.test.ts` **247 → 51 行（-196）**。

删掉的 5 个 describe 均已确认原测试仍在：

| 删除的 describe | 原测试所在 |
| --- | --- |
| `shouldEnsureRouteDeviceSubscription` | `device-connection-status.test.ts:262` |
| `shouldEnsureDeviceSubscription` | `device-connection-status.test.ts:283` |
| `deriveDeviceConnectionStatus` | `device-connection-status.test.ts:40`（优先级矩阵 + 空 id + 原型链键） |
| `readPersistedIds / writePersistedIds` | `device-connection-persistence.test.ts:36 / :80` |
| `pruneUnknownDeviceIds` | `device-connection-persistence.test.ts:110` |

保留 `devicesQueryOptions`、`routeDeviceId` 两组（只在 barrel 里定义），并顺手收掉随之失效的
`createMemoryStorage` / `createSnapshot` 两个 helper 与多余 import。

## 2. C6 局部：account-security-panel 拆文件（纯搬运）

`apps/fe/src/components/side-panels/account-security-panel.tsx` **830 → 184 行（-646）**，新增目录
`account-security/`：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `account-security/password-section.tsx` | 232 | `PasswordFields` / `ReloginCodeField` / `FullResetOption` / `PasswordSection` |
| `account-security/totp-section.tsx` | 210 | `TotpSection` |
| `account-security/passkey-section.tsx` | 182 | `PasskeySection` |
| `account-security/section.tsx` | 33 | `Section` / `Feedback` / `FEEDBACK_TONE` |
| `account-security/types.ts` | 10 | `SecurityActionFeedback` / `ResolvedMode` |

公开入口路径不变：`account-security-panel.tsx` 继续默认导出 `AccountSecurityPanel`，并再导出
`PasswordSection`、`SecurityActionFeedback` 与原有的 `account-security-password` 那几项，
`account-security-panel.test.tsx`、`side-panel-host.tsx` 一行未改。类型放独立文件是为了避开
「面板 import 区块 / 区块 import 面板」的循环。零行为改动。

## 3. C2：use-hub-role-switch 拆分

`apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts` **1342 → 562 行（-780）**，
`useHubRoleSwitch` 函数体 **249 → 124 行**。新增两个兄弟模块（依赖是单向的 model ← run ← hook，无循环）：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `hub-role-switch-model.ts` | 390 | 常量、`Translate`、切换计划与按钮态、请求层（`HubRoleIo` / `submitAdmitHubRecord` / `createHubRoleIo`）、全部文案 |
| `hub-role-switch-run.ts` | 507 | 状态机与断点续跑：`guardHubRoleRun` / `admitHubWithForce` / `awaitHubRoleSwitch` / `promoteHub` / `switchWriter` / `runHubRoleSwitch` / `resumeHubRoleSwitch` + sessionStorage 持久化 |

`use-hub-role-switch.ts` 保留 `export * from './hub-role-switch-model'` 与 `'./hub-role-switch-run'`，
因此 **`use-hub-role-switch.test.ts`（1446 行）以及 `nodes-table.tsx` / `hub-role-dialog.tsx` /
`nodes-management.tsx` / `nodes-management.test.tsx` 一个字都没改**（这几个 UI 文件在禁改清单里）。

hook 拆成 3 个聚焦 hook + 2 个纯函数：

- `useHubRoleRun(latest)`（93 行）：`running` / `phase` / `switchingIds` / `recovery` 与 `settle` / `drive` /
  `abandon` / 挂载时的续跑 effect。
- `useHubRoleForce()`（10 行）：`admit-hub` 强制确认框的开关与它等着的 resolve。
- `useHubRolePlan(hubs, writerHubId, nameOf)`（16 行）：待确认计划的 `plan` / `request` / `dismiss`。
- 纯函数 `hubRoleSwitchRun(plan, startedAt)`、`hubRoleRecoveryRun(prompt, rollback, startedAt)`：
  把「算受影响的行 + 新 operationId + 续跑记录写入器」从 `confirm` / `resolveRecovery` 里提出来。

## 4. A1（fe 子集）：删零引用导出

`grep -rw` 确认三处在 `apps` + `packages` 全库（含测试）零引用后删除：

- `apps/fe/src/pages/settings/nodes/relay/use-relay-admit-follow-up.ts` — `resetRelayAdmitFollowUpForTest`（-5 行）
- `apps/fe/src/pages/settings/relay/relay-metrics-model.ts` — `EMPTY_MEMBER_FILTER`（-2 行）
- `packages/panels/src/device-console/terminal-keep-alive.ts` — `readKeepAlivePool`（-4 行，已复核 `KeepAlivePool` 类型仍被 `createKeepAlivePool` 用着）

## 5. A3 局部：relay-metrics-tiles 收窄导出

`apps/fe/src/pages/settings/relay/relay-metrics-tiles.tsx`（414 行不变）：13 个仅文件内使用的 tile
组件去掉 `export` —— `MembersOnlineTile`、`ActiveStreamsTile`、`BytesInTile`、`BytesOutTile`、
`FramesTile`、`LatencyTile`、`EventLoopTile`、`MemoryTile`、`CpuTile`、`TrafficTile`、`SocketsTile`、
`ReconnectsTile`、`UptimeTile`。

保留导出：`ThroughputTile`（`relay-metrics-ui.test.tsx:28,334,338` 直接渲染断言）、
`RelayCompactTiles` / `RelayFullTiles` / `RelayTilesSkeleton`（外部消费）、`MetricsTileProps`（接口，未在
本项范围内）。

## 6. D9（fe 部分）：hub-api 的 readError 折进 readCodedError

T8 已在 `packages/api-client/src/json-mutation.ts:75` 给 `readCodedError` 加上第四个参数
`pick(body, status)`，因此本项照办：`apps/fe/src/node/hub-api.ts` 原来手写的 `readError`
（读 body → `error` 字符串 → `code` 字符串 → fallback）改为调用 `readCodedError`，端点自有的
「顶层只有 `code`」那一档走 `pick`，`error` 存在时一律让默认契约解析接手以保住原有优先级。
`readRoleError`（404/405 → `HUB_ROLE_UNSUPPORTED`）本来就委托给 `readError`，无需再动。

行为差异仅有一处扩大：`{ error: { code, message } }` 这种标准契约错误体，原实现落到 fallback，
现在会取出 `code`——属修正而非回归。`hub-api.test.ts` 三条错误路径断言（404/405 折叠、
`{code:'HUB_EPOCH_STALE'}` 原样带出、读不出 body 退 `hub_role_failed`）全部原样通过。

## 7. D7：确认框上移到 `@tmex/ui/confirm-dialog`

新增 `packages/ui/src/components/confirm-dialog.tsx`（95 行）。`packages/ui/package.json` 的
`exports` 是 `"./*": "./src/components/*.tsx"` 通配，`@tmex/ui/confirm-dialog` 自动可用，**无需改
package.json**。

组件在原 `DangerConfirmDialog` 基础上补了几个轴，正好覆盖四个调用点的差异：`onOpenChange`
（不传则关闭时回调 `onCancel`）、`variant`（缺省 `'destructive'`，保住 fe 原有 5 个调用点的样式）、
`media`（标题上方图标块）、`cancelDisabled` / `confirmDisabled`、以及三个可选 testId
（`cancelTestId` 缺省仍是 `${testId}-cancel`）。

改动的文件：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `apps/fe/src/pages/settings/components/danger-confirm-dialog.tsx` | 67 → 7 | 只剩 `export { ConfirmDialog as DangerConfirmDialog, ... }` 的薄再导出；`direct-section` / `domain-access-row` / `https-section` / `tenant-confirms` / `remote-access/status-card` 五个调用点一行未改（后者在禁改清单里） |
| `packages/panels/src/device-console/refresh-confirm-dialog.tsx` | 38 → 26 | `variant="default"` |
| `packages/panels/src/device-tree/close-confirm-dialog.tsx` | 45 → 28 | `media` 传 `<X/>`，`confirmDisabled={!candidate}` |
| `apps/fe/src/pages/settings/nodes/setup/pure-relay-confirm.tsx` | 51 → 33 | `variant="default"` + 三个显式 testId |
| `apps/fe/src/pages/settings/nodes/relay/relay-switch-dialog.tsx` | 77 → 62 | `confirmLabel` 传 fragment（busy 时带 spinner），cancel/confirm 都跟 `controller.busy` |

按要求跳过 `packages/panels/src/device-management/device-delete-dialog.tsx`。

### testId 逐个核对（改动前后逐字相同）

`grep -rho` 在 `apps/fe/tests/**`（e2e spec）与 `apps/fe/src` + `packages` 源码中各查了一遍：

| testId | e2e 引用数 | 源码出现数（改动后） |
| --- | --- | --- |
| `setup-pure-relay-confirm` | 0 | 2（容器 + `-ok` 前缀） |
| `setup-pure-relay-cancel` | 0 | 1 |
| `setup-pure-relay-confirm-ok` | 0 | 1 |
| `nodes-relay-switch-dialog` | 0 | 1 |
| `nodes-relay-switch-cancel` | 0 | 1 |
| `nodes-relay-switch-ok` | 0 | 1 |
| `local-machine-direct-remove-confirm`(+`-ok`/`-cancel`) | 0 | 1（调用点未改） |
| `local-machine-domain-access-confirm`(+`-ok`/`-cancel`) | 0 | 1（调用点未改） |
| `https-confirm-stop`(+`-confirm`/`-cancel`) | 0 | 2（调用点未改） |

`refresh-confirm-dialog` 与 `close-confirm-dialog` 原本就没有 testId，改动后仍不带（`testId`
不传时 `data-testid` 为 `undefined`，不渲染属性）。

### 一处有意的行为微调

原 `DangerConfirmDialog` 有 `if (!open) return null`，共享组件去掉了它，改为始终渲染
`<AlertDialog open={open}>`：panels 两个对话框本来就是这个写法（保住 Base UI 的退场动画），
而 fe 侧只有 `direct-section` / `domain-access-row` 两处会传 `open={false}`，它们从「瞬间消失」
变成「正常淡出」。children 由调用方在传入前就已求值，早退不构成任何空值保护，故无正确性影响。

## 行数汇总

| 范围 | 前 | 后 |
| --- | --- | --- |
| 已跟踪文件净变化 | — | 13 files changed, +234 / −2001 |
| 新增文件 | — | account-security/ 5 个（667 行）、hub-role-switch-model/run（897 行）、ui/confirm-dialog（95 行） |
| 净行数 | — | 约 −108 行（含 5 个新文件的 import 头与 3 处 barrel 再导出） |
