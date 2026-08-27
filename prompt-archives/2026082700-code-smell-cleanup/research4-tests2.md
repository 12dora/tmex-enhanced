# 单元测试第二轮审计报告

审计范围：目标目录下 89 个 `*.test.ts(x)` 文件。已排除生成文件、`apps/gateway`、`packages/ghostty-terminal`。

结论：

- 未发现 `.skip`、`.todo`。
- 未发现仍引用拆分前已删除目标的测试。
- 未发现 panels、terminal-ui 中拆分前单体测试与新 hook 测试的明确重复；相关测试主要覆盖不同层级。
- 除下文列出的两个 sandbox 临时目录限制外，其余测试逐文件运行通过。
- 唯一运行时间超过 2 秒的文件是 `packages/app/src/lib/dep-install.test.ts`。

## P0

### 1. `site-theme.test.ts` 的 DEFAULT_SETTINGS 测试是错误的断言

文件：

- [`packages/stores/src/site-theme.test.ts:92`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:92)，92–94 行
- [`packages/stores/src/site.ts:21`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site.ts:21)，21–36、69–87 行

证据：

```ts
test('DEFAULT_SETTINGS.theme 为 dark', () => {
  expect(useSiteStore.getState().settings).toBeNull();
});
```

生产代码中 `DEFAULT_SETTINGS.theme` 在 33 行定义为 `dark`，只有请求失败时才在 82–87 行写入 store。当前测试只验证 `beforeEach` 设置的 `settings: null`，即使默认主题改成其他值也会通过。

建议：

模拟 `/api/settings/site` 请求失败，调用 `fetchSettings()`，断言返回值、store 和 UI store 的主题均为 `dark`。

预计行数变化：测试代码净增加约 6–10 行。  
风险：低。  
优先级：P0。

### 2. localStorage fallback 测试只测试了测试 helper

文件：

- [`packages/stores/src/site-theme.test.ts:64`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:64)，64–79、285–297 行
- [`packages/stores/src/ui.test.ts:88`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/ui.test.ts:88)，88–110 行

证据：

```ts
test('localStorage 作为离线 fallback：启动时先读 localStorage 即时反馈', () => {
  setLocalStorageTheme('light');
  expect(readLocalStorageTheme()).toBe('light');
});
```

`setLocalStorageTheme()` 和 `readLocalStorageTheme()` 都是本测试文件自定义的 helper，测试没有创建 store，也没有验证启动时是否消费持久化主题。真正的持久化行为已经由 `useUIStore.setTheme` 测试和 `ui.test.ts` 的 rehydrate 测试覆盖。

建议：

删除该测试；如果确实需要启动 fallback 覆盖，应创建新的 UI store 并验证 rehydrate 后主题为 `light`。

预计行数变化：净减少约 4 行；属于应移除的无效测试。  
风险：低。  
优先级：P0。

### 3. `dep-install.test.ts` 存在条件性空测试，并且是唯一超过 2 秒的测试文件

文件：

- [`packages/app/src/lib/dep-install.test.ts:15`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/lib/dep-install.test.ts:15)，15–23 行
- [`packages/app/src/lib/dep-install.test.ts:47`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/lib/dep-install.test.ts:47)，47–50 行
- [`packages/app/src/lib/dep-install.ts:46`](/Users/konata/code/tmex-enhanced-wt-smell/packages/app/src/lib/dep-install.ts:46)，46–52、103–112 行

证据：

```ts
const commands = await planTmuxInstall('darwin');
if (commands.length > 0) {
  expect(commands[0]!.command).toBe('brew install tmux');
}
```

没有 Homebrew 时整个测试不执行任何断言，会无条件通过。`planTmuxInstall('darwin')` 实际调用 `brew --version`，导致测试依赖本机环境。

另外：

```ts
test('returns false for normal user', () => {
  expect(isRoot()).toBe(false);
});
```

该断言依赖运行测试的 UID，root 环境或 CI 容器中会失败。

实测：

```text
Ran 7 tests across 1 file. [2.31s]
```

建议：

为命令可用性注入 runner 或 `isCommandAvailable`，分别显式测试“brew 可用”和“brew 不可用”两条路径。删除依赖实际 UID 的断言，或将 UID 判断也改为可注入的纯逻辑测试。

预计行数变化：测试代码净减少约 15–30 行，生产代码增加约 5–10 行。  
风险：中。  
优先级：P0。

## P1

### 4. agent 删除场景在 history-sync 与 session-actions 中重复覆盖

文件：

