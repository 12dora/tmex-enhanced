# OE 结果：前端流畅度 U1 + U6 + U9

worktree `/Users/konata/code/tmex-r22`，分支 `feat/round22-perf-tui-color-smell`。三项全部落地，未做 e2e，未动 OB 的 `apps/fe/src/pages/settings/nodes/**` 与 `remote-access/**`，未动 `packages/stores/src/tmux.ts`。无 git 操作。

---

## U6 — mesh 侧栏三处不稳定引用打穿 memo

EX1 把这条写成「3 行 `useCallback`/`useMemo`」，实测**只加 useMemo 不够**，两条额外事实必须一起处理，否则 memo 照样 100% 失效：

1. `patchNodesWithEvent`（`apps/fe/src/node/mesh-nodes.ts:54`）命中某个 node 时**无条件换对象**，数组也跟着换引用 → `toSidebarEntries` 的 `useMemo` 重算 → `map` 给**每一个** node 都造新 entry。于是 `memo(SidebarNodeRuntimeSection)` 先在 `node` 这个 prop 上就 bail 不掉，`drag` 改不改都一样。
2. dnd-kit 的 `useSortableRow`（`packages/panels/src/device-tree/device-tree-dnd-impl.tsx:115`）每渲染返回新的 `style` 与 `dragHandleProps` 字面量。`useMemo(() => ({ sortable, dragHandleLabel }), [sortable, ...])` 的依赖本身每帧都变，等于白写。

### 改动

- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`
  - `expansionKeyFor` 内联箭头 → `useCallback`（依赖 `runtimeNodeId`）。key 格式 `${runtimeNodeId}:${deviceId}` 未变。
  - 新增 `sameNodeEntry` / `sameRuntimeSectionProps`，作为 `memo(SidebarNodeRuntimeSection, …)` 的比较器：`node` 逐字段比（7 个字段，`inventory` 按引用——事件没带新 inventory 时它保持原引用），`drag` / `disclosure` 按引用比（引用稳定性在下面一条解决）。
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`
  - 新增 `sameSortableRow` + `useStableSortableRow`：把 dnd-kit 每帧新建的 `style` / `dragHandleProps` 按内容比一次，没变就沿用上一帧引用；再 `useMemo` 出 `drag`。至此 `drag` 真的引用稳定。
- `apps/fe/src/pages/devices/node-device-group.tsx`
  - `nodeContext={nodeDeviceContext(node)}` → `useMemo`，依赖是解构出来的 `runtimeNodeId` / `name` / `isSelf`（`nodeDeviceContext` 的参数类型放宽成 `Pick<…>` 以便传字面量，同时保住 exhaustive-deps）。
  - 链路已复核：`device-management-panel.tsx:112` → `device-grid.tsx:114` 的 `cardProps` useMemo 就是以 `nodeContext` 为依赖，稳定后整页 `memo(SortableDeviceCard)` 才拦得住。

### 预期效果

- `DeviceRow` 的 memo 恢复生效；panels `sidebar-device-list.tsx:196` 那条 effect 不再每渲染对每台可见设备空跑 `ensureDeviceSubscribed`（`handleDeviceExpandedChange` 与两条 effect 的依赖里都含 `expansionKey`）。
- 链路抖动时（RTT 事件 10 s / ping 15 s 一次）不再每次全树 + 全页卡片重渲染。

### 关于「render-count 测试」

**做不到真正的渲染计数**：本仓 `bun test` 无 DOM（无 happy-dom / jsdom / react-test-renderer，`bunfig.toml` 只 preload env），既有测试一律用 `react-dom/server` 静态渲染（见 `sidebar-device-list.test.tsx:1-2`、`device-row.test.tsx:1-2` 的注释）。SSR 每次都是全新树，`React.memo` 不参与，计数没有意义；为此引入 DOM 依赖会改到共享 worktree 的依赖树，风险不划算。

改为**直接锁死决定 memo 是否 bail 的比较函数**——这就是 React 在重渲染时唯一会调用的那段逻辑：

`apps/fe/src/components/page-layouts/components/sidebar-memo-stability.test.ts`（新增，8 test / 21 assert）

- `sameNodeEntry`：字段相同、对象是新的 → true；7 个字段各自变化 → false。
- `sameRuntimeSectionProps`：**用真实链路造数据**——`patchNodesWithEvent` 打一条只改 `node-b` 的 RTT 事件，再过 `toSidebarEntries`，断言 `after[0] !== before[0]`（复现 EX1 的根因）而比较器返回 true，即 memo 会 bail；本节字段变了 / `drag` 换引用 / `disclosure` 换引用 → false。
- `sameSortableRow`：未拖拽时每帧新建的 `style` + `dragHandleProps` → true；transform / transition / `isDragging` / 手柄 props 任一变化、键数不同 → false。
- `nodeDeviceContext`：只取三个字段。

---

