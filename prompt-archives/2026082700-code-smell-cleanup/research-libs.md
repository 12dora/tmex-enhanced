# 前 8 项代码异味（按影响排序）

## 1. `GhosttyTerminalController`：终端领域 God Object

- 文件/符号：[terminal.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ts:206) `GhosttyTerminalController`
- 范围/行数：206–2261，共 2056 行。
- 异味：同时负责 WASM 生命周期、DOM 创建与销毁、键盘/鼠标/IME、选择区、剪贴板、链接检测、渲染调度、滚动条、自动滚动、输入路由和兼容 xterm API。任意一个子系统的变更都可能影响整个类，状态字段之间耦合度很高。
- 安全重构：保留当前类作为兼容门面，抽取以下模块：
  - `terminal-lifecycle.ts`：WASM 与 DOM 生命周期；
  - `terminal-input.ts`：键盘、IME、paste、beforeinput；
  - `terminal-pointer.ts`：鼠标、触摸、滚轮、自动滚动；
  - `terminal-selection.ts`：选择区与剪贴板；
  - `terminal-render-loop.ts`：dirty state、rAF、渲染与链接 overlay。
  
  通过明确的 controller context 共享状态，保持现有公开方法、事件顺序和 dispose 行为不变。
- 现有测试：`terminal.canvas.test.ts` 已覆盖 open、dispose、输入、IME、滚轮、鼠标报告、选择、渲染等；`terminal.ime.issue45.test.ts` 和 `issue45-cross-bug.test.ts` 覆盖 IME 与强制重绘回归。测试覆盖较广，但仍集中在一个超大测试文件中。

## 2. `GhosttyBindings`：WASM ABI、内存管理和业务编码混合

- 文件/符号：[ghostty-wasm.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/ghostty-wasm.ts:331) `GhosttyBindings`
- 范围/行数：331–1396，共 1066 行。
- 异味：同一类同时封装 WASM 原始内存分配、结构体字段访问、终端操作、formatter、viewport selection、render-state、鼠标协议、键盘协议和粘贴编码。底层资源安全与上层终端语义混在一起，异常清理难以审计。
- 安全重构：抽取一个共享的 `WasmMemory` facade，再拆分：
  - `terminal-bindings.ts`
  - `formatter-bindings.ts`
  - `render-bindings.ts`
  - `input-encoders.ts`
  
  每个模块只依赖 `WasmMemory` 和 ABI exports；暂时保留 `GhosttyBindings` 作为兼容 facade，避免调用方大面积修改。
- 现有测试：主要通过 `terminal.canvas.test.ts` 中的 fake bindings 间接测试；鼠标协议和 render-state 有测试，但实际 WASM 内存异常路径缺少直接覆盖。

## 3. `bindDomEvents`：381 行事件注册与业务判断集中在单一函数

- 文件/符号：[terminal.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ts:997) `bindDomEvents`
- 范围/行数：997–1377，共 381 行。
- 异味：一个函数注册 root、screen、window、textarea 的全部监听器，并同时处理鼠标报告、选择、链接、键盘、IME、Android `beforeinput`、paste、copy 和输入去重。嵌套条件多，事件顺序和 `preventDefault`/`stopPropagation` 关系难以维护。
- 安全重构：按事件域拆成：
  - `bindMouseEvents`
  - `bindKeyboardEvents`
  - `bindCompositionEvents`
  - `bindClipboardEvents`
  - `bindInputEvents`
  
  所有注册函数返回 disposer，由原函数按现有顺序统一收集，确保行为和销毁顺序不变。
- 现有测试：`terminal.canvas.test.ts` 覆盖键盘、IME、Android beforeinput、鼠标报告、滚轮、触摸和剪贴板；IME 专项测试覆盖 issue45 回归。

## 4. `BorshWebSocketClient`：连接生命周期与协议状态耦合

