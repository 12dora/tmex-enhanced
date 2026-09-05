# T5 结果：被分享人页（前端）

分支 `feat/round29-terminal-share`，worktree `/Users/konata/code/tmex-r29`。

## 一、交付内容

### 1. 路由（RootLayout 之外）

`apps/fe/src/main.tsx`（**共 3 处 pointwise 编辑**）：

- 新增 `/s/:shareId`、`/n/:nodeId/s/:shareId` 两条路由，与 `/login` 同级，挂在 `RootLayout` 之外
  ——没有侧栏、没有 `MeshNodesResident`、没有 `GlobalDeviceProvider`、没有 `NodeRouteGate`。
- 路由元素为 `ShareRouteElement`（薄壳，只做 chunk 懒加载 + 失败重试卡片），不复用 `PageWrapper`
  （那层顶栏带品牌链接与侧栏开关，且页标题/动作区只吃路由参数，而分享名称与剩余期限来自接口）。
- `installSessionInterceptor` 的 navigate 前加一句 `if (isSharePathname(location.pathname)) return;`
  ——访客手上只有分享凭证，任何常规 `/api/*` 的 401 都是预期内的，踢去登录页只会拆掉正在看的终端。

`apps/fe/src/page-modules.ts`：新增 `sharePageModule`（不进 `IDLE_PRELOAD_PAGE_MODULES`）。
`vite build` 实测产出独立 chunk `SharePage-*.js`。

**PWA / service worker**：`apps/fe` 里**没有** service worker，也没有 vite-plugin-pwa / workbox
（已全仓 grep 确认）。PWA 只靠 `index.html` 里的 `<link rel="manifest" href="/api/manifest.webmanifest">`，
其 `start_url: '/'`、无 `scope` 字段，默认 scope 即 `/`，`/s/*` 天然在内。
`/s/*` 的 HTML 由 `packages/app/src/runtime/serve-frontend.ts` 的 SPA fallback 直接回 `index.html`
（无扩展名即回落，且 index.html 带 `no-cache`）。分享接口全走 fetch，无任何缓存层。**故本项无需改动。**

### 2. `apps/fe/src/share/access-client.ts`

按 plan §2.3 实现 `getShareAccess` / `loginShareAccess` / `logoutShareAccess`，
URL 为 `<nodeBase>/api/share-access/:id[/login|/logout]`（`nodeBase = nodePathPrefix(nodeId)`，self 为空串）。

**刻意不走 `ApiClient`**：那条路径上挂着全局 401 响应钩子，一次密码错误会被当成「entry 会话失效」。
用注入式 `ShareFetch`（默认 `globalThis.fetch`，`credentials: 'same-origin'`），错误经纯函数
`shareAccessErrorFrom(status, body)` 归一成 `ShareAccessError { code, status, retryAfterMs }`：
`SHARE_PASSWORD_INVALID`(401) / `SHARE_LOGIN_LOCKED`(429, 带 `retryAfterMs`) / `SHARE_ENDED`(410) /
`SHARE_NOT_FOUND`(404) / `SHARE_REQUEST_FAILED`（其余 + 网络异常）。错误体里的契约码优先于状态码。

### 3. 页面状态机与视图

- `share-state.ts`：纯 reducer `loading → password → terminal → ended`，
  含 4401 回表单、4410/登出进结束态、限速锁定换算成解除时刻、`shareLockSeconds()`。
- `share-format.ts`：`shareRemainingMs` / `shareRemaining` / `shareRemainingLabel`（→ i18n key + 插值）
  / `shareCountdownIntervalMs`（不足 1 小时才每秒刷新）。
- `share-pane.ts`：`resolveSharePaneId(panes, requested)` —— 查询参数点名的 pane 还在就用它，否则第一个。
- `share-password-form.tsx`：标题即分享名称；密码框带显示/隐藏切换；一行内联错误（含锁定倒数，
  锁定期间禁用提交）；`sr-only` live region 播报。
