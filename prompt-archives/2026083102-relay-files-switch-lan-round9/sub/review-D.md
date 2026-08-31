结论：发现 2 个 Blocker、4 个 Should fix。定向运行相关 6 个测试文件，结果为 60 pass / 0 fail；现有测试未覆盖下面的跨事务和生命周期场景。

## 1. Blockers

1. [`packages/stores/src/tmux-selection-actions.ts:118`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:118) — warm select 打断冷事务时，旧事务的门控不会被取消，也不会标记缺口。

   当前只有新的冷 select 才检查并标记 `inFlight`；warm 路径完全跳过 `SELECT_START` 分支。

   具体场景：

   - `%1`、`%2` 已保活。
   - 冷切到 `%3`，客户端状态机开始缓存 `%3` 输出。
   - history 完成前迅速切回 `%2`，因为 `%2` 已保活而发送 warm select。
   - Gateway 会取消 `%3` barrier 并丢弃服务端缓存，但客户端仍保留 `%3` 事务；新 token 的 ACK/LIVE_RESUME 因不匹配而被忽略。
   - 客户端随后继续缓存 `%3` 输出，直到超时再整批丢弃。`%3` 没有被加入 `gappedPanes`，以后切回 `%3` 仍可走 warm，永久展示缺字节的终端状态。

   同一处还有第二个生命周期错误：[`clearPaneGap()` 在冷请求开始时执行](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:120)，而不是在 history 成功提交后执行。若该冷事务 ACK 超时、被拒绝或在重试前切走，pane 仍然缺数据，但 gap 标记已经消失。

   最小修复：任何 select 都先检查现有事务；warm select 若打断事务，应标记旧 pane 并显式取消客户端事务/门控。gap 只能在匹配 token 的冷事务成功完成 history + LIVE_RESUME 后清除，失败、超时、取消时必须保留。测试应使用真实 `SelectStateMachine` 覆盖“cold in-flight → warm interrupt”和“gap recovery cold select → timeout → revisit”，不能再用 `settle()` 直接把假事务置空。

2. [`packages/panels/src/device-console/terminal-keep-alive.ts:61`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-keep-alive.ts:61) — 重连时保留下来的可见 pane 仍可能被判为 warm，导致断线期间丢失的输出无法恢复。

   `dropHiddenKeepAlivePanes()` 只裁剪 `panes`，却保留 `visibleIsWarm`。当当前 pane 是一次 warm revisit 后发生自动重连时，`TerminalStage` 会在断线期间保留该实例；连接恢复后 [`isWarmSelectTarget()`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/use-pane-route-reconciliation.ts:134) 仍返回 `true`，于是发送 `wantHistory:false`。

   具体场景：先 `%1 → %2 → %1`，此时 `%1.visibleIsWarm=true`；设备进入 reconnecting 并断线；pane sink 状态被清理且终端错过断线期间输出；恢复后 `%1` 只收到 focus/LIVE_RESUME，没有 history 或 screen rebase，画面继续停在断线前。

   最小修复：任何设备流中断都必须使当前 pane 失去 warm 资格；至少让 `dropHiddenKeepAlivePanes()` 将 `visibleIsWarm` 置为 `false`，更稳妥的是按连接 epoch 记录保活有效性。补充 reconnecting → disconnected → reconnected 的回归测试，并断言恢复后的 select 为 cold。

## 2. Should fix

1. [`packages/panels/src/device-console/terminal-stage.tsx:179`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:179) — 模块级池在 render 中写入，却由无所有权的 effect cleanup 全局清空，StrictMode 下提交后的池会变空。

   前端明确由 [`<StrictMode>`](/Users/konata/code/tmex-enhanced-wt-r9/apps/fe/src/main.tsx:327) 挂载。初次提交后 React 会执行一次模拟 cleanup；[`useEffect(() => releaseKeepAlive, [])`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/terminal-stage.tsx:186) 清空池，第二次 effect setup 不会重新执行 render-time `retainVisiblePane()`。因此在下一次渲染前，DOM 中虽然有终端，warm 查询和 MRU 池却是空的；第一次切换会把本应保活的当前 pane 卸载。

   现有 SSR 静态渲染测试不会执行 effect，无法发现此问题。

   最小修复：池应由组件实例持有，并在 layout/commit 阶段发布只读快照供父级 select effect 查询；cleanup 需带 owner/generation，不能无条件清全局单例。增加真实 `createRoot(...<StrictMode>)` 的挂载测试。

2. [`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:317`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:317) — e2e 终端指针会切到可见实例，但全局选区探针仍可永久属于隐藏实例。

   `setE2eTerminalProbe()` 只更新终端、engine 和 renderer，不同步 `__tmexE2eTerminalSelectionText`。Ghostty 的 `selectionProbeOwner` 又只有在选区变化或实例销毁时才释放。

   具体场景：在 `%1` 选中文本后 warm 切到 `%2`。`__tmexE2eXterm` 指向 `%2`，但 `__tmexE2eTerminalSelectionText` 继续返回隐藏 `%1` 的选区；若新 pane 启动失败，终端指针也会继续指向隐藏实例。依赖这些全局变量的 selection/鼠标 e2e 会操作或断言错误 pane。

   最小修复：探针所有权应跟随 `focused/autoFocus`，切换时用新实例的 `getSelection()` 同步选区，并在可见实例尚未就绪或启动失败时清空旧指针。增加“隐藏 pane 带选区 → warm 切换”的浏览器测试。

3. [`packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:226`](/Users/konata/code/tmex-enhanced-wt-r9/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:226) — tmex 前端实际上无法命中新加入的同步字体快路径。

   字体缓存命中时 `ensureTerminalFonts()` 会返回 `undefined`，但 [`DeviceConsole.prepareResources`](/Users/konata/code/tmex-enhanced-wt-r9/packages/panels/src/device-console/device-console.tsx:96) 在没有宿主资源钩子时仍固定返回 `Promise.resolve()`。因此 `loadResources()` 总会返回 Promise，`boot()` 仍会经过一次 `await`；新增的 void 测试只验证了手工构造的 lifecycle，未验证真实接线。

   最小修复：没有 `prepareTerminalResources` 时传 `undefined`，或允许准备函数返回 `void` 并同步返回。增加通过 `DeviceConsole`/真实 `createLifecycleDeps` 的缓存命中测试。

4. [`packages/stores/src/tmux-selection-actions.ts:76`](/Users/konata/code/tmex-enhanced-wt-r9/packages/stores/src/tmux-selection-actions.ts:76) — `gappedPanes` 在设备断开、非当前 pane 关闭或池淘汰后没有清理路径，会随运行时间增长。

   `handleSnapshotPaneRemoval()` 只清理当前选中 pane；`disconnectDevice()` 也只取消重选计时器。反复创建 pane、在冷事务中切走、再关闭这些 pane，会持续向集合加入不可再访问的 ID，直到整个 runtime dispose。

   最小修复：设备断开/移除时删除该 device 的集合；快照更新时裁剪已不存在的 pane ID。池淘汰本身无需跨层直接清理，只要快照裁剪保证集合不超过设备当前有效 pane 范围即可。

## 3. Nits

无。