- 文件/符号：[client.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/client.ts:90) `BorshWebSocketClient`
- 范围/行数：90–583，共 494 行。
- 异味：同一类管理 WebSocket 创建、事件绑定、HELLO 协商、消息解码、chunk 重组、心跳、重连退避、页面可见性、发送队列、状态转换和 URL 切换。连接 epoch、定时器和协议状态相互影响，容易产生旧连接事件污染新连接的问题。
- 安全重构：抽取：
  - `WebSocketSession`：socket 创建、事件绑定和身份校验；
  - `HeartbeatController`：ping/pong 与超时；
  - `ReconnectController`：退避和重连次数；
  - `ProtocolDispatcher`：HELLO、chunk、事件解码。
  
  对外继续保留 `BorshWebSocketClient` API。
- 现有测试：`client.test.ts` 覆盖 socket factory、connect 幂等、HELLO、disconnect、chunk progress；未覆盖重连、心跳、visibilitychange 和旧 socket 事件。

## 5. `transport.ts`：协议适配器承担过多职责

- 文件/符号：[transport.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/transport.ts:240)
- 范围/行数：文件共 644 行；`encodeGatewayTransportCommand` 为 240–309，共 70 行；`WebSocketGatewayTransport.handleMessage` 为 394–487，共 94 行。
- 异味：模块同时负责命令编码、消息解码、WebSocket transport、lazy transport、共享 owner 状态和事件转发。编码和解码都采用大型 switch，协议类型增加时需要在多个位置同步修改。
- 安全重构：
  - `transport-command-encoder.ts`：每个命令对应一个 typed handler；
  - `transport-message-decoder.ts`：按消息 kind 建立 handler map；
  - `websocket-transport.ts`：只负责 socket 生命周期；
  - `shared-transport.ts`：只负责共享连接和 owner。
  
  原 `transport.ts` 作为 re-export facade，并保留未知类型的现有错误行为。
- 现有测试：`transport.test.ts` 只覆盖 shared transport、命令转发和一个 rename 编码路径；`handleMessage` 的多数分支没有直接测试。

## 6. `CanvasRenderer`：渲染层、DPR、字体度量和光标绘制混合

- 文件/符号：[canvas-renderer.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/canvas-renderer.ts:85) `CanvasRenderer`
- 范围/行数：85–636，共 552 行。
- 异味：同时管理四个 canvas layer、DPR resize、字体度量、背景、文本、装饰线、block element、selection、link 和 cursor。渲染顺序、邻行重绘和缓存策略都集中在同一类。
- 安全重构：保留当前 render pipeline，拆出：
  - `CanvasSurface`
  - `TextLayerRenderer`
  - `DecorationRenderer`
  - `SelectionRenderer`
  - `CursorRenderer`
  
  由 `CanvasRenderer` 只编排 dirty 行、绘制顺序和 layer 生命周期。
- 现有测试：`terminal.canvas.test.ts` 覆盖完整/部分重绘、DPR、block element 和基础 cursor 绘制；`canvas-renderer.vcenter.test.ts` 覆盖字体垂直定位与装饰线，但未验证不同 cursor style 和 blinking 行为。

## 7. `shared/src/index.ts`：不是纯 barrel，而是共享合同 God Module

- 文件/符号：[index.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/index.ts:1)
- 范围/行数：1–1230，共 1230 行。
- 异味：文件主体不是 re-export，而是直接声明 system/update、设备、站点设置、通知、tmux、WebSocket、LLM、agent、watch、文件等大量跨域接口、类型、常量和少量运行时逻辑。它的运行时逻辑很少，但 fan-in 和类型变更影响面极大。
- 结论：它不是严格意义上的 barrel。只有开头和结尾部分承担导出职责，中间大量内容是实际类型目录。
- 安全重构：按领域拆成 `system.ts`、`devices.ts`、`site-settings.ts`、`tmux.ts`、`notifications.ts`、`agent.ts`、`watch.ts`、`files.ts` 等，`index.ts` 最终只保留 re-export。`ws-borsh/convert.ts` 应直接引用领域模块，避免所有类型都经由总入口导入。
- 现有测试：主要是 `i18n/exports.test.ts` 和各功能模块的间接类型使用；缺少完整公共导出表测试。

## 8. `readMeta`：WASM render-state 读取函数过长

