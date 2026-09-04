# F5 结果 — R2 前端评审 11 条修复（含指挥官追加的 relay-join 错误码）

## 1. 密封包上传逐台核对 + K_log 清零 + 欠账细化到中继地址

- `apps/fe/src/node/relay-pack.ts`
  - `refreshRelayPack()` 返回值从 `boolean` 换成 `RelayPackRefreshResult { ok, requested, failed, transportError }`。
    `failedPackUrls()` 逐条比对响应 `results`：**每台都有 `ok:true` 才算成功**；旧节点不下发
    `results` 时按全部成功算（一台都没成功服务端回的是 502，走 `transportError`）。
  - `sealPacksFor()`：解出 `logKey` 的下一步就进 `try`，`token` / `sealed` 改为可空并在 `finally`
    里各自清零。畸形令牌导致的抛出不再把已解出的 K_log 留给 GC。
- `packages/api-client/src/relay/tenant-api.ts`：`normalizeJoinMaterial()` 增加
  `RELAY_KEY_B64URL = /^[A-Za-z0-9_-]{43}$/`（32 字节 base64url 无填充），`logKey` 与每条
  `token` 长度不对当场抛 `RELAY_JOIN_MATERIAL_INVALID`。顺带订正了 `RelayJoinMaterial.relays`
  的过时注释（现在有 `scope=all`）。
- `apps/fe/src/node/relay-meta-key-pending.ts`：密封包欠账从布尔标记换成
  `RelayPackDebt { all: boolean; urls: string[] }`，落 sessionStorage 为 JSON，**兼容 1.1.23 的
  `'1'` 旧值**。新增 `relayPackDebtDetail()`（引用稳定，可直接喂 `useSyncExternalStore`）；
  `rememberRelayPackDebt(urls?)` / `forgetRelayPackDebt(urls?)`，不给地址即「全部中继」。
- 销账策略（`runPackRefresh` / `settlePackDebt` / `refreshPackAfterRotate`）：
  逐台回执里失败的那几台**精确留账**，请求整个没打通（`transportError`）时不新记欠账
  （改密那一路例外，它本来就必须记）。
- `use-relay-pending.retryPack` 按欠账明细重封：`all` 时整份重封，否则只重封欠着的那几台。

## 2. 根签 append 的覆盖：admit 那一路 + 去重改成「同头 / 在途」

- `apps/fe/src/pages/settings/nodes/relay/use-relay-admit-follow-up.ts`：`distributeMetaKey()` 里
  `appendMetaKey` 之后显式 `refreshRelayPackForSigner(signer, …)`。admit-node 与 meta-key 都由
  `prompt.request()` 的复用签名者落账，`withSigner` 的钩子罩不到，日志头已经往前走了。
- `relay-pack.ts` 的 `WeakSet<RootKey>` 永久去重删除，换成：
  - `packRefreshedHead`：成功重封过的日志头 seq（只在**未限定中继子集**时记）；
  - `packInFlight`：`{head, promise}`，同头并到同一次上传，异头先等在途那次跑完；
  - 新头一律重新封。`resetRelayPackDedupeForTest()` 供测试复位。

## 3. 跨重启恢复的「纯中继」不再被默认值吞掉

`setup/standalone-relay-setup.tsx`：`<BecomeRelayForm key={initialRole ?? 'relay,node'} …>`，
intent 晚于本机状态到达时强制重挂，`useState` 初值跟着 `initialRole` 走。

## 4. `relay,node → relay` 的专用告警

`membership/leave-dialog.tsx`：新增导出 `isLeaveToPureRelay()`，并在该档下渲染
`PureRelayWarning`（testid `membership-leave-pure-relay-warning`）——与 `PureRelayConfirm` 同一套
强度：网页会消失、只能用命令行管理（`tmex relay status`）、以及怎么把网页要回来
（`tmex init --role relay,node`）。新 i18n 键 `nodes.membership.leaveToRelayConfirm.{webGone,restore}`。

## 5. 设置路径互斥：提交态提到共同父级

- 新增 `setup/setup-transition.tsx`：`SetupTransitionProvider` / `useSetupTransition` /
  `useSetupCommitted` / `isSetupBlocked`（无 Provider 时默认不锁，单独渲染表单的测试不受影响）。
- `setup/use-hub-setup-submit.ts`：用 `useId()` 作归属标记，提交成功即 `commit(owner)`；
  返回新字段 `blocked`，`handleSubmit` 在 `blocked` 时直接返回。新增 `uplink?: 'hub'|'relay'` 选项。
