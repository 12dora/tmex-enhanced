# Backend 代码异味清单

范围：`apps/gateway/src`。行数按包含首尾行计算，已排除生成文件。

## 文件规模基线

| 文件 | 总行数 | 主要热点 |
|---|---:|---|
| [apps/gateway/src/ws/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:1) | 2,155 | `WebSocketServer`：103–2155，2,053 行；`handleBorshMessage`：429–663，235 行 |
| [apps/gateway/src/tmux-client/ssh-external-connection.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-external-connection.ts:1) | 2,020 | `SshExternalTmuxConnection`：97–2019，1,923 行 |
| [apps/gateway/src/tmux-client/local-external-connection.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.ts:1) | 1,915 | `LocalExternalTmuxConnection`：203–1914，1,712 行 |
| [apps/gateway/src/db/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/db/index.ts:1) | 1,250 | 多领域数据库门面 |
| [apps/gateway/src/ws/canonical-feed-session.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/canonical-feed-session.ts:152) | 1,201 | `CanonicalFeedSession`：152–1200，1,049 行 |
| [apps/gateway/src/api/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/index.ts:1) | 1,041 | `handleApiRequest`：199–423，225 行 |
| [apps/gateway/src/tmux-client/pane-retention.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/pane-retention.ts:1) | 1,030 | `PaneRetention`：259–1030，772 行 |
| [apps/gateway/src/agent/run.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.ts:254) | 1,013 | `AgentRun`：254–1013，760 行；`runOnce`：435–639，205 行 |
| [apps/gateway/src/watch/service.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/service.ts:1) | 908 | `WatchService`：197–906，710 行 |

## Top 8

### 1. SSH 与本地 External tmux 连接实现高度重复

- 文件与符号：
  - [ssh-external-connection.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/ssh-external-connection.ts:97)，`SshExternalTmuxConnection`，97–2019，1,923 行。
  - [local-external-connection.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/local-external-connection.ts:203)，`LocalExternalTmuxConnection`，203–1914，1,712 行。

- 重复量化：

  - 两个物理文件分别为 2,020 行和 1,915 行。
  - 去除空行、纯注释后，SSH 文件 1,805 行，本地文件 1,693 行；按有序精确匹配块计算，共匹配 1,216 行，占较小文件的 71.8%。
  - 仅归一化类名、依赖类型名及 `[ssh]`/`[local]` 日志前缀后，匹配 1,229/1,693 行，即 72.6%。
  - 最大连续完全匹配块为 262 行：SSH 298–559 与本地 365–626。
  - 进一步归一化 transport、控制进程和远端 home 等名称后，有 51 个方法体相同，双方各约 664 行。

- 异味原因：两套实现共同维护 tmux session/window/pane 操作、快照解析、历史请求、主题订阅、布局处理、错误识别和恢复逻辑。任何协议行为修复都必须同步修改两处，长期容易产生 SSH 与本地行为漂移。

- 安全重构：提取 `external-tmux-core.ts`，承载 `ensureSession`、窗口/pane 操作、快照解析、历史处理、主题订阅及 tmux 错误语义；通过注入 `runTmux`、`runTmuxAllowFailure`、`runIsolated`、控制客户端适配器、默认工作目录和日志钩子复用核心逻辑。SSH 仅保留 ssh2/channel/远端 home 处理，本地仅保留 Bun process/argv/env/进程重启逻辑，避免直接强行合并两个 transport。

### 2. `WebSocketServer` 是多职责 God Module

- 文件与符号：[ws/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:103)，`WebSocketServer`，103–2155，2,053 行；文件总计 2,155 行。
- 主要职责同时包括 WebSocket 生命周期、Borsh 协议分发、设备连接注册、连接创建竞态、旧版 feed、canonical feed、终端输出、历史与剪贴板、主题/设置广播、overlay、指标和关闭重连。
- 长函数热点：`handleBorshMessage`，429–663，235 行。函数中包含 HELLO/PING 前置处理及大量按 kind 分支，每个分支重复 payload 解码、调用业务方法和返回。

- 异味原因：协议层、连接生命周期和业务事件广播共享同一个类状态，导致任意小改动都需要理解大量无关状态；Borsh kind 增长时复杂度线性累积。

- 安全重构：保留 `WebSocketServer` 作为门面，拆出 `BorshDispatcher`、`DeviceConnectionRegistry`、`LegacyFeedBroadcaster`、`CanonicalSessionRegistry`、`ThemeSettingsBroadcaster` 和 `WebSocketLifecycle`。将 `handleBorshMessage` 改为保留现有前置检查和错误语义的 handler descriptor/map，每个 handler 继续使用现有 schema 和业务方法，确保路由顺序、响应编码和关闭行为不变。

