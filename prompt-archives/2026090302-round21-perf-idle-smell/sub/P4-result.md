# P4：FE 渲染热点（EX1 附录 B 的 P3 / P2 / P4-P5）落地结果

分支 `feat/round21-perf-idle-slim`，worktree `/Users/konata/code/tmex-r21`。三项均为行为保持的性能修复，未改任何可见行为、未改路由语义、未引入虚拟化库。

## 验收状态

| 项 | 结果 |
|---|---|
| `packages/stores` `bun test` | **431 pass / 0 fail**（基线 420，新增 10；另有 1 条其他 agent 新增） |
| `packages/panels` `bun test` | **757 pass / 0 fail**（基线 747，新增 10） |
| `packages/ui` `bun test` | **62 pass / 0 fail**（基线 54，新增 8） |
| `apps/fe` `bun test src/` | **1742 pass / 0 fail**（与本轮基线同） |
| `bunx tsc --noEmit -p .` ×4 包 | 我的文件 **0 error**。残留两条均非本任务文件：`packages/stores/src/host-services.test.ts:93`（stores 既有基线 1）、`packages/stores/src/tmux-event-router.ts:98`（另一 agent 正在改，写报告时仍在飞） |
| `bunx biome check`（全部改动文件） | 通过 |
| `bun scripts/complexity/gate.ts` | 我碰过的文件 **0 violation**（见下「复杂度门禁」） |

## 改动文件

新增：`packages/stores/src/ui-persist.ts`、`packages/ui/src/components/sidebar/resize-controller.ts`、`packages/panels/src/files/selected-file.tsx`，及三份对应测试 + `packages/panels/src/device-tree/sidebar-device-selection.test.ts`。
修改：`packages/stores/src/ui.ts`、`packages/panels/src/device-console/use-editor-input.ts`、`packages/ui/src/components/sidebar/{context.ts,sidebar-provider.tsx,sidebar-layout.tsx,sidebar-menu.tsx}`、`packages/panels/src/files/files-node-roots.tsx`、`packages/panels/src/device-tree/sidebar-device-list.tsx`、`apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`。

---

## 项 1（P3）：每次按键一次全量 JSON 序列化 + 同步 localStorage 写

### 之前

`use-editor-input.ts` 的 `handleEditorChange` → `setEditorDraft` → zustand `set` → persist 中间件在**每次 set 之后**跑 `partialize`（17 个 key，含 `editorHistory` 50 条与全部草稿）→ `JSON.stringify` → 同步 `localStorage.setItem`。UI store 没有 `storage:` 覆盖，所以这条链路每敲一个字符走一遍，全部在输入关键路径的主线程上。次生：草稿写回 store 后顺着 `paneEditorDraft` 订阅绕回 `setEditorText(同值)`，每次按键多跑一轮 `DeviceConsole` 渲染。

### 之后

沿用 `agent.ts` 的 `dedupedStorage()` 思路，但**做在 `PersistStorage` 层而不是 `createJSONStorage` 层**——这一点很关键：自定义 `PersistStorage` 拿到的是 `partialize` 之后的**对象**，可以在 `JSON.stringify` 之前就决定要不要落盘，于是省掉的不只是 `setItem`，还有序列化本身。

`packages/stores/src/ui-persist.ts` 的 `createDeferredPersistStorage`：逐字段与上次落盘的快照做 `Object.is` 比较（17 次引用比较，store 的每个 action 都是整体替换，引用比较是可靠的），据此分三档：

- 逐字段同引用 → **完全跳过**（顺带给全部 30 余处 `set` 去了重，不只是草稿）；
- 只有 `editorDrafts` 变 → 记为待写，最多 300 ms 后合并成一次写；
- 其它任何字段变 → 立即写，并把待写的草稿一起带出去。

定时器**只在首次挂起时武装、后续不重置**（trailing throttle 而非 debounce）：连续输入也保证每 300 ms 至少落一次盘，不会出现「连打 10 秒一个字节没写」。离场兜底：`document` 的 `visibilitychange → hidden` 与 `window` 的 `pagehide` 各挂一次 `flush()`（`pagehide` 是移动端 Safari 唯一可靠的卸载信号，BFCache 下 `beforeunload` 不触发）。

草稿之外的 16 个 key 行为完全不变（一变即同步落盘），所以跨标签页外观同步（`syncThemeFromStorage` 直接读 raw localStorage）、发送后清草稿（`addEditorHistory` 同时变化 → 立即写）都与今天一致。