- [`packages/stores/src/agent-history-sync.test.ts:94`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent-history-sync.test.ts:94)，94–106 行
- [`packages/stores/src/agent-session-actions.test.ts:249`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/agent-session-actions.test.ts:249)，249–321 行

证据：

history-sync 已有固定 bug 保护：

```ts
test('drops a response whose session was cleared while the request was in flight', async () => {
```

session-actions 又构造相同的延迟 history response，并重复断言：

```ts
expect(state.messages.s1).toBeUndefined();
expect(state.historyLoaded.s1).toBeUndefined();
expect(state.inProgress.s1).toBeUndefined();
expect(state.activeSessionId).toBeNull();
```

建议：

保留 `agent-history-sync.test.ts` 作为并发响应丢弃的 bug guard。`agent-session-actions.test.ts` 只验证 `deleteSession()` 发出 DELETE、调用 `clearSessionRuntime()` 并清理 session 列表；移除重复的延迟响应流程和 history 状态断言。

预计行数变化：净减少约 35–50 行。  
风险：中。  
优先级：P1。

### 5. `ws-client/client.test.ts` 重复测试已拆出的 heartbeat/reconnect collaborator

文件：

- [`packages/ws-client/src/client.test.ts:423`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/client.test.ts:423)，423–533 行
- [`packages/ws-client/src/reconnect-controller.test.ts:5`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/reconnect-controller.test.ts:5)，5–93 行
- [`packages/ws-client/src/heartbeat-controller.test.ts:7`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ws-client/src/heartbeat-controller.test.ts:7)，7–109 行

证据：

client 单体测试覆盖：

```ts
test('断开后按退避重连，超出上限进入 CLOSED 并报错', ...)
test('HELLO 成功后重置尝试次数...', ...)
test('READY 后立即发 PING；PONG 超时关闭 socket', ...)
test('收到 PONG 后解除超时并上报 latency', ...)
```

而 collaborator 测试已经分别覆盖退避次数、封顶、reset、PING、PONG timeout、stop 和 RTT。

建议：

`client.test.ts` 保留一条 reconnect wiring 冒烟测试和一条 heartbeat wiring 冒烟测试，验证 client 正确连接 controller；详细退避数值、timer 状态和 timeout 行为统一由 collaborator 测试负责。

预计行数变化：`client.test.ts` 净减少约 60–90 行。  
风险：中。  
优先级：P1。

### 6. `ws-borsh/convert.test.ts` 的逐事件测试与 table-driven 测试重复

文件：

- [`packages/shared/src/ws-borsh/convert.test.ts:64`](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/ws-borsh/convert.test.ts:64)，64–138、162–186、213–240 行
- [`packages/shared/src/ws-borsh/convert.test.ts:388`](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/ws-borsh/convert.test.ts:388)，388–507 行

证据：

前半部分逐个测试 `window-add`、`window-renamed`、`pane-active`、`bell`、`notification`、`layout-change`、`output`。后半部分的 `cases` 已覆盖相同事件，并额外断言 wire tag：

```ts
it(`${c.type} 事件 round-trip 且 wire tag 为 ${c.tag}`, ...)
```

建议：

保留 table-driven 测试、缺失可选字段测试、未知 tag 测试和损坏 payload 测试；删除普通事件的逐个重复测试。

预计行数变化：净减少约 75–95 行。  
风险：中。  
优先级：P1。

### 7. notification wrapper 重复覆盖 `buildPaneLocationLabel` 的分支矩阵

文件：

- [`packages/notifications/src/notification-format.test.ts:16`](/Users/konata/code/tmex-enhanced-wt-smell/packages/notifications/src/notification-format.test.ts:16)，16–50 行
- [`packages/notifications/src/notification-format.test.ts:53`](/Users/konata/code/tmex-enhanced-wt-smell/packages/notifications/src/notification-format.test.ts:53)，53–101 行
- [`packages/notifications/src/notification-format.ts:53`](/Users/konata/code/tmex-enhanced-wt-smell/packages/notifications/src/notification-format.ts:53)，53–57 行

证据：

生产代码直接调用：

```ts
const location = buildPaneLocationLabel(data, t);
```

helper 测试已经覆盖 title、current command、pane index 和空数据；wrapper 测试 69–101 行再次分别覆盖 title、command、index。

建议：

保留 helper 的完整分支矩阵。wrapper 只保留一条组合测试，验证 title、location 和 body 拼接；保留 fallback title/source/detail 测试。

预计行数变化：净减少约 30–40 行。  
风险：低。  
优先级：P1。

### 8. `runtime-features.test.ts` 建立了未被测试使用的大型 mock 前奏

文件：

