## 真实缺陷

1. **连接取消竞态（高）**  
   [device-session-runtime.ts:207](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/device-session-runtime.ts:207>)（L207–249）：`disconnect()` 只设置标志并调用底层 `disconnect()`，未取消进行中的 `connect()`。  
   [local-external-connection.ts:187](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/local-external-connection.ts:187>)（L187–220）及 SSH 对应实现会在异步步骤完成后无条件设置 `connected`、发布 source-ready、更新状态并请求快照，可能在断开后“复活”。现有测试只覆盖并发 connect 去重（`device-session-runtime.test.ts:160–179`）。  
   修复：引入连接代次或 AbortSignal，在每个 await 后及发布状态前校验连接仍有效；增加“connect 阻塞期间 disconnect，释放阻塞后不得恢复”的回归测试。

2. **微信启动失败后状态卡死（高）**  
   [weixin/ilink/client.ts:247](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/weixin/ilink/client.ts:247>)（L247–255）：`running = true` 后，`loadSyncBuf()` 在 `try` 外执行；若加载失败，L324–327 的 `finally` 不执行，`running` 和 `internalAbort` 永久残留，后续 `start()` 被错误判定为已运行。现有测试只覆盖成功加载（`client.test.ts:131–151`）。  
   修复：将初始游标加载放入 `try/finally`；增加加载失败后状态清理及可再次启动测试。

3. **HTTP 输入验证缺陷（中）**

   - [files.ts:241](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/files.ts:241>)（L241–244）使用 `parseInt`，`offset=12garbage` 会被接受为 `12`，而 [transfer-session.ts:114](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/files/transfer-session.ts:114>)（L114–119）要求 offset 为严格的已接收字节数。应改用 `Number()` 与 `Number.isSafeInteger()`。
   - [messaging-routes.ts:46](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/messaging-routes.ts:46>)、[203](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/messaging-routes.ts:203>)、[394](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/messaging-routes.ts:394>) 直接强制转换 `req.json()`；`null` 或 `{ name: 42 }` 会在 `.trim()`/属性访问处抛出 TypeError，返回 500 而非 400。文件根和上传接口也有 `null` 解引用（[files.ts:96](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/files.ts:96>)、[215](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/files.ts:215>)）。项目已有安全解析器 [http.ts:21](</Users/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/http.ts:21>)（L21–31），应统一使用并补充 null、错误类型字段测试。

## 重构候选

1. **规范屏幕捕获函数**  
   [canonical-screen-capture.ts:48](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/runtime/canonical-screen-capture.ts:48>)（L48–147）：100 行，CC≈24；同时负责 barrier/fallback 采集、历史预算、UTF-8 截断、epoch 校验和 checkpoint 构造。  
   重构为 `runtime/screen-frame-source.ts`（采集路径）和 `runtime/screen-checkpoint-builder.ts`（预算、光标、历史 cursor、payload），保留主函数做流程编排。风险：高。测试：`runtime/canonical-screen-capture.test.ts:53–139`。

2. **拆分 metadata reconcile 计划与提交**  
   [metadata-projection.ts:146](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/metadata-projection.ts:146>)（L146–219）：74 行，CC≈23；混合 desired diff、revision/baseRevision 冲突判断、增删改计划和 patch 提交。  
   新增 `metadata/reconcile-plan.ts`，纯函数返回 additions/fieldChanges/parentChanges/removals；projection 只负责 revision 原子提交。风险：高。测试：`metadata-projection.test.ts:141–418`。

3. **拆分 pane history 分页流程**  
   [pane-history-reader.ts:125](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/pane-history-reader.ts:125>)（L125–244）：120 行，CC≈19；混合 cursor 会话、eviction 检测、tmux range 采集、anchor 校验和 byte-limit 行选择。  
   新增 `pane-history-session.ts` 与 `pane-history-page.ts`，`readPage()` 仅串联生命周期和结果。风险：高。测试：`pane-history-reader.test.ts:34–82`。

4. **抽取 approval-response reconciliation**  
   [agent/supervisor.ts:572](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/agent/supervisor.ts:572>)（L572–665）：94 行，CC≈21；同时扫描 assistant/tool 消息、匹配 confirmation、构造 approved/denied/cancelled parts、落库和广播。  
   新增 `agent/approval-response-reconciler.ts`，提取 `findApprovalRequests`、`collectResolvedToolCalls`、`buildApprovalResponseParts`；Supervisor 保留 DB 与广播副作用。风险：高。测试：`agent/supervisor.test.ts:400–542`、`:902–961`。

5. **隔离微信 long-poll 更新循环**  
   [weixin/ilink/client.ts:233](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/weixin/ilink/client.ts:233>)（L233–323）：91 行，CC≈20；混合启动状态、游标加载、超时 signal、退避、session 过期、消息分发和游标持久化。  
   新增 `weixin/ilink/update-loop.ts`，由 `WeixinClient.start()` 提供 credentials、signal、cursor/context 回调。风险：中高。测试：`weixin/ilink/client.test.ts:91–251`。

