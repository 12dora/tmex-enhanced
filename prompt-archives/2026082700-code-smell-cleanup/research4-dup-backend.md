# 后端重复代码审查报告

范围：`apps/gateway/src/**`、`packages/app/**`，排除测试、生成文件和依赖目录。当前代码已包含上一轮大型拆分，本报告不重复提出已完成的 SSH/local 合并、WebSocket 拆分等事项。未修改文件。

估算的行数变化均为粗略净源码行数，不含测试。

## P0

### 1. JSON Response 包装函数重复

- 位置：`apps/gateway/src/api/http.ts:L1-L9`；重复于 `api/files.ts:L41-L46`、`api/system.ts:L12-L17`、`api/system-managed.ts:L3-L8`、`api/theme.ts:L53-L58`、`api/tmux-tree.ts:L57-L62`、`api/llm.ts:L369-L376`、`api/test-connection.ts:L27-L34`、`api/agent.ts:L526-L533`、`api/watch.ts:L409-L416`、`api/tree-order.ts:L167-L172`、`api/capabilities.ts:L13-L22`。
- 证据：多处重复 `new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })`。
- 规范位置：`apps/gateway/src/api/http.ts` 的 `json()`。
- 删除内容：各 API 文件的本地 `json()`，以及 `capabilities.ts` 的内联 `Response`。
- 建议：统一导入 `json()`；保留 `manifestJson()`，因为其 MIME 和 HEAD 语义不同。
- 估算：净减少 `60–80` 行。
- 风险：低。
- 优先级：P0。

### 2. BUG：Borsh 分片发送逻辑重复，协议行为可能漂移

- 位置：`apps/gateway/src/ws/index.ts:L415-L436`、`apps/gateway/src/agent/ws-hub.ts:L166-L193`；已有基础实现 `apps/gateway/src/ws/borsh/codec-borsh.ts:L165-L190`。
- 证据：两处都执行 `seqGen()`、`splitPayloadIntoChunks()`、`generateChunkStreamId()` 和 `encodeChunk()`；`ws-hub.ts` 明确注释“与 WebSocketServer.sendEnvelope/sendChunked 保持一致”。
- 规范位置：导出 `codec-borsh.ts` 的 `encodeWithChunking()`，或新增 `encodePayloadFrames()`。
- 删除内容：`ws/index.ts` 与 `ws-hub.ts` 中的分片编码主体。
- 建议：统一生成 frame；调用方只保留发送保护、错误日志和返回值差异。必须保持未分片时使用原始序列号。
- 估算：净减少 `30–40` 行。
- 风险：中。序列号和 wire protocol 改动需要回归验证。
- 优先级：P0。

### 3. BUG：IPv4-mapped IPv6 地址可绕过 SSRF 私网判断

- 位置：`apps/gateway/src/agent/tools/web.ts:L71-L103`、`L110-L123`。
- 证据：

  ```ts
  if (host.startsWith('::ffff:')) {
    return isPrivateHostname(host.slice('::ffff:'.length));
  }
  ```

  对 `[::ffff:7f00:1]` 会递归判断 `7f00:1`，最终返回 `false`，但该地址表示 loopback。
- 规范位置：新增纯地址解析模块，例如 `apps/gateway/src/agent/tools/ip-address.ts`。
- 删除内容：当前基于字符串前缀的 IPv6 判断。
- 建议：将 IPv6 解析为 16 字节后判断 `::1`、`::`、`fc00::/7`、`fe80::/10` 以及 IPv4-mapped 地址，并复用 IPv4 私网判断。
- 估算：增加约 `20–30` 行，删除约 `5–10` 行。
- 风险：高，涉及出站网络安全。
- 优先级：P0。

### 4. BUG：重连失败达到上限后保留过期连接注册表项