- [`packages/stores/src/runtime-features.test.ts:3`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/runtime-features.test.ts:3)，3–64 行
- [`packages/stores/src/runtime-features.test.ts:68`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/runtime-features.test.ts:68)，68–105 行
- [`packages/stores/src/runtime.ts:264`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/runtime.ts:264)，264–313 行

证据：

测试只读取：

```ts
const core = resolveRuntimeCore({ features: { watchUi: false } });
expect(core.features.watchUi).toBe(false);
```

但文件前 64 行额外安装 localStorage，并 mock `i18next`、`@tmex/notifications`、`@tmex/ws-client`。`resolveRuntimeCore()` 的 feature 解析只是 306–310 行的默认值合并，不会调用这些 mock。

建议：

删除无关的浏览器环境和模块 mock，直接测试 `resolveRuntimeCore()`。若模块初始化确实需要隔离，则提取纯 `resolveRuntimeFeatures()` 并对其做 table-driven 测试。

预计行数变化：净减少约 55–65 行。  
风险：中。  
优先级：P1。

### 9. `tmux-sync-theme.test.ts` 为 5 条简单断言维护约 130 行 ws mock

文件：

- [`packages/stores/src/tmux-sync-theme.test.ts:3`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-sync-theme.test.ts:3)，3–137 行
- [`packages/stores/src/tmux-sync-theme.test.ts:141`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-sync-theme.test.ts:141)，141–188 行
- [`packages/stores/src/tmux.ts:43`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux.ts:43)，43–46、367–371 行

证据：

mock 中手工定义了大量与本组测试无关的 builder：

```ts
buildDeviceConnect
buildTmuxSelect
buildTmuxCreateWindow
buildTermInput
buildAgentSubscribe
...
```

实际断言只检查发送消息的 kind 和 window style payload。

建议：

直接为 `createTmuxStore()` 构造最小 `RuntimeCore` fake，或将 window-style 发送逻辑提取为小 collaborator；不要 mock 整个 `@tmex/ws-client` 导出面。保留 dark/light、空 deviceId、transport 未 ready 的行为覆盖。

预计行数变化：净减少约 80–110 行。  
风险：高。  
优先级：P1。

### 10. app-runtime 测试的全局 message handler 不会注销，测试之间会互相污染

文件：

- [`packages/stores/src/tmux-host-managed-notifications.test.ts:44`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-host-managed-notifications.test.ts:44)，44–74、79–100 行
- [`packages/stores/src/tmux-clipboard-host.test.ts:44`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-clipboard-host.test.ts:44)，44–87 行

证据：

```ts
const messageHandlers: MessageHandler[] = [];

onMessage: (handler) => {
  messageHandlers.push(handler);
  return () => {};
},
```

`dispatchToAll()` 和 `dispatchClipboard()` 会向所有历史 handler 广播；测试中的 runtime 也没有调用 `runtime.dispose()`。后续测试会继续驱动前面测试创建的 runtime。

建议：

让 mock 的 unsubscribe 从数组移除 handler，并在每个测试的 `finally` 中调用 `runtime.dispose()`；更理想的是使用注入的 shared transport，按测试实例发布事件，避免进程级 handler 数组。

预计行数变化：净减少或持平，约 `-10` 至 `-25` 行。  
风险：中。  
优先级：P1。

### 11. stores 中重复实现了 8 份 MemStorage 和浏览器环境安装代码

文件：

- [`packages/stores/src/host-services.test.ts:4`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/host-services.test.ts:4)，4–29 行
- [`packages/stores/src/runtime-features.test.ts:3`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/runtime-features.test.ts:3)，3–35 行
- [`packages/stores/src/site-theme.test.ts:5`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:5)，5–39 行
- [`packages/stores/src/tmux-clipboard-host.test.ts:4`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-clipboard-host.test.ts:4)，4–36 行
- [`packages/stores/src/tmux-host-managed-notifications.test.ts:4`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-host-managed-notifications.test.ts:4)，4–36 行
- [`packages/stores/src/tmux-sync-theme.test.ts:3`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-sync-theme.test.ts:3)，3–36 行
- [`packages/stores/src/tmux-shared-transport.test.ts:7`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-shared-transport.test.ts:7)，7–40 行
- [`packages/stores/src/ui.test.ts:4`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/ui.test.ts:4)，4–46 行

证据：

多个文件重复出现：

```ts
class MemStorage {
  private store = new Map<string, string>();
  ...
}
```

并重复安装：

```ts
globalThis.localStorage = ...
globalThis.window = { localStorage: ..., location: ... };
```

建议：

