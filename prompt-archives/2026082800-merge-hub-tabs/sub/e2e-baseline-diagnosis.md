## 总结

8 条中没有确认的用户侧产品缺陷：

- #1–#5：测试选择器过期，当前 HEAD 的 `b8bf9e8` 已修复。
- #6：测试 mock 没跟上 API 响应契约。
- #7：分屏下 e2e 全局探针存在竞争和 pane 错配，属于测试基础设施问题；当前已有部分修复，但仍不稳。
- #8：测试比较了不同视口下的 pane 尺寸，断言本身不成立；不是把阈值放宽的问题。

说明：检查过程中用户提供的临时日志和 `test-results` 产物已被外部清理。下面的错误原文来自此前已读取的 trace，源码行来自当前 worktree。

---

### 1. mobile-settings.spec.ts:5

失败原文：

```text
Error: expect(locator).toBeVisible() failed
Locator: getByTestId('settings-enable-browser-bell-toast')
Expected: visible
Timeout: 15000ms
Error: element(s) not found
at .../apps/fe/tests/mobile-settings.spec.ts:136:72
```

根因：测试选择器过期。

`0a759af` 重做了通知设置，删除了旧的 `enableBrowserBellToast`，当前真实 DOM 为：

- `settings-enable-notification-push`
- `settings-enable-bell-push`
- `settings-enable-bell-sound`
- `settings-enable-browser-notification-toast`

见 [notification-settings-tab.tsx:28](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/src/pages/settings/notification-settings-tab.tsx:28)。

当前测试已改为正确的 `settings-enable-browser-notification-toast`，见 [mobile-settings.spec.ts:136](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/mobile-settings.spec.ts:136)。

结论：测试失效，不是产品缺陷。修复风险低，当前已由 `b8bf9e8` 修复。

补充：这条失败实际不是 `settings-tab-devices`。当前该测试没有设备设置 tab 断言；设备文件 tab 的真实 testid 是 `settings-tab-devicesAndFiles`。

---

### 2. mobile-terminal-interactions.spec.ts:79

失败原文：

```text
Error: expect(locator).toBeEnabled() failed
Locator: getByTestId('editor-shortcut-ctrl-c')
Expected: enabled
Timeout: 20000ms
Error: element(s) not found
at .../apps/fe/tests/mobile-terminal-interactions.spec.ts:114:62
```

根因：终端快捷键栏改名后测试仍使用设置页预览组件的旧前缀。

当前终端快捷键栏显式传入：

```tsx
idPrefix="terminal-shortcut"
```

见 [terminal-shortcuts-slot.tsx:38](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/device-console/terminal-shortcuts-slot.tsx:38)，最终 DOM testid 由 [ShortcutButtonRow.tsx:73](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/settings/ShortcutButtonRow.tsx:73) 生成：

```text
terminal-shortcut-ctrl-c
```

`editor-shortcut-ctrl-c` 只属于设置页的快捷键预览。

当前测试已改为 `terminal-shortcut-ctrl-c`，见 [mobile-terminal-interactions.spec.ts:114](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/mobile-terminal-interactions.spec.ts:114)。

结论：测试失效，不是连接或 Ctrl-C 产品逻辑缺陷。该测试在旧选择器处中断，后续焦点和 WS 断言根本没有执行。当前已由 `b8bf9e8` 修复。

---

### 3. mobile-terminal-interactions.spec.ts:140

失败原文：

```text
Error: expect(locator).toBeEnabled() failed
Locator: getByTestId('editor-shortcut-ctrl-c')
Expected: enabled
Timeout: 20000ms
Error: element(s) not found
at .../apps/fe/tests/mobile-terminal-interactions.spec.ts:184:62
```

根因和 #2 相同：测试使用了 `editor-shortcut-ctrl-c`，而终端页真实 testid 是 `terminal-shortcut-ctrl-c`。

该用例的 compositionend 逻辑尚未被执行，不能据此判断 IME 产品代码有问题。

修复：改测试选择器。当前已修复，风险低。

---

### 4. mobile-terminal-interactions.spec.ts:221

失败原文：

```text
Error: expect(locator).toBeEnabled() failed
Locator: getByTestId('editor-shortcut-ctrl-c')
Expected: enabled
Timeout: 20000ms
Error: element(s) not found
at .../apps/fe/tests/mobile-terminal-interactions.spec.ts:262:62
```

