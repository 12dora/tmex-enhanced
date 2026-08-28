# agent-session-actions 拆分与列表拉取回滚 bug 修复

## 1. Bug：`loadSessions` 用陈旧快照整体覆盖 `sessions`

### 问题

旧 `loadSessionsRequest`（`agent-session-actions.ts` L150–168）用响应列表重建整张 `sessions` 表：

```ts
const sessions: Record<string, AgentSessionDto> = {};
for (const session of sessionList) sessions[session.id] = session;
return { ...withSessionOrder(sessions), sessionsLoaded: true };
```

请求在途期间发生的本地写入（新建、重命名、删除、WS `AGENT_EVENT_STATUS` / `SYNC` / `TURN_FINISHED` 改状态）会被这份「请求发起前的服务端视图」整体回滚：新建的会话消失、重命名回退旧标题、已删除的会话复活、running 状态被打回 idle。旧代码 L83–85 的注释本身已承认该问题，但只做了 in-flight 去重，没解决单次请求跨越本地写入的窗口。

### 修复思路

原计划的「单调递增本地写版本号」在本仓库不可行：`sessions` 的写入方分布在 `agent-event-router.ts`（WS 事件，本次不可改）、`agent-history-sync.ts`、`agent-thread.ts` 等模块，无法统一要求它们 bump 版本号；`AgentSessionDto` 也没有可用的事件序号字段，`updatedAt` 由服务端产生，WS 状态推送并不会改它（`{ ...session, status }` 原地替换），因此按 `updatedAt` 比较无法区分「本地更新」与「拉取结果」。

改用**条目引用作为写入标记**：所有写入方一律以 `{ ...session, ... }` 产出新对象，因此「请求发起时快照中的条目引用 === 落盘时的条目引用」等价于「该会话在途期间无本地写入」。这是免协作、零侵入的等价方案。

新增纯函数 `mergeFetchedSessions(before, current, fetched)`（`agent-session-map.ts`）：

| 情况 | 结果 |
| --- | --- |
| 在 `fetched` 中，`current[id] === before[id]` | 采用服务端版本 |
| 在 `fetched` 中，`current[id] !== before[id]` | 保留本地版本（在途本地写入更新） |
| 在 `fetched` 中，`current[id]` 缺失且 `before[id]` 存在 | 丢弃（在途被本地删除，不复活） |
| 不在 `fetched` 中，`before[id] === current[id]` | 丢弃（确为别端删除） |
| 不在 `fetched` 中，但在途有本地写入 / 本地新建 | 保留 |

`loadSessionsRequest` 在首个 `await` 之前抓 `before = get().sessions`（即请求发起时刻），落盘时在 `set` 的 updater 里拿 `prev.sessions` 作 `current`，两者比对合并。`sessionsLoaded`、`activeSessionId` 被别端删除后的清理逻辑保持不变。

### 回归测试

新增 `src/agent-session-crud-actions.test.ts`（9 个用例），其中 4 个正是任务要求的场景，均使用可门控的列表请求 harness（`createLoadHarness` 暴露 `set` 以模拟 WS 直写）：

- create during load：`loadSessions` 在途时 `createSession`，放行后新会话仍在，且 `sessionOrder`/`activeSessionId` 正确；
- rename during load：在途 `renameSession`，放行后标题与 `updatedAt` 保持新值；
- delete during load：在途 `deleteSession`，放行后不复活，`sessionOrder`、`activeSessionId`、`clearSessionRuntime` 均已清理；
- WS status update during load：按 `AGENT_EVENT_STATUS` 的写法原地替换条目，放行后 `status` 仍是 `running`；
- 另加 `mergeFetchedSessions` 的 4 个纯函数用例 + 1 个「未被本地改动的会话仍按别端删除处理」用例，确保修复没有把「别端删除」的清理能力一起关掉。

**验证过修复有效性**：把 `mergeFetchedSessions(before, prev.sessions, ...)` 临时改回 `(before, before, ...)`（等价旧行为）后，上述 4 个并发用例全部 fail；改回后全绿。

## 2. 按域拆分

`agent-session-actions.ts` 从 493 行的单文件（`createAgentSessionActions` 一个 426 行工厂、20+ 个不相干动作）拆为：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `agent-session-actions.ts` | 22 | 薄组合根：拼装四组动作 + 向后兼容的类型/工具再导出 |
| `agent-session-crud-actions.ts` | 258 | 列表拉取（含合并修复）、刷新、激活切换、建/删、元数据 PATCH、停止 |
| `agent-session-message-actions.ts` | 97 | 历史加载、直发消息、队列消息入队/编辑/撤回 |
| `agent-session-draft-actions.ts` | 89 | 草稿开启/更新/清空/物化（含 in-flight 去重） |
| `agent-session-confirmation-actions.ts` | 61 | 工具确认决策 + 冲突重拉 |
| `agent-session-map.ts`（新增，共享） | 63 | `sortSessionOrder` / `withSessionOrder` / `mergeFetchedSessions` 纯函数 |
| `agent-session-deps.ts`（新增，共享） | 24 | `AgentSessionActionsDeps` 与 `reportActionError` |

要点：

- 公共动作名与类型完全不变。`AgentSessionActions = Omit<AgentActions, 'ensureInitialized'>` 由四个 `Pick<AgentActions, ...>` 子类型精确覆盖（12 + 5 + 4 + 1 = 22 个动作），少一个或多一个都会编译报错，等于用类型系统锁住了拆分的完整性。
- `sortSessionOrder`、`AgentSessionActionsDeps` 继续从 `agent-session-actions.ts` 再导出，`agent.ts` 与既有测试无需改动（二者是仅有的两个外部引用点）。
- `createSessionRequest` 提为 `agent-session-crud-actions.ts` 的模块级导出，草稿物化直接复用，不构成循环依赖（draft → crud 单向）。
- 顺手消掉重复：4 个 `updateAgentSession` 包装（`setWriteMode`/`setAllowControlChars`/`setSessionModel`/`rebindPane`）与 `renameSession` 收敛到 `createPatchActions(patchSession)`；`deleteSession` 里 6 段「拷贝 record 再 delete」收敛到 `withoutKey` + `pruneSessionState`；`decideConfirmation` 的 conflict 分支去掉了重复的 `removeLocally` 调用（行为等价：两条路径都先本地移除，冲突时再静默重拉）。

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `cd packages/stores && bun test` | 117 pass / 0 fail（基线 108 pass，新增 9） |
| `cd packages/stores && bunx tsc --noEmit -p .` | 1 error，即基线既有的 `src/host-services.test.ts(93,23)`，未新增 |
| `cd packages/panels && bunx tsc --noEmit -p .` | 我方相关 0 error |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check <改动文件>` | clean |

注意：`packages/panels` 当前会报 `src/watch/spike.test.tsx(6,38)` 缺 `react-dom/server` 声明。该文件是本 worktree 里**未跟踪的新增文件**（并行 agent 的产物），与本次改动无关；排除它后 panels 为 0 error。

## 4. 遗留与风险

- 引用相等法依赖「写入方一律产出新对象」这一约定，已在 `agent-session-map.ts` 的注释中写明。若后续引入 immer 或出现原地 mutate 的写入方，该判定会退化为「不保留本地写入」（即回到旧行为，不会产生错误数据，但会丢失新鲜度）。store 目前是裸 zustand + `persist`，`set` 为浅合并，约定成立。
- 「在途有 WS 写入、但服务端列表已不含该会话」的矛盾场景选择保留本地条目（宁可多留一条，由 `refreshSession`/`STATUS` 兜底删除），而非直接丢弃，避免误删仍在运行的会话。
