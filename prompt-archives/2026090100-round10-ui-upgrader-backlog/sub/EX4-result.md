# E2E baseline 失败根因分析

范围：只读静态分析；未修改文件，未运行 Playwright e2e。

## 总结

| 用例 | 判定 | 置信度 | 推荐修复 |
|---|---|---:|---|
| `sidebar-resize.spec.ts:40` | 测试过时 | 99% | 改用当前 `data-testid` |
| `mobile-mouse-reporting.spec.ts:205` | 测试过时 | 99% | 断言单指滚动产生滚轮，而非 motion |
| `agent-session.spec.ts:404` | 测试时序脆弱 | 80% | fill 后显式等待 send 按钮启用 |
| `settings-llm.spec.ts:42` | 测试 mock/流程过时 | 99% | mock 返回 `searchProviders` |
| `ws-borsh-theme-resize.spec.ts:39` | 测试断言过时 | 99% | 恢复初始 viewport 后再比较，或改为比较收敛结果 |

---

## 1. 移动端 Sidebar Sheet

### Spec 摘要

[sidebar-resize.spec.ts:40](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/sidebar-resize.spec.ts:40)：

```ts
await page.goto('/');
await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
const sheet = page.getByTestId('mobile-sidebar-sheet');
```

### 产品侧锚点

- [page-wrapper.tsx:19](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/page-wrapper.tsx:19)：移动端 label 为 `nav.openSidebar`。
- [page-wrapper.tsx:27](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/page-wrapper.tsx:27)：当前触发器为 `data-testid="mobile-sidebar-open"`，并显式设置 `aria-label={label}`。
- [sidebar-layout.tsx:213](/Users/konata/code/tmex-enhanced-wt-r10/packages/ui/src/components/sidebar/sidebar-layout.tsx:213)：内部仍有 `sr-only` 文本 `Toggle Sidebar`，但它被显式 `aria-label` 覆盖。
- [en_US.json:49](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/i18n/locales/en_US.json:49)：英文可访问名为 `Open Sidebar`。
- [mobile-nav.spec.ts:13](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/mobile-nav.spec.ts:13)：现有测试已经使用 `mobile-sidebar-open`。

### 根因 verdict

**测试过时，置信度 99%。**

当前按钮的可访问名不是固定的 `Toggle Sidebar`，而是随移动/桌面状态和语言变化的 `Open Sidebar` 或对应中文翻译。`sr-only` 文本不能抵消显式 `aria-label`。

### 最小修复

把测试选择器改为：

```ts
await page.getByTestId('mobile-sidebar-open').click();
```

不建议修改产品以恢复固定的 `Toggle Sidebar`，因为当前动态 label 是有意提供更准确的无障碍语义。

### Live run

不需要 live run 才能确认根因；修复后可做一次移动端冒烟验证。

### 文件归属

- 测试文件：[sidebar-resize.spec.ts](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/sidebar-resize.spec.ts)
- 产品文件：无

---

## 2. 移动端单指拖动没有 motion

### Spec 摘要

[mobile-mouse-reporting.spec.ts:205](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/mobile-mouse-reporting.spec.ts:205)：

```ts
await multiTouch(page, '.xterm-screen', [{ from, to }], { steps: 6 });

await expect
  .poll(() => [...readLog(logPath).matchAll(SGR_MOTION_RE)].length)
  .toBeGreaterThan(0);

expect(SGR_PRESS_RE).toHaveLength(1);
expect(SGR_RELEASE_RE).toHaveLength(1);
```

测试通过合成 `TouchEvent` 模拟单指拖动。

### 产品侧锚点

- [useMobileTouch.ts:23](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/useMobileTouch.ts:23)：TouchEvent 监听挂在终端容器上。
- [gesture-machine.ts:100](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/gesture-machine.ts:100)：鼠标上报模式下单指初始进入 `pending`。
- [gesture-machine.ts:148](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/gesture-machine.ts:148)：单指越过移动阈值后明确转为 `scroll`，不再升级为 TUI drag。
- [gesture-machine.ts:172](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/gesture-machine.ts:172)：滚动路径调用 `handleSingleMove`。
- [mouse-report-gesture.ts:3](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/mouse-report-gesture.ts:3)：触摸鼠标上报只保留 tap 的 press/release。
- [terminal-input-bridge.ts:298](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-input-bridge.ts:298)：viewport gesture 在鼠标上报模式下转入滚轮编码。
- [terminal-input-bridge.ts:329](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-input-bridge.ts:329)：单指滚动编码为按钮 64/65，即 SGR wheel。
- [terminal-pointer-handlers.ts:162](/Users/konata/code/tmex-enhanced-wt-r10/packages/ghostty-terminal/src/terminal-pointer-handlers.ts:162)：真正的 motion drag 仍存在，但它属于原生 MouseEvent/pointer drag 路径。
- [gesture-machine.test.ts:157](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/gesture-machine.test.ts:157)：单测已经固定了“单指移动走滚动，不产生 motion”的行为。