根因和 #2 相同。

取消 IME 组合的断言尚未执行，因此不存在“取消输入泄漏”的本次运行证据。测试在过期选择器处失败。

修复：改测试选择器为 `terminal-shortcut-ctrl-c`。当前已修复，风险低。

---

### 5. mobile-terminal-interactions.spec.ts:303

失败原文：

```text
Error: expect(locator).toBeEnabled() failed
Locator: getByTestId('editor-shortcut-ctrl-c')
Expected: enabled
Timeout: 20000ms
Error: element(s) not found
at .../apps/fe/tests/mobile-terminal-interactions.spec.ts:327:62
```

根因和 #2 相同。

触摸滚动测试尚未进入发送 320 行输出和 swipe 手势阶段，不能据此判定终端滚动功能有缺陷。

修复：改测试选择器为 `terminal-shortcut-ctrl-c`。当前已修复，风险低。

trace 中虽然能看到页面曾显示 `Connecting to device...`，但浏览器到 gateway 的 WS 已进入 `READY`，且没有对应 API 错误；结合当前选择器和 `b8bf9e8` 的定向验证，这不是本条断言的根因。

---

### 6. settings-llm.spec.ts:42

失败原文：

```text
Error: locator.click: Test timeout of 90000ms exceeded.
Call log:
- waiting for locator('[data-slot="select-content"]').getByText('Tavily')
at .../apps/fe/tests/settings-llm.spec.ts:294:74
```

根因：测试 mock 缺少 `searchProviders`。

测试 mock 的 GET 响应只有：

```ts
{ settings }
```

见 [settings-llm.spec.ts:165](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/settings-llm.spec.ts:165)。

而前端现在按 `searchProviders` 动态生成选项：

```ts
const searchProviders = settingsQuery.data?.searchProviders ?? [];
```

见 [search-tab.tsx:102](/Users/konata/code/tmex-enhanced-wt-merge/packages/panels/src/settings/search-tab.tsx:102)。

因此 mock 数据下只有 `none`，没有 `Tavily`。真实 gateway 已返回：

```ts
{
  settings: ...,
  searchProviders: [...]
}
```

见 [llm.ts:265](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/llm.ts:265)；响应契约也要求该字段，见 [llm.ts:87](/Users/konata/code/tmex-enhanced-wt-merge/packages/shared/src/contracts/llm.ts:87)。

修复方案：在 GET mock 中加入：

```ts
searchProviders: [
  { id: 'tavily', label: 'Tavily', isConfigured: false },
  { id: 'brave', label: 'Brave', isConfigured: false },
]
```

不建议在产品代码中给 `Tavily` 做硬编码 fallback，否则会掩盖后端响应契约错误。

结论：测试 mock 过期，产品代码没有证据显示缺陷。风险低。

---

### 7. terminal-selection-canvas.spec.ts:131

主要失败原文：

```text
Error: expect(received).toBe(expected)
Expected: "dbltoken"
Received: null
at .../apps/fe/tests/terminal-selection-canvas.spec.ts:163
```

同一产物的另一个 trace 片段还出现过：

```text
Expected substring: "dragtarget"
Received string: "PANE0_READY ... sh-3.2$"
```

该用例使用 `createTwoPaneSession`，但测试读取的是页面级全局对象：

```ts
window.__tmexE2eXterm
window.__tmexE2eTerminalSelectionText
```

见 [terminal-selection-canvas.spec.ts:26](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/terminal-selection-canvas.spec.ts:26)。

问题有两层：

1. 分屏页面实际挂载两个终端控制器。旧实现中，每个控制器每帧都会写全局选区探针；空闲 pane 写入 `null` 会覆盖已选中的 pane。历史单测已经复现过该问题。
2. 当前仍存在未完全收敛的全局清空路径：[useTerminalBootSurface.ts:96](/Users/konata/code/tmex-enhanced-wt-merge/packages/terminal-ui/src/components/hooks/useTerminalBootSurface.ts:96) 直接写入全局 `null`，绕过了 [terminal.ts:747](/Users/konata/code/tmex-enhanced-wt-merge/packages/ghostty-terminal/src/terminal.ts:747) 的 `selectionProbeOwner` 保护。

