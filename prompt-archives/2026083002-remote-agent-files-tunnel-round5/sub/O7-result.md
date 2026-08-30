# O7 结果 — 终端页顶栏：命令输入框动画 + 全部图标按钮 tooltip

## 一、先说结论

两条需求都已落地并通过验证。有两处与任务书描述不完全一致的判断，写在「四、判断与偏差」，请指挥官过目。

## 二、改了什么

### 1. 命令输入框（editor 输入模式面板）的展开 / 收起动画

先确认了「右上角图标展开命令输入框」指的是哪一个：终端页顶栏的
`terminal-input-mode-toggle`（Keyboard / Smartphone 图标），它把 `inputMode` 在
`direct` ↔ `editor` 之间切，`editor` 时在终端下方展开
`EditorInputPanel`（就是那个可以敲多行命令再发出去的输入框）。全仓再无第二个
「点图标展开的输入框」（已 grep 过 fe / panels / terminal-ui 的所有 header、PageActions、
搜索框、下拉）。原实现是 `{inputMode === 'editor' && <EditorInputPanel/>}` 直接挂/卸，
只有一个入场 `tmex-fade`（还是 opacity），退场完全是硬切——与用户反馈一致。

新增 `packages/panels/src/device-console/command-input-collapse.tsx`：

- `useCollapsePresence(open)`：展开时**先挂载、下一帧才置展开态**（起止值同帧写入浏览器不过渡），
  收起时先置收起态、跑满 `COMMAND_INPUT_COLLAPSE_MS = 200ms` 再卸载。首屏就处在 editor 模式时
  不播入场动画。
- `CommandInputCollapse`：`grid-template-rows: 0fr → 1fr` 做高度过渡（内容高度不用写死），
  叠 `opacity 0→1` 与 `translate-y-1 → 0` 的轻微位移；`duration-(--tmex-motion-layout)`（200ms），
  展开 `ease-out`、收起 `ease-in`，带 `motion-reduce:transition-none`
  （另有 `packages/theme/src/motion.css` 的全局 reduced-motion 兜底）。**没有新增 keyframe**，
  全部复用现有 `--tmex-motion-*` token。

`editor-input-panel.tsx`：

- 去掉 `tmex-fade`（改由外层 collapse 统一负责，否则两层动画打架）。
- 展开后焦点自动落到输入框（`useEffect` 里 `focusEditor()`，内部是
  `focus({ preventScroll: true })`）。
- 新增 `onClose` prop，面板根节点接 `onKeyDown`：**Esc 收起**回到 direct 输入；
  `event.nativeEvent.isComposing` 时不处理——输入法候选窗开着时的 Esc 归输入法。
- `device-console.tsx` 用 `CommandInputCollapse` 包住面板，并传 `onClose={() => setInputMode('direct')}`。

顶栏按钮不会因此位移：面板在终端下方纵向展开，顶栏一个像素不动。

### 2. 左右上角所有纯图标按钮的 tooltip

新增 `packages/ui/src/components/icon-tooltip.tsx`（`@tmex/ui/icon-tooltip`）：

```tsx
<IconTooltip label="向右分屏">{按钮}</IconTooltip>
```

- 复用现有 Base UI `Tooltip` 原语，统一 `delay = ICON_TOOLTIP_DELAY_MS = 400`、统一 `side = 'bottom'`（顶栏）。
- **触发器渲染成 `span` 而不是按钮本身**：这是关键取舍。顶栏一半按钮会进禁用态
  （`canInteract === false`，即没选中 pane / 未连接），而带原生 `disabled` 的 `<button>`
  在浏览器里根本不派发指针事件（Button variant 里还有 `disabled:pointer-events-none`），
  气泡挂在按钮上时禁用态永远弹不出来——恰恰是用户最需要提示的时候。套在外层 span 上，
  禁用按钮的 hover 事件落到 span，提示照常出；`focusin` 会冒泡，键盘聚焦内部按钮同样能触发
  （floating-ui 的 `useFocus` 取的是 `event.target` 再 `matches(':focus-visible')`，已核对源码）。
- 所有接入点同时保证 `aria-label` 与气泡文案同源，并**移除原有的 `title`**，
  否则原生提示会和气泡叠出两层。

接入的按钮（全部纯图标，带文字标签的一律不加，符合任务书要求）：

