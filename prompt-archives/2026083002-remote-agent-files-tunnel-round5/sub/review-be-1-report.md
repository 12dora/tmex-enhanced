# 代码审查结果

## 1. blocker — `/api/mesh-internal` 可通过路径规范化绕过用户鉴权

位置：[stream-targets.ts:34](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/stream-targets.ts:34)、[stream-targets.ts:181](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/stream-targets.ts:181)、[stream-targets.ts:210](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/stream-targets.ts:210)

问题：`verifyAuth()` 在原始 `open.path` 上判断是否以 `/api/mesh-internal/` 开头并跳过 session 鉴权，之后才通过 `new URL()` 规范化路径。`..` 会在两者之间改变实际路由。

证据：

```text
原始路径：/api/mesh-internal/../agent/sessions
isAuthSkippedPath：true
实际 Request.pathname：/api/agent/sessions
```

编码形式 `/api/mesh-internal/%2e%2e/agent/sessions` 同样有效。该请求随后直接进入 gateway API，不经过正常浏览器侧 `localUiGuard`，因此持有 peer 凭据但没有用户 session 的节点可以调用任意本地 API，例如 agent、tunnel 或其他敏感管理接口。

最小修复：先构造并规范化 URL，再用规范化后的 `url.pathname` 执行 `verifyAuth`；仅当规范化路径仍严格属于 `/api/mesh-internal/` 时跳过 session 鉴权。补充明文、百分号编码和多级 `..` 回归测试。

## 2. blocker — 0028 升级会静默删除全部 Agent 历史和确认记录

位置：[0028_magical_doctor_doom.sql:1](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/drizzle/0028_magical_doctor_doom.sql:1)、[0028_magical_doctor_doom.sql:28](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/drizzle/0028_magical_doctor_doom.sql:28)

问题：Bun SQLite 的 Drizzle migrator 在执行迁移语句前已经开启事务；SQLite 不允许在事务中切换 `PRAGMA foreign_keys`，因此第一行的 `PRAGMA foreign_keys=OFF` 实际无效。

`agent_messages`、`agent_queued_messages` 和 `agent_confirmations` 都以 `ON DELETE CASCADE` 引用 `agent_sessions`，见 [schema.ts:245](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/db/schema.ts:245)。在外键仍开启时执行 `DROP TABLE agent_sessions`，SQLite 会对这些子表执行级联删除。

内存库复现结果：

```text
foreign_keys during migration = 1
children after DROP TABLE = 0
children after COMMIT = 0
```

现有迁移测试只验证空的新库，没有插入任何子记录，因此无法发现数据丢失。

最小修复：在重建父表前备份三个子表并在新父表就位后恢复，或调整迁移执行机制，使关闭外键发生在 Drizzle 外层事务之前。新增从 0027 状态升级的测试，至少保留一条 message、queued message 和 confirmation，并在迁移后检查内容及 `foreign_key_check`。

## 3. blocker — 内部 tmux RPC 不建立 runtime 连接，且可能“成功”丢弃输入

位置：[mesh-internal-tmux-routes.ts:28](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:28)、[mesh-internal-tmux-routes.ts:99](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:99)

问题：`withDeviceRuntime()` 只调用 registry 的 `acquire()`，没有执行 `runtime.connect()`。registry 创建的新 runtime 默认未连接；连接通常由浏览器 WS 的设备连接流程完成。

实际后果：

- 目标节点没有浏览器持有该设备 runtime 时，`pane-info` 和 `capture` 返回 502。
- `DeviceSessionRuntime.sendInput()` 在未连接时直接返回，内部路由仍返回 `{ ok: true }`。
- 即使已经连接，`sendInput()` 的类型仍为 `void`，只是排队异步写入；这里的 `await` 不等待写入完成，随后立即 release/shutdown runtime，错误无法反馈，输入可能丢失。

这使远端 Agent 依赖目标节点上恰好存在一个浏览器连接，无法可靠后台运行。

最小修复：内部调用获得 runtime 后先 `await runtime.connect()`；为输入提供真正可等待、在 tmux 确认后才完成的 API，并在该 Promise 完成后再 release。新增“registry 中没有预存 runtime”的端到端测试，验证三条 RPC 均成功且输入确实到达 pane。

## 4. should-fix — Agent supervisor 与 mesh bridge 的启停顺序破坏重启恢复

