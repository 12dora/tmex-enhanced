# alt-screen TUI 鼠标两 bug 修复结果

分支 `worktree-fix-tui-mouse-drag-bugs`。计划见 `plan-00.md`。

## bug1：鼠标行号偏一行 ✅

**根因**：`emitMouseInput`（`packages/ghostty-terminal/src/terminal.ts`）把 CSS cell
尺寸 `Math.round()` 成整数后再传给 SGR 编码器。CSS cell 按物理像素网格对齐
（`round(raw*dpr)/dpr`），Retina（dpr=2）+ 默认字号（13×1.2=15.6）下 cell 高为
**15.5**，取整成 16 后 `floor(y/16)+1` 从视觉第 ~16 行起行号比渲染网格少 1。
渲染（整数设备像素）与文本选择 `hitTest`（float cell）都在 15.5 基准上，唯独鼠标
上报漂移——单 pane 与分屏同一机制（坐标本就是 pane-local，`send-keys -H -t pane`
直达）。**issue45 时期未复现的原因**：Playwright 默认 dpr=1（cell 恰为整数 16）
且只点了 row 0/5/10（偏差交点在 ~15.5 行之后），双重错过。

**修复**：cell 尺寸不取整、按 float 传给编码器（编码器是纯 JS 数学，本就支持）。

## bug2：切窗/刷新后只能点击不能拖拽 ✅

**根因链**：
1. tmux control mode 的 `%output` 原样转发 pane 字节流，TUI 启动瞬间的
   `\x1b[?1002h`/`\x1b[?1003h` 实时进前端 WASM → 刷新前拖拽正常；
2. 切窗/刷新走 `capture-pane -e` 重建，快照只含 SGR 颜色、**不含 DECSET**；
3. gateway 从不查询 tmux 的 `mouse_*_flag` 格式变量（真实模式的唯一权威来源）；
4. 前端 `reconcileRecoveredModes` 只能猜：sessionStorage 缓存 + alt 屏 fallback
   **硬编码 1000+1006（永不 1002/1003）**；且缓存被 mount 时序污染（新实例全
   false 先 persist 覆盖旧值）；
5. WASM 编码器门控：1002/1003 未开 → motion 事件全部丢弃 → 只剩点击。

**实测 opencode 用的是 1003（`mouse_all_flag`）+1006**，旧 fallback 连 1000 场景
都覆盖不了它。注意 tmux 的 `mouse_any_flag` 是"任意鼠标模式开启"的聚合标志，
**1003 对应的是 `mouse_all_flag`**，实测确认（tmux 3.7b）。

**修复**（权威模式下发，删除猜测路径）：
- `capture-history.ts`：`PANE_SCREEN_INFO_FORMAT` 增查
  `mouse_standard/button/all/sgr/utf8_flag`，`PaneScreenInfo.modes`；
- shared 新增 `ws-borsh/pane-modes.ts`（u8 位图 + encode/decode），
  `TermHistorySchema` 增加 `modes: b.u8()`；
- gateway：`fetchPaneHistory` 返回 modes；`onTerminalHistory` 回调链、
  `broadcastTerminalHistory`（select barrier 路径）与 `handleFetchPaneHistory`
  （点对点路径）都下发 modes；local/SSH 两个 connection 同步；
- fe：`HistoryEvent`/`PaneSink.onApplyHistory`/`dispatchPane*` 透传 modes；
  `Terminal.tsx` 用 `terminalModesFromHistory` 直接 restore 权威模式，
  **删除** sessionStorage 模式缓存、`reconcileRecoveredModes`、
  `createAlternateScreenFallbackSnapshot`、`persistTerminalModes` 全链。

## 验证

- 单测（全绿）：ghostty-terminal 97（含新增取整复现测试，修复前红）、
  gateway 826（capture 解析/connection 回调断言 modes）、shared 91（位图往返）、
  fe src 138；`tsc --noEmit` 与 main 基线一致（29 个预存错误，无新增）。
- 新 e2e（全绿，且做过红验证——模拟旧 fallback 时 fail）：
  - `terminal-mouse-drag-recovery.spec.ts`：1002 拖拽 motion 在刷新后、跨 window
    往返后仍到达 TUI（断言 TUI 实际收到的 SGR 字节流）；
  - `terminal-mouse-row-alignment.spec.ts`：dpr=2 下下半屏 press 行号与渲染网格
    一致（动态计算取整必错的行）。
- 既有 e2e 回归：mouse-recovery / ws-borsh-history / ws-borsh-pane-route /
  render-regressions / split 系列 / switch-barrier / single-pane-window-switch
  全过（render-regressions bug4 套跑偶发 flaky，单跑+全套连跑两轮绿，属既有）。
- 真实 opencode 验收（chromium dpr=2）：tmux flags `all=1 sgr=1` → 前端 snapshot
  `mouseAny=true mouseSgr=true`；刷新后不变；刷新后拖拽 onData 发出 6 个 motion
  （修复前为 0）；渲染截图正常。

## 注意事项 / 已知边界

- **borsh schema 变更**：`TermHistorySchema` 加字段，fe/gateway 必须同版本部署
  （同仓同发满足）；旧前端 bundle + 新 gateway 会解码错位。
- 前端对 **1003 的裸悬停 motion**（无按钮 hover tracking）仍不上报：
  `terminal.ts` 的 window mousemove 只在按住（`mouseDragActive`）时 emit。拖拽
  不受影响；hover 高亮类交互是既有 gap，不在本次范围。
- 1016（SGR-pixels）/1015/9 无 tmux format 变量，tmux 下 pane 也拿不到像素坐标，
  恢复时恒 false；1007（altScroll）无 format 变量，alt 屏按惯例开启。
- e2e 调试教训：gateway 日志的 "control client stdout ended unexpectedly ...
  can't find session" 出现在测试 finally（kill-session）之后，是**清理噪声**，
  不代表连接中途断开——排障时先对时序再下结论。
- python 诊断 TUI（`scripts/issue45-mouse-tui.py`，新增 `--alt`）不响应 WINCH
  重绘，e2e 里必须 `new-session -x 120 -y 45` 给足行数，否则 80x24 只剩尾部
  24 行锚点可见。
