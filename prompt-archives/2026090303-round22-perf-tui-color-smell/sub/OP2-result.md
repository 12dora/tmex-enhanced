# OP2 结果：前端评审 4–10 项修复

对应 `scratchpad/r22/review/frontend-review.md` 第 4～10 条（全部 LOW）。每条都配了「改前失败、改后通过」的定向测试。
未跑 e2e（任务要求）。未触碰 `packages/ui/**` 与 `apps/fe/src/main.tsx`。

## 逐条说明

### 4. 高亮 worker 的取消没有传到 worker

- 协议改成带 `type` 的联合体（`highlight` / `cancel`），`highlight-protocol.ts`。
- 新增 `packages/panels/src/code-viewer/highlight-queue.ts`：worker 侧串行队列。
  - **每个任务开跑前先让出一个宏任务**。这是关键：worker 的 message 事件也是宏任务，
    不让出的话 `engine.highlight` 那条微任务链会在下一条消息被读到之前跑完，
    已经躺在事件队列里的 cancel 根本没机会生效（实测确认：不加这一步，e2e 里被取消的请求照样回包）。
  - 让出之后 cancel 命中队列即 `splice` 出队（从不执行）；命中正在执行的任务（语言 chunk 动态 import 期间）
    则丢弃其回包。`run` 失败按未高亮回包，不卡住后续任务。
- `highlight-client.ts`：cancel 回调除了删本地 pending，还向 worker `postMessage({type:'cancel',id})`；
  重复取消只发一次。「同一查看器只保留最新待执行请求」由 `use-highlighted-code` 的 effect cleanup
  （切 code/fileName 时先 cancel 再 request）配合新协议达成，无需额外接线。
- worker 本体退化成 5 行接线。

测试：新增 `highlight-queue.test.ts`（7 条，含「排队中取消→从不执行」「开跑前才出队」「执行中取消→不回包」）；
`highlight-client.test.ts` 补 3 条（cancel 发给 worker、重复取消只发一次、切文件时旧请求当场撤掉）；
`highlight.worker.test.ts` 补一条真 worker 端到端的取消断言（连跑 5 次稳定）。

### 5. 非路由懒面板可能先于 rest 语言包挂载

- 新增 `apps/fe/src/i18n/rest-prerequisite.ts`：`setI18nRestPrerequisite` / `awaitI18nRest` / `withI18nRest`。
  单独一个模块是因为 `apps/fe/src/i18n/index.ts` 用了 vite 专属的 `import.meta.glob`，进不了 bun 单测环境
  （与 `use-page-module` 的 prerequisite 注入同法）。
- `apps/fe/src/i18n/index.ts` 启动时 `setI18nRestPrerequisite(ensureI18nRest)`。
- **本条涉及的懒面板 loader 文件（仅此一个）**：`apps/fe/src/components/side-panels/side-panel-host.tsx`。
  两个面板 loader 改成 `withI18nRest(...)`（模块 import 与 `ensureI18nRest()` 并行，两者都到位才交付），
  并导出 `loadConnectDevicesPanel` / `loadAccountSecurityPanel` 以便单测。
  - 「接入设备」用 `connectDevices.*` / `mesh.*` / `nodes.*`（均在 rest），是本条的正主；
    「账号安全」当前只用 `auth.*` / `common.*`（core），一并包上是为了统一，避免后续加 rest key 时再踩一次。
- 其余 `lazy(`/`import(` 排查结论：`app-sidebar.tsx` 的 AgentTab/FilesTab/FilesNodeSection 用的
  `agent.*` / `files.*` 都在 core 前缀里；`SettingsPage.tsx` / `FilePage.tsx` 的子 chunk 属于路由页，
  路由页本身已经由 `usePageModule` 的 prerequisite 挡过一次。故都不需要改。
- rest 加载失败时仍然交付模块（退化成裸 key），不把面板永远卡在骨架上。

测试：`apps/fe/src/i18n/rest-prerequisite.test.ts`（5 条）；
`side-panel-host.test.tsx` 新增 2 条：注入一个不 resolve 的前置条件后，两个面板 loader 都不交付组件，
放行后才交付（改前立即交付）。

