# T10 收尾批次执行结果

工作树：`/Users/konata/code/tmex-r28`（分支 `feat/round28-net-perf-smell`）。
禁区（codex 并行中）全程未碰：`apps/gateway/src/mesh/**`、`apps/gateway/src/relay/**`、
`apps/gateway/src/hub/uplink-server.ts`、`apps/gateway/src/config.ts`、`packages/shared/src/link/**`、
`packages/shared/src/net/**`、`packages/app/src/vendor/**`、`packages/ws-client/src/direct/**`。
未执行任何改变 git 状态的命令，未跑 e2e。

## 1. A2 无用 i18n 键（61 个全部删除）

### 复核方法

1. 全字面量：`grep -rF "<key>"` 扫 `apps packages scripts`，排除 `i18n/locales/`、`resources.ts`、`types.ts`
   —— 61 个键零命中。
2. 动态拼接：写脚本抽出全仓 2731 条含 `${}` 的模板字面量，仅保留出现在 i18n 取值上下文
   （`t(...)` / `*Key` 属性）且**含真实字面量片段**的 152 条，转成正则回匹候选键。
   命中的只有 `connect-devices/` 里的 `${prefix}.title` / `${prefix}.warning`——读源码确认
   四处 `PREFIX` / `prefix` 常量分别是 `connectDevices.computer{,.join,.relayHost,.ssh,.install,.host.*}`，
   拼不出 `connectDevices.title` / `device.title` / `settings.title` / `agent.panel.title` / `common.warning`。
3. 另外排查了三条可能绕过 grep 的机制：裸前缀常量（`'deviceStatus.'` 之类）零命中；
   `useTranslation({ keyPrefix })` 全仓无使用；`<Trans i18nKey>` 全仓无使用。

结论：61 个键确认死键，**没有一个因被引用而保留**。`_one` / `_other` 复数键未触碰
（删的是精确路径叶子，不匹配带后缀的兄弟键）；脚本会顺带清理变空的父节点，实际执行中无父节点变空。

### 实际删除的键（zh_CN / en_US / ja_JP 各一份，共 183 条）

```
common.warning            common.info               common.enabled            common.disabled
common.pending            common.authorized         common.empty              common.none
common.default            common.optional           common.required
nav.settings              connectDevices.title      settings.title            webhook.enabled
device.title              device.devices            device.localDevice        device.subtitle
device.modify
terminal.initializing     terminal.activePane       terminal.activeWindow     terminal.closeWindow
terminal.closePane
telegram.testMessageSent  telegram.expand           telegram.collapse         telegram.botNotFound
weixin.allowAuthRequests  weixin.loggedIn           weixin.sendTestMessage    weixin.removeFailed
weixin.userId             weixin.expand             weixin.collapse           weixin.authSuccess
weixin.authPending
sshError.agentNoIdentity  sshError.timeout
deviceStatus.reconnecting deviceStatus.offline
websocket.error           websocket.checkGateway
sidebar.noWindows         sidebar.currentPane       sidebar.closeWindow       sidebar.closePane
agent.orphan.process      agent.orphan.startedAt    agent.panel.title
agent.session.none        agent.session.showAll
watch.form.enabled        files.transfer.canceled
file.notFound             file.tooLarge             file.binary
nodes.actions.rename      nodes.rename.save         nodes.rename.done
```

`bun run build:i18n` 重生成 `resources.ts` / `types.ts` / `locales/generated/*`；
core/rest 切分后 core 580 键不变，rest 由 1831/1826 降到 1826/1821。

行数：`packages/shared/src/i18n/**` 合计 **-628 / +18**（源 3×61 条 + 生成物）。

验证：`packages/shared` `bun test` 720 pass 0 fail（含 locale 一致性）；`apps/fe` `bun test src/`
2406 pass 0 fail（含 `core-coverage`）。

## 2. D3 `errorMessage` 统一

新增 `packages/shared/src/errors.ts`（`errorMessage(err: unknown): string`），从 `@tmex/shared`
主入口导出，配 `errors.test.ts`。`packages/app` 刻意不加 workspace 依赖，另建
`packages/app/src/lib/error-message.ts` 本地一行实现（注释里写明了原因）。

### 具名副本

