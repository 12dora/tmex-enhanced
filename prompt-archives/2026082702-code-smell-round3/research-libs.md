## 按优先级

1. **P1｜真实 Bug：`NOTIFY_EVENT` 被客户端静默丢弃**

   - 位置：`packages/ws-client/src/transport-message-decoder.ts:9-138`、`transport-types.ts:66-109`
   - 现状：`KIND_NOTIFY_EVENT` 已在 `shared/src/ws-borsh/kind.ts:66-69` 定义，服务端 `theme-settings-broadcaster.ts:115-124` 会发送，但 decoder 没有对应分支；`decodeGatewayTransportMessage()` 在 `:135` 直接返回 `false`。
   - 规模：decoder 138 行；主函数 CC≈2。
   - 建议：增加 `notify-event` 类型及 `EventNotifyS2CSchema` 解码；在消费侧增加事件路由，必要时新增 `packages/notifications/src/event-notify-format.ts`。
   - 风险：高，涉及公共 WebSocket 事件联合类型和下游消费。
   - 测试：服务端 `apps/gateway/src/ws/event-notify-broadcast.test.ts:49-126`、共享协议 `packages/shared/src/ws-borsh/index.test.ts:588-612`；缺少客户端 decoder 和通知路由测试。

2. **P1｜真实 Bug：`SETTINGS_UPDATE` 被客户端静默丢弃**

   - 位置：`packages/ws-client/src/transport-message-decoder.ts:9-138`、`transport-types.ts:66-109`
   - 现状：服务端在 `apps/gateway/src/ws/theme-settings-broadcaster.ts:98-112` 发送 `KIND_SETTINGS_UPDATE`，但 decoder 没有该 kind；`SettingsUpdateS2CSchema` 已在 `packages/shared/src/ws-borsh/schema.ts:438-444` 定义。
   - 规模：decoder 138 行；主函数 CC≈2。
   - 建议：增加 `{ type: "settings-update"; namespace; serverTimestamp }` 事件；在 stores/宿主侧接入设置缓存失效和 REST 重取。
   - 风险：中高，缺失会导致多客户端设置缓存长期不一致。
   - 测试：服务端 `apps/gateway/src/ws/settings-broadcast.test.ts:44-95`；当前缺少客户端解码和缓存失效测试。

3. **P1｜真实 Bug：六位非法颜色字符串被解析为 `NaN`**

   - 位置：`packages/ghostty-terminal/src/ghostty-wasm.ts:206-216`
   - 现状：只校验长度，不校验十六进制字符。`#zzzzzz` 会返回 `[NaN, NaN, NaN]`，随后 `DataView.setUint8()` 将其转换为 `0`；`setTerminalTheme()` `:604-675` 的注释却声称解析器会拒绝非法颜色。
   - 规模：文件 1495 行；`parseHexRgb()` 11 行，CC≈2。
   - 建议：在解析前要求 `/^[0-9a-fA-F]{6}$/`；无需拆分 `ghostty-wasm.ts`。
   - 风险：低。
   - 测试：现有 `packages/ghostty-terminal/src/ghostty-wasm.alloc.test.ts:161-184` 只覆盖错误长度；增加 `#zzzzzz` 回归测试。

4. **P1｜真实 Bug：清理指针状态时未清除横向滚轮余量**

   - 位置：`packages/ghostty-terminal/src/terminal-input-bridge.ts:169-173,387-418`
   - 现状：`resetPointerAccumulation()` 只重置 `wheelPixelDelta`，遗漏 `wheelPixelDeltaX`；`gestureToColumns()` 后续会继续消费旧横向余量。
   - 规模：文件 419 行；重置函数 5 行，CC=1。
   - 建议：同时重置两个 accumulator；与滚轮逻辑一起抽到 `packages/ghostty-terminal/src/wheel-delta.ts`。
   - 风险：低。
   - 测试：现有横向滚轮测试 `terminal.canvas.test.ts:1094-1134`，选择状态测试约 `:2189`；增加“部分横向滚动 → clearSelection → 新滚动”测试。