### 3. Pane 流解析器是超长、深状态机闭包

- 文件与符号：[pane-stream-parser.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/pane-stream-parser.ts:61)，`createPaneStreamParser`，61–557，497 行。
- 内部热点：
  - `push`：233–555，323 行。
  - `processByte`：272–548，277 行。
  - `emitOsc`：102–230，129 行。

- 异味原因：一个闭包同时维护普通字符、ESC、CSI、OSC、DCS、tmux passthrough、屏幕标题、Kitty 状态、剪贴板、通知和溢出控制。`processByte` 通过多层 if/状态分支处理大量协议状态，跨 chunk 状态很难局部验证。

- 安全重构：保留对外的 `PaneStreamParser.push`，抽出 `osc-handlers.ts`、`csi-handler.ts`、`tmux-passthrough-handler.ts` 和终端状态转换模块。主解析器只负责跨 chunk 缓冲、状态保存、溢出限制和回调顺序；拆分过程中必须保留字节级输出、分片输入、异常序列和 callback 顺序，并补充跨 chunk 测试。

### 4. `CanonicalFeedSession` 混合协议、订阅、流数据和事务发送

- 文件与符号：[canonical-feed-session.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/canonical-feed-session.ts:152)，`CanonicalFeedSession`，152–1200，1,049 行。
- 长函数热点：`handleSetPaneSubscriptions`，396–515，120 行；内部包含订阅收集、pane 校验、容量检查、generation 更新、replay 和响应发送。
- 其他职责包括设备 attach、metadata patch/rebase、pane 数据批处理、gap 处理、screen/history transaction、frame size 判断、编码和发送。

- 异味原因：订阅状态、实时流一致性、事务编码和设备生命周期互相耦合，修改订阅或 frame 限制时容易影响数据顺序和 replay 行为。

- 安全重构：拆出 `CanonicalSubscriptionCoordinator`、`CanonicalPaneStream`、`CanonicalTransactionSender` 和 `CanonicalFrameSizer`。`CanonicalFeedSession` 只保留命令路由、设备 attach/detach 和组件协调；保持现有 generation、gap、事件排序、`send` 背压及错误响应语义。

### 5. `AgentRun.runOnce` 集中了承载运行时、流式响应和结果判定

- 文件与符号：[run.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/run.ts:254)，`AgentRun`，254–1013，760 行。
- 长函数：
  - `runOnce`：435–639，205 行。
  - `execute`：318–433，116 行，接近阈值。
- `runOnce` 同时负责 prompt/tools/model 构造、`streamText`、step 持久化、steer、idle watchdog、流 part 分发、delta 刷新和最终状态优先级判定。

- 异味原因：资源释放、AI SDK 事件处理、工具审批、持久化和停止原因判定共享一个控制流。状态优先级一旦调整，可能改变 abort、approval、steer、stalled、error 等结果之间的覆盖关系。

- 安全重构：提取 `AgentRunResourceScope`、`AgentStreamAccumulator`、`AgentStreamPartRouter` 和 `AgentOutcomeResolver`。保留 `AgentRun.execute` 作为生命周期编排层，明确保存当前的重试规则、结果优先级、delta flush 时机以及 runtime/emulator 的 finally 释放顺序。

### 6. `PaneRetention` 将缓存策略、订阅和定时回收全部集中

- 文件与符号：[pane-retention.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/pane-retention.ts:259)，`PaneRetention`，259–1030，772 行；文件总计 1,030 行。
- 长函数热点：`applySubscriptions`，612–719，108 行；内部同时执行 active/hot 校验、容量判断、状态更新和 replay。
- 其他逻辑包括 pane epoch 对账、历史读取、checkpoint、消费者 lease、hot/grace/cold 状态、LRU、边界淘汰、timer 和统计。

- 异味原因：数据生命周期策略与订阅 generation、回放和资源回收强耦合，难以单独测试淘汰顺序、订阅变更和 timer 交互。

- 安全重构：拆出 `PaneReplayStore`、`PaneSubscriptionCoordinator` 和 `RetentionPolicyScheduler`，由 `PaneRetention` 保持现有公开 API。迁移时必须锁定现有 generation/fingerprint 判断、replay 顺序、LRU 顺序、淘汰边界和 timer 清理行为。

### 7. `handleApiRequest` 是顺序堆叠的超长路由分发器

