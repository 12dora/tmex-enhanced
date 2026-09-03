# L1d 结果：terminal-ui 下线 legacy history 还原 + FE e2e helper/spec 改写为 canonical-only

范围：`packages/terminal-ui/src/**`、`apps/fe/tests/**`、`apps/fe/src/node/node-runtimes*`、
`packages/panels/src/device-console/keep-alive-subscription.test.ts`、
`packages/stores/src/tmux-event-router*`（`server-too-old` 提示，见第五节）、
`packages/shared/src/i18n/locales/*.json`（3 条定点插入）、4 篇文档。

## 一、改动文件（24 个工作区文件 + 已被 F1 提交带走的 i18n）

### packages/terminal-ui（6）

| 文件 | 改动 |
|---|---|
| `src/components/terminal-snapshot.ts` | 删 `TerminalGeometry` / `HistoryRestoreTerminal` / `HistoryRestoreTarget` / `HistoryRestorePayload` / `resolveHistoryRestoreGeometry` / `writeRestoredHistory`（原 136-192）；`terminalModesFromHistory` 的注释改成「canonical Screen 下发的 tmux 权威位图」。198 → 136 行 |
| `src/components/normalization.ts` | 删 `ALT_SCREEN_HISTORY_PREAMBLE` + `wrapAlternateScreenHistory`（唯一调用方是 `writeRestoredHistory`；经 `src/index.ts` 的 `export *` 对外，全仓无其它引用） |
| `src/components/hooks/usePaneSinkRegistration.ts` | 删 `remotePaneGeometry()`、`onReset`、`onApplyHistory` 与 `runPostSelectResize` 入参；`useMemo` 依赖收敛为 `[deviceId, instance, paneId, surfaceRef]`（不再依赖 `runtime`，sink 不会因 runtime 引用变化重建） |
| `src/components/Terminal.tsx` | `usePaneSinkRegistration({...})` 去掉 `runPostSelectResize`（该函数仍被 boot surface / handle / panels 使用，未删） |
| `src/components/SplitTerminalArea.tsx` | 注释 `KIND_TERM_RESIZE` → `canonical ResizePaneV11` |
| `src/components/terminal-snapshot.test.ts` | 删 `RecordingHistoryTarget` / `createHistoryTarget` 与 `resolveHistoryRestoreGeometry`（2 例）、`writeRestoredHistory`（4 例）两组 describe |

### packages/panels（1）

`src/device-console/keep-alive-subscription.test.ts`：`paneSink()` 的 `onReset` / `onApplyHistory` 换成
canonical `onScreenSnapshot` 计数；`sinkReceives()` 由 `dispatchPaneReset(...)` 改为
`dispatchPaneScreenSnapshot({ deviceId, paneId, paneEpoch, baseSeq: 0n, rows, cols, modes, data, historyCursor })`
——语义不变（置冷的 pane 仍能收到投递 ⇒ 注册表没把它当「无 sink」缓冲）。一处提到 `wantHistory:true` 的注释改写。
**panels 源码一行未动。**

### apps/fe/src（2）

- `src/node/node-runtimes.ts`：删 `CANONICAL_STATE_KILL_SWITCH_KEY` / `canonicalStateEnabled()` 与
  `clientOptions: { canonicalStateEnabled: ... }`（`BorshClientOptions` 已无该项，kill switch 也已无意义）；
  `resumeSubscribedPanes()` 删掉 `stateFeedMode !== 'canonical'` 时对挂载 pane 重取整屏的分支
  （legacy feed 不存在了，`'unsupported'` 下 `request-pane-screen` 只会抛编码错误），文档注释同步改写。
- `src/node/node-runtimes.test.ts`：`fakeConnection()` 去掉 `stateFeedMode` 入参（固定 `'canonical'`）与
  `selectMachine` 字段；删「canonical state kill switch」用例与重复的「canonical 回落」用例；
  「重发订阅 + 对挂载中的 pane 重取整屏」改为「重发订阅 + 不主动重取整屏」。

### apps/fe/tests（9）