实际链路是：

```text
合成 touchmove
→ pending 越过阈值
→ scroll
→ handleViewportGesture
→ reportGestureAsMouse
→ SGR wheel 64/65
```

### 根因 verdict

**测试过时，置信度 99%。**

合成 TouchEvent 能正常冒泡到当前产品监听器，问题不在模拟器没有触发产品代码，而是产品当前已经有意改变了移动端语义：

- 单指静态 tap：press + release；
- 单指移动：滚动/滚轮；
- 双指移动：滚轮；
- TUI 的 press + motion + release：保留给桌面原生鼠标拖动。

因此该测试不仅不会收到 motion，也不应收到单指拖动对应的 press/release。

### 最小修复

将测试改为验证滚轮：

- 重命名为单指滚动；
- 使用 `SGR_WHEEL_RE` 断言至少产生一个滚轮事件；
- 断言 motion、press、release 均为 0。

如果产品需求重新要求“移动端单指拖动 TUI 选区”，才需要反向修改：

- [gesture-machine.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/gesture-machine.ts)
- [mouse-report-gesture.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/touch/mouse-report-gesture.ts)

但这会与当前注释和单测契约冲突，不是本 baseline 的推荐修复。

### Live run

静态代码已经足以确认不会产生 motion。建议 live run 仅用于确认实际滚轮事件数量和方向。

### 文件归属

- 测试文件：[mobile-mouse-reporting.spec.ts](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/mobile-mouse-reporting.spec.ts)
- 推荐产品文件：无
- 需求改变时的候选产品文件：`gesture-machine.ts`、`mouse-report-gesture.ts`

---

## 3. Running session 入队时 send 按钮等待超时

### Spec 摘要

[agent-session.spec.ts:414](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/agent-session.spec.ts:414)：

```ts
await textarea.fill('first message SLOW_REPLY');
await page.getByTestId('agent-chat-send').click();

await expect(page.getByTestId('agent-chat-stop')).toBeVisible();

await expect(textarea).toBeEnabled();
await textarea.fill('queued while running');
await page.getByTestId('agent-chat-send').click();
```

测试等待的是 textarea 启用，没有在 `fill` 后显式等待 send 按钮启用。

### 产品侧锚点

- [agent-composer.tsx:96](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-composer.tsx:96)：提交函数在 `disabled` 或空文本时直接返回。
- [agent-composer.tsx:158](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-composer.tsx:158)：running 状态下仍渲染 `agent-chat-send`。
- [agent-composer.tsx:161](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-composer.tsx:161)：send 按钮禁用条件是 `disabled || text.trim().length === 0`。
- [agent-tab-view.ts:74](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-tab-view.ts:74)：全局输入禁用来源包括 `sending`、草稿物化、等待确认、节点离线等，但**不包括 running**。
- [agent-tab-view.ts:90](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-tab-view.ts:90)：running 只由 session 状态决定。
- [use-agent-tab-actions.ts:134](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/use-agent-tab-actions.ts:134)：running session 的 `onSend` 调用 `enqueueMessage`。
- [agent-session-message-actions.ts:55](/Users/konata/code/tmex-enhanced-wt-r10/packages/stores/src/agent-session-message-actions.ts:55)：首条消息请求期间设置 `sending=true`。
- [agent-session-message-actions.ts:68](/Users/konata/code/tmex-enhanced-wt-r10/packages/stores/src/agent-session-message-actions.ts:68)：REST 请求结束后清除 `sending`。
- [supervisor.ts:298](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/agent/supervisor.ts:298)：后端运行中的 session 会入队。
- [supervisor.ts:317](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/agent/supervisor.ts:317)：空闲 session 才直接追加用户消息并启动 run。

### 根因 verdict

**测试时序脆弱，置信度 80%。**

产品当前的状态机允许 running session 继续输入并入队；没有发现“running 时产品错误禁用 send”的静态证据。

测试存在两个独立的异步条件：

1. session 状态已经是 `running`；
2. `sending/materializingDraft` 已经结束；
3. textarea 的本地文本 state 已经更新，使 send 按钮从空文本禁用变为启用；
4. React 条件渲染后的按钮已经稳定。

测试只等待了 textarea，而没有等待 send 按钮本身。`agent-chat-stop` 可见也只证明 session 是 running，不等价于 send 已经 action-ready。

### 最小修复

每次 `fill` 后显式等待 send：

