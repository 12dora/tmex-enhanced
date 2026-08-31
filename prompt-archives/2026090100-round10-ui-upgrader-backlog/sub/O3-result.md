# O3：SelectionToolbar 吞掉终端顶部点击（P2.1）

## 改动

| 文件 | 说明 |
|---|---|
| `packages/terminal-ui/src/components/selection-dismiss.ts` | 新增：纯判定函数 `shouldDismissSelectionOnPointerDown` + 常量 `SELECTION_TOOLBAR_SELECTOR` |
| `packages/terminal-ui/src/components/selection-dismiss.test.ts` | 新增：7 个用例覆盖判定分支 |
| `packages/terminal-ui/src/components/Terminal.tsx` | 容器 div 挂 `onPointerDownCapture`，命中判定则调用既有 `dismissSelection()` |

`SelectionToolbar.tsx` **零改动**（`data-testid="terminal-selection-toolbar"` 已存在，直接作为选择器锚点；
`preventFocusSteal` 原样保留）。

## 判定逻辑

`shouldDismissSelectionOnPointerDown({ hasSelection, pointerType, button, target })` 返回 true 仅当：

1. `hasSelection === true`（无选区时完全不介入）；
2. `pointerType !== 'touch'`；
3. `button === 0`（左键/笔尖）；
4. `target.closest('[data-testid="terminal-selection-toolbar"]')` 为空（工具条内部按下一律放行）。

Terminal 里只做「判定 → 调用 `dismissSelection()`」，**不 `preventDefault`、不 `stopPropagation`**，
capture 阶段也只读不拦，终端画布的事件路径不受影响。

### 为什么排除触摸

移动端选区与软键盘时序由 `useMobileTouch` → `MobileTouchGestureMachine` 独占（`touchstart` 只清长按定时器，
终端选区跨滚动保留；`focus()` 只在 tap 结束时显式调用来唤软键盘）。而 `dismissSelection()` 内部是
`clearSelection() + focus()`——若在触摸 pointerdown 上触发，会「滚动一下就丢选区并弹出软键盘」，
属于实打实的移动端回归。另一方面触摸场景下工具条覆盖区的按下本来就落在按钮上（规则 4 放行），
接入触摸没有任何收益，故显式排除。

### 为什么排除非左键

右键（会出 contextmenu）、中键落到画布时 ghostty 的 mousedown 对 `button !== 0` 直接 return、不动选区；
指针层跟着不动，避免出现「右键把选区清了」这种新行为。

## 挂钩点与既有连线

选区状态与清除全部复用 `useTerminalClipboard`（`packages/terminal-ui/src/components/hooks/useTerminalClipboard.ts`）：

- `hasSelection` 来自 `instance.onSelectionChange`，是工具条 `visible` 的唯一来源；
- `dismissSelection()` = `instance.clearSelection() + instance.focus()`，**清的是 ghostty 的真实选区**
  （不是只隐藏工具条），因此 ghostty 随后的 `mousedown → beginPointerSelection` 是从干净状态起选。

没有新增 store、没有新增状态。

## 时序

浏览器保证 `pointerdown` 先于兼容 `mousedown`；ghostty 只在 select surface 上监听 `mousedown`
（`packages/ghostty-terminal/src/terminal-pointer.ts:109`）。所以按下瞬间旧选区已清、工具条随之卸载，
同一次手势的 `mousedown` 落到画布即开新选区，拖拽全程不再被工具条盖住。

## 已知残留（有意为之）

指针**直接按在工具条按钮上**时仍不会开始新选区——按钮必须可点（复制/粘贴/关闭），这是规则 (a) 的必然结果。
本次改动把「工具条挡住顶部 3 行」压缩为「工具条只在可见期间挡住它自己的按钮区」：在画布任意其他位置按一下，
工具条立刻消失，该区域即刻可框选。

若之后要连按钮之间的间隙也放行，方向是给工具条外层加 `pointer-events-none`、按钮加 `pointer-events-auto`；
但工具条 `p-1` + `gap-1` 的空隙不足 8px，收益极小、且会让「点在工具条上却穿透到画布」变得反直觉，本次未做。

## 验证

| 项 | 改动前 | 改动后 |
|---|---|---|
| `bun test src/`（packages/terminal-ui） | 337 pass / 0 fail（26 files） | 344 pass / 0 fail（27 files） |
| `bunx tsc --noEmit -p .` | 0 error | 0 error |
| `bunx biome check <3 个改动文件>` | — | clean（No fixes applied） |
| `bun scripts/complexity/gate.ts` | — | 我的文件零违规 |

新增的 7 个用例即 337 → 344 的差额，无既有用例失败。未跑 e2e、未起 dev server。