- `share-ended.tsx`：三种文案（已结束 / 不存在 / 不可用），不给任何跳转出口。
- `share-remaining.tsx`：剩余期限徽标，永久显示「永久」，到期显示「已过期」。
- `share-console.tsx`：已认证视图 —— 头部（名称 + 剩余期限 + `DeviceConsoleActions` + 断开）
  与 `DeviceConsole` 一起挂在专用 `RuntimeProvider` + `QueryClientProvider` 内；
  挂载即 `connectDevice(deviceId)`；`formatBrowserTitle` 固定回分享名称（设备名/节点名不外泄）。
- `pages/SharePage.tsx`：外壳 `SidebarInset`（即 `<main data-slot="sidebar-inset">`，
  `h-dvh overflow-hidden`），按状态四选一渲染。

### 4. 专用运行时 `share-runtime.ts`

`createShareRuntime({ nodeId, shareId, uiStore, onClose })`：

- 自建 `createGatewayConnection({ wsUrl: nodeWsUrl(nodeId), wsUrlFactory, onClose })`
  （self → `/ws`，远端 → `/n/<id>/ws`，每条 socket 换 `?cid=`），cookie 由浏览器自动携带。
- `createAppRuntime({ features: { agentUi:false, watchUi:false, filesUi:false, shareViewer:true },
  controlsBrowserPrefs:false, storagePrefix:'share:<id>:', terminalFileLinks: <空实现> })`。
- `host.appPath` 用 `createShareAppPath(base)`：把包内构造的 `/devices/<d>/windows/<w>/panes/<p>`
  映射成 `\<base\>?w=&p=`，其余路径一律回到分享页本身；`host.navigate` 直接吞掉。
  **这是本任务唯一的结构性取舍**：控制台以 URL 为真相源、会自行 `navigate` 到 `/devices/…`
  （焦点跟随、分屏点击、pane 关闭回落、移动端 pane 切换），不做这层映射就会把访客带出分享页。
  改成映射后每一次导航都留在 `/s/<id>`，`SharePage` 从 `?p=` 读回 pane，`windowId` 恒取接口给的
  分享 window（查询串里的 `w` 只写不读），访客被钉死在这一个 tab 上。
  代价：appPath 不再是纯前缀变换，不能拿去当 `matchPath` pattern（已在文件注释里写明；
  用 matchPath 的 agent tab / 文件面板 / 设备树在分享页一个都不渲染）。
- **零 401**：`QueryClient` 预置 `['devices'] = { devices: [] }`、
  `['terminal-shortcuts'] = DEFAULT_TERMINAL_SHORTCUTS`（`staleTime: Infinity`、`retry:false`、
  `refetchOnWindowFocus:false`），并注入空的 `terminalFileLinks`。
  控制台路径上原本会打 `/api/devices`、`/api/settings/terminal-shortcuts`、`/api/files/roots`
  三条常规接口，现在一条都不发。快捷键栏用内置默认表，手机访客照样有 ESC/CTRL-C/方向键。

### 5. 关闭码处理（无需改 `packages/ws-client`）

`packages/ws-client` **没有**「非重试关闭码列表」——现有机制是宿主经 `GatewayConnectionOptions.onClose`
拿到 `CloseEvent.code` 后调 `client.disconnect()`（`disconnect()` 内 `clearTimers()` → `reconnector.cancel()`
且置 `CLOSED`，`handleClose` 随即早退），`NodeConnectionManager.handleUnauthorized` 处理 4401 就是这一套。
分享页照搬：`createShareRuntime` 在 `onClose` 里对 4410/4401 **同步**调 `socket.client.disconnect()`
（`handleClose` 紧跟回调执行，等 React 提交完卸载再停已经排上了一次重连），随后 4410 → `ended` 态、
4401 → 回密码表单并释放运行时。**因此没有编辑 `packages/ws-client`。**

### 6. 移动端键盘避让

