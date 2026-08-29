# 第三阶段 code smell 清理 —— 执行结果

分支 `chore/code-smell-round3`，base `4a14ff26`，39 个 commit，199 个源码文件改动（+20044 / −7867，不含存档文档）。

## 流程

三轮「探索 → 编码 → 审查 → 修复」，同一 worktree 并行、按文件范围隔离，agent 不做 git 操作。

- 探索：codex `gpt-5.6-luna` xhigh 三路并行 → `research-gateway.md` / `research-fe.md` / `research-libs.md`（各含「不值得做」清单）。
- 编码：cursor-agent `cursor-grok-4.6-high` 13 个（gateway / shared / CLI），Claude Opus 5 子代理 13 个（前端与 libs）。
- 审查：codex `gpt-5.6-sol` high 六次并行审查 → `reviews/round1-*.md`、`round2-*.md`、`round3-gateway.md`。
- 每轮结果存档在 `sub/*-result.md`。

## 指标

| 指标 | 基线 `4a14ff26` | Round 1 后 | Round 2 后 | 最终 |
|---|---:|---:|---:|---:|
| CC ≥ 15 的函数 | 69 | 46 | 18 | **17** |
| CC ≥ 30 的函数 | 3 | 3 | 3 | **3** |
| 最大源码文件（行） | 1496 | 1435 | 770 | **712** |
| ≥ 480 行的源码文件 | 21 | 20 | 18 | **16** |
| 源码 | 634 文件 / 89.5k 行 | — | — | 701 文件 / 93.1k 行 |
| 测试 | 326 文件 / 61.9k 行 | — | — | 359 文件 / 70.7k 行 |

行数上升是拆分的直接代价（模块头、import、显式参数）与新增约 8.8k 行测试；复杂度与单文件体积是本轮的目标指标，均大幅下降。

剩余 17 个 CC ≥ 15 全部是**有意保留**或**低价值**：协议扁平分派（`emitOsc` 52、`encodeMouseEvent` 33、`classifySshError` 32、control-mode `parse` 26、`dispatchPaneStreamByte` 18）、开发脚本（`scan-managed-artifact` 24、`run-managed-smoke` 20）、语法即分支的解析器与逐字段默认值链（`sanitizeBunPath`、`runInit`、`gesture-machine`、`createWatchRuleDraft`、`parseIpv6ToBytes`、`decodeLegacyStateSnapshotDiff`）、以及纯条件 JSX（`DeviceRow`）。这些在报告里都写明了拒绝理由。

## 主要改动

### Round 1（16 commit）

- **gateway**：`splitSnapshotFields` 改布局表；`reconcile` 抽 `buildMetadataReconcilePlan`；`captureInternal` 拆 `captureFrame` + `buildCanonicalCheckpoint`；`readPage` 拆分页计算；retention active/hot 双循环合并为 `acceptSubscriptionRequests`；`evaluateWatchRule` 拆触发器；bell/notification 广播合并为 `broadcastThrottledEvent`；`handleMessage` 抽 `decodeInboundFrame`；`appendApprovalResponsesIfReady` 抽 reconciler；send_input 抽 payload/格式化；上传/下载共用 NDJSON 进度流；CLI doctor 改 `DOCTOR_FIXERS` 注册表。
- **前端**：device-tree 两种行共用 `buildSharedPaneActionItems`；device-console、watch dialog、device dialog、weixin 登录、终端快捷键编辑器、files 根表单各拆 model hook + 视图；stores 抽 `reorderByIds`。
- **libs**：canvas 抽 block/decoration/cursor 三组绘制；render-state 抽 cell 解码；WASM 两趟 UTF-8 输出封装；手势累加器与指针策略提纯；terminal-ui 抽历史页校验与 resize 决策；ws-client 抽 `DeferredSelectEffects`；shared ws-borsh 字段表 + 快照编辑器。

### Round 2（15 commit）

- gateway API/db 改声明式字段表（llm 设置、设备更新、树排序、终端快捷键、watch 生效配置、watch/site-settings 可选列写入）。
- tmux-client：pane emulator、replay-store、policy-scheduler、hierarchy-builder、snapshot row、control 重连拆分。
- agent 工具与 push/weixin：环境采集、read-screen、run-command、bell 上下文、连接告警分类、ilink 轮询拆分。
- `ghostty-wasm.ts` 1435 → 38 行，拆成 abi / core / terminal / formatter / render-state / encoders / loader 七个模块（线性子类链，公开面不变）。
- stores 事件与持久化消息改 handler 表；shared `parseNode` 拆分（20 万次差分模糊测试证明等价）；terminalKeySequence 转义表；诊断死分支清理。

### Round 3（8 commit）