### 6. `loadRest()` 失败伪装成成功 + 切语言时机

- 新增 `apps/fe/src/i18n/rest-bundle.ts`：
  - `createRestBundleCache`：有界重试（退避 `[200, 600] ms`，共 3 次尝试），用尽后 **reject**；
    失败不缓存（下次 ensure 真的重来），成功后复用同一个 promise。
  - `changeLanguageAfterRest`：先备好目标语言 rest，再执行真正的切换。
- `apps/fe/src/i18n/index.ts`：`loadRest` 换成上面的 cache；`ensureI18nRest` 现在会 reject；
  **在本模块内包一层 `i18n.changeLanguage`**，切语言时先 `loadRest(目标语言)` 再 `changeLanguageDirect`
  （rest 失败也放行，不把切换卡死）。`languageChanged` 里的补包保留为兜底并加了 `.catch`。
  - 包一层而不是改调用点：`changeLanguage` 的调用点在 `packages/stores/src/site.ts`、
    `apps/fe/src/pages/settings/use-site-settings-form.ts`，都不在本任务的文件所有权范围内。

测试：`apps/fe/src/i18n/rest-bundle.test.ts`（7 条，含「重试用尽后 reject」「失败不缓存」「切语言顺序」）。

**未做（越权）**：`apps/fe/src/use-page-module.ts:47` 现在仍显式 `.catch(() => undefined)` 吞掉前置条件失败
（注释写明「语言包失败不该拖垮页面」）。所以「路由前置条件把失败暴露到页面」这一半没有落地——
`ensureI18nRest()` 已经会 reject，但要不要变成页面错误由那个文件的策略决定，它不在我的文件清单里。

### 7. CRLF 闭栏行不被识别

`streaming-markdown.tsx`：新增 `stripCr()`，`parseFenceOpen` 与 `closesFence` 比对前先摘掉行尾 `\r`。
注意开栏也要摘：JS 的 `.` 不匹配 `\r`，`FENCE_OPEN` 的 `(.*)$` 在 CRLF 下根本不成栏（只改闭栏正则不够）。

测试：`streaming-markdown.render.test.tsx` 新增一条，同时断言「CRLF 闭栏 → null」与「CRLF 未闭栏 → 正常出栏且 lang 不带 \r」，
两个方向都覆盖（只改一半会挂）。

### 8. 卸载时合法草稿被 cancel 掉

- `numeric-setting-draft.ts` 新增 `createNumericDraft`（草稿状态机：`change` / `commitNow` / `syncFromStore` / `teardown`），
  `teardown()` 走 `flush()` 而不是 `cancel()`。抽出来是因为 panels 没有 DOM 测试环境，hook 的 effect cleanup 无法直测。
- `terminal-settings-panel.tsx` 的 `useNumericSetting` 改成这个控制器的薄包装；卸载 cleanup 调 `teardown()`。
  失焦/回车/store 回灌的既有语义逐条保留（非法值回灌已提交值、自己刚提交的那次不回灌）。
- 旧测试标题「cancel（卸载）丢掉待提交值」改成「cancel 丢掉待提交值」（cancel 本身语义不变，只是不再是卸载路径）。

测试：`numeric-setting-draft.test.ts` 新增 `createNumericDraft` 5 条。
验证过：把 `teardown` 换回 `cancel` 时「卸载时合法的待提交值必须落地」这条会失败。

### 9. 惯性在边界不停

`scroll-gesture.ts`：`ScrollOutcome` 新增 `boundaryReached`（**已攒够整行并喂下去、却被拒绝**，任一方向）。
- `feedViewportGesture`（生产路径）改成返回完整 `ScrollOutcome`：`linesToScroll === 0` 是「还没攒够一行」→ `boundaryReached: false`；
  喂下去被 `handleViewportGesture` 拒绝 → `boundaryReached: true`。