次生问题一并修掉：`use-editor-input.ts` 用 `editorTextRef` 记住本地已渲染的文本，回灌 effect 同值直接早退，去掉每次按键的第二轮渲染。

**净效果**：连续输入时每键的持久化成本从「一次 17 键序列化 + 一次同步 setItem」降到 0（每 300 ms 一次），渲染轮次从 2 降到 1。

### 测试

`packages/stores/src/ui-persist.test.ts`（10 条）：连打 N 个字符窗口内 0 次写、定时器到点正好 1 次；同引用跳过；非延后字段立即写并带上待写草稿；`flush()` 幂等；经 `createUIStore` 的端到端「模拟刷新后草稿仍在」；`visibilitychange → hidden` 与 `pagehide` 各自 flush（只在 `hidden` 时 flush，`visible` 事件不写）。

---

## 项 2（P2）：侧栏拖拽每个 pointermove 一次同步 localStorage + 全侧栏重渲染

### 之前

`onPointerMove` → `setWidth()`，其中 `viewportWidth()` 读 `window.innerWidth`、`writeSidebarStorage()` 同步 `setItem`、`_setWidth()` 发布新 context value。触控板 ~120 Hz ⇒ 每秒 120 次同步写盘 + 120 次布局读 + 120 次「所有 `useSidebar()` 消费者重渲染」（`SidebarMenuButton` 每一行、每个 `FileLeaf`、每个 window/pane 行、agent 会话行）。叠加 `sidebar-menu.tsx` 的 `transition-[width,height,padding]` 没有 `isResizing` 门控，每次采样给每一行重启一个 200 ms 宽度过渡。

### 之后

四处一起改：

1. **拆 context**（`context.ts` + `sidebar-provider.tsx`）：`width / setWidth / commitWidth / resetWidth` 挪进独立的 `SidebarWidthContext`，主 `SidebarContext` 只留 `isResizing`（一次拖拽变两次）。全仓读 `width` 的只有 `SidebarResizer` 一处（已核实），所以这是零波及的拆分。
   - 探索报告说「唯一没 memo 化的 provider value 就是 SidebarProvider」——**这一条实测不成立**，它本来就 `useMemo` 了；真正的问题是 memo 的**依赖里有 width**，每帧都产出新对象。拆 context 才是解，单纯 memo 化解决不了。
   - 顺带的收益：宽度 state 现在只驱动 provider 自己的那个 wrapper `<div>` 的 CSS 变量，而 `children` 是 props 里传进来的同一份 element 引用，React 直接 bail——每帧的重渲染面从「整棵侧栏」收缩到「一个 div 的 style」。
2. **rAF 合并 + 只在 pointerup 落盘**：拖拽时序抽成不依赖 React/DOM 的 `resize-controller.ts`。`move()` 只记最后一次采样并武装一帧，一帧最多提交一次 `setWidth`；`end()` / `dispose()`（拖拽途中侧栏被 Ctrl+B 折叠会直接卸载 resizer）补提交最后一次采样再 `commitWidth()` 落盘一次。
   - 行为变化：中途被强杀（既无 pointerup 也无卸载）的拖拽不再保存宽度。e2e `apps/fe/tests/sidebar-resize.spec.ts` 走的是 `mouse.up()` + reload，不受影响。
3. **缓存视口宽度**：`viewportWidthRef` 只在 `resize` 监听里刷新，拖拽期间不再读 `window.innerWidth`（刚写过 style 时读它就是一次强制同步布局）。
4. **行过渡门控走 CSS 而不是 React**：wrapper 上加 `data-resizing`，菜单按钮基类加 `group-data-[resizing]/sidebar-wrapper:transition-none`。用 CSS 而不是 `isResizing &&` 是刻意的——后者要让每一行都重渲染两次才能加上这个类，而这些行正是我们想让它们别渲染的对象。已用 Tailwind v4 的 `compile()` 实测该 candidate 确实生成规则，特异性 (0,2,0) 高于基类的 (0,1,0)，覆盖生效。

**净效果**：一次拖拽的 localStorage 写从 ~120 次/秒降到 1 次/拖拽；宽度状态更新从事件率降到帧率；每次采样的 React 重渲染从「全部 `useSidebar()` 消费者」降到「provider 的一个 div + resizer 自身」；行过渡不再被反复重启。

### 测试