见第三节。

### packages/stores（2）+ i18n（3 locale）

见第五节。

### docs（4）

见第四节。

## 二、e2e helper（`apps/fe/tests/helpers/ws-borsh.ts`，422 → 453 行）

删除：

- `KIND` 表里的 `STATE_SNAPSHOT` / `TERM_OUTPUT` / `TERM_HISTORY` / `SWITCH_ACK` / `LIVE_RESUME` /
  `TERM_RESIZE` / `TERM_SYNC_SIZE` / `TERM_INPUT` / `TERM_PASTE`；
- `decodeTermInput` / `decodeSwitchAck` / `decodeLiveResume` / `decodeTermHistory` 四个 payload 解码器；
- `PaneFeedCollector` 的 `barrierKindsByToken` / `historyTextByToken` 与对应的 inbound 分支。

新增：

- `KIND.CANONICAL_COMMAND = 0x0901` / `KIND.CANONICAL_EVENT = 0x0902`
  （**已用脚本把整张 `KIND` 表和 `packages/shared/src/ws-borsh/kind.ts` 逐项对拍，全部一致**）。
- `createFrameDecoder()`：抽出原来内联在 `attachPaneFeedCollector` 里的「envelope 解码 + `ChunkReassembler`」，
  两个 collector 共用（canonical 首屏/粘贴会分片，逐帧解码会漏）。
- `PaneFeedCollector` 新增：
  - `screenPhasesByPane: Map<paneId, {phase:'begin'|'commit', requestId}[]>`
  - `subscriptions: {generation: bigint, activePaneIds: string[]}[]`（来自 `SubscriptionApplied`）
  - `screenCommitted(paneId)`；`paneContent()` 现在只拼 canonical screen + PaneData。
- `CanonicalCommandCollector`（`createCanonicalCommandCollector` / `attachCanonicalCommandCollector`）：
  解 C2S 的 `KIND_CANONICAL_COMMAND`，收 `ResizePaneV11`（deviceId/paneId/cols/rows/`geometryReason`/`sizeEpoch: bigint`）
  与 `TerminalInput`（deviceId/paneId/data）；`counts()` 返回 `{ change, resend }`，`reset()` 清空。
- 导出 `CANONICAL_GEOMETRY_REASON_CHANGE = 0` / `CANONICAL_GEOMETRY_REASON_RESEND = 1`。

`decodeTmuxSelect` 保留（含 `wantHistory` 字段，wire 布局未变、值恒 false，已加注释）。
所有 WS 过滤都走 `isGatewayWsUrl()`，无 `endsWith('/ws')`。

## 三、逐个 spec 改写后断言的内容（供指挥官跑 Playwright 时对照）

> 我无法运行 Playwright，以下是每条用例现在断言什么、为什么这么写。

### 1. `ws-borsh-history.spec.ts`（原 2 例 → 现 1 例）

删掉 `canonical: false` 变体与 `tmex.disable-canonical-state` initScript（kill switch 已删，那条用例无法成立）。
保留的 `ws-borsh: canonical screen feed applies pane ready marker on initial load` 断言：

1. 目标 pane 收到过 `TMUX_SELECT`（`selectTokenByPane` 有值）；
2. `paneContent(pane)`（canonical screen + PaneData）包含 `PANE0_READY`；
3. `sawCanonicalEvent === true`，且 screen + output 文本包含 `PANE0_READY`；
4. **（替代原 SWITCH_ACK/LIVE_RESUME 屏障断言）** 该 pane 的首屏事务完成：`screenCommitted(pane)` 为真，
   `screenPhasesByPane` 里 `begin` 下标 < `commit` 下标，且两者 `requestId` 相同；
5. `readVisibleTerminalText(page)` 包含 `PANE0_READY`。

### 2. `ws-borsh-pane-route.spec.ts`（原 2 例 → 现 1 例）

同样删 legacy 变体。`ws-borsh: canonical feed preserves encoded pane id and loads target pane` 断言：