- `scrollLinesDirect` / `scrollDomFallback` 同样补上（贴底方向也算）。
- `stepFling` 现在 `boundaryReached || atTopWhilePullingDown` 即取消惯性。
- **`atTopWhilePullingDown` 语义一字未动**：它只喂 `gesture-machine.ts:248` 的 preventDefault 判定，
  改它会把「到顶下拉刷新 / 到底原生回弹」的交还语义一起改掉，超出本条范围。故新增字段而不是改名。

测试：`scroll-gesture.test.ts` 5 条既有断言补上新字段（含「贴底 → boundaryReached: true」「不足一行 → false」），
新增 2 条惯性测试（`handleViewportGesture` 路径、`scrollLinesDirect` 贴底路径），均断言「第一次被边界拒绝的那帧就 pending()===0」。
验证过：把 `stepFling` 的判定改回只看 `atTopWhilePullingDown`，这 2 条都失败。

### 10. ContextMenu Trigger 包住整棵树

根因是 base-ui `ContextMenuTrigger` 挂的 document 级 `contextmenu` 监听会对 Trigger 内**所有**元素调 `preventDefault()`
（`context-menu/trigger/ContextMenuTrigger.js` 的 `handleDocumentContextMenu`）。

改法：
- Trigger 缩成一个 **0 尺寸、`pointer-events-none`、`position: fixed` 的空锚点**，不再包任何内容；
  文件树改由一个普通 `<div>` 承载委托 handlers（`-webkit-touch-callout: none` 从原 Trigger 内联样式挪到这里）。
- 命中文件行时由委托**主动**给锚点 `dispatchEvent(new MouseEvent('contextmenu', {clientX, clientY, button: 2, bubbles, cancelable}))`，
  并在原事件上 `preventDefault()`。base-ui 的 `handleContextMenu` 据此 `setAnchor` 到指针坐标并开菜单——
  定位、开合、document mouseup 那套时序仍是它的原代码，一行没抄。
  （`MenuPositioner` 在 `parent.type === 'context-menu'` 时用的是 `ContextMenuRootContext.anchor`，
  只能由 Trigger 的 `setAnchor` 写入，所以必须走「派发给 Trigger」这条路，不能自己算位置。）
- **未命中就一个字节都不碰**（不 preventDefault、不 stopPropagation），空目录 / 加载行 /「显示其余」/ 空白处
  右键恢复浏览器原生菜单。
- 触摸长按：Trigger 收不到 touch 事件了，在 `file-leaf-delegates.ts` 里复刻成 `createLongPress`
  （`FILE_LEAF_LONG_PRESS_MS = 500`、`FILE_LEAF_LONG_PRESS_MOVE_PX = 10`，与 base-ui 常量一致；
  单指 + 命中才武装），触发后同样派发 `contextmenu`；抬指时若刚触发过则 `preventDefault()` 抑制合成 mouse 序列
  （规范保证），避免模拟 mouseup 把刚弹出的菜单关掉。
- `armFileLeafMenu`（依赖 `preventBaseUIHandler`）已无意义，替换为类型谓词 `shouldArmLongPress`。
- testid / 菜单项 / i18n key / `data-file-*` 属性 / 行结构全部原样：`file-item-*`、`file-dir-*`、
  `file-download-*`、`file-show-more-*`、`context-menu-content` 的 `data-slot` 都没动，
  `apps/fe/tests/files-context-menu.spec.ts` 用到的选择器逐条核对过，均保留。
- `useLeafGestureHandlers` 抽成独立 hook 是为了过复杂度门禁（组件 122 行 > 120）。

测试：`file-leaf-delegates.test.ts` 用 `shouldArmLongPress` + `createLongPress`（手动时钟）8 条替换原 4 条
（500ms 才触发、10px 阈值内/外、取消、`consumeFired` 只消费一次、重新按下顶掉上一次）；
`files-node-roots.test.tsx` 新增结构断言：树级 Trigger 是**空**锚点，且带 `space-y-0.5` 的树容器**不是** Trigger。
改前该断言必挂（改前树容器就是 Trigger）。