- 文件/符号：[render-state.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/render-state.ts:316) `readMeta`
- 范围/行数：316–452，共 137 行。
- 异味：一个函数内完成颜色、256 色 palette、dirty state、尺寸、cursor 坐标、cursor style、blink、password mode 和 alternate screen 的全部 WASM 标量读取。每个字段都重复分配临时指针、读取、断言和释放，异常路径和字段映射不易检查。
- 安全重构：抽取通用 `readScalar`/`readEnum`/`readOptionalU16` 辅助函数，再拆成 `readColors`、`readViewportMeta`、`readCursorMeta`、`readModeMeta`。保持字段读取顺序和快照结构不变。
- 现有测试：`terminal.canvas.test.ts` 覆盖 render-state 创建、更新、cursor 和释放的 happy path；没有覆盖单个字段读取失败时的清理行为。

# 其他已确认的代码异味

## `api-client/src/files.ts` 的上传/下载流处理重复

- 文件/符号：[files.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/files.ts:149)
- 范围/行数：`uploadFileChunked` 为 149–238，共 90 行；`downloadFileWithProgress` 为 249–336，共 88 行。
- 异味：两个函数都内联实现 NDJSON 分包、`TextDecoder`、逐行解析、progress 回调、AbortSignal 和异常清理；同时文件还承担普通文件 CRUD。
- 安全重构：抽取共享 `readNdjsonStream`，再拆出 `upload-transfer.ts`、`download-transfer.ts` 和 `file-resources.ts`。下载的远端 session 删除必须继续保持 best-effort 语义。
- 测试：目前只有 `files-download.test.ts`，覆盖下载成功和 content 阶段失败；没有上传测试，也没有 prepare 阶段异常测试。

## `terminal.ts` 中逻辑行拼接重复

- 文件/符号：[terminal.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ts:1768)
- 范围/行数：`updateLinkOverlay` 为 1768–1816，共 49 行；`linkAtPoint` 为 2117–2151，共 35 行。
- 异味：两个位置都向前寻找 wrapped logical line 起点、向后寻找终点，再组装模型并扫描链接。
- 安全重构：抽取 `collectWrappedLogicalLine(line): { startLine; endLine; models }`，由 overlay 更新和 point lookup 共用，保留现有缓存和边界行为。

## `shared/ws-borsh/convert.ts` 的事件映射重复

- 文件/符号：[convert.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/ws-borsh/convert.ts:79)
- 范围/行数：`encodeEventData` 为 79–176，共 98 行；`decodeEventData` 为 272–326，共 55 行。
- 异味：编码和解码分别维护事件类型 switch，并重复维护 event type map；大量 `as` 强制转换使新增事件容易只修改一侧。
- 安全重构：建立每种事件的 `{ encode, decode }` codec table，集中维护类型标签和 schema；未知标签和历史兼容分支继续保留现有行为。

## 测试文件过大

- 文件：[terminal.canvas.test.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.canvas.test.ts:1)，约 2753 行。
- 异味：同时包含 controller、输入、鼠标协议、render-state、CanvasRenderer、selection 和 clipboard 测试，测试 fake DOM 也与其他 IME 测试重复。
- 安全重构：拆成 `terminal-input.test.ts`、`mouse-protocol.test.ts`、`render-state.test.ts`、`canvas-renderer.test.ts` 和 `selection.test.ts`，共享 `fake-dom.ts`。这属于测试可维护性改进，不影响生产代码行为。

# 高置信 BUG

## 1. render-state 部分初始化失败时泄漏已分配的 WASM handle

- 文件/行：[render-state.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/render-state.ts:528) `createRenderState`，528–537。
- `createRenderState()` 先创建 `renderStateHandle`，再创建 `rowIteratorHandle`，最后创建 `rowCellsHandle`，但没有 `try/catch/finally`。如果第二次或第三次 WASM 分配失败，之前已成功创建的 handle 没有释放，后续也没有返回资源对象供调用方清理。应改为逐步保存 handle，并在初始化失败时按已创建资源的逆序释放。

## 2. `formatViewport` 创建 formatter 失败时泄漏 selection

- 文件/行：[ghostty-wasm.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/ghostty-wasm.ts:898) `formatViewport`，898–920。
- `selection` 在 905 行创建，但 `createFormatter()` 在 910 行、外层 `try` 之前执行。如果 formatter 创建期间抛错，917–920 的 finally 根本不会执行，已分配的 selection 不会释放。应把 formatter 创建纳入覆盖 selection 的 `try/finally`，同时保留 formatter 自身的清理逻辑。