- 位置：`apps/gateway/src/ws/device-connection-registry.ts:L236-L341`，尤其是 `L286-L300`。
- 证据：

  ```ts
  if (!retryConnection) {
    ...
    this.host.broadcastDeviceEvent(entry, finalEvent);
    return;
  }
  ```

  该分支没有执行后续的 `connections.delete(deviceId)`；而 `getOrCreate()` 在 `L98-L101` 会直接返回旧 entry。
- 规范位置：`device-connection-registry.ts` 新增 `finalizeReconnectFailure()`。
- 删除内容：无须删除大量代码；应抽取并复用正常断开清理逻辑。
- 建议：达到重试上限时清除 timer、detach canonical session、清空客户端引用、删除 `connections` 中的 entry，并广播最终失败事件。下一次连接必须创建新 runtime。
- 估算：净增加约 `10–15` 行。
- 风险：高，涉及连接生命周期。
- 优先级：P0。

## P1

### 5. Rsync 文件操作重复设备上下文和资源清理模板

- 位置：`apps/gateway/src/files/device-storage.ts:L159-L201`、`L224-L261`、`L292-L335`、`L343-L377`、`L395-L443`、`L456-L522`。
- 证据：六个操作都重复：

  ```ts
  let spec = await buildRsyncDeviceSpec(device);
  ...
  try {
    // operation
  } finally {
    spec.cleanup();
  }
  ```

  同时重复 `resolveContext()`、`checkAndNormalize()`、`enqueueDeviceJob()` 和 `RsyncAuthError` 转换。
- 规范位置：新增 `apps/gateway/src/files/rsync-operation.ts` 的 `withDeviceRsync()`。
- 删除内容：六个函数中的 spec 构建、认证错误转换和 `finally` 清理模板。
- 建议：helper 统一处理队列、spec 生命周期和认证错误；操作函数只保留 rsync 参数、大小限制和临时文件语义。
- 估算：净减少 `45–60` 行。
- 风险：中，需保证异步队列和 cleanup 顺序不变。
- 优先级：P1。

### 6. SSH 与本地 tmux 重连流程近重复

- 位置：`apps/gateway/src/tmux-client/ssh-external-connection.ts:L458-L514`、`apps/gateway/src/tmux-client/local-external-connection.ts:L515-L578`。
- 证据：两处均包含重试计数、退避、连接状态检查、`has-session` 探测、session gone 处理、启动 control client、snapshot 和历史捕获。
- 规范位置：`apps/gateway/src/tmux-client/external-tmux-core.ts`，或新增 `external/control-reconnect.ts`。
- 删除内容：两个子类中的公共重连主体。
- 建议：抽取公共模板，通过 hook 保留差异：local 的 `TMUX_SPAWN_UNAVAILABLE_EXIT` 处理、SSH/local 不同的错误通知和日志前缀。
- 估算：净减少 `45–65` 行。
- 风险：高，涉及连接生命周期和重连竞态。
- 优先级：P1。

### 7. SSH ready/connect 与 exec channel Promise 模板重复

- 位置：`apps/gateway/src/tmux-client/ssh-probe.ts:L23-L64`、`ssh-external-connection.ts:L285-L344`、`ssh-external-connection.ts:L713-L730`。
- 证据：

  ```ts
  client.exec('/bin/sh -s', { pty: false }, (error, channel) => {
    if (error) reject(error);
    else resolve(channel);
  });
  ```

  `connectClient()` 和 `connectSshClient()` 也重复 `settled`、`resolveOnce()`、`rejectOnce()`、`ready/error/close` 监听。
- 规范位置：新增 `apps/gateway/src/tmux-client/ssh-transport.ts`。
- 删除内容：probe、command channel、reader channel 的 Promise 模板。
- 建议：提供 `waitForSshReady()` 和 `openShellChannel()`；SSH 主连接仍通过 hook 注入 runtime 状态和关闭行为。
- 估算：净减少 `35–50` 行。
- 风险：中。
- 优先级：P1。

### 8. API 路由手写 dispatcher 重复且复杂度过高