5. **P2｜真实 Bug：历史门控 flush 丢失 `paneEpoch`/序号元数据**

   - 位置：`packages/ws-client/src/pane-sink-registry.ts:163-198,245-301`
   - 现状：存在 history gate 时，`dispatchPaneTerminalData()` 在 `:174-176` 只缓存 `frame.data`，丢弃 `paneEpoch`、`seqStart`、`seqEnd`；匹配历史或超时 flush 时又通过 `dispatchPaneOutput()` 重新生成无元数据 frame。
   - 规模：文件 407 行；`dispatchPaneTerminalData()` CC≈8；gate 生命周期约 57 行。
   - 建议：新增 `packages/ws-client/src/pane-history-gate.ts`，缓存完整 `GatewayTerminalData`，flush 时重新调用 `dispatchPaneTerminalData(frame)`。
   - 风险：中，可能破坏依赖序号的输出消费者。
   - 测试：现有 `pane-sink-registry.test.ts:44-76,130-149,228-238`；增加匹配历史和超时两条路径的元数据断言。

6. **P2｜真实 Bug：`SelectCallbacks` 允许半套回调，但 deferred history 永远无法提交**

   - 位置：`packages/ws-client/src/state-machine.ts:93-105,299-333,510-547`
   - 现状：类型允许只提供 `onResetTerminal` 或 `onApplyHistory`。但 `handleHistory()` 和 `replayDeferred()` 都要求两者同时存在；否则 deferred history 保留，后续缓冲输出也不会回放。
   - 规模：文件 661 行；`handleHistory()` CC≈7，`replayDeferred()` CC≈8。
   - 建议：将 history 操作改成一个原子 `HistoryCallbacks`；或在构造时强制两个回调成对存在，并明确拒绝不完整配置。无需拆分整个状态机。
   - 风险：中，涉及公共回调 API。
   - 测试：现有 `state-machine.test.ts:73-111` 只覆盖完整回调；`:156-186` 的单回调测试没有 history 场景。增加半套回调与 `wantHistory=true` 回归测试。

7. **P2｜真实 Bug：canonical event 解码未验证 PaneData 序号范围**

   - 位置：`packages/shared/src/ws-borsh/canonical-state.ts:348-381`
   - 现状：`encodeCanonicalEventPayload()` 在 `:350-355` 校验 `seqEnd - seqStart === data.byteLength`，但 decode 路径只校验边界和 canonical 编码。原始 schema payload 可携带不匹配的 `seqEnd` 并成功解码。
   - 规模：文件 382 行；编码/解码函数各约 17 行，CC≈4。
   - 建议：新增 `packages/shared/src/ws-borsh/canonical-state-validation.ts`，统一由 encode/decode 调用 `assertCanonicalEventSemantics()`。
   - 风险：中，涉及协议兼容和数据完整性。
   - 测试：`apps/gateway/src/ws/borsh/canonical-state.test.ts:187-245` 当前只测试编码拒绝；增加直接构造非法 schema payload 的 decode 测试。

8. **P2｜重复逻辑：纵向与横向滚轮换算几乎完全重复**

   - 位置：`packages/ghostty-terminal/src/terminal-input-bridge.ts:356-418`
   - 现状：`gestureToLines()` 和 `gestureToColumns()` 都处理 pixel/line/page 三种 deltaMode、余量累积和 viewport 换算，分别约 30/32 行，CC 各约 7。
   - 建议：抽出 `wheel-delta.ts` 的通用 `consumeWheelDelta({ delta, cellSize, deltaMode, viewportUnits, accumulator })`，轴向方法只提供尺寸和 accumulator。
   - 风险：中，需保持负数、取整和反向滚动语义。
   - 测试：现有 `terminal.canvas.test.ts:467-655,1094-1134`；为 helper 增加 pixel/line/page、余量和符号变化测试。