1. URL 停在 `/devices/:id/windows/:w/panes/:encodedPane`（前后各一次）；
2. 目标 pane 收到过 `TMUX_SELECT`；
3. `paneContent(targetPane)` 与 canonical screen+output 文本都包含 `PANE1_READY`；
4. **新增**：`paneContent(otherPane)` 不含 `PANE1_READY`（canonical `PaneTarget.paneId` 是原样 UTF-8，
   不能把首屏/输出串到同 window 的另一个 pane）；
5. 目标 pane 的首屏事务已 commit。

### 3. `ws-borsh-switch-barrier.spec.ts`（2 例，文件名保留）

**用例 1** `ws-borsh: TMUX_SELECT carries cols/rows and the canonical screen transaction completes`：

- tmux 控制面不变：跨 window 点击后，`TMUX_SELECT` 里 `paneId === 目标 pane`、`cols`/`rows` 非 null 且 > 1；
- 数据面替代屏障：目标 pane 的首屏 `begin`/`commit` 成对、`requestId` 一致；
- 最新 `SubscriptionApplied.activePanes` 包含目标 pane。

**用例 2** `ws-borsh: rapid window switches keep subscription generations monotonic and land on the final pane`
（替代原「rapid select cancels previous transaction / no LIVE_RESUME for old token」）：

- 记录点击前的 `subscriptions.length` 作基线，连点 `secondWindow` → `firstWindow`；
- 订阅条数增长，且**最后一条** `SubscriptionApplied.activePanes` 含 `firstPane`（最终落点正确）；
- `subscriptions[i].generation >= subscriptions[i-1].generation`（被取消的那次不会以更旧 generation 后到覆盖）；
- 收到过 `PaneData` 的每个 pane 都出现在某次订阅集合里（没有向未订阅 pane 推字节）。

> 注意：keep-alive 池会让上一个 pane 在宽限期内仍留在 active 集合里，所以断言用的是
> `toContain(firstPane)` 而不是等值比较。

### 4. `ws-borsh-resize.spec.ts`（6 例，标题 2 处改名）

`attachResizeFrameCounter()` 内部换成 `attachCanonicalCommandCollector`，`read()` 仍返回
`{ resize, sync }`，但 `resize = geometryReason 0（change）计数`、`sync = geometryReason 1（resend）计数`。
逐例：

1. `resize does not spam canonical geometry-change commands`（原 `...spam TERM_RESIZE frames`）：
   改视口后 change ≤ 3；**新增** change 的 `sizeEpoch` 严格递增且恒 > 0n。
2. `initial load and browser resize converge to tmux pane size`：未动（只看 term/pane 尺寸一致）。
3. `growing viewport converges to latest tmux pane size`：未动。
4. `remote tmux resize does not trigger resize echo from another browser`：A 页 change+resend ≤ 4，
   B 页 `{resize:0, sync:0}`（语义不变，只换了计数来源）。
5. `focus restore emits no geometry command when terminal size is already current`
   （原 `...does not emit TERM_SYNC_SIZE...`）：`{resize:0, sync:0}`。
6. `focus restore resyncs one stale terminal without reintroducing resize loop`：
   resend ≥ 1、change == 0、resend ≤ 2；**新增** 每条 resend 的 `sizeEpoch > 0n`
   （shared 的语义校验拒绝 `sizeEpoch <= 0n`，这条能挡住「补发时没复用 epoch 而写了 0」的回归）。

### 5. `ws-borsh-theme-resize.spec.ts`（1 例，断言未变）

`attachFrameCounter` 的 `resize`/`sync` 换成 canonical 计数，`windowStyle` 改用 `KIND.TMUX_SET_WINDOW_STYLE`
（原来写的是裸字面量 `0x020a`）。该用例只断言 `windowStyle >= 1` 与尺寸收敛，resize/sync 计数本来就没被断言。

### 6. `mobile-keyboard-avoidance.spec.ts`（4 例，断言未变）