| 位置 | 处理 |
| --- | --- |
| `apps/gateway/src/agent/retry-policy.ts:toErrorMessage` | 删除，`run.ts` / `run-stream-handlers.ts` 改用 `@tmex/shared`；`retry-policy.test.ts` 里那段 `toErrorMessage` 用例删掉（已由 `shared/errors.test.ts` 覆盖） |
| `apps/gateway/src/agent/run-resource-scope.ts:toErrorMessage` | 删除 |
| `apps/gateway/src/watch/notifier.ts:toErrorMessage`（导出） | 删除，`watch/service.ts` 改用 `@tmex/shared` |
| `apps/fe/src/node/hub-load-coordinator.ts:errorMessage` | 删除 |
| `packages/panels/src/watch/use-watch-rules.ts:toErrorMessage` | 删除 |
| `packages/app/src/tls/acme-service.ts:errMsg` | 改用本地 `lib/error-message` |
| `packages/app/src/tls/tls-service.ts:errMsg` | 同上（两份合成一份） |
| `apps/gateway/src/mesh/uplink-reconnect.ts` / `uplink-key-log-sync.ts` 的 `errMsg` | **跳过**（禁区） |

### 内联表达式

脚本按 `X instanceof Error ? X.message : String(X)`（三处同名标识符）整体替换，跳过禁区、
测试 / `.integration.ts` / `.spec.ts`、`apps/fe/tests/`、`scripts/`：**80 个文件、108 处**。
含 i18n 兜底（`... : t('common.error')`）或返回结构体的变体全部保留（正则天然不匹配）。
剩余未处理的内联仅在禁区文件里（`mesh/*` 12 处、`hub/uplink-server.ts` 1 处、`link/mux.ts` 1 处、
`ws-client/direct/*` 1 处），已列在报告末尾。

行数（具名副本 8 个文件）：**-53 / +27**；内联替换整体为净减（每文件 −1~−3 行的表达式，+1 行 import）。

## 3. D4 `sleep` / `sleepOrAbort`

新增 `packages/shared/src/async/sleep.ts`：`sleep(ms)`（不可中断）与
`sleepOrAbort(ms, signal): Promise<boolean>`（`false` = 被中断，**永不 reject**，定时器与监听器两分支都清）。
按 T8 的风格从 `src/async/index.ts` 与主入口双出口导出，配 `sleep.test.ts`（含「睡满后摘掉 abort 监听器」用例）。

各调用点的 abort 语义逐个核对后改写：

| 调用点 | 原语义 | 迁移方式 |
| --- | --- | --- |
| `apps/fe/.../management/use-node-upgrade.ts:waitFor` | 走完 `true` / 取消 `false` | 与 `sleepOrAbort` 完全同构，`defaultUpgradeIo.wait` 直接换成 `sleepOrAbort` |
| `apps/fe/.../restart/wait-for-restart.ts:delay` | 取消时**提前 resolve void** | 删掉，`sleep` 选项类型放宽成 `Promise<unknown>`，默认值换 `sleepOrAbort`；循环本来就在下一拍 `signal?.aborted` 上收尾，行为不变 |
| 同上的调用方 `hub-role-switch-model.ts` | `await delay(...); return !signal.aborted` | 直接 `wait: sleepOrAbort`（语义逐字相同） |
| `apps/fe/src/pages/settings/use-site-settings-save.ts:sleep` | 纯 setTimeout | 换 `@tmex/shared` 的 `sleep` |
| `apps/gateway/src/weixin/ilink/update-loop.ts:sleep` | 取消时 **reject(AbortError)** | 删掉。`backoffSleep` 原本用 try/catch 吞掉这个异常，改成直接 `await sleepOrAbort(...)`（丢掉了一层 try/catch）；**`client.ts:login()` 靠这次 reject 把 AbortError 抛出循环**，改写成 `if (!(await sleepOrAbort(pollIntervalMs, signal))) throw new AbortError();`，抛出语义保持不变 |

按要求跳过：`packages/app/src/commands/enroll.ts`（无 shared 依赖）、`mesh/rtc/*`（禁区）、测试与脚本。

## 4. D5 / D10 调用点

- `apps/gateway/src/system/remote-upgrade-job.ts`：删掉本地 `mergeAbortSignals` 与 `withTimeout`，
  改用 `@tmex/shared` 的 `combineAbortSignals` / `withTimeout`（T8 产物）。**-38 / +7**。
- `apps/gateway/src/system/release-download.ts`：删掉逐字相同的 `mergeAbortSignals`。
  `downloadTarballToFile` 里那处结果要 `addEventListener`，而 `combineAbortSignals` 返回
  `AbortSignal | undefined`，故拆成 `const timeout = AbortSignal.timeout(...)` +
  `combineAbortSignals(timeout, signal) ?? timeout`，类型安全且行为不变。**-19 / +4**。
- `apps/gateway/src/weixin/ilink/update-loop.ts`：裸 `AbortSignal.any([...])` 换 `combineAbortSignals`。

## 5. C3 `TunnelStatusCard`