## 验收数据

| 项 | 基线 | 现在 |
|---|---|---|
| `packages/panels`: `bun test` | 889 pass / 0 fail | **911 pass / 0 fail** |
| `packages/panels`: `bunx tsc --noEmit -p .` | 2 errors（均在 `packages/ws-client/src/client.ts`，他人在改） | **2 errors（同上，未新增）** |
| `packages/terminal-ui`: `bun test` | 398 pass / 0 fail | **400 pass / 0 fail** |
| `apps/fe`: `bun test src/` | 1769 pass / 0 fail | **1783 pass / 0 fail** |
| `apps/fe`: `bunx tsc --noEmit -p .` | 2 errors（同上） | **2 errors（同上，未新增）** |
| `bunx biome check`（panels/terminal-ui/fe 相关目录） | — | **clean** |
| `bun scripts/complexity/gate.ts` | — | **ok**（1310 files / 12038 functions） |
| `bun packages/panels/src/files/files-tree-render.bench.tsx` | 内置护栏 | 500 行 mean 17.31ms / triggers=2；50 行 mean 2.04ms / triggers=2 |

## 文件清单

新增：
- `packages/panels/src/code-viewer/highlight-queue.ts`、`highlight-queue.test.ts`
- `apps/fe/src/i18n/rest-bundle.ts`、`rest-bundle.test.ts`
- `apps/fe/src/i18n/rest-prerequisite.ts`、`rest-prerequisite.test.ts`

改动：
- `packages/panels/src/code-viewer/`：`highlight-protocol.ts`、`highlight-client.ts`、`highlight.worker.ts`、
  `highlight-client.test.ts`、`highlight.worker.test.ts`
- `packages/panels/src/markdown/`：`streaming-markdown.tsx`、`streaming-markdown.render.test.tsx`
- `packages/panels/src/settings/`：`numeric-setting-draft.ts`、`numeric-setting-draft.test.ts`、`terminal-settings-panel.tsx`
- `packages/panels/src/files/`：`file-leaf-delegates.ts`、`file-leaf-delegates.test.ts`、`file-leaf-menu.tsx`、`files-node-roots.test.tsx`
- `packages/terminal-ui/src/components/touch/`：`scroll-gesture.ts`、`scroll-gesture.test.ts`
- `apps/fe/src/i18n/index.ts`
- `apps/fe/src/components/side-panels/side-panel-host.tsx`、`side-panel-host.test.tsx`

未改：`packages/terminal-ui/src/components/touch/gesture-machine.ts`（`atTopWhilePullingDown` 语义保持不变，无需改）、
`packages/panels/src/files/files-node-roots.tsx`（第 10 条不需要改树结构）。

## 需要人工确认 / 遗留

1. **第 10 条走的是真实 DOM 事件，本地无 DOM 测试环境，只能靠 SSR 结构 + 纯逻辑单测把住。
   合并前建议跑一次 `apps/fe/tests/files-context-menu.spec.ts` 与 `files-sidebar-drag.spec.ts`。**
   关键假设：手工 `dispatchEvent(new MouseEvent('contextmenu', {bubbles:true}))` 会触发 React 的合成
   `onContextMenu`（testing-library 的 `fireEvent` 就是这个机制），已核对 base-ui 源码确认
   `handleContextMenu` 只读 `event.clientX/clientY` 并 `setAnchor`。
2. 第 6 条的「路由前置条件把失败暴露出来」只做了一半，原因见上（`use-page-module.ts` 不在文件所有权内）。
3. 第 6 条的副作用：rest chunk 真的拉不到时，切语言会被重试退避拖慢约 800 ms 才可见。
   这是「宁可慢一点也不要闪裸 key」的取舍，若产品不接受可以把 `changeLanguageAfterRest` 换成带超时的等待。
4. 第 4 条给每个高亮任务加了一个 `setTimeout(0)` 的宏任务让出（这是取消能生效的前提）。
   相对 512 KiB 文件的同步高亮可以忽略，且纯文本已先上屏。
