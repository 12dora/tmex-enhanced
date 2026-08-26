## 结论

本区域仍有 3 个高价值问题，其中 2 个是确定性竞态 BUG。Round 1 的组合根大多已经有效拆分；但 `useDevicePaneSelection` 是 Round 1 新拆出的模块，仍然过大且副作用密集。

| 排名 | 价值 | 类型 | 位置 |
|---|---|---|---|
| 1 | 高 | Round 1 残留 god-hook / effect storm | `useDevicePaneSelection` |
| 2 | 高 | 草稿重复提交竞态 | `AgentTab` + `materializeDraft` |
| 3 | 高 | 首次历史加载覆盖新消息竞态 | `agent-history-sync` |
| 4 | 中 | god-component | `AgentTab` |
| 5 | 中 | god-form | `WatchRuleForm` |
| 6 | 中 | god-hook / 手势状态机过重 | `useMobileTouch` |

### 1. `useDevicePaneSelection` 仍是过大的 Round 1 残留模块

- 文件：[use-device-pane-selection.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/device-console/use-device-pane-selection.ts:72)
- 符号：`useDevicePaneSelection`
- 范围：72–710，共 639 行；文件共 710 行
- 类型：Round 1 拆分后遗留的 god-hook、effect storm

该 Hook 同时负责路由目标协调、设备和窗口自动选择、缺失选择恢复、活动窗口跟随、快照跟随、分屏布局、尺寸同步、终端事件监听以及多个请求去重引用。内部包含约 17 个 `useEffect`、大量互相关联的 `useRef` 和多层条件分支，任何选择时序或路由行为调整都需要理解整个 Hook，副作用之间也容易产生回归。

安全重构方式是保持公开返回值不变，按副作用域拆成：

- `usePaneRouteReconciliation`：路由目标、自动选择、缺失选择恢复、创建窗口后的补选；
- `usePaneActiveFollow`：活动窗口事件、快照跟随和请求去重；
- `usePaneSizeSync`：本地 resize、远端尺寸同步；
- `usePaneSelectionState`：派生选择状态和共享引用。

保留现有 effect 的执行顺序、引用重置时机和选择请求去重逻辑；先抽取纯函数和显式参数，再拆 Hook，避免仅按代码行切割导致行为变化。

### 2. 草稿发送存在重复创建会话的竞态 BUG

- 文件：[agent-tab.tsx](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/agent/agent-tab.tsx:359)
  - `AgentTab.handleSend`：359–375，共 17 行
  - `inputDisabled`：403–405，共 3 行
- 文件：[agent-session-actions.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent-session-actions.ts:372)
  - `materializeDraft`：372–381，共 10 行
- 类型：确定性竞态 BUG

草稿状态下，`sending` 只关联 `activeSessionId`，而草稿没有活动会话，因此输入框仍然可用。两次快速提交都会读取同一个 `draft`，然后分别调用异步的 `createSession`；两个请求都可能成功创建会话，后创建的会话覆盖活动会话状态，而两条消息分别发送到不同会话，造成重复会话和消息分裂。这不依赖异常网络条件，只要第一次 `materializeDraft()` 尚未完成即可发生。

安全修复应把草稿物化做成 Store 内部的 single-flight 操作：为当前草稿保存进行中的 Promise，并在物化期间暴露 `materializingDraft` 状态，禁用输入或将后续提交排队到同一会话。同时给草稿增加 generation/key，避免旧草稿完成后覆盖用户已经切换的新草稿。应补充两个并发调用 `materializeDraft` 的回归测试。

### 3. 首次历史加载可能覆盖刚发送的新消息

- 文件：[agent-history-sync.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent-history-sync.ts:51)
- 符号：`createAgentHistorySync.loadHistory`
- 范围：51–95，共 45 行
- 相关发送路径：[agent-session-actions.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent-session-actions.ts:288)，288–317，共 30 行
- 类型：确定性竞态 BUG