## U1 — 终端字号 / 行高输入每敲一键重建全部 ghostty 实例

### 改动

- `packages/panels/src/settings/numeric-setting-draft.ts`（新增）
  - `parseNumericSetting(raw, min, max)`：区间内的有限数才是可提交值（空串 / 非数 / 越界返回 null）。
  - `createDeferredCommit(commit, delayMs = 250)`：`schedule` 重排延时窗口（窗口内多次调用只提交最后一个值）、`flush` 立刻提交、`cancel` 丢弃。
- `packages/panels/src/settings/terminal-settings-panel.tsx`
  - 新增 `useNumericSetting`：输入只改本地草稿，提交走 **失焦 / 回车 / 停手 250 ms**。按住上下箭头（约 30 次/秒）期间 `schedule` 一直被重排，**松手后只提交一次**；失焦立即 `flush` 并且到点的定时器不会重复提交（`committedRef` 挡住）。
  - 原来那条「store 变了就回灌草稿」的 effect 加了守卫：只在**别处**改了 store 时回灌（`value !== committedRef.current`），否则 250 ms 后的自提交会把用户还在敲的内容改写掉。
  - 越界 / 空串在失焦时回退到已提交值（原实现是留在框里不提交）。
  - 两个 `<Input>` 接上 `onBlur` / `onKeyDown`（`@tmex/ui` 的 `Input` 直接 spread props，已确认）。
  - 面板文档注释同步：字体 / 键盘行为仍即改即生效，字号 / 行高改为失焦或停手后生效。
- `packages/stores/src/ui.ts`
  - `deferredKeys: ['editorDrafts']` → `['editorDrafts', 'terminalFontSize', 'terminalLineHeight']`。
- `packages/terminal-ui/src/components/TerminalPreview.tsx`
  - **确认它确实会重复 await**：effect 依赖含 `fontSize`，改字号就重跑一遍 `await loadTerminalFonts(fontId, fontSize)`。而 `document.fonts.load` 的字号只用于匹配 face，与「加载哪几张字体表」无关，所以纯属白等一拍。
  - 抽出模块级 `loadedPreviewFontIds` + `ensurePreviewFonts(fontId, fontSize)`：同一个 fontId 只在首次真的去加载，失败不入集合。抽成模块级函数同时把组件行数压回复杂度 allowlist 的 162 行以内。
  - 预览仍跟 store（即提交后的值），未改成跟草稿——EX1/任务把这条列为可选。

> 语义变化（需要产品确认）：字号 / 行高由「即改即生效」变成「失焦 / 回车 / 停手 250 ms 生效」。这正是任务要求的取舍。`apps/fe/tests` 里没有任何 e2e 依赖 `terminal-font-size` / `terminal-line-height`（已 grep）。

### 测试

- `packages/panels/src/settings/numeric-setting-draft.test.ts`（新增，7 test / 18 assert）：`parseNumericSetting` 边界；窗口内连续 `schedule` 只提交最后一个值一次；`flush` 立刻提交且到点定时器不重复提交；空 `flush` 无副作用；`cancel` 丢弃待提交值；提交后再 `schedule` 走新窗口。用手动时钟替换 `globalThis.setTimeout`，`finally` 里恢复。
- `packages/stores/src/ui-persist.test.ts` 新增 `describe('终端字号 / 行高延后落盘')`（3 test）：连着调字号在去抖窗口内最多写一次、窗口后正好再写一次并能读回；行高与字号合并成同一次写；字体族仍立即落盘并顺带把待写的字号一起写出去。

---

## U9 — 站点设置草稿 state 挂在页级

`use-site-settings-form.ts` 的注释与 `SettingsPage.tsx:141` 都明确写着「表单常挂在页级，切标签不丢未保存的草稿」，所以**「把草稿下沉到用它的两个 tab」会改行为**（general ↔ notifications 互切会丢草稿），按任务「pick the smaller, safer change」的要求排除。选了保行为的那条：

- `apps/fe/src/pages/SettingsPage.tsx`
  - 抽出 `memo(SettingsTabBar)`：标签条与草稿无关，每敲一键不再重渲染 7 个 `TabsTrigger`（各带 lucide 图标 + 一次 `t()`）。`selectTab` / `warmTab` 改 `useCallback` 让 memo 真的 bail 得掉。
  - 抽出 `SettingsTabPanels`，`useSiteSettingsForm` 下沉到它里面。它**不带 key**、常挂，切标签草稿照旧保留（`Reveal key={activeTab}` 仍在它内部，入场动画不变）。草稿改动的重渲染就此止步于这一层。
  - `useSiteSettingsForm` 本身未改（`enabled` 仍按 `TABS_USING_SITE_SETTINGS` 算，dirty / save / 语言预览全部原样）。