此外，测试同时用“全局焦点终端 buffer”查找文字，又用：

```ts
document.querySelector('.xterm canvas')
```

取第一个 canvas，二者不保证属于同一个 pane。

当前的 `selectionProbeOwner` 修复只能解决“对侧 pane 普通渲染帧覆盖选区”的一类竞态，不能消除全局测试桥本身的 pane 错配和生命周期清空问题。

结论：这是 e2e 探针/测试设计问题，不是已确认的用户选词产品缺陷。真实产品选择状态由每个终端实例和 SelectionToolbar 管理，失败的是测试读取的全局诊断值。

推荐修法：

- 最小风险：该基础选词用例改用 `createSinglePaneSession`。
- 完整修法：将 e2e probe 按 `data-pane-id` 建立 pane 级映射，canvas、terminal buffer、selection text 必须绑定同一 pane。
- 同时把 boot/dispose 清理改为 owner-aware，不允许任意 pane 直接把全局值清空。

不要单纯增加 timeout、重试次数或依赖“隔离运行通过”；那只是掩盖调度竞态。

---

### 8. ws-borsh-theme-resize.spec.ts:39

失败原文：

```text
Error: expect(received).toBeLessThan(expected)
Expected: < 2
Received: 3
at .../apps/fe/tests/ws-borsh-theme-resize.spec.ts:94:23
```

失败点是列数断言，行数断言尚未执行。

测试先在 `1200x800` 下记录：

```ts
const paneSizeBefore = getPaneSize(targetPaneId);
```

见 [ws-borsh-theme-resize.spec.ts:58](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/ws-borsh-theme-resize.spec.ts:58) 和 [ws-borsh-theme-resize.spec.ts:75](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/ws-borsh-theme-resize.spec.ts:75)。

但循环最后一次把视口设置为：

```ts
width: 1250,
height: 830
```

见 [ws-borsh-theme-resize.spec.ts:82](/Users/konata/code/tmex-enhanced-wt-merge/apps/fe/tests/ws-borsh-theme-resize.spec.ts:82)。

当前产品明确将浏览器尺寸转换为 tmux window 尺寸：

- `computeSplitWindowGridSize()` 按 viewport 和 cell 尺寸计算 cols/rows，见 [splitLayoutGeometry.ts:168](/Users/konata/code/tmex-enhanced-wt-merge/packages/terminal-ui/src/components/splitLayoutGeometry.ts:168)。
- `useWindowResizeReporter` 将结果发送为 window resize，见 [useWindowResizeReporter.ts:39](/Users/konata/code/tmex-enhanced-wt-merge/packages/terminal-ui/src/components/split/useWindowResizeReporter.ts:39)。
- `SplitTerminalArea` 也明确是 `resize-window` 语义，见 [SplitTerminalArea.tsx:9](/Users/konata/code/tmex-enhanced-wt-merge/packages/terminal-ui/src/components/SplitTerminalArea.tsx:9)。

两 pane 横向布局下，视口宽度增加 50px，平均到目标 pane 后增加约 25px；按当前终端 cell 宽度折算，增加 3 列是合理且与实际结果吻合。

所以这不是“3 列漂移太大”，而是测试把不同最终几何尺寸与初始几何尺寸比较了。2 秒等待后仍为 3，反而说明它已经稳定在最终视口尺寸。

结论：测试 oracle 错误，不是环境噪声，也不是应把阈值从 2 放宽到 4。

修法：

- 若要测试回到原尺寸后能稳定，应在循环结束后恢复 `1200x800`，等待收敛，再比较。
- 更合理的是记录最终视口对应的预期 pane 尺寸，验证终端尺寸与 tmux 尺寸收敛。
- 也可以连续采样确认最终尺寸不再变化，而不是比较 initial/final 数值。

---

## 优先级

按用户侧影响排序：

1. 当前没有确认的真实产品缺陷。
2. #7：最值得优先修复，避免分屏选区测试失真；应修 pane 级测试桥，而不是放宽断言。
3. #8：修正测试 oracle，避免未来用错误阈值掩盖真实 resize 问题。
4. #6：补齐 `searchProviders` mock，恢复搜索 provider 覆盖。
5. #1–#5：当前已由 `b8bf9e8` 修复，属于低风险测试契约同步。