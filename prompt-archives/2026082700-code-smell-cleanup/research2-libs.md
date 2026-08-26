## 统计基线

按要求先执行 `find … | xargs wc -l | sort -rn`，排除生成文件和测试文件后，当前最大文件为：

| 文件 | 行数 |
|---|---:|
| [`terminal.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ts:1) | 1,584 |
| [`ghostty-wasm.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/ghostty-wasm.ts:1) | 1,485 |
| [`canvas-renderer.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/canvas-renderer.ts:1) | 669 |
| [`render-state.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/render-state.ts:1) | 611 |
| [`state-machine.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/state-machine.ts:1) | 609 |

Round 1 中：

- `f6dac7b` 已拆出输入、指针、链接、选择和渲染循环模块，但 `terminal.ts` 仍然保留大量跨领域协调逻辑，属于拆分后的残留问题。
- `2017186` 已拆分 WebSocket、传输和文件传输模块；`api-client/src/files.ts` 当前只有 15 行，是有价值的兼容导出入口，不属于无效 facade。
- `3762c67` 已拆分 shared 的协议模块；`shared/src/index.ts` 和 `ws-borsh/index.ts` 主要是稳定导出入口，不重复报告。
- `946e591` 已处理部分 WASM 资源释放和光标行为；以下只报告仍存在的问题。

## 排名

### 1. 高价值：终端控制器仍是大型 God Object

- 文件：[`terminal.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ts:173)
- 符号：`GhosttyTerminalController`
- 范围：L173–1576，约 1,404 行；文件共 1,584 行
- 另有超长函数：`open`，L303–419，共 117 行

`GhosttyTerminalController` 同时负责 WASM 句柄生命周期、DOM 构建、事件绑定、键鼠编码、手势滚动、选区、链接、滚动条、Canvas 渲染、兼容 xterm API 和资源释放。Round 1 虽然拆出了若干事件处理模块，但控制器仍然承担了大部分基础设施和业务协调，后续修改任一方向都容易影响其他状态。

安全重构方式是保留当前公开 API，将内部职责继续按端口拆分：`TerminalDomSurface` 负责 `open`、DOM 生命周期、尺寸和滚动条；`TerminalInputBridge` 负责键鼠编码及事件到 WASM 的适配；`TerminalRenderCoordinator` 负责快照、行缓存、链接覆盖层和 renderer 调度。控制器只保留生命周期和模块编排，保持现有销毁顺序、回调语义和公开方法不变。

### 2. 高价值：`resize` 不是原子操作，并且未失效选区行缓存

- 文件：[`terminal.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/terminal.ts:619)
- 符号：`resize`
- 范围：L619–635，共 17 行
- 相关缓存：`lineCache` L237；写入 L1294–1296；读取 `getLineModel` L1494–1505

`resize` 在调用可能抛错的 `bindings.resizeTerminal()` 之前就更新了 `this.cols` 和 `this.rows`。一旦 WASM resize 失败，下一次使用相同尺寸调用会在 L626 提前返回，导致控制器尺寸与 WASM 终端尺寸永久不一致。同时，resize 会改变软换行和 scrollback 行模型，但代码只清除选区状态，没有清除按绝对行号缓存的 `lineCache`，因此后续选区文本、选区高亮或链接检测可能读取 resize 前的行模型。

安全修复是先完成 WASM resize 和鼠标编码器重置，成功后再提交 `cols/rows`、清除 `lineCache` 和选区并调度渲染。由于尺寸变化本身已经清除选区，直接清空该缓存是最简单且行为稳定的方案。

### 3. 高价值：选择状态机存在旧超时回调误伤新事务的竞态

- 文件：[`state-machine.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/state-machine.ts:131)
- 符号：`SelectStateMachine`
- 范围：L131–588，约 458 行；文件共 609 行
- 相关范围：`SELECT_START` 定时器 L253–261，`handleTimeout` L410–413，`setTimer` L541–545

`setTimer` 按 `deviceId` 保存并取消定时器，但回调本身没有绑定事务 token 或代数。旧定时器如果已经进入事件队列，随后新的 `SELECT_START` 会创建同设备的新事务；旧回调执行时，`handleTimeout` 只按 `deviceId` 查找当前事务，可能把新事务错误标记为超时。这会表现为重试事务被错误触发 `ack_timeout` 或 `progress_timeout`。现有手动 scheduler 测试会真正删除被取消的任务，覆盖不到“取消时回调已经排队”的情况。

