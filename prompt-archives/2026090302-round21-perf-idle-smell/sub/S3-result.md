# S3 — 前端包体积（懒加载三件套）执行结果

工作区：`/Users/konata/code/tmex-r21`（分支 `feat/round21-perf-idle-smell`）
日期：2026-09-03

## 0. 结论（首屏 gzip）

首屏就是 `dist/index.html` 里那唯一一个阻塞渲染的 `<script>`（无 modulepreload）。

| 阶段 | entry raw | entry **gzip** | 相对基线 |
| --- | ---: | ---: | ---: |
| 基线（改动前，同一工作区当日构建） | 1,226,837 | **376,321** | — |
| item 1 后（watch 对话框懒加载） | 1,164,124 | **359,205** | −17,116 |
| item 2 后（@dnd-kit 懒加载） | 1,112,947 | **342,289** | −34,032 |
| item 3 后（hljs 去重，终态） | 1,113,965 | **342,493** | **−33,828** |

取数：`bun run build:fe` → `gzip -9c apps/fe/dist/assets/index-*.js | wc -c`。
首屏 CSS 未动（23,045 → 23,063 gzip，属其它 agent 改动带来的漂移）。

**首屏合计从 ≈390 KB gz 降到 ≈356 KB gz（−8.7%）。**

> 漂移说明：其它 agent 在并行改同一个 worktree，构建间隔里 entry 会有百字节级抖动
> （342,289 → 342,493 就是这么来的）。三项的**增量**都是在各自前后两次构建之间取的，
> 且每项都有结构性佐证（对应符号是否还在 entry 里），不受漂移影响。

## 1. watch 规则表单树移出首屏

**做法**：新增 `packages/panels/src/watch/deferred-watch-dialog.tsx`，用 `lazy()` +
`Suspense fallback={null}` 包 `WatchDialog`，并且**打开过才挂载**（`useState(open)` + effect），
关掉后保持挂载，开合语义与原先直接渲染一致。两条 eager 边都改掉：

- `packages/panels/src/device-tree/device-tree-dialogs.tsx:3`（侧栏常驻 → 首屏）
- `packages/panels/src/device-console/page-actions.tsx:6`

顺带在 `page-actions` 里加了 `useWatchDialogPreload()`（空闲预热），与同文件已有的
`useTerminalSettingsPreload()` 同一套理由：发版后旧 index.html 指向的 chunk 会 404，
趁 index 还新鲜先把它拉下来。

**效果**：entry gzip 376,321 → 359,205（**−17,116**）；新增按需 chunk
`watch-dialog-*.js` 25,936 raw / **6,852 gz**。entry 里 `watch-rule-delete-confirm` 等
标记归零。

## 2. `@dnd-kit/*` 移出首屏

**做法**：`device-tree-dnd.tsx` 拆成
- `device-tree-dnd-impl.tsx`（新）：原文件全部内容，一字未改；
- `device-tree-dnd.tsx`（改写成门面）：`SortableVerticalList` / `useSortableRow` 两个
  首屏可达的导出留在这里，实现走 `import('./device-tree-dnd-impl')`。

未加载时 `SortableVerticalList` 原样渲染 children（列表可滚、可点、可键盘导航），
`useSortableRow` 返回同形状的空样板（**保留 `role="button"` / `tabIndex=0` /
`aria-roledescription`**，焦点顺序和语义不变；不填 `aria-describedby`，那会是悬空引用）。
加载完成后换成真正的 `DndContext` + `SortableContext`。

三个连带改动：
- `device-tree/index.ts`：不再导出 `reorderIdsByDragEnd` / `useDeviceTreeSensors`（barrel
  之外全仓 0 消费者）。
- `device-folders/device-folder-tree.tsx:42`：`useDeviceTreeSensors` 的 import 改指
  `device-tree-dnd-impl`（**这个文件不在我的 owned 清单里，只改了这一行 import**）。
  device-folders 本身就在懒加载页里，继续同步引 dnd-kit 没问题。
- `device-tree-dnd.test.ts`：纯函数测试改从 impl 引。

**关键坑（值得记）**：一开始想在门面里 `export { useDeviceTreeSensors } from './...-impl'`
以免动 device-folders，结果**拆分完全失效**（entry 仍 359,182，dnd 还在里面）。原因是
rollup 对「既被入口静态可达、又被动态 import」的模块一律并进入口 chunk，动态 import 退化成
引用同一块；而 `@dnd-kit/*` 三个包都没有 `sideEffects: false`，那条静态边摇不掉。
**门面里一个实现侧的值都不能 re-export，只能透传类型。**

**效果**：entry gzip 359,205 → 342,289（**−16,916**）。dnd-kit 落到共享 chunk
`sortable.esm-*.js` 50,561 raw / **16,728 gz**（由 DevicesPage / device-folders /
terminal-settings 与门面的动态 import 共用）+ `device-tree-dnd-impl-*.js` 1,273 / 746 gz。
entry 里 `activationConstraint` 归零。

