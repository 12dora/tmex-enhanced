## 1. 高价值：`ExternalTmuxConnectionCore` 成为新的 God Class

- 文件：[`external-tmux-core.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/external-tmux-core.ts:82)，`ExternalTmuxConnectionCore`，82–1427 行，共 1,346 行；文件共 1,427 行。
- 相关方法：`configureSessionOptions` 559–639、`startControlClient` 713–805、`performSnapshot` 1103–1177、`parseSnapshot*` 1178–1269、`runTmux` 1356–1390、`shutdownInternal` 1403–1427。
- Round 1 的 `16d7bec` 把本地/SSH 的 tmux 语义集中到此处，确实减少了重复，但新基类同时承担 session/window/pane 操作、控制模式、心跳、主题订阅、快照解析、历史记录、错误恢复和清理。后续任一职责变更都需要理解整条连接生命周期，子类 hook 也容易形成隐式耦合。
- 安全重构：保持现有公开方法不变，提取 `TmuxSessionCommands`、`ControlModeLifecycle`、`SnapshotProjector`、`ConnectionCleanup`，通过显式 transport/callback 接口注入；保留现有调用顺序和子类 hook 语义，避免仅按行切文件。

## 2. 高价值 BUG：`AgentSupervisor.stop()` 超时后清空活动任务

- 文件：[`supervisor.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/agent/supervisor.ts:199)，`AgentSupervisor.stop`，199–215 行，共 17 行。
- 当 `Promise.race` 在 5 秒超时后返回时，旧的 `run` 可能仍在执行，但第 214 行无条件清空 `activeRuns`。此后 `submitUserMessage`（223–257 行）会认为 session 空闲并启动第二个 run；旧 run 的 `finally` 又因身份检查失败而不会删除新任务，可能造成消息、状态和事件交错。
- 安全修复：增加 `stopping` 状态，停止期间拒绝新的提交和 `startRun`；超时后保留旧 entry，直到其 promise 真正结束，再按 entry 身份删除。补充“永不结束的 run + stop 超时 + 新消息”的回归测试。

## 3. 高价值 BUG：健康检查脚本会提前退出或报告假阳性

- 文件：[`health-check.sh`](/Users/konata/code/tmex-enhanced-wt-smell/scripts/health-check.sh:50)，`run_test`，50–64 行；文件共 148 行。
- 脚本启用了 `set -e`。`((TESTS_PASSED++))` 和 `((TESTS_FAILED++))` 在旧值为 0 时返回状态码 1，因此第一次检查无论成功还是失败都可能直接终止；即使修正自增表达式，`run_test` 在失败时返回 1，顶层未保护的调用仍会被 `set -e` 终止，最终汇总结果无法执行。
- WebSocket 检查位于 111–125 行，第 122 行的 `|| true` 会把失败强制变成成功；默认 `HOST=http://localhost:3000` 时，`${HOST/ws/wss}://$HOST/ws` 还会生成错误 URL。并且 `wscat -x` 发送文本帧，而 gateway 在 `index.ts` 142–145 行直接忽略文本帧，因此该检查并未验证 WebSocket 协议。
- 安全修复：让 `run_test` 始终返回成功，由计数器决定最终退出码；使用 `TESTS_PASSED=$((TESTS_PASSED + 1))`，移除 `eval` 字符串拼接；通过 URL helper 正确转换 `http/https` 到 `ws/wss`，并使用真正的 Borsh 协议探针或明确标记为跳过。

## 4. 中价值：canonical metadata/runtime 边界仍然过宽

- 文件：[`metadata-projection.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/metadata-projection.ts:148)，`MetadataProjection`，148–784 行，共 637 行；`applySourceEvent` 315–462 行，共 148 行。
- `MetadataProjection` 同时管理层级构建、事件状态机、revision/tombstone、未知 pane 缓存、自定义名称、脏数据、定时 flush、大小限制和 wire 编码。`applySourceEvent` 的长 `switch` 还混合了字段更新、布局展开和未知实体缓存。
- 关联文件：[`device-session-runtime.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/tmux-client/device-session-runtime.ts:124)，文件共 661 行；`captureCanonicalScreenInternal` 465–566 行，共 102 行，另有约 182 行纯转发方法。
- 安全重构：提取 `MetadataHierarchyBuilder`、`MetadataEventApplier`、`MetadataPatchBuffer`，并将屏幕采集移入 `CanonicalScreenCapture`、回调接线移入 `RuntimeEventBridge`；保留当前 runtime API 和 revision 更新顺序。

## 5. 中价值：Round 1 后 `WebSocketServer` 仍是大型协议 façade

- 文件：[`ws/index.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/ws/index.ts:50)，`WebSocketServer`，50–737 行，共 688 行；文件共 737 行。
- Round 1 的 `000d8bb` 已提取 dispatcher、registry 和 broadcaster，但当前类仍负责 Bun 生命周期、Borsh 协议、canonical session、指标和依赖组装。515–735 行约 221 行主要只是转发到 collaborator，并大量使用 `this as never`，类型边界被类型逃逸掩盖。
- 安全重构：引入显式的 `WebSocketServerHost` 窄接口，将 upgrade/open/message/close/Borsh 生命周期移入 `WebSocketProtocolController`；`WebSocketServer` 只保留 Bun 绑定和 collaborator 组装，保持错误处理和调用顺序不变。

## 6. 中价值：Agent/Watch API 的请求校验重复且容易漂移

- [`agent.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/agent.ts:268)：`handleCreateSession`，268–372 行，共 105 行；`handleUpdateSession`，383–503 行，共 121 行；文件共 722 行。
- [`watch.ts`](/Users/konata/code/tmex-enhanced-wt-smell/apps/gateway/src/api/watch.ts:175)：`parseRuleFields`，175–298 行，共 124 行；创建和更新规则又在 355–425、437–505 行重复合成有效值和语义校验。
- Agent 的 provider/model/web-search/hosted-tools/maxSteps 校验在 create/update 间重复；Watch 的字段校验、创建默认值和更新时的“未提供/null”语义分散在多个函数中，未来容易出现行为漂移。
- 安全重构：增加纯函数 `parseAgentSessionConfig(raw, existing?)` 和 `buildEffectiveWatchRule(existing, patch)`，明确区分 omitted 与 null；将 `captureSessionOrigin` 等副作用保留在 handler 层，确保默认值、错误码和更新语义不变。

### 其他检查结论

`packages/app` 没有超过 600 行的生产文件；[`doctor.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/commands/doctor.ts:42) 的 `runDoctor` 为 42–305 行、264 行，属于低价值编排味道，建议将各项检查拆成返回 `DoctorCheck` 的独立函数，再单独处理 `--fix` 和重跑流程。`scripts/dev-supervisor.sh` 虽有 392 行，但函数边界尚可，未发现同等价值的确定性问题。