`share-keyboard.ts` 复刻 `MainInset` 的策略（`useKeyboardAvoidance(false, keyboardBehaviorMode)`
→ transform / height 两种 style），外壳用 `SidebarInset` 保证 `[data-slot="sidebar-inset"]` 选择器命中
（hook 内的 `AppliedTransformReader` 依赖它）。分享页没有侧栏抽屉，`disabled` 恒为 false。
输入模式切换（direct/editor）由 `DeviceConsoleActions` 提供，已在头部。

### 7. i18n

`packages/shared/src/i18n/core-keys.ts` 加入 `'shareAccess'` 前缀；
三份 locale 各加 21 个 `shareAccess.*` 键（en_US / zh_CN / ja_JP 完全同步）：
`defaultName, loading, passwordTitle, password, showPassword, hidePassword, continue,
passwordRequired, passwordInvalid, locked, requestFailed, ended, notFound, unavailable,
expiresIn, expired, permanent, remainingDays, remainingHours, remainingMinutes, disconnect`。
生成物已含这些键（另一 agent 跑过 `build:i18n`，三语 core 各 21 条、rest 无残留，已核对）。

### 8. `packages/stores` 的 feature 开关

`runtime.ts`：`AppRuntimeOptions.features.shareViewer?: boolean`、`RuntimeFeatures.shareViewer: boolean`，
`resolveFeatures` 缺省 `false`。同步更新两处断言全量 features 的既有测试
（`runtime-features.test.ts`、`runtime-core-resolution.test.ts`）并各补一条 `shareViewer` 用例。
**T4 可以据此隐藏工具栏里的分享按钮与结构性操作**（见下方遗留）。

## 二、文件清单

新增（全部在 `apps/fe/src/share/`，除 SharePage）：
`access-client.ts`、`share-state.ts`、`share-format.ts`、`share-pane.ts`、`share-route.ts`、
`share-runtime.ts`、`share-keyboard.ts`、`use-share-session.ts`、`use-share-now.ts`、
`share-console.tsx`、`share-password-form.tsx`、`share-ended.tsx`、`share-remaining.tsx`、
`share-route-element.tsx`；`apps/fe/src/pages/SharePage.tsx`。
测试：`access-client.test.ts`、`share-state.test.ts`、`share-format.test.ts`、`share-pane.test.ts`、
`share-route.test.ts`、`share-runtime-codes.test.ts`。

改动（均为 pointwise）：
`apps/fe/src/main.tsx`（+9 行）、`apps/fe/src/page-modules.ts`（+1 行）、
`apps/fe/src/page-modules.test.ts`（补分享页断言）、
`packages/shared/src/i18n/core-keys.ts`（+1 前缀）、
`packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`（各 +1 个 `shareAccess` 子树）、
`packages/stores/src/runtime.ts`（+3 行）、
`packages/stores/src/runtime-features.test.ts`、`packages/stores/src/runtime-core-resolution.test.ts`。

**未触碰** `packages/panels`（T4 在改工具栏）、`packages/ws-client`、`apps/fe/src/pages/settings/**`（T6）。

## 三、验证

| 项 | 结果 |
|---|---|
| `cd apps/fe && bun test src/share/` | 61 pass / 0 fail（6 文件） |
| `cd apps/fe && bun test src/` | 2544 pass / 1 fail —— 唯一失败是 `NodeLinkDiagnostics > 浏览器直连有 ICE 明细…`（`src/node/device-node-badges`，链路信息窗 i18n 任务在途，与 T5 无关） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 我的文件 0 错；仓库里另有 `pages/settings/{share,nodes}/**`、`src/node/mesh-events.ts` 的在途错误（T6 / 其它 agent） |
| `cd packages/stores && bun test` | 432 pass / 0 fail |
| `cd packages/stores && bunx tsc --noEmit -p .` | 0 错 |
| `bunx biome check <我的 27 个文件>` | 0 违规 |
| `bun scripts/complexity/gate.ts` | 我的文件 0 违规（现存 6 条违规全在 `apps/gateway/src/mesh/stream-targets.ts`、`packages/app/src/runtime/assemble-routes.ts`、`apps/fe/src/pages/settings/share/share-tab.tsx`，属 T3 / T6） |
| `cd apps/fe && bunx vite build` | 成功，产出独立 chunk `SharePage-*.js` |