### 2.1 加载时机：**没有**按 pointerdown 触发，理由与代价

实现切换**必然伴随子树重挂**：`useSortable` 内部的 hook 数量与空样板不同，同一个组件实例上
换实现会触发「渲染的 hook 比上次多」；而 children 从 `<>{children}</>` 变成
`<DndContext><SortableContext>{children}</SortableContext></DndContext>`，在树里的位置变了，
React 本来也会重挂。这一点无论怎么设计都躲不掉（除非把每行的 `useSortable` 挪进容器渲染的
隐藏 binding 组件里、行改用 `useSyncExternalStore` 订阅——那要改 6 个不归我管的调用点）。

于是**不能**在 pointerdown / pointerenter 上触发加载：重挂会落在手势中途，mousedown 在旧
DOM 节点、mouseup 在新节点，浏览器不会派发 `click`——用户在侧栏的**第一次点击会被静默吞掉**，
这比省一次预取严重得多。触摸端 `pointerover` 与 `pointerdown` 同一 tick，同样中招。

**实际做法**：首帧提交后的 `useEffect` 里立刻发起 import。首屏那个阻塞的 `<script>` 已经不含
它（这才是要优化的量），chunk 在用户来得及交互之前就到位。

**代价（诚实记录）**：极慢链路上，chunk 到达前的第一个拖拽手势不会有任何反应——不是报错，
是没反应，松手重拖即可。重挂的安全性有两条依据：行本身没有局部状态（展开态在 store 里）；
聚合视图里的 `NodeRuntimeScope` 经 `useNodeRuntime` 引用计数 + **宽限期**释放连接
（round12 的「保活延时退订」），秒级内的重挂不会真的断连。

## 3. `highlight.js` 跨构建格式去重

**根因**：`code-viewer.tsx` 引 `highlight.js/lib/common` —— 该入口的 ESM 壳只是
`import HighlightJS from '../lib/common.js'`，拿到的仍是 **CJS 构建**（`lib/languages/*.js`）；
而 markdown 预览走 `rehype-highlight → lowlight`，引的是 `highlight.js/lib/languages/*`，
按 exports map 的 `import` 条件解析到**真 ESM 构建**（`es/languages/*.js`）。两套文件，
rollup 去重不了。

**做法**：`code-viewer.tsx` 改成 `highlight.js/lib/core` + 逐语言 import，按
`lib/common.js` 的**同一套 36 种语言、同一注册顺序**自己注册（顺序会影响
`highlightAuto` 的相关度排序，故逐行对齐）。语言集合与顺序完全一致 ⇒ **高亮输出不变**。
新增测试直接读 `node_modules/highlight.js/lib/common.js` 抽 `registerLanguage` 清单对账，
升级 highlight.js 时这条会先红（注意测试里**不能** import 那个入口，否则等于把语言注册进来）。

`lowlight` 用的是 `HighlightJs.newInstance()`，与 code-viewer 的单例互不干扰，已确认。

**效果**（gzip，去掉 entry 后的「额外下载量」，按 chunk 静态 import 闭包算）：

| 路径 | before | after | delta |
| --- | ---: | ---: | ---: |
| 只开文件页（FilePage 闭包） | 72,157 | 68,693 | **−3,464** |
| 只开 markdown 预览 | 184,358 | 187,265 | **+2,907** |
| 两条都用（并集） | 247,953 | 206,373 | **−41,580** |

hljs 现在落在共享 chunk `hljs-terminal-theme-*.js` 159,457 raw / 49,347 gz。
markdown-only 那 **+2.9 KB gz 是真实回退**：把 hljs 从 markdown-preview 里抽出来单独成块，
丢掉了跨模块的 gzip 压缩上下文。判断是净赚（两条都用时省 41.6 KB，只开文件页也省 3.5 KB，
只用 markdown 的多花 2.9 KB），但这是个可讨论的取舍——不同意的话，回退只需把
`code-viewer.tsx` 的 import 段改回 `import hljs from 'highlight.js/lib/common'`
并删掉 `COMMON_LANGUAGES` 注册块与对应测试，其余两项不受影响。

## 4. 验收

| 项 | 结果 |
| --- | --- |
| `packages/panels` `bun test` | **765 pass / 0 fail**（基线 757，新增 8 条） |
| `apps/fe` `bun test src/` | **1743 pass / 0 fail**（基线 1742/1743，非本任务新增） |
| `bunx tsc --noEmit -p .`（panels / fe） | 0 error |
| `bunx biome check`（全部改动文件） | 通过 |
| `bun scripts/complexity/gate.ts` | 18 violation，**全部来自其它 agent 的文件**（gateway / ws-client / ghostty-terminal / apps/fe side-panels / stores），本任务改动的文件 0 条 |

