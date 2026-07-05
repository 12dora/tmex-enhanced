# 鼠标事件补全结果（plan-01：Shift 豁免 / motion 去重 / 移动端触摸 / 1003 悬停 / 水平滚轮）

分支 `worktree-fix-tui-mouse-drag-bugs`（与 plan-00 的两个 bug 修复同分支连续交付）。计划见 `plan-01.md`。

## 交付内容

### A. Shift 豁免本地选择（`packages/ghostty-terminal/src/terminal.ts`）
- mousedown：上报模式下 `Shift+左键` 走本地选择分支，置 `mouseReportBypassed`；window move/up 判定加 `!mouseReportBypassed` 使整次拖拽会话稳定走选择，up 时复位。
- 悬停 motion 同样豁免 Shift（xterm 约定：Shift 按住时鼠标整体交还本地；真实 opencode 验收时发现 shift+hover 泄漏 code 39 事件后补上）。
- Shift+中/右键、Shift+滚轮不豁免。

### B. motion 同 cell 去重（`emitMouseInput`）
- `lastMotionCell` 锚（float cell 换算与编码器一致）：motion 同 cell 直接丢弃；press 记锚（press 后同 cell motion 不发）、release 清锚；`clearMouseTrackingModes` / `restoreModeSnapshot` 清锚。
- 1016（SGR-pixels）像素粒度语义，不去重。

### C. 1003 悬停 motion
- selectSurface mousemove 在 `GHOSTTY_MODE_ANY_MOUSE`（1003）开启且无 Shift 时发 button-less motion（SGR code 35），受 B 去重约束。

### D. 水平滚轮
- `GhosttyViewportGesture.deltaX`；`handleViewportGesture` 上报分支经 `gestureToColumns`（独立 `wheelPixelDeltaX` 累积器，deltaMode 0/1/2 与纵向同构）按列发按钮 6/7（SGR 66/67）。非上报模式 deltaX 不消费。

### E. 移动端触摸映射（`useMobileTouch.ts` 重写为状态机 + terminal 新 API）
- terminal 新 API：`isMouseReporting()`（折叠 disposed/disableStdin）、`sendTouchMouseEvent({action,clientX,clientY})`（左键、mods=0、不写 pressedMouseButtons/mouseDragActive、返回 false=模式已关）、`noteTouchHandled()`（touchend 起 500ms 合成鼠标抑制窗，mousedown/window mouseup 入口检查；不查 isTrusted 保证可测）。
- 状态机 `idle/bypass/scroll/pending/drag/wheel/select`：
  - 上报模式：tap→press+release（都用起点坐标，防 wobble 跨 cell）+ 显式 `focus()` 唤起软键盘 + touchend preventDefault（规范级抑制 compat mouse 序列，touchend 监听改 passive:false）；单指越阈（12px，与长按容差同一常量）→ press@起点 + motion 流（touchmove preventDefault）；双指→质心滚轮（触点数变化只重锚），走 `handleViewportGesture` 上报分支（64/65）；长按 500ms（press 未发）→ 本地 word 选择（移动端的"Shift 豁免"）；touchcancel 拖拽中补发 release（防 TUI 卡左键）；emit 返回 false → 静默中止手势。
  - 上报模式下滚动条 bypass 收窄为"直接命中滚动条元素"（右缘 36px 热区在 TUI 下是死区）；拖拽中 bypass 判定冻结。
  - 非上报模式行为与原先完全一致（滚动 + 长按选择）。
  - 顺带修复现存 bug：长按选择结束的 touchend 现在 preventDefault + noteTouchHandled，防合成 mousedown 命中上报/选择分支清掉刚建立的选区。
- editor 输入模式（disableStdin）下不启用触摸上报（`isMouseReporting` 已折叠）。

### 测试
- ghostty-terminal 单测 108（新增 11：Shift 豁免、同 cell 去重/1016 例外、1003 悬停/1002 对照/shift+hover、水平滚轮/非上报对照、sendTouchMouseEvent 三态/关闭态、noteTouchHandled 抑制、fractional cell 编码），TDD 红→绿。
- 新 e2e：
  - `terminal-mouse-gestures.spec.ts`：Shift+拖拽产生本地选区且 TUI 日志零 SGR（对照：无 Shift 点击照常上报）；`--all`（1003）TUI 收到 code 35 悬停 motion。
  - `mobile-mouse-reporting.spec.ts`（hasTouch 上下文 + 合成 TouchEvent + `multiTouch` 双指辅助）：tap→press+release 同 cell、单指拖→motion 流（press/release 恰一次）、双指竖划→wheel 64/65 且零 press/motion。
- `scripts/issue45-mouse-tui.py` 增加 `--all`（开 1003）。

## 验证

- 分包单测全绿：gateway 826 / fe src 138 / shared 91 / ghostty-terminal 108；fe `tsc --noEmit` 干净；biome 无新增错误。
- e2e：新 spec 5 个用例全过；桌面回归（mouse 三件套 + render-regressions + split-screen-desktop）两轮套跑各有 1-2 个 render/切窗类用例偶发失败（**单跑均过、两轮失败项不同、main 亦有此类记录**，属既有套跑 flaky）；`mobile-terminal-interactions.spec.ts` 中 4 个用例失败为**预存失败**（main 主仓同样 4 failed，等待 `editor-shortcut-ctrl-c` 元素超时，与本次无关），其长按选择用例在新代码下通过。
- 真实 opencode 验收（dev 实例 19663/19883 + chromium dpr=2，onData 探针）：
  - 1003 悬停划过 → 13 个 code 35 motion ✓
  - 原地小幅抖动 → 0 事件（同 cell 去重）✓
  - Shift+拖拽 → 0 个 SGR 事件 + `hasSelection()=true` ✓
  - 横向滚轮 → 7 个 66/67 事件 ✓

## 注意事项 / 边界

- 项目 8（分屏边框拖拽 resize）确认已存在（`split-gutter`），未做改动。
- 移动端 editor 输入模式下触摸不上报（与 stdin 禁用一致）；双指滚轮在 1002-only TUI 下由 `handleViewportGesture` 上报分支自然工作。
- 合成鼠标抑制主机制是 touchend preventDefault（规范保证），500ms 时间窗为兜底；iPadOS 外接鼠标在触摸后 500ms 内的真实点击可能被误吞（可接受）。
- `mobile-terminal-interactions.spec.ts` 的 4 个预存失败与 render 系列套跑 flaky 值得另行治理，不在本次范围。
