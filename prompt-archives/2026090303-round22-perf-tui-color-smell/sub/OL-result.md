# OL 结果：文件树右键菜单提到树根（EX1 §U5）

## 结论

500 行文件树的 SSR 从 **62.36 ms → 16～19 ms（p50 61.5 → 13～15 ms，约 3.3～4.2×）**，
`ContextMenu` 的 Trigger 数从 **501 → 2**（树级共享 1 个 + 展开着的那个目录行自己的 1 个），
且**与行数无关**（10 行与 500 行同为 2 个）。行退化成一个不带任何回调、不调 `useTranslation`、
不调 `useSidebar`/`useNavigate`/`useRuntime`/`useFileNodeActions` 的 `<button>`，只剩
`useIsFileSelected` 一个订阅型 hook。

## 改动清单

新增：
- `packages/panels/src/files/file-leaf-target.ts` —— 三个数据属性常量（`data-file-list-root` /
  `data-file-list-dir` / `data-file-leaf-path`）＋ 从事件目标反查 `{root, entry}` 的纯函数。
  只依赖 `closest`/`getAttribute` 的最小接口 `AttrElement`，无 DOM 环境可用替身单测。
- `packages/panels/src/files/file-leaf-delegates.ts` —— 事件委托逻辑：`hitFileLeaf`（命中哪一行）、
  `armFileLeafMenu`（该不该把手势交回 base-ui）、`markOpenRow`（补 `data-popup-open`/`data-pressed`）。
- `packages/panels/src/files/file-leaf-menu.tsx` —— `FileLeafContextMenu`：整棵树唯一的
  `ContextMenu` + `ContextMenuTrigger`，接管 click / contextmenu / touchstart / dragstart / dragend。
- `packages/panels/src/files/file-entry-identity.ts` —— `stabilizeFileEntries` / `sameFileEntry`。
- 测试：`file-entry-identity.test.ts`、`file-leaf-delegates.test.ts`、`files-node-roots.test.tsx`。
- 基准：`files-tree-render.bench.tsx`（与 EX1 §1.12 同法：500 行 SSR，预热 5 次 + 20 次取均值）。

改动：
- `files-node-roots.tsx`：树根包一层 `FileLeafContextMenu`（`className="space-y-0.5"` 把原来由宿主
  容器给根行的间距下移一层，视觉不变）；每个目录的子节点外包一层带 `data-file-list-*` 的容器 div；
  `FileLeaf` 精简为 `{entry, rootId, indent, symlinkTitle}` 四个 prop 的纯按钮（缩进值改由 `DirNode`
  算好传入，实测 SSR `padding-left:34px` 与改前逐字一致，已写成断言）。
- `file-node-actions.tsx`：`useFileNodeActions()` 改成**无参**、树根调用一次，返回
  `{download(rootId, entry), onDragStart(e, rootId, entry), onDragEnd(e, entry)}`；
  `FileNodeMenuContent` 一字未改（菜单项、i18n key、`data-testid="file-download-${root.id}-${path}"` 全保留）。
- `use-directory-listing.ts`：导出 `fileListQueryKey(rootId, path)`（共享菜单按它回查 entry）；
  返回值新增引用稳定化后的 `entries`。

**未改动**：`bulk-transfer.ts`（他人）、`directory-node-view.tsx`、`node-menu.tsx`、`selected-file.tsx`、
`index.ts`，以及 `packages/panels/src/files/` 以外的任何文件。

## 设计要点与一处刻意的偏离

### 长按手势：没有重写，而是把同一个 base-ui Trigger 提到树根

任务书建议「用 pointer 事件在树根重新实现长按，参数与现有实现一致」。实际做法是**保留 base-ui 的
`ContextMenu.Trigger`，只把它从每行一个提成整棵树一个**（Trigger 渲染成包住排序列表的 `<div>`）。
理由：

1. 500ms 延时、10px 位移阈值、`allowMouseUp` 那套时序全是
   `@base-ui/react/context-menu/trigger/ContextMenuTrigger.js`（`LONG_PRESS_DELAY = 500`、
   `moveThreshold = 10`）里的原代码，**一行没动**，不存在「参数抄错/时序抄漏」的风险；
2. 重写方案必须走「隐藏 Trigger + 手工 dispatch `contextmenu`」，而 `handleContextMenu` 会额外挂一条
   document `mouseup` 监听（长按 500ms 后 `allowMouseUpRef` 变 true），移动端抬指产生的模拟 mouseup
   有很大概率**立刻把刚弹出的菜单关掉**——这是现有触摸路径（`handleTouchStart → handleLongPress`，
   不挂 mouseup）没有的新故障面；
3. `packages/panels` 没有任何 DOM 测试环境（全仓 `happy-dom`/`jsdom`/`@testing-library` 零命中，
   测试一律 `renderToStaticMarkup`），即使自己重写也**无法**用 fake timers 真正驱动它，
   只能测一个与真实 DOM 脱节的纯计时器。加依赖需要改 `package.json` + `bun install`，
   在 15 个 agent 共用的 worktree 里不做。