- `apps/fe/src/pages/settings/notification-settings-tab.tsx`：`TelegramBotsTab` / `WeixinAccountsTab` / `WebhooksTab` 三张无 props 的重卡片改走 `memo(...)`——这正是任务给的「memo the heavy sibling cards」那一支，EX1 点名的「Telegram / 微信 / Webhooks 三张卡每键全量重渲染」由此消掉。
- `apps/fe/src/pages/settings/general-settings-tab.tsx`：同理 `memo(VersionTab)`。

> 说明：这两个 tab 文件不在任务明示的 files-you-own 清单里，但「memo the heavy sibling cards」这条选项指向的就是它们，各只改 3–4 行；两个文件都不属 OB 的 `nodes/**` / `remote-access/**`，全程无冲突。

---

## 文件清单

新增
- `apps/fe/src/components/page-layouts/components/sidebar-memo-stability.test.ts`
- `packages/panels/src/settings/numeric-setting-draft.ts`
- `packages/panels/src/settings/numeric-setting-draft.test.ts`

修改
- `apps/fe/src/components/page-layouts/components/sidebar-node-section.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`
- `apps/fe/src/pages/devices/node-device-group.tsx`
- `apps/fe/src/pages/SettingsPage.tsx`
- `apps/fe/src/pages/settings/notification-settings-tab.tsx`
- `apps/fe/src/pages/settings/general-settings-tab.tsx`
- `packages/panels/src/settings/terminal-settings-panel.tsx`
- `packages/stores/src/ui.ts`
- `packages/stores/src/ui-persist.test.ts`
- `packages/terminal-ui/src/components/TerminalPreview.tsx`

---

## 验证

| 项 | 基线（改前实测） | 改后 |
|---|---|---|
| `apps/fe` `bun test src/` | 1744 pass / 0 fail（89 文件） | **1757 pass / 0 fail**（91 文件；+8 本任务，+5 其它 agent） |
| `packages/panels` `bun test src/settings` | 86 pass / 0 fail（7 文件） | **104 pass / 0 fail**（9 文件；+7 本任务，其余为其它 agent） |
| `packages/stores` `bun test` | 435→439 pass / 0 fail | **440 pass / 0 fail**（+3 本任务） |
| `packages/terminal-ui` `bun test` | 394 pass / 0 fail | **398 pass / 0 fail**（+4 为其它 agent） |
| biome | — | 13 个改动文件 `bunx biome check` **全清**（含 2 处 format 自动修） |
| `bun scripts/complexity/gate.ts` | — | 我的文件**零违规**（`TerminalPreview` 一度 167 > 162，抽出 `ensurePreviewFonts` 后回到限内） |

tsc（`bunx tsc --noEmit -p .`）：`packages/panels`、`packages/terminal-ui` **零错误**；`apps/fe` 与 `packages/stores` 只剩其它 agent 在飞的错误，我的文件零错误——

- `packages/ghostty-terminal/src/canvas-renderer.ts(25,3)` `GhosttyColorRgb` 未使用
- `packages/panels/src/files/files-node-roots.tsx(351/399)` `FileNodeActions.dragHandlers` 尚未落地
- `packages/stores/src/host-services.test.ts(93,23)`

期间还观察到其它 agent 的**瞬时**破坏（`@tmex/api-client` 缺 `fetchCapabilities` / `FeatureSet`、`apps/fe/src/auth/session-login.ts` 缺 `resumeSessionAfterPasswordChange`、`apps/fe/src/use-page-module.ts`、`packages/panels/src/agent/messages/tool-brief.ts`），均已自行恢复或与本任务无关；最终一轮全量跑时四个包全绿。

复杂度门禁最终仍失败 7 项 + 1 条 stale allowlist，全部归属其它 agent：`streaming-markdown.tsx`、`split/SplitPaneView.tsx`（含 stale 条目 `SplitPaneView`，实现已改名成 `SplitPaneViewComponent`）、`Terminal.tsx`、`usePaneSinkRegistration.ts`、`ghostty-wasm.ts`、`render-state-read.ts`、`terminal-render-coordinator.ts`。

## 未做 / 需注意

- **真正的重渲染计数测试做不了**（无 DOM），已按上面说明改成锁比较器 + 用真实 `patchNodesWithEvent` 造数据，理由见 U6 小节。
- **U6 的根因比 EX1 描述的更深一层**：`patchNodesWithEvent` 无条件换对象 + dnd-kit 每帧换 props。更彻底的做法是在 `patchNodesWithEvent` 里做「字段全等就沿用原对象」，或把 `useSortableRow` 的返回值在 `device-tree-dnd-impl.tsx` 里 `useMemo` 掉——**这两个文件都不在我的 owned 清单内，没有改**，改在消费侧等价且不影响别处。若后续有人统一收敛，本次加的比较器可以直接退化成默认引用比较。
- 字号 / 行高从「即改即生效」变为「失焦 / 回车 / 停手生效」，属产品语义变化，需确认。