| 位置 | 按钮 | 文案 key |
| --- | --- | --- |
| 终端页右上 | 向右分屏 | `window.splitRight` |
| 终端页右上 | 向下分屏 | `window.splitDown` |
| 终端页右上 | 刷新页面 | `nav.refreshPage` |
| 终端页右上 | 命令输入框开关 | `nav.switchToEditor` / `nav.switchToDirect` |
| 终端页右上 | 跳到最新 | `nav.jumpToLatest` |
| 终端页右上 | 监控规则 | `watch.title` |
| 终端页右上 | 终端设置 | `settings.terminal.title` |
| 顶栏左上 | 侧栏开关 | `nav.openSidebar` / `nav.sidebarCollapse` / `nav.sidebarExpand` |
| 侧栏头部 | 主题 | `settings.theme` |
| 侧栏头部 | 多节点互联 | `sidebar.nodes` |
| 侧栏头部 | 设置 | `sidebar.settings` |
| 侧栏头部（移动端） | 关闭侧边栏 | `nav.closeSidebar` |

顶栏左上的侧栏开关原来**没有任何 aria-label**，只有一段写死英文的 `sr-only "Toggle Sidebar"`。
新增 `SidebarToggle` 子组件读 `useSidebar()`，按形态给文案：移动端「打开侧边栏」，
桌面端按展开态给「收起侧边栏 / 展开侧边栏」。

## 三、文件清单

新增：

- `packages/ui/src/components/icon-tooltip.tsx`
- `packages/panels/src/device-console/command-input-collapse.tsx`
- `packages/panels/src/device-console/command-input-collapse.test.tsx`
- `packages/panels/src/device-console/toolbar-tooltips.test.tsx`

修改：