增加非生成的 `packages/stores/src/test-utils.ts`，提供显式的 `createMemoryStorage()` 和 `installWindowStorage()`。helper 必须返回 reset 函数，避免隐藏全局状态。

预计行数变化：净减少约 140–190 行。  
风险：中。  
优先级：P1。

### 12. `site-theme.test.ts` 重复写入六份完整 SiteSettings fixture

文件：

- [`packages/stores/src/site-theme.test.ts:103`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:103)，103–118 行
- [`packages/stores/src/site-theme.test.ts:136`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:136)，136–152 行
- [`packages/stores/src/site-theme.test.ts:164`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:164)，164–180 行
- [`packages/stores/src/site-theme.test.ts:192`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:192)，192–207 行
- [`packages/stores/src/site-theme.test.ts:219`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:219)，219–235 行
- [`packages/stores/src/site-theme.test.ts:253`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/site-theme.test.ts:253)，253–268 行

证据：

每个测试都重复 `siteName`、`siteUrl`、通知开关、SSH 重连参数、language、theme、updatedAt 等字段，差异通常只有 theme。

建议：

在测试文件内增加：

```ts
makeSiteSettings({ theme: 'light' })
```

默认提供合法的完整 `SiteSettings`，测试只覆盖业务相关字段。

预计行数变化：净减少约 70–90 行。  
风险：低。  
优先级：P1。

### 13. `tmux-clipboard-host.test.ts` 三次重复完整 runtime/HostServices 配置

文件：

- [`packages/stores/src/tmux-clipboard-host.test.ts:90`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-clipboard-host.test.ts:90)，90–129 行
- [`packages/stores/src/tmux-clipboard-host.test.ts:131`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-clipboard-host.test.ts:131)，131–169 行
- [`packages/stores/src/tmux-clipboard-host.test.ts:171`](/Users/konata/code/tmex-enhanced-wt-smell/packages/stores/src/tmux-clipboard-host.test.ts:171)，171–209 行

证据：

三个测试重复相同的 `notifications`、`host` 方法、`ensureSocketConnected()` 和 `selectedPanes` 设置，只有 visibility、paneId、storagePrefix 和写入文本不同。

建议：

增加 `createClipboardRuntime({ visibility, write })` helper，统一创建 runtime，并在 helper 或测试结束时负责 dispose。

预计行数变化：净减少约 40–55 行。  
风险：低。  
优先级：P1。

## P2

### 14. 多个低价值测试只验证模块可导入或第三方库行为

文件：

- [`packages/notifications/src/sinks.test.ts:7`](/Users/konata/code/tmex-enhanced-wt-smell/packages/notifications/src/sinks.test.ts:7)，7–18 行
- [`packages/ui/src/utils.test.ts:4`](/Users/konata/code/tmex-enhanced-wt-smell/packages/ui/src/utils.test.ts:4)，4–20 行
- [`packages/shared/src/i18n/exports.test.ts:20`](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/i18n/exports.test.ts:20)，20–40 行
- [`packages/theme/src/exports-and-fonts.test.ts:36`](/Users/konata/code/tmex-enhanced-wt-smell/packages/theme/src/exports-and-fonts.test.ts:36)，36–54 行

证据：

no-op 测试只断言默认空实现“不抛错”：

```ts
expect(() => {
  noopNotificationSink.info(...);
  noopBellPlayer.play();
}).not.toThrow();
```

`ui/utils.test.ts` 主要重复 `clsx` / `tailwind-merge` 的基础行为。i18n 和 theme 中部分断言只是：

```ts
expect(typesMod).toBeDefined();
expect(types).toBeDefined();
expect(en.default ?? en).toBeTruthy();
```

模块已经成功 import，通常已足以证明这些条件。

建议：

删除 no-op 方法测试；`cn` 仅保留一条项目真正依赖的 Tailwind 冲突契约；删除 `toBeDefined`/`toBeTruthy` 导入断言，保留 export map、文件存在性、manifest 内容和字体资源归属测试。

预计行数变化：净减少约 30–40 行。  
风险：低。  
优先级：P2。

## 验证边界

以下两个文件在当前只读 sandbox 中因系统临时目录禁止 `mkdtemp` 而无法完成运行，不将其误判为代码问题：

- `packages/app/src/lib/install.test.ts:42,65`
- `packages/app/src/runtime/serve-frontend.test.ts:14`

`packages/stores/src/tmux-event-router.test.ts` 与 `tmux-clipboard-host.test.ts` 的覆盖分别属于 router 单元层和 app-runtime/host 集成层，当前证据不足以认定为应删除的精确重复，因此未列为重复测试问题。