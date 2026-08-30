由于当前会话文件系统为只读，写入 `S1-report.md` 的操作被拒绝；目标文件未生成。以下为完整报告正文。

# S1 Code Smell Report

## 结论

本轮没有 HIGH 项。

当前复杂度门禁结果：

- `1061` 个文件、`8824` 个函数
- 门禁通过：`bun scripts/complexity/gate.ts`
- backend 无新的未 allowlist 超标项
- `apps/gateway/src/mesh/auth-routes.ts` 与 `apps/gateway/src/ws/index.ts` 当前均为 `898` 行，尚未超过 `900` 行阈值

## 排名项

### [MED] `TMEX_ROLES` 解析与角色模型在 gateway、app、mesh 中重复维护

证据：

- `apps/gateway/src/config.ts:75-92` 定义 `TmexRoles` 和 `parseTmexRoles`
- `packages/app/src/lib/roles.ts:1-31` 再次定义 `TmexRoleName`、`TmexRoles`、`parseTmexRoleName`、`parseTmexRoles`、`isStandaloneRoles`、`roleNameFromFlags`
- `apps/gateway/src/mesh/mesh-deps.ts:52-58,252-254` 再次定义 `MeshRoles` 和 `isStandaloneRoles`
- `packages/app/src/runtime/assemble.ts:4-8,362-363` 直接依赖 `apps/gateway/src/config.ts` 的角色解析，而 app 其他命令使用自身的 `lib/roles`

两套 parser 对空值的行为已经不同：gateway 对空字符串/空白字符串报错，app 将其视为 `standalone`。同一个 `TMEX_ROLES` 值在不同启动路径可能得到不同结果；后续增加角色时还需要同步修改多个实现。

建议：

- 将纯角色类型、角色名转换、`isStandaloneRoles` 和角色映射放到 `packages/shared` 的无 Node 依赖模块。
- gateway 保留自身的环境变量输入校验，以维持“空字符串 fail-closed”语义；app 保留其默认值归一化。
- 删除 `assemble.ts` 对 gateway config 的角色 parser 直接依赖。
- 补充 undefined、空字符串、空白字符串和非法角色的跨包一致性测试。

风险：中。重点风险是保持 gateway 的空值拒绝语义，以及 CLI 初始化/升级流程的默认角色行为。

### [MED] RTC 入站路径仍重复执行 WS envelope 解码

证据：

- `apps/gateway/src/mesh/stream-targets.ts:533-548` 已解码 envelope 后调用 `attached.onDecodedEnvelope`
- `apps/gateway/src/mesh/mesh-runtime.ts:702-706` 的 `deliverInbound` 仍将 RTC 字节复制后调用 `gateway.wsServer.handleMessage`
- `apps/gateway/src/ws/index.ts:224-261` 的 `handleMessage` 再次执行 magic 检查、envelope 解码和分发

最近的优化只消除了 mux/WS stream 路径的二次解码，RTC 路径仍保留另一套 bytes→envelope→dispatch 入口。协议校验、payload 所有权和错误处理的变更需要同时维护两条路径；未来容易出现浏览器 WS、mux WS、RTC 行为不一致。

建议：

- 在 WS server 内统一“已解码 envelope 分发”入口。
- RTC 入口复用统一解码/分发逻辑，同时保留当前 invalid-frame 的错误响应行为。
- 明确 RTC `Uint8Array` 的生命周期；无法保证 buffer 所有权时继续复制 payload，不能直接复用 borrowed view。
- 为 RTC invalid envelope、payload 生命周期和关闭竞态补测试。

风险：中。错误响应语义和 zero-copy view 的生命周期不能因重构而改变。

### [LOW] `StreamReplayState` 重复维护 envelope 解码和异常回退

证据：

- `apps/gateway/src/mesh/stream-replay-state.ts:28-34`
- `apps/gateway/src/mesh/stream-replay-state.ts:94-100`
- `apps/gateway/src/mesh/stream-replay-state.ts:166-172`
- `apps/gateway/src/mesh/stream-replay-state.ts:244-252`

上述位置分别重复 `decodeEnvelope` 加 `try/catch`。各调用点的失败回退不同，但 envelope 解码本身可以复用。

建议：

- 增加私有 `tryDecodeEnvelope(bytes)`，返回 `Envelope | null`。
- 保留各调用点现有的 fallback 行为，仅统一解码和异常吞并逻辑。

风险：低。需要确认 `rewriteQueuedFrame` 的坏帧回退仍返回原始字节。

### [LOW] 外部 cloudflared detector 保留了无调用的旧 API、全局 cache 和重复 projection

证据：