`resizeFrames` 从「TERM_RESIZE + TERM_SYNC_SIZE 帧计数」换成 `resizeCommands.resizes.length`
（change + resend 都算一次尺寸上报）；`resetResizeFrames()` 调 `collector.reset()`。
断言仍是弹/收键盘时 `resizeFrames() === 0`，以及 resize 模式下 `> 0`。

### 7. `mobile-terminal-interactions.spec.ts`（3 处监听）与 `sidebar-click-no-pty-injection.spec.ts`（1 处）

**这两个文件不是本轮改坏的**——`TERM_INPUT` 早在 canonical 输入上线时就已不再上线
（`50e2f718^` 的 `websocket-transport.ts` 只把 `terminal-resize`/`terminal-sync-size` 留在 legacy 白名单，
输入已走 canonical `TerminalInput`）。**这正是记忆里 KI-3「mobile-terminal-interactions ×4 长期失败」的真因**：
监听的 kind 根本不再出现，`sentInputs` 恒为空。既然本轮已经把 canonical 命令解码器建起来了，顺手修掉：

- `sentInputs` 从数组改为函数 `sentInputs()`，映射 `collector.inputs`；
- `isComposing === false` 的断言直接去掉：canonical 链路下组合中的输入在
  `canonical-state-client.ts:285`（`if (command.isComposing) return 'sent'`）就被拦掉，线上看到的每条都是已提交输入，
  该条件恒成立；
- `sidebar-click-no-pty-injection`：`sgrInjections` 改为按 `collector.inputs` 过滤 `\x1b[<`，
  清零用 `commands.reset()`；`TMUX_CREATE_WINDOW` 计数仍走原 `decodeEnvelope` 路径。

断言语义与原来一致：ctrl-c 发 ``、editor send 发 `echo hello\r`、IME `compositionend` 发 `；`、
取消的组合不泄漏 `n`、侧栏点击不注入 SGR 序列。

## 四、文档

| 文件 | 改动 |
|---|---|
| `docs/ws-protocol/2026021403-ws-state-machines.md` | 代码索引删 `state-machine.ts` / `pane-history-gate.ts` / `switch-barrier.ts` 三行，加 canonical 客户端；顶部加「1.1.23 起 legacy 状态流整体下线、不回退」说明；全局不变量 1-4 重写为 canonical（首屏基线、订阅代替换、`(paneEpoch, terminalSeq)` 对账、`geometryReason`）；**第 3 节**「选择事务状态机」重写为「Pane 画面重建」（订阅 → RequestScreen → Begin/Chunk/Commit → PaneData → RequestHistory），**第 4 节**「输出门控状态机」重写为「订阅代与重连补流」（含 `unsupported` 分支）；第 5 节 resize 建议改写为 `ResizePaneV11` 的 `geometryReason` / `sizeEpoch` 语义 |
| `docs/terminal/2026021404-terminal-switch-barrier-design.md` | 整篇改为「已于 1.1.23 下线」：保留背景与问题定义、把屏障方案压缩成历史小节并列出被替换的 4 条局限，新增 canonical 时序图与「旧机制 → canonical 替代」对照表（`SWITCH_ACK`→`SubscriptionApplied`、`TERM_HISTORY`→`Screen*/History*`、`LIVE_RESUME`→`ScreenCommit.baseSeq`、token→requestId/generation、超时降级→`SourceGap`），并写清 `TMUX_SELECT` 系为何保留；验收用例改指向改写后的 3 个 spec |
| `docs/terminal/2026090101-viewport-policy.md` | 顶部加 kind 迁移说明（change/resend + `sizeEpoch` 语义与网关丢弃规则）；正文 3 处 `TERM_RESIZE`/`TERM_SYNC_SIZE`/`wantHistory` 表述改写 |
| `docs/hub/2026082800-hub-node-operations.md`（原 232 行） | legacy 回放（`TMUX_SUBSCRIBE_PANES` + `TMUX_FETCH_PANE_HISTORY` → `TERM_HISTORY` → `TERM_OUTPUT`）标记为 1.1.23 删除，明确「对端 < 1.1.22 不再降级回放，直接判定该 peer 不可用」，canonical 游标续传补上 `SourceGap` 兜底 |