- 位置：`api/agent.ts:L47-L96`、`api/watch.ts:L67-L97`、`api/llm.ts:L45-L72`、`api/files.ts:L459-L506`、`api/tree-order.ts:L8-L39`。
- 规范位置：已有 `apps/gateway/src/api/route.ts:L46-L109` 的 `route()`、`matchPath()`、`dispatchRoutes()`。
- 证据：

  ```ts
  if (path.match(/^\/api\/agent\/sessions\/[^/]+$/) && req.method === 'GET') {
    return handleGetSession(path.split('/')[4]);
  }
  ```

  多个 dispatcher 重复正则、`split('/')[4]` 和 method 判断；`handleAgentApiRequest` 粗略复杂度超过 25，`handleFilesApiRequest` 超过 20。
- 删除内容：上述手写 dispatcher，以及 `agent-routes.ts:L6-L21` 的 wildcard 转发 wrapper。
- 建议：把每个 domain 改成具体 `ApiRoute[]`，最终由 `api/index.ts:L24-L47` 单次调用 `dispatchRoutes()`。明确保留 files/tree-order 的 `decodeURIComponent()` 和路由顺序。
- 估算：净减少 `60–90` 行。
- 风险：中，路由优先级和编码参数行为需要回归测试。
- 优先级：P1。

### 9. Telegram/Weixin 通知视图构建重复

- 位置：`events/channels/telegram.ts:L48-L79`、`L133-L188`；`events/channels/weixin.ts:L8-L23`、`L58-L84`、`L125-L159`。
- 证据：两处重复 terminal topbar：

  ```ts
  typeof event.tmux?.windowIndex === 'number'
    ? `${event.tmux.windowIndex}`
    : (event.tmux?.windowId ?? '?')
  ```

  两处还重复 14 项事件 emoji 映射。
- 规范位置：新增 `apps/gateway/src/events/channels/notification-format.ts`。
- 删除内容：两套 `buildTerminalTopbarLabel()`、共享 pane metadata 逻辑，以及 Telegram 内联 emoji map。
- 建议：共享原始 notification view、emoji map、topbar 和 pane metadata；Telegram 仅负责 HTML 转义，Weixin 负责纯文本输出。
- 估算：净减少 `30–45` 行。
- 风险：中，需避免 Telegram HTML 转义规则泄漏到 Weixin。
- 优先级：P1。

### 10. Uint8Array 基础工具重复

- 位置：`ws/canonical/bytes.ts:L4-L14`、`tmux-client/retention/bytes.ts:L3-L13`、`tmux-client/metadata/types.ts:L58-L68`、`tmux-client/pane-history-reader.ts:L59-L73`、`L86-L102`、`L147-L167`、`tmux-client/runtime/canonical-screen-capture.ts:L147-L167`。
- 证据：多处完全重复：

  ```ts
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
  ```

  以及 `copyBytes()`、`bytesHex()`、`truncateUtf8Tail()`、`concatBytes()`。
- 规范位置：新增 `apps/gateway/src/bytes.ts`。
- 删除内容：各模块的通用 `copyBytes`、`bytesEqual`、`bytesHex`、`truncateUtf8Tail` 和 `concatBytes`；保留 retention 专用 clone/fingerprint。
- 建议：统一 `concatBytes(...values)` 签名，canonical/retention 文件改为 re-export 或只保留领域 helper。
- 估算：净减少 `35–50` 行。
- 风险：低至中。
- 优先级：P1。

### 11. tmux 版本解析器和版本类型重复

- 位置：`apps/gateway/src/tmux-client/tmux-version.ts:L4-L49`、`packages/app/src/lib/tmux.ts:L4-L63`、`packages/app/src/constants.ts:L5`。
- 证据：两边都定义 `TmuxVersion`、`parseTmuxVersion()` 和版本比较；app 侧直接使用：

  ```ts
  const match = versionOutput.match(/(\d+)\.(\d+)/);
  ```

  gateway 侧已存在更完整的首行/provenance 规范化。