- `apps/gateway/src/tunnel/external-detect.ts:58-66` 的模块级 `cache` 与 `resetExternalDetectCache`
- `apps/gateway/src/tunnel/external-detect.ts:90-95` 的 `detectExternalCloudflared` 在仓库内无调用方
- `apps/gateway/src/tunnel/external-detect.ts:672-682` 的 `toExternalStatus` 在仓库内无调用方
- `apps/gateway/src/tunnel/external-detect.ts:691-699` 的 `ExternalTunnelDetector` 已使用独立 `localCache`
- `apps/gateway/src/tunnel/manager.ts:106-120` 重复定义 `EMPTY_EXTERNAL`
- `apps/gateway/src/tunnel/manager.ts:608-620` 重复实现 `externalStatus`

该文件于 2026-08-30 新增，旧函数和新 class 同时存在，导致两套 cache 语义并存；manager 还重复维护状态投影。

建议：

- 删除无调用的 `detectExternalCloudflared`、模块级 cache 和 `resetExternalDetectCache`。
- 让 manager 复用 `toExternalStatus`，或删除该无调用 helper 并保留唯一 projection。
- 合并 `EMPTY_EXTERNAL` 的构造逻辑。
- 保留 class 现有的 per-instance cache 和 invalidate 测试。

风险：低到中。主要风险是仓库外部隐藏调用方；gateway 不是公开 package API，仍建议先做一次发布面检查。

### [LOW] 无调用的 `decodeEnvelopeAndPayload` 导出

证据：

- `packages/shared/src/ws-borsh/codec.ts:158-171`
- `packages/shared/src/ws-borsh/index.ts:254`

仓库内没有实际 importer，仅有定义和 barrel re-export。该 helper 还停留在旧的 envelope/payload 一体解码 API，而当前调用方普遍分别使用 `decodeEnvelope` 与 `decodePayload`。

建议：

- 确认 `@tmex/shared` 的外部发布兼容要求后删除函数及 re-export。
- 如果必须保留 public API，则标记为 deprecated，并禁止新增调用。

风险：低到中。风险来自仓库外部消费者，而非当前 monorepo。

### [LOW] Cloudflare Access rule 旧导出名仅作为 alias 存在

证据：

- `apps/gateway/src/tunnel/access-rules.ts:54-83` 定义 `rulesToCfInclude`、`rulesFromCfInclude`
- `apps/gateway/src/tunnel/access-rules.ts:85-86` 暴露新名称 `toCloudflareInclude`、`fromCloudflareInclude`
- 仓库内调用方只使用新名称，旧名称无独立 importer

建议：

- 保留新名称，将旧函数声明改为非导出实现，或直接以内联 alias 形式保留单一导出面。
- 发布前确认没有外部直接依赖旧名称。

风险：低。

## allowlist 收紧

以下为 backend 范围内“当前值低于锁定值”的条目，格式为 `当前值 / locked 值`。

函数行数：

- `apps/gateway/src/agent/tools/send-input.ts:createSendInputTool`：`130 / 138` lines
- `apps/gateway/src/managed-entry.ts:runManagedGateway`：`154 / 162` lines
- `apps/gateway/src/mesh/rtc/channel-fanout.ts:fanoutDataChannel`：`135 / 143` lines
- `apps/gateway/src/mesh/rtc/dc-handshake.ts:handshakeDataChannel`：`128 / 136` lines
- `apps/gateway/src/mesh/stream-targets.ts:openHttpStream`：`137 / 145` lines
- `apps/gateway/src/runtime.ts:createGatewayRuntime`：`154 / 162` lines
- `apps/gateway/src/tmux-client/external-tmux-core.ts:bindCollaboratorHost`：`134 / 142` lines
- `apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts:emitOsc`：`131 / 139` lines
- `apps/gateway/src/ws/tmux-kind-handlers.ts:createTmuxKindHandlers`：`183 / 191` lines
- `packages/app/src/runtime/assemble.ts:assembleTmex`：`150 / 158` lines
- `packages/shared/src/link/websocket-link.ts:createQueuedTransport`：`133 / 141` lines
- `packages/shared/src/uplink/codec.ts:decodeHubInner`：`145 / 153` lines
- `packages/shared/src/uplink/codec.ts:decodeMeshUplinkCtl`：`163 / 171` lines

圈复杂度：

- `apps/gateway/src/ws/index.ts:handleMessage`：`CC 9 / 16`

文件行数：

- `apps/gateway/src/hub/uplink-server.ts`：`1207 / 1226` lines
- `apps/gateway/src/mesh/mesh-runtime.ts`：`1346 / 1347` lines
- `apps/gateway/src/mesh/peer-manager.ts`：`2297 / 2323` lines
- `apps/gateway/src/tunnel/manager.ts`：`1215 / 1255` lines

这些条目可在后续稳定后直接收紧锁定值；其中协议 parser、生命周期组合根和已明确保留的 cohesive file 不建议因此启动新的拆分重构。