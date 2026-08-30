结论：本轮未发现证据充分的 HIGH 项。以下为新增、按预估收益排序的 MED 项；未重复 round 1–6 已知问题。

### [MED] `Terminal.write()` 每个输出帧重复进行 3–5 次 WASM mode 查询

证据：

- [`packages/ghostty-terminal/src/terminal.ts:324`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal.ts:324) 每次写入都会检查 alt-screen、写 VT、检查同步输出。
- [`packages/ghostty-terminal/src/terminal-input-bridge.ts:104`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-input-bridge.ts:104) 的 `isAltScreenActive()` 最多查询两个 mode。
- [`packages/ghostty-terminal/src/terminal-input-bridge.ts:112`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-input-bridge.ts:112) 每次都会查询 synchronized output。
- [`packages/ghostty-terminal/src/ghostty-wasm.ts:856`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/ghostty-wasm.ts:856) 每次 mode 查询都执行 WASM export，并在 [`:866`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/ghostty-wasm.ts:866) 释放临时内存。
- 输出最终由 [`packages/terminal-ui/src/components/terminal-snapshot.ts:194`](/Users/konata/code/tmex-enhanced-wt-r7/packages/terminal-ui/src/components/terminal-snapshot.ts:194) 调用 `terminal.write()`；coalescer 默认窗口为 4ms，见 [`packages/ws-client/src/pane-output-coalescer.ts:13`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ws-client/src/pane-output-coalescer.ts:13)。

原因与影响：普通 screen 每帧约 3 次 mode probe；alt-screen 离开路径最多 5 次。高输出 pane、多分屏同时流式输出时，该成本按输出帧数线性增长，并与 VT 解析、渲染争用主线程/WASM 桥接时间。

修复方向：增加一次性 mode bitmask/snapshot WASM API；或者让 `writeVt` 返回 mode transition 元数据，避免分别查询 alt-screen 与 synchronized output。

风险：中。需要保持 alt-screen 离开时清理鼠标模式，以及旧内核不支持 mode 2026 时的兼容逻辑。

### [MED] 非拖拽 `mousemove` / `wheel` 事件重复查询输入路由状态

证据：

- [`packages/ghostty-terminal/src/terminal-pointer-handlers.ts:106`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-pointer-handlers.ts:106) 每个非拖拽 `mousemove` 都调用 `getInputRoutingState()`。
- [`packages/ghostty-terminal/src/terminal-input-bridge.ts:126`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-input-bridge.ts:126) 的 `routingState()` 最多检查 4 个鼠标 mode、2 个 alt-screen mode 和 1 个 alt-scroll mode。
- wheel 路径同样在 [`packages/ghostty-terminal/src/terminal-input-bridge.ts:274`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-input-bridge.ts:274) 查询。
- SGR pixel motion 还会在 [`packages/ghostty-terminal/src/terminal-input-bridge.ts:299`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-input-bridge.ts:299) 再查一次 mode。

原因与影响：普通无鼠标上报模式下，悬停也要付出最多 6–7 次 WASM mode 查询。只读 Bun probe 中，调用 `routingState()` 10,000 次产生了 60,000 次 fake mode export 调用。高刷新率触控板、鼠标移动和滚轮事件会持续制造桥接调用。

修复方向：复用上述一次性 mode snapshot；在终端输出改变 mode 后更新缓存，并让 `routingState()` 与 duplicate-motion 判断共享同一份快照。

风险：中。缓存失效必须与 VT 输出、reset、history restore 的时序一致，否则可能错误地把本地滚动或鼠标事件路由给远端。

### [MED] 分屏 Agent 徽标对全量 session 表做 `O(P×S)` 扫描

证据：

- 每个 pane 都挂载 `PaneAgentBadge`，见 [`packages/terminal-ui/src/components/split/SplitPaneView.tsx:28`](/Users/konata/code/tmex-enhanced-wt-r7/packages/terminal-ui/src/components/split/SplitPaneView.tsx:28) 和 [`:135`](/Users/konata/code/tmex-enhanced-wt-r7/packages/konata/code/tmex-enhanced-wt-r7/packages/terminal-ui/src/components/split/SplitPaneView.tsx:135)。
- [`packages/stores/src/use-pane-agent-state.ts:21`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/use-pane-agent-state.ts:21) 每次 selector 调用都会执行 `Object.values(state.sessions)` 并线性扫描。
- Agent delta 每 40ms flush 一次，见 [`packages/stores/src/agent-delta-buffer.ts:6`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/agent-delta-buffer.ts:6) 和 [`:40`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/agent-delta-buffer.ts:40)。
- selector 订阅入口位于 [`packages/stores/src/react.tsx:100`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/react.tsx:100)。

原因与影响：任意一个 session 的流式 delta flush 都会触发所有已挂载 pane selector；最坏情况下每次更新都会重新分配 session 数组并检查全部 session。只读 probe 中，1000 sessions × 10,000 次 selector 调用完成了 10,000,000 次条目检查。

修复方向：在 stores 层维护 `(nodeId, deviceId, paneId) -> sessions/status` 索引，或复用已有按 pane 分组缓存逻辑（[`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:63`](/Users/konata/code/tmex-enhanced-wt-r7/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:63)），让 badge 查询变为 `O(1)`。

风险：中。需要覆盖 session 创建、删除、状态变更、rebind 及 node 过滤。

### [MED] 选区自动滚动每 48ms 最多触发两次完整渲染

证据：