安全重构是给每个设备事务增加递增 generation，定时器捕获创建时的 generation 和阶段；执行回调前同时校验当前事务仍是该 generation 且阶段匹配，否则直接忽略。`clearTimer` 和事务完成/取消时递增或失效 generation，并补充一个“取消后旧回调仍执行”的回归测试。

### 4. 中价值：铃声自动清除定时器会提前清除新铃声

- 文件：[`bell-store.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/notifications/src/bell-store.ts:9)
- 符号：`triggerBell`、`clearBell`
- 范围：`triggerBell` L11–20，共 10 行；`clearBell` L21–26，共 6 行；文件共 27 行

每次 `triggerBell(paneId)` 都创建一个独立的 1.5 秒定时器，但定时器只按 `paneId` 删除状态。如果同一 pane 在 1.5 秒内连续收到两次 bell，第一次定时器会提前清除第二次 bell；如果调用 `clearBell` 后又触发新 bell，旧定时器也可能清除新状态。这是实际的时间语义错误，不是单纯的代码风格问题。

安全重构是在模块级维护 `Map<paneId, timer>` 或 generation token。触发前取消旧定时器，`clearBell` 同时取消定时器；回调只允许当前 timer 清除对应 pane。这样不会改变单次 bell 的现有 1.5 秒行为。

### 5. 中价值：WASM FFI 适配器仍过度集中，初始化失败会永久缓存

- 文件：[`ghostty-wasm.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/ghostty-wasm.ts:331)
- 符号：`GhosttyBindings`
- 范围：L331–1411，约 1,081 行；文件共 1,485 行
- 初始化：`getGhosttyBindings` L1447–1476，共 30 行

`GhosttyBindings` 将内存和布局访问、终端操作、formatter、render-state iterator、键盘编码和鼠标编码全部放在一个类中。它不是无效 forwarding facade，而是真正包含 FFI 资源管理的适配器；问题在于边界过宽，任何底层协议改动都需要审阅一个千行级类，资源所有权也难以局部验证。

可以拆成共享的 `WasmMemory`/`WasmLayout`，以及 terminal、formatter、render-state、input 五个领域适配器；保留一个薄的 `GhosttyBindings` 组合入口以兼容现有调用方，并保留所有 `try/finally` 释放逻辑。

同文件还有一个独立的高置信错误：`bindingsPromise` 一旦因 WASM 加载、实例化或类型 JSON 解析失败而 reject，就会永久保存 rejected Promise，后续调用无法重试。失败时应清空当前 promise，成功结果继续缓存。

### 6. 中价值：通用分片重组未校验元数据，重复分片错误后仍保留流

- 文件：[`chunk.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/ws-borsh/chunk.ts:44)
- 符号：`ChunkReassembler.addChunk`
- 范围：L57–121，共 65 行；类范围 L44–184，共 141 行；文件共 276 行

重组流只校验后续分片的 `totalChunks`，没有校验 `originalKind` 和 `originalSeq`。因此同一个 `chunkStreamId` 内可以混入不同原消息的元数据，最终结果却使用首个分片的 kind/seq 解码，造成 payload 与元数据不匹配。此外，重复 `chunkIndex` 在 L104–109 抛错后没有删除流，调用方若继续处理该 stream，仍可能让这个已被判定错误的流最终完成；协议文档要求重复分片丢弃整个流。

安全重构是将“流元数据一致性失败、重复分片、越界分片”统一走 `abortStream(streamId)`：校验 `totalChunks`、`originalKind`、`originalSeq`，任一不一致就删除流后抛出协议错误；并增加混合元数据和重复分片后的状态测试。

## 未列入前六的检查结果

- [`canvas-renderer.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/canvas-renderer.ts:86) 共 669 行，`CanvasRenderer` 约 577 行，但职责仍集中在同一套 Canvas 渲染管线中，单个方法均未超过 100 行；拆层会增加大量绘制上下文传递，当前价值偏低。
- [`render-state.ts`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ghostty-terminal/src/render-state.ts:1) 共 611 行，主要是内聚的 WASM 快照解码器和资源释放逻辑，未发现有把握的 bug。
- `api-client` 没有超过 600 行的实现文件；各 endpoint 重复的请求/错误处理属于低价值机械重复，且存在 404、409、响应 envelope 等差异，暂不建议冒险做泛化。
- `ws-client/src/client.ts` 共 515 行，仍是有效的连接协调器，不是 Round 1 后无意义的转发 facade。
- 未发现目标目录中有需要单独报告的 effect storm、明显资源泄漏或测试之外的其他高置信 off-by-one 问题。