6. **拆分 retention subscription apply 计划**  
   [retention/subscription-coordinator.ts:34](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/tmux-client/retention/subscription-coordinator.ts:34>)（L34–145）：112 行，CC≈18；混合去重、generation 冲突、请求校验、容量准入、consumer 提交和 replay 结果构造。  
   新增 `retention/subscription-plan.ts`，生成不可变 accepted/rejected/replay 计划；`apply()` 保留最终原子提交。风险：高。测试：`retention/subscription-coordinator.test.ts:27–76`。

7. **拆分 legacy event fan-out 分支**  
   [legacy-feed-broadcaster.ts:42](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/ws/legacy-feed-broadcaster.ts:42>)（L42–111）：70 行，CC≈21；同时处理事件扩展、空通知过滤、bell 频控、notification 频控、普通广播和 metrics。  
   新增 `ws/legacy-event-delivery.ts`，抽取 `deliverBell`、`deliverNotification`、`deliverGenericEvent`；主类只负责编码和选择策略。风险：中。测试：`ws/index.test.ts:760–888`。

8. **拆分 watch evaluator 的 match/unchanged 分支**  
   [watch/evaluator.ts:73](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/watch/evaluator.ts:73>)（L73–157）：85 行，CC≈20；同时处理规则类型、正则编译、命中、no-match reset、值变化计时和 cooldown。  
   新增 `watch/evaluator-match.ts`、`watch/evaluator-unchanged.ts`，保留公共 regex 编译和 trigger gate。风险：中。测试：`watch/evaluator.test.ts:42–282`。

9. **按业务域拆分 messaging API**  
   [messaging-routes.ts:1](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/messaging-routes.ts:1>)（L1–538）：538 行；单函数约 CC2–8，但包含 Telegram、Weixin、Webhook 三套 DB/service/路由。  
   新增 `api/telegram-routes.ts`、`api/weixin-routes.ts`、`api/webhook-routes.ts`，当前文件仅保留聚合导出。风险：中。测试：`api/weixin.test.ts:44–109`、`api/index.routing.test.ts:86–164`；Telegram 创建和 Webhook 缺少专门接口测试。

10. **拆分 files API 的 root、浏览和传输职责**  
    [files.ts:1](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/files.ts:1>)（L1–516）：516 行；单函数约 CC2–9，混合 root CRUD、目录读取、上传协议、下载流和 HTTP header/stream helper。  
    新增 `api/file-root-routes.ts`、`api/file-browser-routes.ts`、`api/file-transfer-routes.ts`、`api/file-http.ts`。风险：中高，需保持 stream cancel/cleanup 语义。测试：`api/files.test.ts:16–27`、`files/transfer-session.test.ts:13–54`、`files/rsync-operation.test.ts:18–110`、`files/path-safety.test.ts:30–84`。

11. **按资源拆分 agent REST API**  
    [agent.ts:1](</Users/konata/code/tmex-enhanced-wt-tabs/apps/gateway/src/api/agent.ts:1>)（L1–539）：539 行；`handleUpdateSession` 约 CC11；混合 session、message/queue、confirmation、DTO、错误映射和路由表。  
    新增 `api/agent-session-routes.ts`、`api/agent-message-routes.ts`、`api/agent-confirmation-routes.ts`、`api/agent-dtos.ts`，保留聚合路由。风险：中。测试：`api/agent.test.ts:122–470`。

12. **拆分依赖安装执行流程**  
    [dep-install.ts:150](</Users/konata/code/tmex-enhanced-wt-tabs/packages/app/src/lib/dep-install.ts:150>)（L150–232）：83 行，CC≈19；混合 sudo 检查、交互确认、命令解析、shell pipeline 执行和安装后版本验证。  
    新增 `lib/dependency-install-runner.ts`，拆为 `resolveInstallPlan`、`confirmInstall`、`runInstallCommand`、`verifyInstalledDependency`。风险：中。测试：`dep-install.test.ts:33–176` 目前只覆盖计划解析和 sudo 命令拼接，未直接覆盖执行流程。

## 刻意跳过

- `pane-stream/osc-handlers.ts:23–150` 的 `emitOsc`（CC≈49）、`ws/error-classify.ts:1–103` 的 `classifySshError`（CC≈32）、`control-mode/metadata.ts:14–85` 的协议分派（CC≈26）及 `pane-stream-parser.ts:38–72`：都是扁平协议标签/字节映射，拆分会分散协议表，收益低。
- `external/session-commands.ts`、`external-tmux-core.ts`、`device-session-runtime.ts`、`ws/index.ts`、`ws/borsh/switch-barrier.ts`、`db/schema.ts`：分别是命令集合、连接 facade、运行时 facade、WS facade、单一状态机和 schema 定义，继续拆分主要增加转发层。
- `ws/borsh/session-state.ts`：虽然接近 500 行，但都是同一 WebSocket 会话的状态生命周期与清理逻辑，拆成多个 store 会增加耦合。
- SSH/local 的 `reconnectControlClient()`：存在重复，但两者在 spawn 错误、SSH channel 清理和生命周期上有实质差异；此前清理轮次已因风险暂缓，适合先补生命周期 characterization tests。
- `packages/app/src/commands/init.ts:182–277`：96 行、CC≈18，但属于线性的初始化编排，现有 helper 边界已经清晰，继续拆分暂时只会增加转发函数。