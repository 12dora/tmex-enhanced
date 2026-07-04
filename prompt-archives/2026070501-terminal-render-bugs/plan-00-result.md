# 终端渲染三连 bug 修复结果

## 报告的三个 bug

1. 冷启动 webapp 直落具体单 pane 窗口，终端只显示空白；
2. 切换到单 pane 窗口后，claude code 等 inline TUI 错位一行；
3. claude code TUI 超长选择界面（如 /theme）切换选项时整页更新错位。

## 根因（三者同根）

`apps/fe/src/components/terminal/Terminal.tsx` 的 `onOutput` 中存在 xterm.js 时代遗留的
`keepShortHistoryVisible` 逻辑：history 应用后首条 live 输出到达时，若 `baseY <= 1`
调用 `instance.scrollToTop()`。在 ghostty-terminal 中该调用把 WASM 视口从"跟随底部"
切成固定在 scrollback 顶部；之后 buffer 一旦增长（TUI 重绘触底滚动、任何滚动输出），
前端视口便与 tmux 视口永久错开 `total - len` 行：

- **bug1 空白**：claude code 启动清屏后 capture 的 scrollback 恰好 ≤1 行，pin 顶部后
  TUI 的所有更新都发生在视口之外，画面永不更新（视口区域是空行/旧内容）；
- **bug2 错位一行**：`baseY == 1` 时 pin，恒差 1 行；
- **bug3 /theme 错位**：长列表整页重绘撑大 buffer，偏移每帧扩大。

**为什么近期爆发**：0.16.3 引入主题传播（c798142 / 914e976，OSC / mode 2031 stdin 注入），
select 后立即产生一条 live 输出，命中"history 刚应用完的首条输出"窗口的概率大增。

短历史贴顶显示并不需要该 hack：内容不足一屏时 `baseY = 0`，顶部即底部，天然贴顶。

## 修复

删除 `keepShortHistoryVisibleRef` 及 `scrollToTop()` 调用（净删 9 行）。
commit：`cbd421c fix(terminal): remove scrollToTop hack that pinned viewport off-bottom`

## 验证

新增 e2e `apps/fe/tests/terminal-render-regressions.spec.ts`，强断言为
**前端终端视口逐行文本 == tmux capture-pane 视口**（可同时抓空白与任意错位）：

- bug1：深链接冷启动（`/devices/:id/windows/:wid/panes/:pid`），断言已有内容出现、
  像素级非空白（截图众数色比例）、屏幕与 tmux 一致；
- bug2：window B 与视口同尺寸 + 满屏 inline TUI（`TUI_START` + rows 行块 = 1 行
  scrollback），切窗后驱动一帧重绘，断言逐行一致——未修复代码下呈现**整屏空白**
  （即用户 bug1 形态），稳定失败；
- bug3：整视口高度 TUI + 外部 resize 序列驱动 WINCH 重绘——未修复代码下底部
  3 行错失，稳定失败；
- bug3b：stdin 驱动整视口重绘（无 resize 变量），验证纯重绘路径。

回归：single-pane-window-switch-resize、terminal-viewport-render、ws-borsh-history/
pane-route/switch-barrier/resize、terminal-ui 共 14 个用例全过（split-content-persistence
为条件 skip，与本改动无关）；`tsc --noEmit` 过；terminal 相关单测 21 过；biome 过。

## 注意事项

- inline TUI 模拟器（测试内嵌 sh 脚本）：不进 alt-screen、块尾不换行、
  `CSI (N-1)F` 回块顶重绘，WINCH 与 stdin 双驱动，可复用于后续终端对齐类测试。
- 读取前端屏幕用 `__tmexE2eXterm.buffer.active`（`getLine` 基于当前视口渲染行），
  光标用 `term.lastCursor`（ghostty 无 `buffer.cursorY`）。