## 五、`server-too-old` 的用户可见提示（**动了 scope 外的 stores，请复核**）

指挥官要求「找 apps/fe 里向用户暴露 ws-client 连接错误的地方」。实测 **apps/fe 里没有这样的落点**：
transport 事件全部由 `packages/stores/src/tmux-event-router.ts` 消费，`ctx.core.notifications` / `ctx.core.t`
只在那里可用；`stateFeedMode` 全仓无 UI 消费者（`connection-indicator.tsx` 只看 `connectionState`）。
因此按 L1c 结果第八节第 2 条的建议，改在 stores 的 handler 里补一次 toast（与同文件 `websocket.inputDropped` 完全同构）：

```ts
'server-too-old': (event, ctx) => {
  console.error(...);                                   // 诊断日志保留
  ctx.core.notifications.error(
    ctx.core.t('websocket.serverTooOld', { minVersion: event.minVersion })
  );
},
```

`packages/stores/src/tmux-event-router.test.ts` 的用例改名为「server-too-old 弹一次错误提示，不改状态」，
断言 `notify:error` 恰好是 `['websocket.serverTooOld']`。

i18n（`websocket` 命名空间内，紧跟 `inputDropped` 的**单行定点插入**，未重排未格式化）：

| locale | 文案 |
|---|---|
| zh_CN | `终端连接失败：Gateway 版本过低，请升级到 {{minVersion}} 或更新版本。` |
| en_US | `Terminal connection failed: the Gateway is too old, please upgrade it to {{minVersion}} or newer.` |
| ja_JP | `端末接続に失敗しました：Gateway のバージョンが古いため、{{minVersion}} 以降へ更新してください。` |

按文案规范：错误句式 `<失败的事>：<原因/下一步>`、无第二人称、`Gateway` 沿用既有 `websocket.checkGateway` 的用词、
数字两侧半角空格。已在仓库根跑 `bun run build:i18n`；`websocket` 落在 core 分包（首绘即可用）。

> **注意**：这三个 locale 源文件与生成物**已被 F1 的提交 `5bbf7b57` 一并带走**（他们也跑了 build:i18n）。
> 我复核过：三语 key 都在，`build:i18n` 重跑后 `git status` 为空（与生成物同步），
> 且 0d7252ff / b977cee3 两次人工润色未与我的 key 冲突。

## 六、验证

| 项 | 结果 |
|---|---|
| `packages/terminal-ui` `bun test` | **394 pass / 0 fail**（32 文件；基线 400，−6 = 删掉的 `resolveHistoryRestoreGeometry` 2 例 + `writeRestoredHistory` 4 例） |
| `packages/panels` `bun test` | **911 pass / 0 fail**（= 基线） |
| `packages/stores` `bun test` | **411 pass / 0 fail**（= L1c 后基线） |
| `apps/fe` `bun test src/` | **1864 pass / 0 fail**（103 文件；round 基线 1783，其余为并发 agent 新增；本任务净 −2：删掉 kill switch 用例与重复的 canonical resume 用例） |
| `packages/shared` `bun test` | **632 pass / 0 fail**（i18n 改动无回归） |
| `bunx tsc -p packages/terminal-ui` / `-p packages/panels` / `-p packages/shared` | **0 error** |
| `bunx tsc -p packages/stores` | 1 error，**非本任务**：`host-services.test.ts(93,23)`，L1c 结果第六节已记为基线 |
| `bunx tsc -p apps/fe` | 2 error，**非本任务**：`membership/leave-dialog.tsx(43,7)`、`membership/role-transition.ts(13,14)`，都是提交 `8335affb`（`LocalRole`/`MeshRole` 扩到 `relay`、`relay,node`）留下的 `Record<Role, string>` 缺项，属 F1/B4 |
| e2e 目录类型检查 | `apps/fe/tsconfig.json` 只 include `src`，测试目录不被 tsc 覆盖。我在 scratchpad 临时建了同 paths 的 tsconfig 单独跑：改动后只剩 3 类**改动前就存在**的报错（`helpers/mesh-boot.ts(416)` ReadableStream asyncIterator、`mobile-terminal-interactions.spec.ts` 第 8/15 行 `Parameters<typeof test>[0]['page']` 的推导artifact），我改的部分 0 error |
| `bunx biome check`（本任务全部改动文件，109 files） | 干净，**未对 `apps/fe/tests` 跑过 `--write`** |
| 仓库根 `bun run lint` | biome 19 个错误、复杂度门禁 11 条违规，**全部在 `apps/gateway/src/{mesh,ws,auth,db}`**（B2/B3/L1b 的文件），本任务文件零违规；门禁报告 `0 stale allowlist entries`（L1c 删掉的 `state-machine.ts` 条目一致） |
| 全仓悬挂引用扫描 | `wrapAlternateScreenHistory` / `writeRestoredHistory` / `resolveHistoryRestoreGeometry` / `HistoryRestore*` / `canonicalStateEnabled` / `CANONICAL_STATE_KILL_SWITCH_KEY` / `decodeTermInput` / `decodeSwitchAck` / `decodeLiveResume` / `decodeTermHistory` / `dispatchPaneReset` / `onApplyHistory` / `disable-canonical-state` 全仓 0 引用（除下面第七节的两处注释） |
| 最大文件行数 | `apps/fe/tests/helpers/ws-borsh.ts` 453 行、`terminal-snapshot.ts` 136 行，均 < 600；未加 allowlist |