新增测试：
- `packages/panels/src/device-tree/device-tree-dnd.lazy.test.tsx`：未加载分支照常渲染
  children 且保留 role/tabIndex、不带悬空 `aria-describedby`；`await loadDeviceTreeDnd()`
  后换成真 dnd-kit 绑定（`aria-describedby="DndDescribedBy-`）；重复加载复用同一实现。
  **模块级缓存跨测试文件共享，该文件 `beforeEach`/`afterAll` 都调
  `resetDeviceTreeDndForTests()`**，否则别的文件会随机看到「已加载」分支。
- `packages/panels/src/watch/deferred-watch-dialog.test.tsx`：没打开过渲染空串；打开但
  chunk 未到不抛错；chunk 到位后渲染真对话框且 props 原样透传。（真 `WatchDialog` 走
  Base UI portal，`react-dom/server` 渲染不了，用 `mock.module` 换哑组件。）
- `packages/panels/src/code-viewer/code-viewer.test.tsx`：语言清单与上游 `lib/common.js` 对账。

## 5. 改动文件

新增：
- `packages/panels/src/watch/deferred-watch-dialog.tsx`
- `packages/panels/src/watch/deferred-watch-dialog.test.tsx`
- `packages/panels/src/device-tree/device-tree-dnd-impl.tsx`
- `packages/panels/src/device-tree/device-tree-dnd.lazy.test.tsx`

修改：
- `packages/panels/src/device-tree/device-tree-dnd.tsx`（改写成门面）
- `packages/panels/src/device-tree/index.ts`
- `packages/panels/src/device-tree/device-tree-dialogs.tsx`
- `packages/panels/src/device-tree/device-tree-dnd.test.ts`（import 改指 impl）
- `packages/panels/src/device-console/page-actions.tsx`
- `packages/panels/src/code-viewer/code-viewer.tsx`
- `packages/panels/src/code-viewer/code-viewer.test.tsx`
- `packages/panels/src/device-folders/device-folder-tree.tsx`（**仅 1 行 import**，不在
  owned 清单里但为 item 2 所必需，见 §2）

## 6. 指挥官必须重跑的 e2e

按影响面排序（我按要求**没有**跑 Playwright）：

**必跑（item 2，拖拽 + 侧栏首帧后一次重挂）**
- `apps/fe/tests/files-sidebar-drag.spec.ts` —— 唯一一条真拖拽用例（鼠标 8px 阈值、竖轴
  modifier、横向不滚、纵向重排落库）。它 `goto('/')` → 点 files 标签 → 等行可见才起拖，
  期间早就过了 chunk 到达点，理论上不受影响；但这是本改动风险最集中的一条。
- `apps/fe/tests/sidebar-device-disclosure.spec.ts`
- `apps/fe/tests/sidebar-click-no-pty-injection.spec.ts`
- `apps/fe/tests/sidebar-close-confirm.spec.ts`
- `apps/fe/tests/sidebar-rename.spec.ts`
- `apps/fe/tests/sidebar-pane-menu-alignment.spec.ts`
- `apps/fe/tests/mobile-sidebar-safe-area.spec.ts`
- `apps/fe/tests/sidebar-resize.spec.ts`

**必跑（item 1）**
- `apps/fe/tests/watch.spec.ts`（`watch-open-button` → `watch-dialog` 现在多一次 chunk 往返，
  Playwright 的 `toBeVisible` 会等，但要确认没有超时）
- `apps/fe/tests/mobile-agent-watch.spec.ts`

**必跑（item 3）**
- `apps/fe/tests/files-context-menu.spec.ts`（文件查看器 / code-viewer）
- `apps/fe/tests/settings-files.spec.ts`
- 任何会渲染 markdown 的用例（版本页发行说明、agent 会话）：`apps/fe/tests/settings.spec.ts`、
  `apps/fe/tests/agent-session.spec.ts`

**建议跑（设备网格拖拽，本次未改但共用 dnd-kit chunk）**
- `apps/fe/tests/devices.spec.ts`

## 7. 未做 / 留给后续

- `@base-ui/react` 的 trigger-gated 组件（select 66 K + menu 52 K + dialog 18 K +
  tooltip 18 K rendered，EX4 §7.4(3)）没动 —— 它们经 `packages/ui/src/components/*` 被急加载，
  而 `packages/ui/` 在本任务的 OFF LIMITS 里。这是首屏剩下的最大一块可挪重量。
- 首屏仍是**单个 1.11 MB 的 `<script>`、0 个 modulepreload**；`vite.config.ts` 没有
  `manualChunks`。把 react-dom / react-router 之类切成可并行下载的 vendor chunk 是另一条路，
  不属于本任务范围。