- `packages/panels/src/device-console/device-console-toolbar.tsx`（导出 `ToolbarIconButton`、套气泡、去 `title`）
- `packages/panels/src/device-console/device-console.tsx`（collapse 包裹 + `onClose`）
- `packages/panels/src/device-console/editor-input-panel.tsx`（去 `tmex-fade`、自动聚焦、Esc 收起）
- `apps/fe/src/page-wrapper.tsx`（`SidebarToggle`）
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`
- `apps/fe/src/components/page-layouts/components/theme-menu.tsx`
- `apps/fe/src/page-wrapper.test.tsx`（补断言）
- `apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx`（补断言）

**没有改任何 locale JSON**（见下）。没有改 `packages/theme/src/motion.css`（现有 token 够用）。
没有跑任何改动状态的 git 命令，没有跑仓库级 formatter。

## 四、判断与偏差（需要指挥官确认的两点）

1. **i18n 一个 key 都没加。** 逐条核对下来，需要的短标题现成 key 全都有，
   连侧栏开关的三态文案（`nav.openSidebar` / `nav.sidebarExpand` / `nav.sidebarCollapse`）
   都已存在且此前无人使用。新造 `toolbar.*` 只会与 `nav.*` 重复，还会把
   `nav.switchToEditor` 之类变成死 key；加上 O6 正在同批扫这三个 JSON，
   少动一行就少一分冲突。若指挥官希望命令输入框那枚按钮的文案从
   「切换到编辑器输入」改成更贴用户口径的「命令输入 / 直接输入」，
   建议并入 O6 的 wording sweep 直接改 `nav.switchToEditor` / `nav.switchToDirect` 的值，
   而不是我这边再加一组同义 key。

2. **任务书里「expand = 宽度动画、相邻按钮不跳动、grid-template-columns 0fr→1fr」的描述
   与实际控件形态对不上。** 这个输入框不是顶栏里横向展开的窄条，而是终端下方整宽的多行面板，
   它旁边没有按钮可跳。我按同一套动效语言做成了**纵向** `grid-template-rows 0fr→1fr`
   + 透明度 + 轻微位移，时长与缓动完全按要求（200ms、展开 ease-out / 收起 ease-in、
   尊重 reduced-motion），焦点与 Esc 也都按要求实现。若指挥官指的是别的控件，请指出，我再改。

## 五、验证

| 项目 | 结果 |
| --- | --- |
| `packages/panels` `bun test` | **569 pass / 0 fail**（基线 507，含本轮各 agent 新增） |
| `packages/panels` `bunx tsc --noEmit -p .` | **0 error**（基线 0） |
| `packages/ui` `bun test` | **47 pass / 0 fail**（基线 47） |
| `packages/ui` `bunx tsc --noEmit -p .` | **0 error**（基线 0） |
| `apps/fe` `bun test src/` | **763 pass / 3 fail**（基线 671 pass / 0 fail） |
| `apps/fe` `bunx tsc --noEmit -p .` | **3 error** |
| `bunx biome check <改动的 12 个文件>` | **无问题** |

`apps/fe` 剩下的 3 个 fail 与 3 个 tsc error **全部落在 tunnel 一侧**
（`src/pages/settings/remote-access/{remote-access-tab.test.tsx,tunnel-actions.test.ts,tunnel-model.test.ts}`，
`TunnelStatusResponse.configuredTrustProxy` 由必填变可选后 fixture 未跟），属于 tunnel owner 的范围，
不是本任务引入——我这轮开工前跑基线时 fe 是 766 pass / 0 fail，这 3 个 fail 是并行 agent 刚改
`tunnel-model.ts` 之后出现的。我改动的 12 个文件在 tsc 里 0 error。

额外做了一次真实构建校验（`apps/fe` 下 `bunx vite build`，产物在 gitignore 的 `dist/`）：
grep 编译后的 CSS 确认动画类全部生成，并因此**修掉一个真 bug**——Tailwind v4 的 `translate-y-*`
写的是 `translate` 属性而不是 `transform`，原来的 `transition-[...,transform]` 不会让位移过渡，
已改成 `transition-[grid-template-rows,opacity,translate]` 并重新构建确认
`transition-property:grid-template-rows,opacity,translate` 落到产物里。

## 六、新增测试

- `toolbar-tooltips.test.tsx`：静态渲染每一枚顶栏图标按钮，断言 ①每枚都有非空标题
  ②渲染出 `aria-label="<标题>"` 与 `data-slot="tooltip-trigger"` ③不再出现 `title=`
  ④禁用态按钮同样带触发器与 `aria-label`（守住上面那条 span 包裹的取舍不被改回去）。
- `command-input-collapse.test.tsx`：`collapseDataState` 的两态；展开时渲染出
  `data-state="open"` 与 `grid-rows-[1fr]` / `data-[state=closed]:grid-rows-[0fr]` /
  `opacity-0` / `translate-y-1` / `duration-(--tmex-motion-layout)` / `motion-reduce:transition-none`；
  从未展开过时不占位；卸载延时与动效时长对齐。
- `page-wrapper.test.tsx`：侧栏开关带 `aria-label` 与气泡触发器，桌面展开态文案是「收起」。
- `sidebar-title.test.tsx`：主题 / 节点 / 设置三枚入口各有 `aria-label` 与气泡触发器（恰好 3 个）。

## 七、遗留与风险

- **范围外未动**：`packages/terminal-ui/src/components/PaneSwitcherMenu.tsx`（移动端 pane 切换按钮）
  已有 `aria-label` + `title`，但只在移动端出现、触屏没有 hover，加气泡无意义，且不在我的文件范围内。
  `apps/fe/src/pages/FilePage.tsx` 与 `DevicesPage.tsx` 的 `PageActions` 里也有纯图标按钮
  （刷新 / 新窗口打开 / 下载等，只有 `title` 没有 `aria-label`）——用户的原话是「左右上角所有图标」，
  这两页的顶栏严格说也在其列，但不在我的 scope 里，也不属于 O6 的「非 header 组件」。
  **建议指挥官补一个小任务**，用 `@tmex/ui/icon-tooltip` 一并收掉，改法与本轮完全一致。
- `SidebarTrigger`（`packages/ui/.../sidebar-layout.tsx`）里那段写死英文的
  `<span class="sr-only">Toggle Sidebar</span>` 仍在。现在外层有 `aria-label`，
  可及名以 `aria-label` 为准，不影响读屏；只是冗余，属于 ui 包公共组件，未擅动。
- **未做真机/浏览器实测**：本轮多个 agent 共用一个 worktree，起临时实例会抢端口，
  且需要真实设备与 tmux 会话。动画与气泡的可见效果靠「构建产物 CSS 校验 + 静态渲染断言」覆盖，
  交互时序（400ms 延迟、Esc、自动聚焦）建议在合并后的一次统一冒烟里过一遍。
- `editor-input-panel.tsx` 里 `editor-mode-input` / `.actions` / `.send-row` 这几个 class
  在全仓找不到任何 CSS 定义（死类，早于本轮存在）。未清理——不在本任务范围，且 e2e 可能有引用风险，
  留给做 code smell 清理的一轮处理。