- 规范位置：新增纯函数模块 `packages/shared/src/tmux-version.ts`。
- 删除内容：app 侧的 `TmuxVersion`、`parseTmuxVersion()`、`compareTmuxVersion()` 和重复最低版本常量；gateway 保留自身的 identity/provenance 适配函数。
- 建议：共享“首个非空版本行 + 版本比较”语义，避免 app 扫描 provenance 文本而误识别版本。
- 估算：净减少 `45–60` 行。
- 风险：中，需明确 master/OpenBSD 无数字版本的放行策略。
- 优先级：P1。

### 12. JSON object body 解析器重复

- 位置：`api/agent.ts:L156-L167`、`api/watch.ts:L139-L150`、`api/llm.ts:L112-L123`。
- 证据：三处均重复 `req.json()`、捕获异常、拒绝数组和 null：

  ```ts
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  ```
- 规范位置：`apps/gateway/src/api/http.ts`。
- 删除内容：三个文件的 `readJsonObjectBody()`。
- 建议：导出统一 helper，保留调用方对字段类型和业务校验的处理。
- 估算：净减少 `25–32` 行。
- 风险：低。
- 优先级：P1。

### 13. Telegram/Weixin 子表 CRUD 查询平行实现

- 位置：`db/telegram.ts:L125-L152`、`L216-L265`；`db/weixin.ts:L148-L175`、`L235-L302`。
- 证据：count、按 parent 查询、authorized 查询、approve 和 delete 结构相同，仅表名、parent 字段、用户字段和 mapper 不同。例如两边均为：

  ```ts
  orm.update(...).set({
    status: 'authorized',
    authorizedAt: now,
    updatedAt: now,
  })
  ```
- 规范位置：新增 `apps/gateway/src/db/messaging-child-queries.ts`。
- 删除内容：两套 count/list/authorized/approve/delete 查询主体；保留 Telegram/Weixin 特有的 upsert、context token 和字段更新。
- 建议：用表配置、parent column、child column 和 mapper 参数化通用查询。
- 估算：净减少 `50–80` 行。
- 风险：中至高，Drizzle 泛型和字段类型需要谨慎设计。
- 优先级：P1。

### 14. BUG：上传初始化接受小数文件大小

- 位置：`apps/gateway/src/api/files.ts:L217-L241`、`files/transfer-session.ts:L78-L123`、`api/files.ts:L258-L263`。
- 证据：

  ```ts
  const size = typeof body.size === 'number' && Number.isFinite(body.size)
    ? body.size
    : -1;
  ```

  `0.5` 会通过校验；之后 `received` 始终为整数，无法满足 `session.received !== session.size` 的 commit 条件。
- 规范位置：仍在 `handleUploadInit()`。
- 删除内容：无大规模删除。
- 建议：校验 `Number.isSafeInteger(size) && size >= 0`，并与配置上限一起检查。
- 估算：增加约 `2` 行，删除约 `1` 行。
- 风险：中。
- 优先级：P1。

### 15. BUG：命令输出截断标志按字符数而不是字节数判断

- 位置：`apps/gateway/src/agent/tools/run-command.ts:L120-L127`、`L162-L173`。
- 证据：

  ```ts
  const truncated = raw.length >= OUTPUT_MAX_BYTES;
  ```

  但累积逻辑实际按 `Uint8Array` 字节数限制：

  ```ts
  if (chunks.length < OUTPUT_MAX_BYTES) chunks.push(byte);
  ```
- 规范位置：`run-command.ts` 的字节累积器。
- 删除内容：`raw.length >= OUTPUT_MAX_BYTES`。
- 建议：累积超过上限时设置 `wasTruncated`，将该布尔值传给 `extractOutput()`；不要从 UTF-16 字符串长度反推。
- 估算：净增加约 `2–4` 行。
- 风险：低。
- 优先级：P1。

### 16. `executeRunCommand()` 仍超过 120 行且复杂度高