- `ssh-external-connection.ts` 770 → 403（抽 shell session / client connect / control channel）。
- `external/session-commands.ts` 742 → 380（抽 host 契约 / argv / runner / lifecycle / pane query）。
- `ws/index.ts` 685 → 224（抽 send / hello / lifecycle / canonical client / runtime attachment / command facade）。
- `ghostty-terminal/terminal.ts` 765 → 711：判定其余部分确为门面，只抽出监听器集合与 DECSET-2026 兜底定时器。
- `parseIpv6ToBytes`（SSRF 相关）、`executeDependencyInstall`、`detectPackageManager`：先补测试再动代码。

## 审查发现与处置

修复的行为漂移：

- ws-client `setCallbacks` 回放顺序从 SELECT_START 顺序退化为 deferred map 顺序（BLOCKER，已修 + 回归测试）。
- ghostty 指针：链接命中测试被提前到鼠标上报判定之前，会污染缓存、且命中测试抛错会吞掉上报（BLOCKER，改为惰性 thunk + 回归测试）。
- stores 持久化消息角色分派用 `Record` 查表会命中原型链（`role: "__proto__"` 抛 TypeError），改 `Map` + 回归测试。
- ssh 重连与 window-style 在 await 前快照了 `sessionName`/`tmuxBin`，改回实时读取。
- gateway ws `sendEnvelope`/`sendError` 绕过了 `this.sendChunked`，恢复实例分派。
- weixin ilink 轮询捕获了 `creds` 快照，改回每轮实时读取。
- stores `resolvePaneSinks` 捕获了初始 registry，改回每次读 `conn.paneSinks`。
- canonical 采集把 `host.now()` 提到了 `createHistoryCursor` 之前，改回原顺序。
- 手势零位移分支提前调用了宿主 getter，恢复短路。

判定为不修的（均已核实仓库内不存在对应子类/覆写）：`SessionCommands.runTmux` / `capturePaneHistory` 与 `WebSocketServer` 的子类拦截路径（无任何子类，`host.*` 调用仍走实例）、`GhosttyBindingsCore.encoder` 由 private 改 protected、断线 `requestPaneHistory` 多出一个微任务。

## 顺手修掉的真实缺陷

- **ghostty 测试套件哑弹**：`terminal.canvas.test.ts` 遗留一个 48ms 自动滚动 `setInterval`，在 `afterAll` 换回真实模块后触发 `Unhandled error between tests`，会**随机杀掉当时正在跑的另一个测试文件**并静默丢弃它的用例（总数仍显示 0 fail）。现在通过 `test-support/fake-dom.ts` 的控制器登记表在换回模块前统一 dispose，实测 4 SET / 4 CLEAR 无泄漏，多次运行稳定。生产 `dispose()` 本身无问题。
- terminal-ui 诊断里 8 处不可达的 `?? 0` 兜底（`boundedMetric` 已处理非有限值），已删除并补上空 terminal 路径的测试。

## 验证

| 包 | 基线 | 最终 |
|---|---|---|
| apps/gateway | 1472 pass / tsc 27 | **1735 pass / 0 fail / tsc 20** |
| packages/shared | 141 / 0 | 184 / 0 |
| packages/stores | 101 / 1 | 137 / 1（既有） |
| packages/panels | 196 / 0 | 292 / 0 |
| packages/terminal-ui | 205 / 0 | 247 / 0 |
| packages/ghostty-terminal | 138 / 0 | 205 / 0 |
| packages/ws-client | 75 / 0 | 77 / 0 |
| packages/app | 90 / 1 | 122 / 1（既有） |
| 其余包 | — | 与基线一致 |

- 全仓 `biome check` 错误数 268 → 略降；新增文件无新增告警（`ghostty-wasm.ts` 与 `run-command.ts` 的既有告警在 main 上同样存在）。
- e2e（`apps/fe` Playwright，102 用例）：91 pass / 10 fail / 1 skip。10 个失败逐条与 main 一致 —— 其中 `terminal-mouse-recovery.spec.ts:305/340/384` 在 main 上用相同的定向命令复跑，结果完全相同，确认非本分支回归。
- gateway 全量测试偶发 1 fail 只在多 agent 并行、机器高负载时出现；空载连跑 4 次均 0 fail。

## 未做 / 后续

- `emitOsc`、`encodeMouseEvent`、`classifySshError`、control-mode `parse`、`dispatchPaneStreamByte` 维持原样（扁平协议分派，表驱动只会掩盖顺序语义）。
- `local-external-connection.ts`(637) / `agent/supervisor.ts`(617) / `canonical-feed-session.ts`(564) / `api/agent.ts`(540) / `messaging-routes.ts`(539) / `sidebar-agent-sessions.tsx`(555) / `agent-session-actions.ts`(489)：探索阶段判定为内聚模块，拆分只会搬运行数。
- `apps/gateway/scripts/*` 两个开发脚本的高 CC 未处理（非产品路径）。
- gateway 剩余 20 个 tsc 错误、api-client 5 / theme 10 / stores 1 / app 1 均为既有，不在本轮范围。