- `nodes-tab.tsx` 用 Provider 包住整个节点标签（本机卡 = 角色选择器 + 中继两块表单 + Hub 向导）。
- 锁上的地方：四个表单的提交按钮（并挂一条 `nodes.setup.transition.blocked` 说明条，
  testid `setup-<path>-blocked`）、`hub-setup-wizard.tsx` 的四张路径卡、
  `local-machine-card.tsx` 的角色下拉。
- `setup/error-messages.ts` + `validation.ts`：`setup_committed` / `setup_in_progress`
  进 `KNOWN_ERROR_CODES` 并三语落文案，不再显示英文原文。

## 6. standalone 不再打 `/api/mesh/relay/status`

- `management/use-create-enrollment.ts`：新增可选入参 `relay?: UseMeshRelayResult`；自己订的那一份
  变成 `useMeshRelay({ enabled: !input.relay && mode?.mode === 'mesh' })`。
- `side-panels/connect-devices/join-token.tsx`：`useJoinEnrollment` 里那份无条件的 `useMeshRelay()`
  也补上 `enabled: meshEnabled`（评审只点了内层，外层同一个洞），并把快照传给 `useCreateEnrollment`。
- 设置页经 `nodes-management.tsx → enrollment-section.tsx` 把本机卡已经在轮询的那份快照传下去
  （`relay` 为可选 prop，静态渲染测试不必构造）。

## 7. meta-key 欠账重试的武装键带上链路

`apps/fe/src/node/relay-meta-key-retry.ts`：`armKey` 从「欠账 id 集合」改为
`<attachedUrl>|on|off|<ids>`；`stampOf()` / `armOf()` 提到模块级。`sync()` 记住上一次的链路指纹，
**offline→online 与 attached URL 变化**时退避从头来并**立刻**试一次（首次挂上仍按退避起步，
保持原有语义）。

## 8. 接入口令对话框

`pages/settings/relay/password-dialog.tsx`：
- `open` 变化（开与关）当场重置草稿，用「prop 变化时调整 state」而不是 `useEffect`——
  effect 要等一帧，那一帧里明文还在（也顺带绕开 biome 的 exhaustive-deps）。
- `onSubmit` 的签名从 `PasswordDraft` 换成已解析的 `RelayPasswordRequest`，交出去后立刻
  `setDraft(emptyPasswordDraft())`。`use-relay-controller.ts` 的 `submitPassword` 跟着改成收 body。

## 9. 校验

`setup/validation.ts`：
- `classifyHubUrl()` 改为先过 `canonicalHubUrl()`（`@tmex/shared/auth`）——与后端同一把尺子，
  用户名/密码、query、fragment 一律判 `invalid`，带凭据的地址不会再被发到本机网关。
- `BecomeRelayField` 增加 `relayPassword`：空串放行（= 不设口令），否则 trim 后至少 8 位，
  错误落在 `setup-relay-password` 字段旁。

## 10. 中继文案

- `setup/error-messages.ts`：新增 `SetupUplinkKind` 与 `setupErrorKeyFor()`；
  `join_failed` / `hub_unreachable` / `node_revoked` / `node_exists` 四个码在中继路径改取
  `nodes.setup.errors.relay.<code>`。`join-relay-form` / `become-relay-form` 传 `uplink:'relay'`。
- `side-panels/connect-devices/join-token.tsx`：`create.relayMode` 时用
  `nodes.enrollment.missingRelayUrl`。
- `apps/fe/src/node/enrollment-engine.ts`：`hubNotConfirmed` 改为 `uplinkNotConfirmedKey()`
  （新文件 `apps/fe/src/node/enrollment-policy.ts`，见「门禁」）。

## 11. 版本过低提示去重

`packages/ws-client/src/websocket-transport.ts`：`reportedTooOld` 从「最近一条 key」换成
`Set<side:nodeId:version>`（transport 生命周期）。canonical READY 只清 `gateway:` 前缀；
同一端报了另一个版本时先抹掉该端的旧记忆再记新的（「reports a different version」那一档）。

> **注**：「node entry clears when that node negotiates successfully」在本层**没有可观测信号**——
> 节点侧的成功协商不会经 `/ws` 回到入口 transport（`node-event` 不进这条 transport，
> 也不带协商结果）。已实现的是「版本变化即作废旧记忆」，并保留了同一 transport 生命周期的去重。
> 若要覆盖「节点升级成功后立刻清记忆」，需要网关补一条「节点已按 canonical 接上」的 S2C 信号。

