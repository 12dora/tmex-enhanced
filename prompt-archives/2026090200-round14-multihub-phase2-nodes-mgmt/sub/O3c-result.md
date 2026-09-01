# O3c 结果 — FE 主备切换：未确认必须进恢复框，异常不再冒成未处理 rejection

对应 RV3 第 11、12 条（两条 FE should-fix）。

## 改了什么

### 1. `unconfirmed` 在有恢复上下文时等同 `failed`（RV3 #11）

- `promoteHub`：回读段（`awaitHubRoleSwitch`）返回 `unconfirmed`（目标重启超时 / writer 迟迟不换人）时，
  只要 `recover` 上下文存在（原主已降备或已发出降备），一律转成 `{kind:'recover'}`，进入不可自动关闭的
  恢复对话框（重试目标 / 回滚原主），**续跑记录保留**。原来只有 `failed` 才转。
- `resumeHubRoleSwitch` 的 `phase=wait` 分支同样处理，并在开跑前就把恢复上下文交回宿主。
- 没有恢复上下文时（`fromUnreachable`、无原主、`demoteOnly`）保持原样：一条 warning toast + 清记录。
- 恢复上下文的传递新增 `onRecoverContext?(context)` 可选回调（`HubRoleStepBase` /
  `HubRoleRunParams` / `HubRoleResumeParams`），`promoteHub` 一进入「原主已不在写」的窗口就回调一次，
  用于让最外层的异常兜底知道该弹恢复框而不是一条 toast。

### 2. 全链路错误边界（RV3 #12）

- 新增 `readHubs(io)`：`io.hubs()` 抛异常一律当成「这一拍没读到」，不再向上冒。
  `awaitHubRoleSwitch` 等 writer 的循环与 `waitForSignedAuthorization` 都改走它——入口在切换期间
  短暂断连会在既有预算（`HUB_ROLE_WRITER_TIMEOUT_MS` / `HUB_ROLE_AUTH_TIMEOUT_MS`）内重试，
  预算耗尽才按 `unconfirmed` / `authTimeout` 收口。
- 新增 `readHubsWithin()` + `HUB_ROLE_HUBS_TIMEOUT_MS = 20_000`：续跑时那一次「先看 writerHubId
  才知道从哪档接着跑」的读取改为预算内重试；始终读不到时**不盲发升主**，有原主则进恢复框，
  否则报未确认（新文案 `errors.hubsUnreachable`）。
- 新增 `guardHubRoleRun({run, recover, t})`：包住整条 `drive` 流水线。任何未预期异常收敛成
  `failed`（有恢复上下文则 `recover`），不再产生未处理 rejection，也不会把页面卡在 `running=true`。
  `useHubRoleSwitch.drive` 现在把 `{signal, onRecoverContext}` 交给 task，三个调用点
  （挂载续跑 / `confirm` / `resolveRecovery`）都已接上。
- 收尾逻辑抽成纯函数 `hubRoleSettlement({outcome,targetName,nameOf,t}) -> {recovery, running,
  clearRecord, toast, refresh}`，`settle` 只负责套用。这样「恢复 = 留记录 + running 保持」「失败 =
  清记录 + running 落回 false」无需渲染组件即可断言（apps/fe 没有 DOM 测试环境）。

### 3. 文案（三语同步，已跑 `build:i18n`）

- 新增 `nodes.hubs.role.errors.hubsUnreachable`、`nodes.hubs.role.errors.unexpected`。
- `recovery.description` / `recovery.noWriter` 由「新主 Hub 未能升起 / 未能升为主 Hub」改为
  「未确认接管」——同一个框现在也承载超时未确认与异常中断，原文案会误报为「明确失败」。

## 文件

- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts`
- `apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.test.ts`
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json`
- `packages/shared/src/i18n/{resources.ts,types.ts}`（生成物，`bun run --filter @tmex/shared build:i18n`）
- `hub-role-dialog.tsx` 未改：恢复框本来就没有自动关闭路径，新语义只影响文案。

## 测试

新增/调整用例（`use-hub-role-switch.test.ts`）：

- `runHubRoleSwitch`：原主已降备 + writer 迟迟不换人 → `recover`（含 target/from 与 writerTimeout 文案）；
  原主不可达时的同一场景 → 仍是 `unconfirmed`；降备落地即交回恢复上下文（`onRecoverContext` 断言）。
- `awaitHubRoleSwitch`：`io.hubs()` 前两拍抛异常、第三拍读到目标 → `done`（断言正好 3 次调用）；
  一直抛 → 预算耗尽后 `unconfirmed`，时钟推进 ≥ `HUB_ROLE_WRITER_TIMEOUT_MS`。
- `resumeHubRoleSwitch`：`phase=wait` 回读超时 + 有原主 → `recover`；无原主 → `unconfirmed`；
  读不到 hub 集合 + 有原主 → `recover` 且**一个 role 请求都没发**；无原主 → `unconfirmed`。
- `guardHubRoleRun`：正常透传 / 异常→`failed` / 异常+上下文→`recover`。
- `hubRoleSettlement`：recover（留记录、running 保持、无 toast）、failed（清记录、running 落回 false、
  error toast）、unconfirmed（warning + 清记录）、done/cancelled。
- 已有用例 `phase=demote 且原主还在写` 的期望由 `unconfirmed` 改为 `recover`——正是本次要求的行为变更。

结果：

- `cd apps/fe && bun test src/`：**1434 pass / 0 fail**（81 文件，4115 断言）；
  其中 `use-hub-role-switch.test.ts` 72 pass / 0 fail（218 断言，原 55 个用例）。
- `cd apps/fe && bunx tsc --noEmit -p .`：**0 error**。
- `bunx biome check`（三个 FE 文件 + 三份 locale JSON）：clean（一次 `--write` 修了格式）。
- `packages/shared` 的 i18n 用例：2 pass / 0 fail。

## 遗留 / 提请注意

- 复杂度门禁（`bun scripts/complexity/gate.ts`）在本分支整体是红的（70 项，多数在 gateway/codec），
  与本任务无关。`use-hub-role-switch.ts` 在我改动**之前**就已超 900 行文件阈值（1209 行），
  本次增至 1343 行；`awaitHubRoleSwitch: CC 16`、`useHubRoleSwitch: 249 行` 也是既有超标项
  （CC 未因本次改动增加，hook 行数 +2）。合并收口时需要 commander 统一 `--tighten` 或补 allowlist。
- 未做 UI 截图核对（无 DOM 测试环境，且不得起生产实例）；改动的三条文案都在既有恢复框内，长度与原文相当。
- `io.roleStatus` 抛异常的场景没有单独的预算内重试：`createHubRoleIo` 已在内部吞掉网络异常并返回
  `unreachable`，真抛出来属于未预期，由 `guardHubRoleRun` 收口成 failed/recover。
