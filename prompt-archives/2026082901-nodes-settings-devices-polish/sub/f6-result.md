# f6 执行结果：panels / terminal-ui 采用共享动效基础

范围严格限定在 `packages/panels/src/**` 与 `packages/terminal-ui/src/**`，未触碰 `apps/fe/**`、
`packages/ui/**`、`packages/theme/**`。全部动效走 `packages/theme/src/motion.css` 的 token 与工具类，
未引入任何运行时动画库。

## 一、按面结算的改动

### packages/panels — device-management

| 文件 | 动效 |
| --- | --- |
| `device-management/device-management-panel.tsx` | 卡片网格加 `tmex-stagger`；**只有首屏那一批**卡片挂 `--tmex-stagger-index`（`initialBatchRef` 在首次拿到 `data` 时冻结 id 集合），档位封顶 `STAGGER_MAX_INDEX = 11`（≈385ms 拖尾上限）。loading / error / empty 三个 `Card` 加 `tmex-reveal` 淡入上移 |
| `device-management/device-card.tsx` | 新增可选 `style` prop（供列表挂 stagger 变量）；卡片 hover 抬升 `transition-[box-shadow,border-color] duration-(--tmex-motion-standard) ease-out hover:shadow-md hover:ring-foreground/20 motion-reduce:transition-none`（`Card` 的边框是 `ring-1`，v4 下 ring 走 box-shadow，故与 shadow 同一条 transition） |

首屏之外新增的设备：仍受 `.tmex-stagger > *` 的淡入，但 index 为 0（无延迟），不会跟着列表重排出现整列重放。
refetch 不会重放——CSS animation 只在元素插入 DOM 时触发，React 复用同一节点。
删除确认对话框沿用 `AlertDialog` primitive 自带动效，未加任何本地动画。

### packages/panels — device-tree

| 文件 | 动效 |
| --- | --- |
| `device-tree/device-window-list.tsx` | 展开内容根节点 `tmex-reveal`（150ms 淡入上移，只在展开挂载时播一次；tmux 快照推送只是重渲染，不重放）；「新建窗口」按钮既有 `transition-colors` 补 fast token + `ease-out` + `motion-reduce:transition-none` |
| `device-tree/device-connection-control.tsx` | 状态圆点补 `transition-colors` + standard token（**在 `cn()` 调用处加，未改 `deviceStatusDotClass` 的返回值**，单测按精确字符串断言）；Power 按钮 hover 与图标配色补 `transition-colors` + token |
| `device-tree/device-actions-menu.tsx` | 行内菜单触发器既有 `transition-opacity` 补 standard token + `ease-out` + `motion-reduce:transition-none` |
| `device-tree/pane-row-content.tsx` | pane 行关闭按钮既有 `transition-opacity` 同上补 token |

未动行几何：`device-row.tsx` / `device-tree-row-shell.tsx` / `device-tree-dnd.tsx` 全部保持原样，
dnd-kit 提供的 `transform` / `transition` 未受任何干扰。

### packages/panels — connection-indicator

`connection-indicator.tsx` 保留 `hidden/entering/visible/exiting` 相位机，改动：

- 时长 `300ms` → `motionDurations.layout`（200ms），缓动 `ease-in/ease-out` → `var(--tmex-ease-in)` / `var(--tmex-ease-out)`。
- 接入 `useReducedMotion()`：为 true 时 `transition: 'none'`，且**相位机跳过 entering/exiting 直接落 visible/hidden**。
  这是必须的——没有 transition 就没有 `transitionend`，退场若停在 `exiting` 节点会永远挂着 `opacity:0` 不卸载。
- spinner 补 `motion-reduce:animate-none`。

### packages/panels — device-console

| 文件 | 动效 |
| --- | --- |
| `device-console/device-console.tsx` | `NoDeviceNotice` 卡片 `tmex-fade` |
| `device-console/terminal-stage.tsx` | `CenteredNotice`（覆盖断开 / 空闲 / 选择失效三种提示）、`ResolvingOverlay`、重连指示条均加 `tmex-fade`；`LoadingPlaceholder` 与 overlay 的两个 spinner 补 `motion-reduce:animate-none` |
| `device-console/editor-input-panel.tsx` | 面板根节点 `tmex-fade`（**只淡不位移**：该节点带 `data-virtual-keyboard-avoid`，`apps/fe` 的键盘避让会写内联 `transform`，用 fade 避免打架）；textarea 的 `transition-colors` 补 fast token；发送 spinner 补 `motion-reduce:animate-none` |

终端画布本身（`TerminalComponent` / `SplitTerminalArea` 的挂载与尺寸）一行未改。

### packages/panels — 徽标与传输

| 文件 | 动效 |
| --- | --- |
| `device-status-badge.tsx` | 重连 spinner 补 `motion-reduce:animate-none`。**配色过渡不重复声明**：`packages/ui/badge.tsx` 已带 `transition-[color,background-color,border-color,box-shadow] duration-(--tmex-motion-fast) ease-out`，reconnecting↔error 两个分支复用同一 DOM 节点，配色自动过渡 |
| `files/transfer-toast.tsx` | `PathBadge` 补 `transition-colors` + fast token。进度条无需改动：`packages/ui/progress.tsx` 已是 `transition-[width] duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none` |

### packages/terminal-ui