```ts
const send = page.getByTestId('agent-chat-send');

await textarea.fill('first message SLOW_REPLY');
await expect(send).toBeEnabled();
await send.click();

await expect(page.getByTestId('agent-chat-stop')).toBeVisible({ timeout: 15_000 });

await expect(textarea).toBeEnabled();
await textarea.fill('queued while running');
await expect(send).toBeEnabled();
await send.click();
```

不建议直接使用 `force: true` 或单纯增加超时。

### Live run

**需要 live run 确认。**

如果显式等待后仍长期保持 disabled，应现场确认是以下哪一个状态未清除：

- `sending`；
- `materializingDraft`；
- `activeSession` 未正确进入 running；
- session 被误判为 orphan/offline。

只有在 live run 证明这些状态卡死时，才需要进一步修改产品。

### 文件归属

- 首选测试文件：[agent-session.spec.ts](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/agent-session.spec.ts)
- 推荐产品文件：无
- 若 live run 证实产品状态卡死，候选文件：
  - [agent-tab-view.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-tab-view.ts)
  - [agent-composer.tsx](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/agent/agent-composer.tsx)
  - [agent-session-message-actions.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/stores/src/agent-session-message-actions.ts)

---

## 4. Settings LLM 搜索 Provider 流程

### Spec 摘要

[settings-llm.spec.ts:168](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/settings-llm.spec.ts:168) 的 mock：

```ts
if (req.method() === 'GET') {
  await route.fulfill({ status: 200, json: { settings } });
}
```

随后测试在 [settings-llm.spec.ts:294](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/settings-llm.spec.ts:294) 打开选择器，并在 [settings-llm.spec.ts:295](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/settings-llm.spec.ts:295) 查找 `Tavily`。

### 产品侧锚点

- [search-tab.tsx:103](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/search-tab.tsx:103)：从 `settingsQuery.data.searchProviders` 构建选项。
- [search-tab.tsx:104](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/search-tab.tsx:104)：默认只加入 `none`。
- [search-tab.tsx:106](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/search-tab.tsx:106)：Tavily/Brave 来自服务端列表。
- [search-tab.tsx:136](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/search-tab.tsx:136)：当前 selector testid 仍是 `settings-search-provider-select`。
- [search-tab.tsx:156](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/settings/search-tab.tsx:156)：当前 Tavily 输入 testid 仍是 `settings-search-tavily`。
- [llm.ts:40](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/api/llm.ts:40)：后端生成搜索 Provider DTO。
- [llm.ts:265](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/api/llm.ts:265)：GET `/api/llm/settings` 返回 `settings` 和 `searchProviders`。
- [llm.ts:156](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/agent/tools/web.ts:156)：当前内建 Provider 的 id/label 为 `tavily`/`Tavily`。
- [llm.ts:222](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/agent/tools/web.ts:222)：注册 Tavily Provider。
- [llm.ts:223](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/agent/tools/web.ts:223)：注册 Brave Provider。
- [llm.ts:87](/Users/konata/code/tmex-enhanced-wt-r10/packages/shared/src/contracts/llm.ts:87)：响应契约要求 `searchProviders`。

### 根因 verdict

**测试 mock/流程过时，置信度 99%。**

当前 AI 设置页仍然同时渲染 LLM Provider 和搜索设置：

- [ai-settings-tab.tsx:7](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/ai-settings-tab.tsx:7)
- [ai-settings-tab.tsx:8](/Users/konata/code/tmex-enhanced-wt-r10/apps/konata/code/tmex-enhanced-wt-r10/apps/fe/src/pages/settings/ai-settings-tab.tsx:8)

选择器和 testid 没有过时；过时的是测试返回的 API 数据结构。mock 缺少 `searchProviders`，因此 UI 只能生成 `none` 选项，不会出现 `Tavily`。

### 最小修复

让 GET 和 PATCH mock 都返回完整结构，例如：

```ts
const searchProviders = [
  { id: 'tavily', label: 'Tavily', isConfigured: false },
  { id: 'brave', label: 'Brave', isConfigured: false },
];
```

然后返回：

```ts
json: { settings, searchProviders }
```

PATCH 返回也应保持该字段，否则保存后 query invalidate 重新 GET 时又会回到不完整响应。

### Live run

不需要 live run 才能确认根因；修复 mock 后可做一次设置页冒烟验证。

### 文件归属

- 测试文件：[settings-llm.spec.ts](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/settings-llm.spec.ts)
- 产品文件：无

---

## 5. Split resize 的 cols drift 3

### Spec 摘要

[ws-borsh-theme-resize.spec.ts:58](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/ws-borsh-theme-resize.spec.ts:58) 初始 viewport：

```ts
await page.setViewportSize({ width: 1200, height: 800 });
```

但循环最后一次设置为 [ws-borsh-theme-resize.spec.ts:82](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/ws-borsh-theme-resize.spec.ts:82)：