- 自动滚动间隔为 48ms，见 [`packages/ghostty-terminal/src/terminal-selection.ts:16`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-selection.ts:16) 和 [`:223`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-selection.ts:223)。
- 每次 tick 先滚动并完整 render：[`packages/ghostty-terminal/src/terminal-selection.ts:257`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-selection.ts:257)、[`:258`](/Users/konata/code/tmex-enhanced-wt-r7/packages/terminal-ui/src/components/terminal-selection.ts:258)。
- 更新 selection focus 后又完整 render：[`packages/ghostty-terminal/src/terminal-selection.ts:260`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-selection.ts:260)、[`:268`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-selection.ts:268)。
- `render()` 由 [`packages/ghostty-terminal/src/terminal.ts:167`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal.ts:167) 连接到 `renderNow()`。

原因与影响：指针拖出 viewport 后约 20.8 tick/s，理论上可产生约 41.6 次完整 render/s；滚动到顶/底时 `scrollViewportBy` 可能无变化，但仍会执行两次渲染。

修复方向：让 `scrollViewportBy` 返回 offset 是否变化；无变化时跳过 render。滚动后的第一次完整 render 用于刷新 viewport，selection focus 更新后改用 `scheduleSelectionRepaint()`，避免第二次完整渲染。

风险：中。必须保留滚动后 hit-test 使用最新 viewport 数据的顺序。

### [MED] 悬停 `mousemove` 持续重置 scrollbar fade timer

证据：

- 每个非拖拽 `mousemove` 都调用 [`packages/ghostty-terminal/src/terminal-pointer-handlers.ts:106`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-pointer-handlers.ts:106)。
- [`packages/ghostty-terminal/src/terminal-dom.ts:302`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-dom.ts:302) 每次都会写 opacity、清理旧 timer，并重新创建 `setTimeout`。
- 新 timer 回调位于 [`packages/ghostty-terminal/src/terminal-dom.ts:311`](/Users/konata/code/tmex-enhanced-wt-r7/packages/ghostty-terminal/src/terminal-dom.ts:311)。

原因与影响：聚焦终端上仅悬停不操作时，60–240Hz 的 pointer move 会持续创建/取消 timer，并重复写 DOM style；例如 120Hz 悬停就是每秒约 120 次 timer churn。opacity 通常不会强制布局，因此主要是事件、timer 和 GC 噪声，而非明确的 layout thrash。

修复方向：只在 wheel、mousedown 或实际滚动时显示 scrollbar；或者 scrollbar 已可见时只刷新 deadline，不重复写 style 和创建 callback。

风险：低到中。可能改变悬停期间 scrollbar 的可见性语义。

### [MED] AgentTab 订阅整个 tmux snapshot map，非相关设备更新也触发聊天模型重算

证据：

- [`packages/panels/src/agent/use-agent-tab-state.ts:217`](/Users/konata/code/tmex-enhanced-wt-r7/packages/panels/src/agent/use-agent-tab-state.ts:217) 订阅完整 `state.snapshots`。
- [`packages/panels/src/agent/use-agent-tab-state.ts:219`](/Users/konata/code/tmex-enhanced-wt-r7/packages/panels/src/agent/use-agent-tab-state.ts:219) 将完整 map 传入 route pane 解析。
- 任意设备的 metadata snapshot/patch 都创建新的 map，见 [`packages/stores/src/tmux-event-router.ts:85`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/tmux-event-router.ts:85) 和 [`:94`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/tmux-event-router.ts:94)。
- Agent view 每次模型更新都会执行 binding 派生，见 [`packages/panels/src/agent/agent-tab-view.ts:104`](/Users/konata/code/tmex-enhanced-wt-r7/packages/panels/src/agent/agent-tab-view.ts:104)。

原因与影响：当前 Agent pane 只需要路由设备的 snapshot，但其他设备的 metadata 更新也会使 map identity 改变，触发 AgentTab、binding 解析和模型派生。`React.memo` 可减少部分子树 DOM 更新，但不能避免父组件 render 和派生计算。

修复方向：先解析 route device id，再用 `useTmuxStore((state) => state.snapshots[routeDeviceId])` 订阅单设备 snapshot；相应地将 binding/title 查询改为接收目标 snapshot。

风险：低到中。需要正确处理路由切换、设备缺失和 node 前缀。

## Bugs

- [BUG] 同一 pane 绑定多个 Agent session 时，徽标状态取决于 session 对象插入顺序。

  [`packages/stores/src/use-pane-agent-state.ts:21`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/use-pane-agent-state.ts:21) 遍历 session，遇到第一个非 stopped/error session 后立即在 [`:25`](/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/use-pane-agent-state.ts:25) 返回。如果第一个是 `idle`、后续 session 是 `running`，结果会错误返回 `bound`。

  多 session 同 pane 是合法状态：[`apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:85`](/Users/konata/code/tmex-enhanced-wt-r7/apps/fe/src/components/page-layouts/components/use-sidebar-agent-sessions.ts:85) 会将多个 session 放入同一个 pane 分组，且 [`apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:99`](/Users/konata/code/tmex-enhanced-wt-r7/apps/fe/src/components/page-layouts/components/sidebar-agent-sessions.tsx:99) 会逐个渲染。

  修复应明确语义：任一匹配 session 为 `running` 时返回 `generating`，否则有活跃 session 时返回 `bound`；并补充 idle + running 同 pane 的回归测试。

本轮仅做只读探查；工作区原有未提交改动未被修改。