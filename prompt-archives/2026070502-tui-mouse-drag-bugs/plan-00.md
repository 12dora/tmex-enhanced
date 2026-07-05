# alt-screen TUI 鼠标两 bug：根因与修复计划

## 背景

用户在 tmex 前端终端里跑 opencode（alt-screen TUI，启用 SGR 鼠标拖拽跟踪 1002+1006）：

- **bug1**：TUI 内鼠标响应位置与预期差一行（单 pane 与分屏均需确认）。
- **bug2**：切换到其他窗口再切回、或刷新页面后，TUI 只能响应点击，无法响应拖拽。

历史参考：issue45 时期（`prompt-archives/2026070300-issue45-terminal-experience`）曾用
`apps/fe/tests/issue45-mouse-coordinate-diagnostic.spec.ts` + `scripts/issue45-mouse-tui.py`
诊断过 bug1，**未复现**（当时 dpr=1、且只点 row 0/5/10），决策"真实 opencode 环境复测"。
本次调查找到了当年复现不了的原因（见下）。

## 根因

### bug1：鼠标编码的 cell 尺寸被取整，与渲染网格基准漂移（累积 off-by-one）

- `updateCellDimensions`（`packages/ghostty-terminal/src/terminal.ts:1713`）把 CSS cell
  对齐到物理像素网格：`cell.height = round(rawHeight*dpr)/dpr`。默认 fontSize=13 ×
  lineHeight=1.2 = 15.6px，在 Retina（dpr=2）下 cssCell.height = round(31.2)/2 = **15.5**。
- `emitMouseInput`（`terminal.ts:1406-1416`）把 cell 尺寸 `Math.round()` 成整数传给编码器：
  15.5 → **16**。编码器 `encodeMouseEvent`（`ghostty-wasm.ts:1179-1180`）用
  `floor(y/cellHeight)+1` 算行号。
- 渲染（canvas-renderer，整数设备像素 cell=31，css 15.5）与文本选择 `hitTest`
  （`terminal.ts:1857`，直接用未取整 float cell）都在 15.5 基准上；唯独鼠标上报在 16
  基准上 → 偏差率 3.2%，从视觉第 ~16 行起 TUI 收到的行号少 1。opencode 全屏 40 行，
  下半屏必偏一行。单 pane / 分屏同一机制（分屏 pane 矮，交点行更少见，但同样存在）。
- **当年未复现的原因**：Playwright 默认 dpr=1（cssCell=16 整数，round 无损）且只点
  row 0/5/10（交点在 ~15.5 行之后），双重错过。
- 编码器是纯 JS 数学，完全可接受 float cell；`screenWidth/screenHeight` 参数编码器根本未用。

### bug2：capture 重建链路从不携带鼠标 tracking 模式，前端靠硬编码猜测

数据流：tmux 用 control mode（`tmux -C attach-session`）挂载，`%output` 原样转发 pane
字节流——opencode 启动瞬间的 `\x1b[?1002h` 实时进前端 WASM，所以**刷新前拖拽正常**。

切窗/刷新后内容用 `fetchPaneHistory` 重建（`local-external-connection.ts:1236`，
`capture-pane -e` 只保留 SGR 颜色，不含 DECSET；alt-screen 状态单独用 `#{alternate_on}`
查询下发）。链路上：

1. gateway 从不查询 tmux 的 `#{mouse_any_flag}/#{mouse_button_flag}/#{mouse_standard_flag}/#{mouse_sgr_flag}/#{mouse_utf8_flag}`——真实模式只有 tmux 知道，但从未下发。
2. 前端 `Terminal.tsx:onApplyHistory` 用 sessionStorage 缓存 + `reconcileRecoveredModes`
   猜测恢复；缓存 miss 时 `createAlternateScreenFallbackSnapshot`（`Terminal.tsx:83-97`）
   **硬编码只开 1000+1006、永不开 1002/1003**。1000 只报 press/release → 只能点击。