位置：[run-deps.ts:72](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/agent/run-deps.ts:72)

问题：远端 runtime 获取依赖进程级 `MeshAgentBridge`，但当前生命周期顺序与该依赖相反：

- 启动时 `createGatewayRuntime()` 已在 [runtime.ts:124](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/runtime.ts:124) 启动 supervisor 并恢复 `running` 会话；`assembleTmex()` 之后才创建 mesh 并安装 bridge。所有待恢复的远端会话都会因 bridge 为 `null` 被立即置为 error，bridge 就绪后也不会重试。
- 停止时 [assemble.ts:478](/Users/konata/code/tmex-enhanced-wt-r5/packages/app/src/runtime/assemble.ts:478) 先停止 mesh、后停止 gateway/supervisor。uplink 变为 offline 会触发 `notifyNodeOffline`，活动远端 run 被记录为 `NODE_OFFLINE`，而不是保留为可在重启后恢复的 shutdown 中断。

最小修复：由 assemble 层管理 supervisor 生命周期：mesh bridge 安装完成后再执行恢复，关闭时先停止 supervisor，再停止 mesh；同时在 supervisor stopping 状态忽略 mesh 离线通知。

## 5. should-fix — node 在线判定与既有 mesh 语义不一致，会误拒绝或误停会话

位置：[mesh-runtime.ts:819](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-runtime.ts:819)、[mesh-runtime.ts:1169](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-runtime.ts:1169)

问题有两个方向：

- `lookupNode()` 把 `listReach().get(nodeId) === null` 直接解释为 offline。但 `listReach()` 的 null 只表示当前没有活动 peer link；链接可能因空闲正常关闭，同时节点仍通过 hub presence 在线，`getLink()` 可以按需重新建立连接。此时 POST 创建远端 session 会错误返回 503。
- hub node list 报告 `node.online=false` 时，事件直接标记 offline，即使 `reach` 表明 LAN/WAN/relay 直连仍然可用。该假离线事件会调用 `stopSessionsForNode()`，中止本可继续运行的 Agent。

仓库现有 `/api/mesh/nodes` 投影已经使用 `hubOnline || isPeerReachable(reach)`，说明当前新增逻辑与既定在线语义不一致。

最小修复：创建校验和 node event 都复用同一在线判定：`hub presence online || isPeerReachable(reach)`；为“hub 在线但链路空闲”和“hub 离线但直连仍存活”分别补测试。

## 6. should-fix — 内部 tmux 路由未校验 pane ID，允许注入 control-mode 命令

位置：[mesh-internal-tmux-routes.ts:17](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:17)、[mesh-internal-tmux-routes.ts:100](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/mesh/mesh-internal-tmux-routes.ts:100)

问题：`paneId` 只要求非空，然后原样传入 runtime。Local/SSH runtime 会把它拼入 tmux control-mode 文本命令，例如 [local-external-connection.ts:337](/Users/konata/code/tmex-enhanced-wt-r5/apps/gateway/src/tmux-client/local-external-connection.ts:337)：

```ts
['send-keys', '-H', '-t', paneId, ...chunk].join(' ')
```

命令队列随后追加换行。带换行的 pane ID 可以插入额外 tmux 命令。现有浏览器 WS 命令处理器已经用 `isTmuxPaneId()` 限制为 `^%\\d+$`，新内部入口绕过了该保护。

另外，`historyLines` 接受任意有限数，而 Agent 工具的公开契约限制为整数 `0..2000`。

最小修复：在 `readRequiredIds()` 中调用 `isTmuxPaneId()`；确认 `deviceId` 对应真实设备；将 `historyLines` 限制为整数 `0..2000`。补充换行、空格、负数和超大值测试。

## 结论

**不可合入。** 当前 diff 包含一个可利用的鉴权绕过、一个确定的数据丢失迁移，以及会让远端 Agent 依赖浏览器连接的核心运行时缺陷。现有相关测试 43 项均通过，但没有覆盖上述边界。

最重要的 3 项：

1. 修复 `/api/mesh-internal/../*` 路径规范化鉴权绕过。
2. 修复 0028 迁移对 Agent 消息、队列和确认记录的级联删除。
3. 让内部 tmux RPC 自行建立连接并真正等待输入写入完成。