`packages/ui/src/components/sidebar/resize-controller.test.ts`（8 条）：一帧内多次 move 只提交最后一次；20 次 move + 5 次帧刷 → `commitWidth` 0 次，`end()` 后正好 1 次；收尾补上未上屏的采样；右侧栏方向；异 pointerId 忽略；卸载收尾；无 rAF 环境退回同步。

---

## 项 3（P4/P5）：每个树节点一次 `useLocation()`，memo 形同虚设

### 文件树（`files-node-roots.tsx` + 新增 `selected-file.tsx`）

**之前**：`useSelectedFilePath()` 里的 `useLocation()` 在**每个** `DirNode` 与**每个** `FileLeaf` 里各调一次。React Router 每次导航发布新 location 对象 ⇒ 切一次 tmux pane 就重渲染整棵已挂载的文件树（单目录 500 行，每行还带完整 `ContextMenu` 子树），`memo` 完全打穿。

**之后**：`SelectedFileProvider` 在树根读一次路由，选中态经一个**恒等的**外部 store 发布（context value 是 store 本身，不随选中态变化）；行组件用 `useSyncExternalStore` 只订阅自己那一位派生值——`FileLeaf` 订 `isFileSelected(rootId, path)` 这一个布尔，`DirNode` 订 `selectedPathInRoot(rootId)`（撑开 `DISPLAY_CAP` 用）。`useSyncExternalStore` 按 `Object.is` 比较快照，同值即不重渲染，于是：

- 与 `/file/:ref` 无关的导航（切 pane、切设备）→ 所有行的快照恒为 `false`/`null` → **一行都不重渲染**；
- 换选中文件 → 只有旧选中行与新选中行两行翻转。

provider 组件放在 `FilesNodeRoots` 内部包住原有 JSX，调用方无需改动；`children` 作为 props 传入，provider 因路由重渲染时子树整体 bail。

### 设备树（`sidebar-device-list.tsx`）

**之前**：`selectedWindowId` / `selectedPaneId` 无条件传给**每个** `DeviceRow`，切 pane 时这两个 prop 一变，所有设备行的 `memo` 全部 bail 不掉。

**之后**：新增导出的纯函数 `deviceRowSelection(selection, deviceId)`，未选中的设备只拿 `{ isSelected: false }`。行为完全等价——`WindowRow` 的 `isPaneSelected` 本来就以 `isDeviceSelected` 为前提（也正因如此，tmux 的 `@1`/`%1` 跨设备撞号今天也没出问题）。切 pane 时非选中设备行的 props 逐字段同值，`memo` 真的能 bail。

### 节点分节（`apps/fe/.../sidebar-node-section.tsx`）

先说复核结论，与探索报告的描述有出入：那「四处 `useLocation()`」分属**四种互斥形态**（离线 / 未登录 / 已折叠 / 在线展开），同一时刻一个 node 只渲染其中一种，所以不是「一个分节四次」而是「一个分节一次」，本身不构成 P4 那种逐行放大。

真正有代价的是 `SidebarNodeOnline`：它因自身的 `useLocation()` 每次导航重渲染，而它下面挂着 `SidebarNodeRuntimeSection` → `NodeRuntimeScope` → 整棵远端设备树。改法是给 `SidebarNodeRuntimeSection` 加 `memo`，并把 `disclosure` 用 `useMemo` / `useCallback` 稳住。这里 memo 能生效有个前提，我核实过：`SortableNodeSection`（`drag` prop 的产地）不读路由，所以导航驱动的重渲染中 `drag` 是同一个引用；如果哪天它开始读路由，这个 memo 会失效，届时要先修 `useSortableRow` 的身份抖动（EX1 的 P10）。

### 测试

`packages/panels/src/files/selected-file.test.ts`（8 条）+ `packages/panels/src/device-tree/sidebar-device-selection.test.ts`（5 条）。

**这里要如实说明验收口径的偏差**：验收条目要求「用 render counter 断言路由变化只重渲染受影响的节点」。仓库的单元测试跑在 **无 DOM 的 bun 环境**（`packages/panels` 的组件测试一律用 `react-dom/server` 的 `renderToStaticMarkup`，见 `device-row.test.tsx` 开头的注释），没有装 `@testing-library/react` 也没有 `react-test-renderer`，**装不了 render counter**（要么引入新的测试依赖，要么造一个 DOM 垫片，两者都超出本任务范围且会影响其他并行 agent）。我改成断言等价的判据：