## 追加：`POST /api/setup/relay-join` 的稳定错误码

`validation.ts` 的 `KNOWN_ERROR_CODES` 增加 `relay_password_invalid` / `relay_tenant_unknown` /
`relay_pack_invalid` / `relay_unreachable` / `relay_not_authorized` / `local_user_exists`
（`join_failed` 已在表内）；`relay_unreachable` 进 `DETAIL_BEARING_CODES`，把后端网络原因一并显示。

**放置口径**：这六个码只会出现在中继路径，文案直接落在 `nodes.setup.errors.<code>`（不再放
`nodes.setup.errors.relay.*` 子对象），`setupErrorKeyFor()` 找不到中继专用键时回落到通用键，
两条路径拿到的都是同一句正确文案，也省掉 6×3 份重复键。若指挥官坚持要 `relay.` 前缀，
改 `RELAY_SPECIFIC_CODES` 一行 + 挪 18 个键即可。

`submit.ts` **无需改动**：`SetupApi.relayJoin()` 已经走 `readError()`，`{error:{code,message}}`
里的 `code` 原样进 `SetupApiError.code`，`describeSetupError()` 直接取用。
表单是**表单级**提示（既有的 `setup-join-relay-error` 说明条），不是字段级——任务书里
「field-level or form-level」二选一。

## 复杂度门禁（未改 allowlist）

新增的 UI 把四个表单顶过了门禁，按「只降不升」原地拆解决：

| 文件 | 处理 |
|---|---|
| `setup/form-parts.tsx` | 新增共用的 `SetupSubmitRow`（说明条 + 提交按钮），四个表单各省 8 行 |
| `setup/become-hub-form.tsx` | 结果面板抽成 `BecomeHubResult`（与 `BecomeRelayResult` 同一模式），194 → 168 行 |
| `setup/become-relay-form.tsx` | 初值构造提到模块级 `initialValues()` |
| `node/relay-meta-key-retry.ts` | `stampOf` / `armOf` 提到模块级 |
| `relay/use-relay-actions.ts` | 欠账判定抽成模块级 `settlePackDebt()` |
| `node/enrollment-engine.ts` | 新文件 `node/enrollment-policy.ts` 收走 `canAutoSignAdmit` / `invalidCertificateKey` + 新的 `uplinkNotConfirmedKey`；引擎 887 → 871 行（allowlist 上限 881，只降）。引擎仍 `export {…} from './enrollment-policy'`，外部 import 路径不变 |

## 文件清单

**新增**
- `apps/fe/src/pages/settings/nodes/setup/setup-transition.tsx` + `.test.tsx`
- `apps/fe/src/pages/settings/nodes/setup/standalone-relay-setup.test.tsx`
- `apps/fe/src/node/enrollment-policy.ts`

**修改（apps/fe/src）**
`node/relay-pack.ts`、`node/relay-pack.test.ts`、`node/relay-meta-key-pending.ts`、
`node/relay-meta-key-pending.test.ts`、`node/relay-meta-key-retry.ts`、
`node/relay-meta-key-retry.test.ts`、`node/enrollment-engine.ts`、
`auth/account-security-actions.ts`、`auth/account-security-actions.test.ts`、
`components/side-panels/connect-devices/join-token.tsx`、
`components/side-panels/connect-devices/computer-join-guide.test.tsx`、
`pages/settings/nodes/nodes-tab.tsx`、`pages/settings/nodes/local-machine-card.tsx`、
`pages/settings/nodes/membership/leave-dialog.tsx`、`…/leave-dialog.test.tsx`、
`pages/settings/nodes/management/use-create-enrollment.ts`、`…/enrollment-section.tsx`、
`…/nodes-management.tsx`、
`pages/settings/nodes/relay/use-relay-actions.ts`、`…/use-relay-pending.ts`、
`…/use-relay-admit-follow-up.ts`、
`pages/settings/nodes/setup/{validation.ts,validation.test.ts,error-messages.ts,error-messages.test.ts,use-hub-setup-submit.ts,form-parts.tsx,hub-setup-wizard.tsx,standalone-relay-setup.tsx,become-hub-form.tsx,become-relay-form.tsx,join-hub-form.tsx,join-relay-form.tsx}`、
`pages/settings/relay/password-dialog.tsx`、`pages/settings/relay/use-relay-controller.ts`