`i18n` 核心覆盖守卫 `apps/fe/src/i18n/core-coverage.test.tsx`：32 pass / 0 fail。

## 四、契约偏差与遗留（需其它 agent / 指挥官关注）

1. **控制台会向分享连接发出白名单外的两种帧**（plan §2.5 会以 `SHARE_FORBIDDEN` 拒绝，不断开）：
   - `TMUX_SELECT`（0x0201）：`usePaneRouteReconciliation` 在路由身份就绪后必发一次
     （`packages/stores/src/select-pane-dispatch.ts`）；
   - `FOCUS_PANE`（0x0212）：分屏内切焦点走轻量路径时发；
   - `SET_WINDOW_STYLE`（0x020a）：`createTmuxStore.sendWindowStyleForCurrentTheme` 在设备连上 /
     主题切换时发。
   三者都是 `packages/stores` 里控制台路径上的既有行为，绕开它们要动 `packages/panels`/`packages/stores`
   的现有逻辑（超出「只加 option」的授权）。**功能上不受影响**：终端画面靠 canonical 订阅
   （`CANONICAL_COMMAND`，白名单内）重建，输入走 `TERM_INPUT`，尺寸走 `RESIZE_PANE` / `TERM_VIEWPORT`，
   都在白名单里。被拒的 `KIND_ERROR` 在前端只落到 `console.error`（`tmux-event-router.ts:270`），
   不弹 toast、不断连。**建议 T2 复核**：要么在白名单里补上 scope 内的 `TMUX_SELECT`/`FOCUS_PANE`
   （语义上就是「切当前分享 window 内的焦点」，且 §一 决策 3 允许访客参与尺寸仲裁），
   要么确认这几条 console 噪声可接受。`SET_WINDOW_STYLE` 必须继续拒——那是写操作。
2. **工具栏按钮**：按任务说明「split/settings 仍出现可接受」。当前分享页头部的
   `DeviceConsoleActions` 在桌面端仍渲染「向右/向下分屏」与「终端设置」「刷新页面」。
   watch 按钮已被 `watchUi:false` 关掉。**T4 可用 `runtime.features.shareViewer`
   在 `buildToolbarButtons`（`packages/panels/src/device-console/device-console-toolbar.tsx:103`）
   里去掉 `splitButtons`，并用同一个标记隐藏新加的「分享」按钮**——分享页不该有分享入口。
   服务端已按 §2.5 拒绝 `SPLIT_PANE`，所以现在点了只是无反应。
3. **`GET /api/share-access/:id` 必须在未认证时也返回 `name`**（契约表里 `name` 是无条件字段）——
   密码表单的标题就是它。若 T1/T3 出于隐私考虑改成认证后才给，分享页会回落到
   `shareAccess.defaultName`（「终端分享」），请提前告知。
4. **永久分享的滑动续期**不会实时反映在头部：`expiresAt` 只在进入页面与登录成功后各取一次。
   永久分享 `expiresAt` 为 null（显示「永久」），所以肉眼无差异；限期分享到期会走 4410。
5. `/n/:nodeId/s/:shareId` 的 HTML 由 entry（hub）的 SPA fallback 提供，分享接口与 WS 才经
   `/n/<id>` 转发到目标节点——与既有 `/n/<id>/devices/...` 同形，需 T3 确认转发层放行
   `/n/<id>/api/share-access/*` 与带分享 cookie 的 `/n/<id>/ws`。
6. 未做 e2e（`apps/fe/tests/*.spec.ts`）：需要真实分享记录，留给指挥官的临时实例实测。