| 文件 | 动效 |
| --- | --- |
| `components/SelectionToolbar.tsx` | 工具条 `tmex-reveal`（150ms 淡入 + 6px 上移，落在要求的 100–150ms 区间）。`preventFocusSteal` 的三个 `onMouseDown` 原样保留。`-translate-x-1/2` 与动画不冲突——已在编译产物中确认 v4 的 translate 工具类走 `translate` 属性，keyframe 走 `transform`，两者叠加。三个按钮补 `transition-colors` + fast token |
| `components/PaneSwitcherMenu.tsx` | 触发器补 `transition-colors` + fast token + `motion-reduce:transition-none`；下拉菜单动效仍由 `dropdown-menu` primitive 统一提供 |
| `components/split/SplitPaneView.tsx` | 标题栏 `transition-colors` 补 standard token；pane 名与 `meta` 两个 span 新增 `transition-colors` + standard token（焦点切换时的配色过渡）；关闭按钮 `opacity-70` → 标题栏 hover / 自身 hover 时 `opacity-100`，走 `transition-[opacity,color,background-color]` + fast token（标题栏加了 `group/pane-titlebar`）；生成中 sparkle `animate-pulse` → `motion-safe:animate-pulse` |
| `components/SplitTerminalArea.tsx` | 分隔条**仅配色**：既有 `transition-colors` 补 fast token + `motion-reduce:transition-none`。pane 宽高、gutter 几何、拖拽参考线一律未动 |

## 二、验证

| 检查项 | 基线（改动前实测） | 改动后 |
| --- | --- | --- |
| `packages/panels` → `bun test` | 381 pass / 0 fail | **381 pass / 0 fail**（29 文件） |
| `packages/panels` → `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `packages/terminal-ui` → `bun test` | 315 pass / 0 fail | **315 pass / 0 fail**（24 文件） |
| `packages/terminal-ui` → `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `apps/fe` → `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `bunx biome check <16 个改动文件>` | — | 1 error，见下 |

### biome 说明

唯一一条 error 是 `connection-indicator.tsx:79 lint/a11y/useKeyWithClickEvents`（可点击 `<div>` 缺键盘事件），
**为既有问题**：该 `<div className="... cursor-pointer" onClick={() => runtime.client.reconnect()}>` 在改动前就是这样，
本次只替换了它的 `style={transitionStyle}` 内容，没有新增/移动任何 `onClick`。修它需要改成 `<button>`（涉及样式与 e2e），
超出本任务范围，故未动。其余 15 个文件 biome 全绿。

### Tailwind 编译验证

用真实的 `apps/fe/src/index.css` 跑了一次 `@tailwindcss/cli@4.1.18`（输出到 scratchpad，未写入仓库），
逐条确认本次新用到的类真的编译出来了，而不是靠猜：

- `.transition-\[box-shadow\,border-color\]`、`.transition-\[opacity\,color\,background-color\]` ✓
- `.hover\:ring-foreground\/20`、`hover:shadow-md` ✓
- `.group-hover\/pane-titlebar\:opacity-100`（配套 `.group\/pane-titlebar`）✓
- `motion-safe:animate-pulse`、`motion-reduce:animate-none`、`motion-reduce:transition-none` ✓
- `duration-(--tmex-motion-standard)` / `duration-(--tmex-motion-fast)` 均产出 `transition-duration` ✓
- `.tmex-reveal` / `.tmex-fade` / `.tmex-stagger > *` 及全局 reduced-motion 块在产物中 ✓
- `.-translate-x-1\/2` 产出的是 `translate:` 属性（非 `transform:`），确认与 `tmex-fade-up` 的 `transform` keyframe 不互相覆盖 ✓

未跑 Playwright（按要求）。未做浏览器视觉验收。

## 三、有意跳过的部分及原因

1. **所有退场（exit）动画**。`EditorInputPanel`、`SelectionToolbar`、`DeviceWindowList`、终端各提示层都是条件挂载，
   CSS class 无法给卸载中的节点上动画。要做真退场必须引入「延迟卸载 / presence」状态机，
   会把状态复杂度带进 device-console 的选择域与 tmux 实时更新路径，风险与收益不对等。统一只做入场。
2. **设备卡片的删除动画**同理——需要两阶段移除模型，`explore-motion.md` 本身也建议不要用纯 CSS 假装。
3. **transfer-toast 工作态卡片内不加任何入场动效**。该卡片每 ≤100ms 就重跑一次 `toast(<WorkingBody/>)`，
   若 sonner 在某个版本里重建内容节点，`tmex-fade` 会以 10Hz 重放成闪烁。只保留零重放风险的配色过渡；
   进度插值继续由 `Progress` primitive 的 `transition-[width]` 承担。
4. **`device-status-badge` 不重复声明配色 transition**：`badge.tsx` primitive 已覆盖，重复写只会互相打架。
5. **`SplitPaneView` 的关闭按钮没有做成「默认 opacity-0，hover 才出现」**。分屏 pane 标题栏在触屏上没有 hover，
   隐藏会直接丢掉关闭入口，也可能影响既有 e2e。改成 `opacity-70 → 100` 的渐显，既有过渡又不损可发现性。
6. **`bell-blink`（pane 通知闪烁）未动**：keyframes 定义在 `apps/fe/src/index.css`，不在本次可改范围；
   它是「需要注意」的瞬态提示，不属于「稳定状态无限脉动」。
7. **dnd-kit 的 `transform`/`transition`、pane 宽高、gutter 几何、xterm 画布挂载与尺寸**：按要求一律未动。
8. **`device-tree` 行几何未加任何动画**，避免与 tmux 高频快照推送打架。