```ts
width: 1250,
height: 830,
```

之后却将最后 pane 尺寸与初始 pane 尺寸比较：

[ws-borsh-theme-resize.spec.ts:94](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/ws-borsh-theme-resize.spec.ts:94)：

```ts
expect(colsDrift).toBeLessThan(2);
```

### 产品侧锚点

- [SplitPaneView.tsx:174](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/split/SplitPaneView.tsx:174)：每个 pane 使用 `sizingMode="follow"`。
- [useSplitPaneTerminals.ts:102](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/split/useSplitPaneTerminals.ts:102)：pane 终端尺寸跟随 tmux layout。
- [useWindowResizeReporter.ts:46](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/split/useWindowResizeReporter.ts:46)：根据外层 viewport 计算 window grid。
- [splitLayoutGeometry.ts:174](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/splitLayoutGeometry.ts:174)：扣除两个水平 pane 的 chrome 宽度。
- [splitLayoutGeometry.ts:176](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/splitLayoutGeometry.ts:176)：按 cell 宽度向下取整计算 cols。
- [splitLayoutGeometry.ts:177](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/splitLayoutGeometry.ts:177)：按 cell 高度向下取整计算 rows。
- [tmux-command-handlers.ts:188](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/ws/tmux-command-handlers.ts:188)：多 pane window 收到 resize 时执行 window resize。
- [tmux-command-handlers.ts:193](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/ws/tmux-command-handlers.ts:193)：调用 `resizeWindow`。
- [session-commands.ts:549](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/tmux-client/external/session-commands.ts:549)：最终执行 tmux `resize-window`。

当前测试实际比较的是：

```text
初始 viewport：1200×800
最终 viewport：1250×830
```

对于两列 pane，额外 50px 宽度除以约 8～10px 的 cell 宽度，再分配到两个 pane 后，目标 pane 增加约 2～3 列是正常结果。报告中的 `cols drift 3` 与当前布局逻辑一致。

### 根因 verdict

**测试断言过时，置信度 99%。**

没有静态证据表明 cell measurement 或 resize pipeline 有 bug。失败是由测试自身改变了最终 viewport，却要求 tmux pane 尺寸回到初始值造成的。

这不是简单应该把容差从 `<2` 放宽到 `<4`；那会掩盖测试比较对象不一致的问题。

### 最小修复

如果要比较前后漂移，应在比较前恢复初始 viewport：

```ts
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForTimeout(2_000);
```

更合理的测试语义是：

- 每次 viewport 改变后，断言本地终端尺寸最终收敛到当前 tmux pane 尺寸；
- 只有在恢复到同一个 viewport 后，才比较前后 drift；
- 或者根据最终 viewport 计算预期的 pane 尺寸，而不是与初始值比较。

### Live run

**需要 live run 做行为确认，但不需要用来判断静态根因。**

live run 可确认：

- 最终尺寸是否稳定为预期的 3 列差值；
- 是否存在额外的 resize oscillation；
- `TERM_RESIZE`、`TERM_SYNC_SIZE` 和 window-style 消息是否按预期收敛。

### 文件归属

- 测试文件：[ws-borsh-theme-resize.spec.ts](/Users/konata/code/tmex-enhanced-wt-r10/apps/fe/tests/ws-borsh-theme-resize.spec.ts)
- 推荐产品文件：无
- 若 live run 发现实际存在额外 oscillation，候选调查文件：
  - [useWindowResizeReporter.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/split/useWindowResizeReporter.ts)
  - [splitLayoutGeometry.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/terminal-ui/src/components/splitLayoutGeometry.ts)
  - [use-pane-size-sync.ts](/Users/konata/code/tmex-enhanced-wt-r10/packages/panels/src/device-console/use-pane-size-sync.ts)
  - [tmux-command-handlers.ts](/Users/konata/code/tmex-enhanced-wt-r10/apps/gateway/src/ws/tmux-command-handlers.ts)

---

## 产品文件触及汇总

按当前推荐修复方案，五项都不需要修改产品代码：

| 用例 | 推荐修改的测试文件 | 产品文件 |
|---|---|---|
| Sidebar mobile | `apps/fe/tests/sidebar-resize.spec.ts` | 无 |
| Mobile mouse | `apps/fe/tests/mobile-mouse-reporting.spec.ts` | 无 |
| Agent enqueue | `apps/fe/tests/agent-session.spec.ts` | 无，待 live run 排除状态卡死 |
| Settings LLM | `apps/fe/tests/settings-llm.spec.ts` | 无 |
| Theme resize | `apps/fe/tests/ws-borsh-theme-resize.spec.ts` | 无，待 live run 排除额外 oscillation |

因此可以按五个独立测试文件分配并行修复；产品侧暂不需要拆分 ownership。