9. **P2｜高复杂度：legacy pane 字段分派链难以扩展**

   - 位置：`packages/shared/src/ws-borsh/state-snapshot-diff.ts:161-190`
   - 现状：`applyPaneFields()` 30 行，包含循环、约 6 个 `else-if`、多处 `&&`/`||`，CC 约 28；字段映射和类型转换集中在一条条件链中。
   - 建议：新增 `packages/shared/src/ws-borsh/legacy-pane-fields.ts`，按字段编号建立 typed handler table，并抽出 number/string/null setter；保留外层 diff 的删除、移动、upsert 顺序。
   - 风险：中，容易改变 wire field 映射。
   - 测试：`state-snapshot-diff.test.ts:49-109` 只覆盖部分字段；增加所有 pane 字段的表驱动测试。

10. **P2｜巨型函数：鼠标事件绑定器同时承载七类事件业务**

   - 位置：`packages/ghostty-terminal/src/terminal-pointer.ts:99-291`
   - 现状：`bindMouseEvents()` 约 193 行，包含 click、mousedown、mousemove、mouseleave、wheel、拖动 move/up 等嵌套处理器；外层 CC≈2，但注册、坐标、拖动恢复、滚轮转换和 teardown 全部耦合在一个函数中。
   - 建议：新增 `packages/ghostty-terminal/src/terminal-pointer-handlers.ts`，通过 `PointerEventContext` 工厂化生成各 listener；`bindMouseEvents()` 只负责注册和清理。
   - 风险：中，需保持 listener 顺序及 window 级拖动监听行为。
   - 测试：`terminal.canvas.test.ts:659-912,935-1134`；E2E 包括 `terminal-mouse-gestures.spec.ts`、`mobile-mouse-reporting.spec.ts`、`terminal-mouse-drag-recovery.spec.ts`。

11. **P3｜死参数/语义不一致：chunk cleanup 的 `force` 参数完全未使用**

   - 位置：`packages/shared/src/ws-borsh/chunk.ts:57-87,181-189`
   - 现状：`addChunk()` 在容量检查前调用 `cleanup(true)`，但 `cleanup(_force = false)` 完全忽略参数，调用者无法表达“强制清理”语义。
   - 规模：文件 296 行；`cleanup()` 9 行，CC≈2；`addChunk()` CC≈13。
   - 建议：若无强制语义，移除参数和 `cleanup(true)`；否则实现明确的 `evictOldestStream()`，并让容量策略可测试。该文件整体协议逻辑内聚，不建议拆分。
   - 风险：低至中。
   - 测试：`packages/shared/src/ws-borsh/index.test.ts:218-235,256-310`；增加并发 stream 超限测试，锁定预期策略。

## 刻意跳过

- `ghostty-wasm.ts`、`canvas-renderer.ts`、`render-state.ts`：分别围绕 WASM ABI/内存生命周期、画布缓存与失效、WASM snapshot handle 生命周期组织，继续拆分会破坏共享不变量；仅报告了独立的颜色解析 Bug。
- `terminal.ts`：前两轮已完成主要拆分，当前是终端生命周期编排器，继续拆分收益不足。
- `state-machine.ts`：事务、输出门控、deferred history 和定时器共享严格顺序不变量；仅报告回调契约 Bug。
- `ws-client/client.ts`、`message-builder.ts`、`transport-types.ts`：分别是连接 façade、命令目录和协议类型目录，拆分会增加跳转成本。
- `shared/src/ws-borsh/schema.ts`、`chunk.ts`：都是按协议域组织的 cohesive wire catalog；不建议仅因文件偏大而拆分。
- `packages/api-client/**`、`packages/notifications/**`：当前主要是薄 endpoint/格式化边界，未发现达到本轮阈值且拆分收益明确的问题。