## 七、需要指挥官处理

1. **`packages/stores/src/tmux-event-router.ts` 与其测试不在我的书面 scope 里**（第五节说明了原因：
   apps/fe 没有 transport 事件的落点）。若指挥官坚持只改 apps/fe，替代方案是在
   `packages/panels/src/connection-indicator.tsx` 按 `stateFeedMode === 'unsupported'` 加一条常驻横幅
   （store 里已有该字段），但那是新 UI、需要新的 panels 测试，成本更高。
2. **两处 scope 外的过期注释，我按规矩没动**：
   - `packages/ghostty-terminal/src/terminal.ts:400`：`forceFullRepaint()` 的注释写「用于 history 注入
     （onApplyHistory）等场景」，该回调已删；改成「canonical 首屏整屏重写（`writeCanonicalSnapshot`）」即可。
   - `packages/panels/src/device-console/use-pane-size-sync.ts:48`：注释「不得发普通 `TERM_RESIZE`」，
     该 kind 已删，应改为「不得发 `geometryReason=change` 的普通尺寸命令」。
3. **e2e 无法由我运行**，第三节逐条写了每个断言检查什么。跑 Playwright 时重点看：
   - `ws-borsh-switch-barrier.spec.ts` 用例 2 的 `SubscriptionApplied` 是否真的每次点击都下发
     （如果客户端在两次快点之间合并了订阅集合，`subscriptions.length` 可能不增长 → 那条 poll 会超时；
     此时把「条数增长」放宽为「最终集合含 `firstPane`」即可，其余断言不受影响）。
   - `ws-borsh-resize.spec.ts` 用例 1 的 `sizeEpoch` 严格递增：账本按**连接**自增（不是按 pane），
     单页单连接下成立；若该用例失败请先确认是否有第二条连接（直连/多 node）混进同一 page。
   - `mobile-terminal-interactions.spec.ts` 的 4 例是长期基线失败，本轮定位到真因并改写；
     跑通的话可以从 `e2e-baseline-failures` 基线里划掉。
4. **`ws-borsh-switch-barrier.spec.ts` 的文件名已名不副实**（屏障没了），我保留了文件名以免打乱
   指挥官的定向运行命令。要改名的话建议 `ws-borsh-pane-switch.spec.ts`，无其它引用。
5. 本任务未触碰：`apps/fe/tests/theme-*.spec.ts`、`helpers/site-theme.ts`（L3 已做）、
   `apps/fe/src/pages/settings/nodes/**`、`mesh-relay.ts` 等 F1 文件、`apps/gateway/**`。
