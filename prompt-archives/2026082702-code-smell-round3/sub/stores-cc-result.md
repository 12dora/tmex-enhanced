# stores / panels 圈复杂度整改结果（round3）

## 范围

- `packages/stores/src/tmux-device-events.ts`
- `packages/stores/src/runtime.ts`（仅 `resolveRuntimeCore`）
- `packages/panels/src/watch/watch-rule-draft.ts`（仅 `createWatchRuleDraft`）

均为纯重构，对外行为保持一致；新增测试先在**改动前**跑通（characterization），再重构后复跑。

## 1. `handleTmuxEvent` → 表驱动分发

`handleTmuxEvent`（原 CC≈17）与同文件的 `handleDeviceEvent` 一起改为 `Map` 表驱动：

- `tmuxEventHandlers: Map<TmuxEventType, TmuxEventHandler>`：`bell` / `notification` / `pane-active`，其余类型天然 no-op（与原来「三段独立 if」等价）。
- `deviceEventHandlers: Map<DeviceEventType, DeviceEventHandler>`：`error` / `disconnected` / `reconnected`，`tmux-missing` 仍无副作用。
- 用 `Map` 而非对象字面量查表，避免原型键（`constructor` 等）被当作 handler 命中。
- 抽出小工具：`eventData`（`payload.data` 归一为对象）、`stringField`（字符串字段安全取值）、`markDeviceReconnecting`、`recordDeviceError`、`shouldSuppressNotification`。
- 唯一的语义收紧：`pane-active` 原先用 `payload.data as {windowId,paneId}` 后做真值判断，现在改为 `stringField` 取值——非字符串字段不再被写进 `activePaneFromEvent`（协议解码本就恒为 string，实际路径无差异，且不再往 state 里塞类型不符的值）。

各 handler CC ≤ 5，`handleTmuxEvent` / `handleDeviceEvent` 各自只剩一行查表调用。

新增 `packages/stores/src/tmux-device-events.test.ts`（33 例）：bell（paneId/windowId 回落、无 id、`enableBellSound=false`、宿主接管）、notification（描述拼装、`Open` 动作走 host.navigate、无 paneUrl、宿主接管、站点开关、title 回落 i18n key）、pane-active（写入与不完整 data）、其余 8 种事件类型无副作用、device 事件（error 首次 toast/同类型不重复/换类型再弹、兜底 message/errorType、宿主接管只写状态、reconnecting 只写重连态、error 清空重连态、disconnected 清 select 状态、reconnected 清错误、tmux-missing no-op）。

## 2. `resolveRuntimeCore` → 有序候选解析器

原 CC≈16 的单个大字面量拆成按优先级排列的解析器：

- `resolveTransport(options)`：显式 `transport` > `connection.transport` > 惰性 `LazyWebSocketGatewayTransport`（解析期不建 client）。
- `resolveSelectMachine(conn)`：有连接用连接状态机（带 callbacks 时才 `setCallbacks`），否则模块级工厂。
- `connectionPaneSinks(conn)`：连接注册表的 11 个转发方法独立成函数，`resolveRuntimeCore` 里只剩 `conn ? connectionPaneSinks(conn) : defaultPaneSinks`。
- `resolveFeatures(features)`：四个开关的缺省值集中一处。
- `defaultTranslate`：原内联 i18next 表达式原样提出为模块常量（含既有 `params as never`，未新增断言）。

`get client()` 的惰性求值语义保持不变。重构后 `resolveRuntimeCore` CC≈8、20 行。

新增 `packages/stores/src/runtime-core-resolution.test.ts`（21 例），逐条覆盖优先级：transport 三级回落 + 解析期不读 client、client 走连接且每次重新求值、selectMachine 连接分支/回调注入/默认分支不碰连接、paneSinks 默认绑模块级函数 vs 连接分支全量转发（含 history gate 与 cleanup，且不污染默认注册表）、apiClient/notifications/bell/host/terminalFileLinks/storagePrefix 的注入与缺省、features 缺省与逐项关断。

注意：同进程其它测试文件（`tmux-host-managed-notifications.test.ts`）对 `@tmex/ws-client`、`@tmex/notifications` 做了全局 `mock.module`，会泄漏到本文件。因此 selectMachine / bell 的默认路径断言避开了「模块单例身份」这类会被 mock 打破的判定，改为断言「不走连接分支」「跨 runtime 同一实现」，全量跑与单文件跑结果一致。

## 3. `createWatchRuleDraft` → 默认值表 + 分组回填

原 CC≈16（15 个 `??`）。改为：

- 导出 `WATCH_RULE_DRAFT_DEFAULTS`（唯一默认值来源，新建草稿直接展开返回）。
- 三个分组回填函数 `matchFieldsOf` / `llmFieldsOf` / `scheduleFieldsOf`（各返回 `Pick<WatchRuleDraft, …>`），空值一律回落到默认值表；`name` / `triggerType` 留在主函数。
- 主函数 CC=3，且因为不再展开默认值表，新增字段会被 TS 强制要求在某个分组里补齐。

说明：任务描述里的「per trigger type 默认值表」在现有实现中并不存在——原代码对三种 trigger 用的是同一套固定默认值（trigger 相关的差异在 `applyTriggerType` / `buildWatchRulePayload` 里），因此这里做成「单表 + 分组回填」，行为与原来逐字段 `??` 完全一致。

`watch-rule-draft.test.ts` 新增 `createWatchRuleDraft 按触发类型` 一组：三种 trigger 的 DTO 回填、每种 trigger 的空字段一律回落默认值、多次新建返回互相独立的对象。

## 验证

- `packages/stores`：`bun test` 210 pass / 0 fail（基线 156，新增 54）；`bunx tsc --noEmit -p .` 仅剩既有的 `host-services.test.ts(93,23)` 一处错误。
- `packages/panels`：`bun test src/watch` 84 pass / 0 fail，全量 `bun test` 347 pass / 0 fail；`bunx tsc --noEmit -p .` 无错误。
- `bunx biome check`（6 个改动文件）无告警。