3. 缓存路径也被污染：新 Terminal 实例（模式全 false）mount 后，`onReset`
   （`Terminal.tsx:383`）先 `persistTerminalModes(新实例)` 把全 false 覆盖进缓存，
   `onApplyHistory` 再读缓存 → 拿到 false。刷新（sessionStorage 尚存正确值）与分屏
   切窗（组件卸载重建）都命中该污染。
4. WASM 编码器门控（`ghostty-wasm.ts:1162`）：1002 未开则丢弃 motion → 拖拽失效。

## 修复方案

### bug1（`packages/ghostty-terminal`）

`emitMouseInput` 去掉 cell 尺寸的 `Math.round`，传 float：

```ts
cellWidth: Math.max(1, cell.width || DEFAULT_CELL_WIDTH),
cellHeight: Math.max(1, cell.height || DEFAULT_CELL_HEIGHT),
```

### bug2（权威模式下发，替代猜测）

1. `capture-history.ts`：`PANE_SCREEN_INFO_FORMAT` 增查五个 mouse flag +
   `PaneScreenInfo` 增加对应布尔字段（local/ssh 两个 connection 共用此常量与解析）。
2. `packages/shared/src/ws-borsh/schema.ts`：`TermHistorySchema` 增加 `modes: b.u8()`
   bitfield（bit0 standard/1000、bit1 button/1002、bit2 any/1003、bit3 sgr/1006、
   bit4 utf8/1005），shared 提供 encode/decode helper。fe 与 gateway 同仓同发，无跨版本
   兼容问题；ws 断线重连后 schema 一致。
3. gateway：`fetchPaneHistory` 返回值与 `onTerminalHistory` 回调链带 modes；
   `handleFetchPaneHistory`（点对点）与 `broadcastTerminalHistory`（select barrier）
   两条下发路径都填充。
4. fe：`PaneSink.onApplyHistory` 增 modes 参数；`Terminal.tsx` 用权威模式构造
   snapshot restore（mouseSgr 等编码模式同样来自 flags）；删除 sessionStorage 模式缓存、
   `reconcileRecoveredModes`、`createAlternateScreenFallbackSnapshot` 与 persist 链
   （权威值随每次 history 重建到达，缓存失去存在意义；fetch 失败时无 history 可放，
   模式也无从恢复，与现状等同）。

## 验证方案

- 失败测试先行（修复前红、修复后绿）：
  - ghostty-terminal 单测：dpr=2 / fontSize=13 → cssCell=15.5，开 1002+1006，
    在深行位置 mousedown/motion，断言 SGR 行号与渲染网格一致（修复前少 1）。
  - gateway 单测：`parsePaneScreenInfo` 解析 mouse flags；fetchPaneHistory 返回 modes。
  - shared 单测：modes bitfield 往返。
  - fe e2e（`terminal-mouse-recovery.spec.ts` 扩展或新 spec）：python TUI 开 1002+1006
    → 拖拽 motion 可达 TUI → 刷新 / 切窗再回 → 拖拽 motion 仍可达（修复前只有
    press/release）。
- e2e 复现 bug1：Playwright `deviceScaleFactor: 2` + 默认字号，点/拖低半屏行，
  对比 TUI 收到的 SGR row（复用 `scripts/issue45-mouse-tui.py`）。
- 回归：ws-borsh 系列、switch-barrier、split 系列、terminal-render-regressions、
  单测全家；`tsc --noEmit`；biome（不触碰生成文件）。

## 注意事项

- 一律在 worktree 干活；e2e/开发实例用 19663/19883 与独立 tmux socket（`tmux -L tmex-e2e`
  等），**严禁触碰生产 tmex 服务（9883）、生产库与名为 `tmex` 的 tmux session**。
- `TermHistorySchema` 为 borsh 定长 struct，两端必须同步改（同仓提交即可）；改动会波及
  既有 ws-borsh 单测的样例字节，需同步更新。
- `exportModeSnapshot`/`restoreModeSnapshot` API 保留（restore 仍是权威模式的应用入口）。
- opencode 本机可用（1.17.13），最终以真实 opencode 手动/脚本化验收一次。