## 3. Cursor 的视觉样式被完全忽略

- 文件/行：[canvas-renderer.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/canvas-renderer.ts:558) `drawCursor`，558–604。
- `GhosttyCursorVisualStyle` 明确定义了 `bar`、`block`、`underline`、`block-hollow`，render-state 也会把 WASM 枚举映射为这些值；但 `drawCursor()` 无论 `cursor.style` 是什么，都只绘制底部横线形状。`lastCursor.style` 仅用于变化检测，不能改变实际绘制结果，因此上游切换光标样式不会反映到画面。应按四种样式分别计算矩形或描边，并为每种样式增加像素操作断言测试。

## 4. `blinking: false` 仍会启动光标闪烁

- 文件/行：[canvas-renderer.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/canvas-renderer.ts:577) `drawCursor`，577–588。
- render-state 提供 `cursor.blinking` 字段，但 `drawCursor()` 没有读取它，只要 cursor visible 就无条件调用 `startCursorBlink()`。因此非闪烁光标也会启动定时器并改变显示状态。应在 `blinking` 为 false 时停止现有 timer、保持 alpha 稳定；同时把 `blinking` 纳入 `lastCursor` 变化检测。

## 5. 下载 prepare 阶段异常不会删除远端 session

- 文件/行：[files.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/api-client/src/files.ts:249) `downloadFileWithProgress`，249–300。
- 远端 `downloadId` 可能已经在 prepare 流的 `done` 事件中设置，但 prepare 阶段的 `reader.read()`、`JSON.parse()`、错误事件处理或流结束异常发生在 303 行的 cleanup `try` 之前时，函数会直接抛出，永远不会执行 DELETE。这样会遗留服务器端临时下载文件或 session。应把 prepare 流和 content 流统一放入以 `downloadId` 为条件的外层 cleanup 结构中。

## 6. WebSocket 旧连接的异步事件可能污染新连接

- 文件/行：[client.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/client.ts:191) `connect`，191–223；[client.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/client.ts:345) `handleClose`，345–359。
- 事件处理器通过 `this.ws` 间接操作客户端，没有捕获并校验创建它们的具体 socket。旧 socket 已进入 CLOSED、但其 `onclose` 事件尚未派发时，调用 `connect()` 可以创建并赋值新 socket；随后旧 socket 的 `onclose` 会调用当前实例的 `handleClose()`，停止新连接的 heartbeat、清空新连接的 chunk 状态并再次安排重连。`onmessage`/`onerror` 也存在同类风险。应为每个 socket 捕获连接 epoch 或对象身份，仅处理仍等于当前 `this.ws` 的事件。

## 7. `setTerminalTheme` 的输入异常路径泄漏 WASM 分配

- 文件/行：[ghostty-wasm.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/ghostty-wasm.ts:604) `setTerminalTheme`，604–664。
- foreground、background、cursor 和 palette 在 605–610 行分配，颜色解析在 618–620 行执行，但清理用的 `finally` 从 630 行才开始。如果运行时传入格式错误的颜色，`parseHexRgb()` 会在进入 finally 前抛错，所有已分配资源都会泄漏。TypeScript 类型无法保证外部运行时输入合法。应将分配后的所有初始化和解析放入统一的 `try/finally`，并对尚未成功分配的资源使用可空句柄清理。

# 检查结论

- 生产代码中明确超过 800 行的主要文件是 `terminal.ts`、`ghostty-wasm.ts` 和 `shared/src/index.ts`。
- 明确超过 120 行的生产函数主要是 `bindDomEvents`（381 行）和 `readMeta`（137 行）。
- `state-machine.ts` 的类约 458 行，但职责仍相对集中，当前没有足够依据将其列入前八；已有测试覆盖 deferred history、pane output、flush、timeout 和恢复失败。
- `notifications/src` 文件均较小，当前没有明显的大文件、超长函数或高复杂度异味。
- 未将任何生成文件，包括 `packages/shared/src/i18n/resources.ts`、`types.ts`、`resources/fe-dist` 和 `dist`，作为重构对象。