- 文件与符号：[api/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/index.ts:199)，`handleApiRequest`，199–423，225 行。
- 相关热点：`normalizeSiteSettingsInput`，90–192，103 行。
- 路由覆盖 capabilities、devices、tree/tmux、settings、Telegram、Weixin、LLM、agent、watch、files、system、webhooks、manifest 和 health。

- 异味原因：大量 method/path 判断、路径拆分、参数解析和业务处理混在一个函数中。路由顺序本身影响行为，例如固定路径 `/api/devices/order` 必须先于 `/:id`，后续维护容易误改优先级。

- 安全重构：引入保留顺序的 typed route table 和 `matchRoute`，再按领域拆成 `device-routes`、`settings-routes`、`messaging-routes`、`agent-routes`、`system-routes`。先只搬运现有 handler，不改变同步/异步返回类型、状态码、路径 decode 和路由优先级。

### 8. `db/index.ts` 是跨领域数据库 God Module

- 文件与符号：[db/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/db/index.ts:1)，模块整体，1–1250，1,250 行。
- 同时包含数据库初始化、row mapper、gateway KV、设备与 runtime、tree order、站点设置与缓存、terminal shortcuts、webhooks、Telegram 和 Weixin。
- 重复聚合热点：
  - `getTelegramBotsWithStats`：722–756，35 行。
  - `getWeixinAccountsWithStats`：981–1035，55 行。

- 异味原因：数据库 schema 访问、缓存失效、不同业务领域的查询和统计聚合共享同一入口，导致依赖关系不清晰；Telegram/Weixin 统计流程也存在结构性重复。

- 安全重构：拆成 `db/device.ts`、`db/site-settings.ts`、`db/webhooks.ts`、`db/telegram.ts` 和 `db/weixin.ts`，由 `db/index.ts` 继续导出兼容接口。共享 row mapper 和通用统计辅助函数，但保留现有同步 Drizzle 调用、事务边界、缓存更新和返回对象结构。

## 八名之外的明显热点

| 文件与符号 | 范围及行数 | 异味与安全重构方向 |
|---|---:|---|
| [agent/tools/terminal.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/tools/terminal.ts:244)，`createTerminalTools` | 244–591，348 行 | 同时创建四个工具、审批、emulator fallback、输入编码和错误处理；拆为四个 tool builder，共享只读 `TerminalToolContext`。 |
| [tmux-client/control-mode-parser.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/control-mode-parser.ts:121)，`createControlModeParser` | 121–337，217 行 | 控制模式 framing、事件解析和状态更新混在一个状态机；拆出 framing、notification 和 pane/window 状态处理器。 |
| [tmux-client/control-mode-subscription.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/control-mode-subscription.ts:58)，`createControlModeSubscription` | 58–228，171 行 | 同时负责控制模式解析、每 pane parser、metadata、结构 timer 和指标；拆为订阅生命周期、pane parser registry 和 metadata bridge。 |
| [watch/service.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/watch/service.ts:197)，`WatchService` | 197–906，710 行 | 规则调度、设备 runtime 引用、regex/LLM 评估、通知和 sample ring 集中；拆为 scheduler、runtime pool、evaluation pipeline、notifier 和 sample store。 |

## 确认的 BUG

### BUG-1：关闭期间的连接创建竞态

位置：[ws/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:419) 419–426、784–800；关闭路径由 [runtime.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/runtime.ts:171) 调用。`closeAll()` 会清空 `pendingConnectionEntries`，但不会使正在等待的 `createDeviceConnectionEntry()` 失效；如果关闭时该 Promise 尚未完成，完成后的 `.then()` 仍会把新 entry 写回 `connections`，而 `closeAll()` 已经遍历结束，不会再次释放它，导致关闭后的 runtime 被重新挂回并可能泄漏。应加入关闭 generation/closed 标记，在 Promise 完成时丢弃并释放过期 entry。

### BUG-2：畸形 Borsh payload 会产生未处理的 Promise rejection

位置：[ws/index.ts](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:265) 265–317、[handleBorshMessage](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:429) 429–663。`handleMessage()` 对 `handleBorshMessage()` 使用 `void` 调用，而 `handleBorshMessage()` 中多数 kind 分支直接调用 `decodePayload()`，没有统一的 try/catch；因此 magic 和 envelope 均合法、但 payload schema 不合法的请求会让 Promise reject，既不发送协议错误，也不关闭连接。`handleHello()` 对同一个 decoder 单独捕获异常，进一步证明 decoder 异常是预期输入错误；应在统一 dispatch 边界捕获并转换为现有的 `sendError`，同时避免重复处理 canonical 分支已有的错误转换。