- 位置：`apps/gateway/src/agent/tools/run-command.ts:L141-L320`，约 180 行。
- 证据：同一函数同时处理 alternate screen、expect、OSC marker、分页、CLI prompt、idle fallback、timeout 和 cleanup；粗略复杂度超过 15。
- 规范位置：拆出 `waitForCommandCompletion()`，再拆分 `checkPosixCompletion()`、`checkPromptCompletion()`、`checkPager()`。
- 删除内容：从 `executeRunCommand()` 移除完成判定循环和各分支。
- 建议：主函数只负责模式初始化、发送命令、安装 tap 和最终 cleanup。
- 估算：主函数减少约 `80` 行，helper 增加约 `35` 行，净减少约 `45` 行。
- 风险：中。
- 优先级：P1。

### 17. `runDoctor()` 过长且职责混杂

- 位置：`packages/app/src/commands/doctor.ts:L42-L305`，约 264 行。
- 证据：同一函数串联平台/Bun/tmux/SSH 检查、安装目录/env/数据库/端口检查、service/health 检查以及输出和 `--fix` 重试；粗略复杂度约 40。
- 规范位置：新增 `commands/doctor-checks.ts`，拆成 `checkEnvironment()`、`checkDependencies()`、`checkService()`、`checkHealth()` 和 `renderDoctorResult()`。
- 删除内容：从 `runDoctor()` 移除各检查分支和渲染分支。
- 建议：`runDoctor()` 只负责参数解析、调用检查器、按 `json/fix` 汇总结果。
- 估算：净减少 `55–70` 行。
- 风险：中。
- 优先级：P1。

### 18. `resolveSshConnectConfig()` 仍超过 120 行且认证分支复杂

- 位置：`apps/gateway/src/tmux-client/ssh-connect-config.ts:L211-L349`，约 139 行。
- 证据：一个函数内同时解析 destination，并通过多分支处理 password、private key、agent、configRef 和 auto fallback；粗略复杂度超过 15。
- 规范位置：同目录新增 `ssh-auth-resolvers.ts`，或在当前文件拆出认证策略函数。
- 删除内容：从主函数删除认证方式 switch/if 链。
- 建议：主函数只做目标地址解析和策略选择；各认证方式独立返回 `ConnectConfig` 片段。
- 估算：主函数减少约 `65` 行，helper 增加约 `30` 行，净减少约 `35` 行。
- 风险：高，涉及凭据解密和认证回退。
- 优先级：P1。

### 19. `createBorshKindHandlers()` 仍超过 120 行

- 位置：`apps/gateway/src/ws/borsh-dispatcher.ts:L91-L307`，约 217 行。
- 证据：一个函数内声明所有 device、tmux、terminal、agent、theme 和 canonical handler：

  ```ts
  const handlers = new Map<number, BorshKindHandler<unknown>>([...]);
  ```
- 规范位置：按领域拆出 `tmux-kind-handlers.ts`、`agent-kind-handlers.ts`、`canonical-kind-handlers.ts`，由 dispatcher 合并。
- 删除内容：从 `createBorshKindHandlers()` 删除各领域 handler 声明。
- 建议：保留统一的 `decoderHandler()`/`schemaHandler()`，只让顶层函数组合多个 map。
- 估算：顶层函数净减少 `80–120` 行。
- 风险：中。
- 优先级：P1。

### 20. BUG：IPv6 bind host 拼接 URL 时缺少方括号

- 位置：`packages/app/src/commands/doctor.ts:L242-L247`、`commands/upgrade.ts:L50-L66`、`lib/install.ts:L21-L31`；已有正确实现 `apps/gateway/src/managed-entry.ts:L88-L90`。
- 证据：

  ```ts
  const url = `http://${host}:${port}/healthz`;
  ```

  IPv6 host 会生成 `http://2001:db8::1:9883/healthz`，而 gateway 已使用 `host.includes(':') ? \`[${host}]:${port}\` ...`。