代价（已知、可接受）：Trigger 现在覆盖整棵树，base-ui 的 document 级 `contextmenu` 监听会对
**树内所有元素**调 `preventDefault`。于是在「加载中 / 空目录 / 显示其余 / 目录内提示行」这类填充行上
右键，既不弹应用菜单（我们主动 `preventBaseUIHandler` 挡掉，避免弹出上一次命中的那份菜单），
也不再弹浏览器原生菜单。文件行与目录行的行为完全不变。

对应的「长按测试」落在 `armFileLeafMenu` 上：单指 + 命中文件行才放行给 base-ui，多指 / 未命中一律
`preventBaseUIHandler`。时序本身不再是本仓代码，故没有 fake-timer 计时断言。

### 两层 ContextMenu 嵌套是安全的（已核对 base-ui 源码）

目录行仍各自持有 `ContextMenu`（数量与展开目录数同阶，不是热点），现在嵌在树级 `ContextMenu` 内。
核对结果：
- `MenuRoot` 只在 `parent.type === 'menu'`（真子菜单）时才继承父级 `floatingTreeRoot`
  （`menu/store/MenuStore.js:32-36`），context menu 各自 `new FloatingTreeStore()`，
  `menuopenchange`/`close` 事件总线互不相通；
- 内层 `ContextMenuRoot` 自己提供 `MenuRootContext(undefined)`，`parentMenuRootContext` 为空，
  不会被误判成子菜单；
- 目录行 Trigger 的 `handleContextMenu`/`handleTouchStart` 都会 `stopPropagation()`（React 合成事件），
  事件不会同时落到两层。

### entry 引用稳定化

先实测确认：react-query 默认 `structuralSharing` **已经**能在「返回内容完全相同」时保住
`data`/`entries`/每个 entry 的引用（实测脚本确认三级全 `true`），所以 EX1 §U5 里
「30 秒轮询打穿行 memo」这条**在内容不变时不成立**。

真正的缺口是 `replaceEqualDeep` 按**下标**比对：目录里插入/删除一个文件，插入点之后的每一项都会拿到
新对象。`stabilizeFileEntries` 按路径复用上一份内容相同的 entry，整份逐位不变时连数组引用一起沿用。
`FileLeaf` 另外三个 prop 全是原始值，因此「entry 引用不变」就是行级 memo 的存活条件——
测试直接断言这一点（500 行同内容轮询：数组与每一项全部 `toBe` 旧引用；插入一项：其后 500 项全部沿用）。

### 顺带修掉的放大链

`useSidebar()` 原本在**每一行**调用，侧栏状态一变就重渲染 500 行；现在只在树根调一次。

## 验收数据

| 项 | 改前 | 改后 |
|---|---|---|
| 500 行 SSR mean / p50 | 62.36 / 61.49 ms | 16.2～19.0 / 12.9～14.6 ms |
| 50 行 SSR mean / p50 | 6.75 / 6.53 ms | 2.4～2.8 / 2.2～2.5 ms |
| `context-menu-trigger` 个数（500 行） | 501 | 2 |

命令：`bun packages/panels/src/files/files-tree-render.bench.tsx`
（内置回归护栏：Trigger 数必须为 2；500 行 mean > 40ms 或 50 行 mean > 5ms 直接抛错）。

- `cd packages/panels && bun test src/files`：基线 **85 pass / 0 fail**（8 文件）→ 现 **105 pass / 0 fail**（11 文件）。
- `cd packages/panels && bun test`（全包）：**889 pass / 0 fail**。
- `cd packages/panels && bunx tsc --noEmit -p .`：基线 4 个错误（全在他人负责的 test 文件里，
  测量期间他们已修完）→ 现 **0 个错误**；`src/files` 全程 0。
- `bunx biome check packages/panels/src/files/`：clean（35 文件）。
- `bun scripts/complexity/gate.ts`：**ok**（1292 files / 11915 functions）。本任务未新增任何超标函数或文件。

## 已知未做 / 需要人工确认

1. **未跑 e2e**（任务要求）。`apps/fe/tests/files-context-menu.spec.ts` 依赖的
   `file-item-*` / `file-dir-*` / `file-download-*` / `file-show-more-*` / `file-root-drag-*`
   全部原样保留，菜单项文案与 i18n key 未动，SSR 测试已锁住行按钮结构；但
   「右键真的弹出菜单」「移动端长按」「拖到 OS 下载」三条走的是真实 DOM 事件委托，
   建议合并前跑一次 `files-context-menu.spec.ts` + `files-sidebar-drag.spec.ts`。
2. 上面提到的填充行右键行为变化（既无应用菜单也无原生菜单），如果产品上不接受，
   唯一干净的解法是把目录行的菜单也一并提到树根、做成一个共享菜单——那需要改
   `directory-node-view.tsx`，不在本任务的文件所有权范围内，故未做。
3. 基线测量期间 `@tmex/api-client`、`@tmex/ws-client`、`packages/ui/src/components/tooltip.tsx`
   曾短暂处于其他 agent 的半成品状态（`fetchCapabilities`/`FeatureSet`/`getBulkClient` 找不到），
   上表数字均为它们落定后重测的。