T2 抽完 `TunnelDetails` / `DegradedHint` 后实测仍是 **CC 33 / 163 行**（脚本口径 31）。
只抽 `TunnelStatusNotices`（动作报错 / 暴露确认 / 进程错误 / 降级四条提示）后降到 **CC 24**，
仍 ≥15，于是把动作按钮行一并抽成 `TunnelStatusActions`（启动 / 停止 / 检查 / 移除·释放，
命名隧道的二次确认经 `onConfirmRemove` 回调抛给宿主）。

现状：`remote-access/` 目录下 `CC>15` 只剩 `tunnel-model.ts:wizardStepState`(26，本轮不在范围)，
`TunnelStatusCard` 已跌出 CC 榜与 >80 行榜。所有 `data-testid` 逐字保留，
**未动 allowlist**。`remote-access-tab.test.tsx` 等 6 个文件 279 pass 0 fail。
文件 `status-card.tsx` 473 → 547 行（+161 / −87：抽出的两个组件各带一份 props 声明）。

## 6. C1 `useNodeUpgrade`

原 453 行 / 17 个 ref，且与整包纯逻辑挤在一个 1350 行文件里。拆法：

- `upgrade-refs.ts`（98 行）：`UpgradeRefs` 类型 + `createUpgradeRefs()`，把 17 个跨段可变量
  收成一包（每项都带「为什么是 ref 不是 state」的注释），另放 `EMPTY_IDS` / `withId`。
- `use-upgrade-runtime.ts`（288 行）：执行层。内部再分
  `useUpgradeLifecycle`（宿主 AbortController + latest 查询 + `alive`）、
  `useExclusiveRunner`（单行互斥 + `anyRunning`）、
  `useUpgradeCancel`（`runCancel` + `startHandoff`）、
  `useUpgradeRunners`（`runOnce` / `resumeOnce` + resume ref 接线），
  `useUpgradeRuntime` 只负责 `entries` / `patch` / `entryOf` 与组合。
- `use-upgrade-batch.ts`（317 行）：`useUpgradeBatchPlan`（计划读写）、
  `useUpgradeBatchResume`（续跑 + storage 事件）、`useUpgradeBatch`（进度 / `startAll` / 心跳）、
  `useUpgradeRestore`（刷新后回读）。
- `use-node-upgrade-controller.ts`（115 行）：`useUpgradeRowActions`（行内两个按钮）+
  `useNodeUpgrade`（**只做组合**，约 45 行）。

**没有引入循环依赖**：新文件单向 import `./use-node-upgrade`；`useNodeUpgrade` 唯一的消费方
`nodes-management.tsx` 改成从 `./use-node-upgrade-controller` 导入，原文件不反向引用新文件。

`use-node-upgrade.test.ts` **一个字都没改**（它只测纯函数，仍从 `./use-node-upgrade` 导入，
被移走的只有 React 层）。原文件 1350 → 863 行（**−509 / +11**）。

allowlist 收紧（只降不升）：
- `use-node-upgrade.ts` 的 `fileLines` 1362 → **864**（当前实测值）；
- `use-node-upgrade.ts:useNodeUpgrade`（`lines: 453`）**整条删除**——该函数已不在此文件，
  新的 `useNodeUpgrade` 只有 45 行，无需豁免。
新增的 4 个文件全部在默认阈值内（最大函数 87 行 < 120，最大文件 317 行 < 600），未新增任何 allowlist 条目。

`apps/fe` `bun test src/` 2406 pass 0 fail。

## 7. D7 `device-delete-dialog`

`packages/panels/src/device-management/device-delete-dialog.tsx` 由手拼 `AlertDialog` 骨架
改为 `@tmex/ui/confirm-dialog`（对齐 T9 的 `refresh-confirm-dialog` 写法）。
该文件原本**没有任何 `data-testid`**，转换后也不新增（`ConfirmDialog` 的 testId 属性全部不传），
DOM 结构与原来逐字一致（`AlertDialogMedia` 的 `bg-destructive/10`、破坏性确认按钮样式都由
`ConfirmDialog` 的默认值给出）。删除 mutation 与 `err instanceof Error ? err.message : t('common.error')`
这一段 i18n 兜底保持原样。**−38 / +17**。

## 8. lint

`bun run lint` 的 biome 部分**零 finding**（2713 个文件）。过程中修掉两处自己造成的格式问题
（`update-loop.ts` 的 import 折行、`sleep.test.ts` 的箭头函数折行）。

复杂度门禁：我改动的文件中，四个已在 allowlist 顶格的大文件因新增一行 import 而 +1 行超限。
按「只收紧不放宽」处理，**没有改这四条 allowlist**，而是消掉那一行：

- `local-external-connection.ts`、`system/upgrade.ts`：把 `errorMessage` 并进同文件已有的
  `@tmex/shared` import（合并后不超 100 列）；