- 规范位置：新增纯函数 `packages/shared/src/network.ts` 的 `formatHttpEndpoint()`。
- 删除内容：app 和 gateway 的重复 endpoint 字符串拼接。
- 建议：统一处理 IPv6 方括号；`0.0.0.0` 转 loopback 应作为独立策略处理。
- 估算：净减少约 `5–10` 行，增加约 `5` 行。
- 风险：中。
- 优先级：P1。

### 21. DB schema 中的枚举类型重复 shadow `@tmex/shared`

- 位置：`apps/gateway/src/db/schema.ts:L11-L18`；规范定义位于 `packages/shared/src/contracts/agent.ts:L3-L9`、`contracts/watch.ts:L3-L7`。
- 证据：schema 重复定义 `AgentWriteMode`、`AgentSessionStatus`、`AgentMessageRole`、`AgentConfirmationStatus`、`WatchTriggerType` 等，而同一文件已经通过 `export type { ... } from '@tmex/shared'` 复用其它类型。
- 规范位置：`@tmex/shared` 对应 contract。
- 删除内容：`schema.ts:L12-L18` 的本地 union type。
- 建议：直接 import/re-export shared 类型，并用于 Drizzle `$type`。
- 估算：净减少 `5–10` 行。
- 风险：低。
- 优先级：P1。  
  该项行数收益较小，但属于明确的契约漂移风险。

## P2

### 22. `WatchRuleUpdates` 重复维护 Watch 字段集合

- 位置：`apps/gateway/src/db/watch.ts:L16-L35`、`apps/gateway/src/api/watch-rule-config.ts:L21-L37`；共享请求类型位于 `packages/shared/src/contracts/watch.ts:L56-L95`。
- 证据：三处重复维护 `triggerType`、`pattern`、`intervalSeconds`、`unchangedMinutes`、`noMatchBehavior`、`fireMode` 等字段。
- 规范位置：优先使用 `@tmex/shared` 的 `UpdateWatchRuleRequest`，数据库侧再用 `Pick`/映射类型表达持久化差异。
- 删除内容：`CreateWatchRuleInput` 和 `WatchRuleUpdates` 中重复字段列表。
- 建议：明确 create/update 的 nullability 和默认值后，用组合类型派生，而不是手写字段集合。
- 估算：净减少 `20–30` 行。
- 风险：中。
- 优先级：P2。

### 23. 两个启动编排函数仍过长

- 位置：`apps/gateway/src/managed-entry.ts:L99-L243`，约 145 行；`apps/gateway/src/runtime.ts:L53-L180`，约 128 行。
- 证据：`runManagedGateway()` 同时处理动态 import、runtime 创建、Bun server、WebSocket ownership、重启循环和 cleanup；`createGatewayRuntime()` 同时处理迁移、全局 broadcaster 注册、多个 supervisor 启停和 runtime facade。
- 规范位置：分别拆出 `managed-server.ts` 的 server callbacks/restart loop，以及 `runtime-bootstrap.ts` 的 initialization/registration。
- 删除内容：从两个入口函数移出初始化和生命周期块。
- 建议：入口只保留阶段编排，令 server/runtime factory 分别承担资源创建和销毁。
- 估算：净减少 `60–80` 行。
- 风险：中。
- 优先级：P2。

### 24. BUG：静态资源请求的非法 percent encoding 会抛出未处理异常

- 位置：`packages/app/src/runtime/server.ts:L38-L49`、`L52-L62`。
- 证据：

  ```ts
  const decoded = decodeURIComponent(pathname);
  ```

  `resolveRequestedFile()` 没有捕获 `URIError`，恶意或损坏的 URL 可能直接使请求处理抛异常。
- 规范位置：`resolveRequestedFile()`。
- 删除内容：无大规模删除。
- 建议：捕获 `URIError` 并返回 `null`，由 `serveFrontend()` 返回 400 或 403。
- 估算：净增加 `3–5` 行。
- 风险：低。
- 优先级：P2。