- 文件树：断言 200 行的快照数组在无关路由变化前后 `toEqual`，换选中文件时**恰好两行**翻转——这正是 `useSyncExternalStore` 决定要不要重渲染时用的那个值；
- 设备树：断言未选中设备的 props 在切 pane 前后**逐字段 `Object.is` 相等**——这正是 `React.memo` 的浅比较判据（并额外断言选中的那台确实变了，避免测出一个「什么都没渲染」的假绿）。

---

## 复杂度门禁

`scripts/complexity/gate.ts` 的 allowlist 是锁值且不允许我改，本轮三处改动把三个函数顶出了锁值，已就地重构回来（不是放宽阈值）：

- `createUIStore` 135 > 125 → 把 `partialize` 提成模块级 `partializeUIState`、persist 工厂提成 `createUIPersistStorage`；
- `useEditorInput` 143 > 135 → 把发送反馈的定时器抽成同文件的 `useSendFeedback()` hook（顺带内聚性更好）；
- `SidebarProvider` 145 > 143 → 把宽度那一份状态抽成 `useSidebarWidthState()`。

跑完门禁我碰过的文件 0 violation。其余 20 条 violation 全在别的 agent 正在改的文件里（gateway/mesh、ghostty-terminal 等），不归我。

---

## 判断为「不做」的部分

1. **虚拟化（问到了要不要）**：本轮不该做，但**值得单独立项**，优先级排在文件树。理由：`DISPLAY_CAP = 500` 加「显示全部」的逃生口意味着上限实际是后端的 2000；每个 `FileLeaf` 除了自身还挂一整个 `ContextMenu`（含 portal），500 行的挂载成本远不止 500 个 DOM 节点。但它与根节点拖排（`SortableVerticalList` 需要完整 id 列表）、`ContextMenu` 的 portal、以及「路由直达的行必须挂载」（现在靠撑开 cap 实现）三处耦合，是一个 L 级改动，塞进本轮只会做成半成品。**廉价的中间步骤**是给行加 `content-visibility: auto` + `contain-intrinsic-size`（EX1 的 P12 已提，全仓零 containment），无行为变化，建议与 P12 一起做。做完选中态修复之后，「切 pane 卡一下」这个最直观的症状已经消失，虚拟化剩下的收益主要在首次展开大目录，紧迫性下降了一档。

2. **窗口/pane 行的第二层收窄**：`selectedPaneId` 现在仍会下发给**选中设备的全部窗口行**（切 pane 时该设备的 N 个 `WindowRow` 会重渲染，N 通常 <10）。再收一层需要在 `device-window-list.tsx` 里按窗口过滤（3 行，行为等价），但那个文件不在我的 owned 列表里，**没动**。建议后续顺手做掉。

3. **`sidebar-node-section.tsx` 里那四处 `useLocation()` 本身**：如上，属于分节级而非行级，改成「上层读一次往下传布尔」需要把三个互斥形态都拆成 memo 组件并稳住 `drag`，收益与风险不成比例，只做了收益最大的那一处 memo。

4. **`SidebarMenuButton` 里 `useSidebar()` 的调用本身**：拆掉 width 之后主 context 一次拖拽只变两次，已经不是热点，没必要再拆成三个 context。

## 需要注意的风险

- **草稿丢失窗口**：进程被强杀（非 `pagehide`/`visibilitychange` 路径，例如浏览器崩溃、iOS 直接抹掉后台页）最多丢 300 ms 内的输入。这是这条修复固有的取舍，已通过「定时器不重置」把窗口钉死在 300 ms（而不是 debounce 那种可以无限延长的窗口）。
- **拖拽中途强杀不再保存宽度**：见项 2 的行为变化说明；正常的 pointerup / 卸载 / 双击重置三条路径都会落盘。
- **`group-data-[resizing]/sidebar-wrapper:transition-none` 依赖 Tailwind 的 `@source "../../../packages/ui/src"` 扫描**（`apps/fe/src/index.css:3`）。已实测该 candidate 能生成规则；若哪天 `@source` 被改窄，这条门控会静默失效（表现为拖拽时行过渡回来了，不会报错）。
- 本轮**没有跑 e2e**（按任务要求，其他 agent 正在改同一 worktree）。与本改动相关的用例是 `apps/fe/tests/sidebar-resize.spec.ts`（拖拽 + 刷新保持宽度）与文件树/设备树的选中态用例，建议合并后统一跑一遍。