首次加载历史时，`afterSeq` 为 `-1`，最终合并使用的是 `undefined`，而不是当前 Store 中已经存在的消息。如果历史请求先发出，随后发送请求返回并把新消息写入 Store，历史请求又因网络延迟最后返回一个不包含该消息的快照，`loadHistory` 会用历史列表替换当前消息，导致刚发送的消息从前端状态中消失。`setActiveSession` 会立即触发历史加载，而会话激活后发送入口已经可用，因此该时序是正常可达的。

安全修复是始终基于 `prev.messages[sessionId]` 合并返回的历史，而不是在 `afterSeq === -1` 时传入 `undefined`；同时只在合并完成后标记历史已加载。这样不会改变正常首次加载结果，却能保留加载期间由发送流程写入的消息。应增加“历史请求挂起期间发送消息，历史响应随后返回”的测试。

### 4. `AgentTab` 承担过多页面职责

- 文件：[agent-tab.tsx](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/agent/agent-tab.tsx:198)
- 符号：`AgentTab`
- 范围：198–635，共 438 行；文件共 635 行
- 类型：god-component

组件同时管理 Store 选择器、设备查询、会话和草稿生命周期、路由绑定解析、确认块合并、发送/排队/转向操作、错误和孤儿会话提示，以及完整聊天布局。业务模型、交互动作和展示结构混在一个函数中，使后续增加 Agent 状态或输入模式时容易继续膨胀。

安全重构方式是抽取 `useAgentTabModel`，集中处理查询、派生状态和动作；再抽取 `AgentBindingStatus`、`AgentStatusBanners`、`AgentComposer` 等展示组件。顶层 `AgentTab` 只负责组合这些部分，并保持现有 Store action、路由行为和 `ChatInput` 参数不变。

### 5. `WatchRuleForm` 是过大的表单编排组件

- 文件：[watch-rule-form.tsx](/Users/konata/code/tmex-enhanced-wt-smell/packages/panels/src/watch/watch-rule-form.tsx:40)
- 符号：`WatchRuleForm`
- 范围：40–564，共 525 行；文件共 564 行
- 类型：god-form

组件集中维护约 15 个字段状态、表单标准化、校验、创建和更新 mutation、未修改判断、触发器类型切换，以及 Regex、Schedule、LLM 等多组条件渲染。字段新增或校验规则变化时，状态、payload 和 JSX 之间的耦合较高，难以局部验证。

安全重构方式是抽取 `useWatchRuleDraft`，负责字段状态、标准化和纯校验；将不同触发器拆为 `RegexTriggerFields`、`ScheduleFields`、`LlmFields`；保留一个集中式 payload builder，确保创建和更新提交格式不变。保存 mutation 的错误处理和 `onSaved` 时机应继续由表单容器控制。

### 6. `useMobileTouch` 是过重的终端手势状态机

- 文件：[useMobileTouch.ts](/Users/konata/code/tmex-enhanced-wt-smell/packages/terminal-ui/src/components/useMobileTouch.ts:50)
- 符号：`useMobileTouch`
- 范围：50–531，共 482 行；文件共 532 行
- 类型：god-hook、深层事件分支

该 Hook 同时处理触摸几何计算、滚动、双指手势、长按选择、鼠标上报、拖拽、上下文菜单、终端行高测量和 DOM 事件注册。多个手势状态共享同一组引用和计时器，`touchmove`、`touchend` 等处理路径较长，修改一种手势时容易影响其他终端协议行为。

安全重构方式是先抽取无副作用的 `touch-geometry` 工具，再将手势控制器按职责拆为滚动、选择和鼠标上报处理器；由一个薄 Hook 统一安装和清理事件监听，并保留现有 passive 配置、事件顺序和终端协议调用顺序。这样可以降低单个闭包的复杂度，同时避免改变触摸行为。

## 未列入排名

- `packages/theme/src/themes.css` 共 876 行，但主要是主题 token 声明。拆成多个 CSS 文件只能降低单文件体积，不能降低业务复杂度，价值低。
- `DeviceConsole`、`Terminal`、`SplitTerminalArea` 当前更像真实的组合根，仍保留渲染和生命周期编排，不属于“只转发、不降低复杂度”的 facade。