- `hub-peer-poller.ts`、`external-detect.ts`：`@tmex/shared` 的两条 import 无法在 100 列内合并，
  改为把「只服务于紧邻一条日志的临时变量」内联掉
  （`const msg = errorMessage(err); console.warn(\`...${msg}\`)` → 一行），各省一行。

门禁剩余 4 条 violation + 3 条 stale allowlist 条目**全部来自并行中的 codex/其他任务**，
不在我的改动面里（`git diff` 对这些文件为空或仅有我的 errorMessage 单行替换，
而报的是函数行数 / CC，与 import 无关）：

```
apps/fe/src/components/side-panels/account-security/totp-section.tsx:21   TotpSection 191 行 > 120
apps/fe/src/components/side-panels/account-security/passkey-section.tsx:18 PasskeySection 166 行 > 120
apps/fe/src/pages/settings/nodes/management/hub-role-switch-run.ts:136    awaitHubRoleSwitch CC 16 > 15
packages/panels/src/agent/chat-thread.tsx:182                            ChatThread 155 行 > 134
stale: apps/fe/src/components/side-panels/account-security-panel.tsx:PasskeySection
stale: apps/fe/src/components/side-panels/account-security-panel.tsx:TotpSection
stale: apps/fe/src/pages/settings/nodes/management/use-hub-role-switch.ts:awaitHubRoleSwitch
```

三条 stale 条目的路径（`account-security-panel.tsx` / `use-hub-role-switch.ts`）说明是别的任务
把这些函数搬了家、还没同步 allowlist；对应的两条 violation 就是搬家后的新位置。请由那个任务收尾。

## 验收结果

| 项 | 结果 |
| --- | --- |
| `packages/shared` `bun test` | 720 pass / 0 fail（补了 `index.test.ts` 的运行时导出快照：新增 `errorMessage` / `sleep` / `sleepOrAbort`） |
| `packages/ui` | 414 pass / 0 fail |
| `packages/api-client` | 226 pass / 0 fail |
| `packages/stores` | 431 pass / 0 fail |
| `packages/panels` | 949 pass / 0 fail |
| `packages/app` | 897 pass / 1 skip / 0 fail（首轮曾有 1 个 `direct enable ... operation timed out` 的原生插件超时用例偶发失败，复跑即绿） |
| `apps/fe` `bun test src/` | 2406 pass / 0 fail |
| `apps/gateway` `bun test` | 4501 pass / 1 fail：唯一失败是 `src/mesh/integration/multi-hub.integration.test.ts > G6: A down long enough → B auto-promotes → A returns fenced`（20 s 超时）。属于 codex 在飞的 `src/mesh` 范围（同批次刚落 `ab3a0670 perf(mesh): rtc 信令…`），单独跑该文件 21 pass / 0 fail，是整包并发下的时序抖动 |
| `bunx tsc --noEmit` | shared / ui / api-client / stores / panels / app / fe / gateway 全部零错误 |
| `bun run lint` biome | 零 finding |

## 附：仍留在禁区里的 D3 内联（交给 codex 或后续轮次）

```
apps/gateway/src/mesh/relay-uplink-ctl.ts:256      apps/gateway/src/mesh/uplink-pool.ts:1596
apps/gateway/src/mesh/uplink-reconnect.ts:14       apps/gateway/src/mesh/uplink-key-log-sync.ts:667
apps/gateway/src/mesh/peer-server.ts:128           apps/gateway/src/mesh/relay-uplink-client.ts:559
apps/gateway/src/mesh/relay-key-log-sync.ts:412    apps/gateway/src/mesh/peer-ws-race.ts:111
apps/gateway/src/mesh/forwarder.ts:287,300         apps/gateway/src/mesh/uplink-pool-switch.ts:168
apps/gateway/src/mesh/peer-manager.ts:700,875,914  apps/gateway/src/mesh/rtc/rtc-peer-helpers.ts:182
apps/gateway/src/hub/uplink-server.ts:680          packages/shared/src/link/mux.ts:131（变体：带默认值）
packages/ws-client/src/direct/direct-carrier-controller.ts:431
```

另：`packages/app/src/commands/enroll.ts` 的本地 `sleep` 按要求保留未动。

## 附：期间的仓库状态变化

执行过程中另一位 agent（codex）向 `main` 之外的本分支提交了 `ab3a0670`（mesh rtc 信令 / 拨号 / 中继限速），
连带把我当时已落盘的部分 gateway 文件（`hub/hub-peer-poller.ts`、`hub/uplink-server-timers.ts`、
`system/upgrade.ts`、`tunnel/*` 等的 `errorMessage` 替换）一并纳入了那次提交。
我本人未执行任何改变 git 状态的命令；其余改动仍留在工作区未提交，交由 commander 收口。