**修改（其它包）**
`packages/ws-client/src/websocket-transport.ts`、`…/websocket-canonical-gate.test.ts`、
`packages/api-client/src/relay/tenant-api.ts`、`…/tenant-api.test.ts`、
`packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`（+ `bun run build:i18n` 的生成产物）

## i18n 新增键（三语同步）

- `nodes.setup.transition.blocked`
- `nodes.setup.errors.{setup_committed,setup_in_progress}`
- `nodes.setup.errors.relay.{join_failed,hub_unreachable,node_revoked,node_exists}`
- `nodes.setup.errors.{relay_password_invalid,relay_tenant_unknown,relay_pack_invalid,relay_unreachable,relay_not_authorized,local_user_exists}`
- `nodes.membership.leaveToRelayConfirm.{webGone,restore}`

## 新增测试

| 文件 | 覆盖 |
|---|---|
| `node/relay-pack.test.ts` | 逐台回执部分失败 / 无 `results` 的旧节点 / 同头去重 + 新头必刷 / 在途并流只上传一次 / 失败的那台留欠账 |
| `node/relay-meta-key-pending.test.ts` | 按地址记账与销账、重复记只留一份、`all` 与不给地址销账 |
| `node/relay-meta-key-retry.test.ts` | 链路恢复在线立刻重试、切到另一台中继重开一轮 |
| `setup/error-messages.test.ts` | 中继口径四个码、无专用文案时回落、两个 409、relay-join 六个新码、`relay_unreachable` 带原因 |
| `setup/validation.test.ts` | 带凭据/query/fragment 的 Hub 地址判非法、`relayPassword` 三档 |
| `setup/setup-transition.test.tsx` | `isSetupBlocked` 两档 + 兄弟表单被锁时按钮禁用并出说明条 |
| `setup/standalone-relay-setup.test.tsx` | 两块并排的顺序、`initialRole` 两档（纯中继赢过默认值） |
| `membership/leave-dialog.test.tsx` | `isLeaveToPureRelay` + 新告警文案 |
| `connect-devices/computer-join-guide.test.tsx` | 中继模式缺地址时说的是中继 |
| `ws-client/websocket-canonical-gate.test.ts` | A/B 两个旧节点各弹一次不重复；入口重连只清 gateway 记忆，同节点换版本再弹 |

## 验证

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit -p apps/fe` | 0 错 |
| `bunx tsc -p packages/ws-client` / `packages/shared` | 0 错 |
| `bunx tsc -p packages/api-client` / `packages/stores` | 5 / 1（= 基线，均为既有测试文件问题） |
| `bun test src/`（apps/fe） | **2058 pass / 0 fail**（基线 2029） |
| `bun test` ws-client | 398 / 0（基线 396） |
| `bun test` stores | 415 / 0（基线 415） |
| `bun test` api-client | 209 / 0（基线 208） |
| `bun test` shared | 649 / 0 |
| `bunx biome check`（fe + ws-client + api-client + locales） | 干净 |
| `bun scripts/complexity/gate.ts` | **ok**，未改 allowlist |
| `bun run --cwd apps/fe build` | ✓ built |

## 需要指挥官处理

1. **既有测试的 mock 与 `scope=all` 不同步（我已顺手修，属我 scope 内）**：
   `apps/fe/src/auth/account-security-actions.test.ts` 的 `mockRelayApi` 用
   `url === '/api/mesh/relay/join-material'` 精确匹配，指挥官加上 `?scope=all` 之后这条会 404。
   已改成 `startsWith`。请确认这不是别的 agent 正在改的同一处。
2. **`packages/api-client/src/relay/tenant-api.ts` 属「append only」范围**，但为了 R2 的 MAJOR
   （K_log 清零前置 + 长度预校验）我改了 `normalizeJoinMaterial()`（加长度正则）与
   `RelayJoinMaterial` 的注释。如果这条约束是硬性的，请复核这两处。
3. **`server-too-old` 的「节点协商成功即清记忆」缺信号**（见第 11 节的注）——需要网关侧补
   S2C 事件才能做全，当前实现只覆盖「版本变化」。
4. **relay-join 新错误码的文案位置**（见「追加」一节）落在 `nodes.setup.errors.<code>` 而不是
   `errors.relay.<code>`，理由已说明；若后端把这些码也用在非中继路径上，需要重新分档。
5. **`nodes.setup.errors.relay_pack_invalid` 的中文措辞**（「请在已加入的机器上重新登录以补上材料」）
   是我按密封包机制推断的用户动作，建议指挥官或产品复核一遍是否与后端语义一致。
