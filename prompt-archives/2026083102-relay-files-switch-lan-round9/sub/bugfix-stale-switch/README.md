# 1.1.4 线上 bug：切换终端 tab 后右侧仍显示旧终端

现象：左侧点另一个终端，title 正常更新（title 与终端槽同样由路由驱动），但终端区域仍是旧 pane；刷新页面恢复。1.1.3 无此问题。

根因：保活槽用 `visibility: hidden; pointer-events: none` 隐藏非路由实例，但每个终端的 ghostty mount 在 `activateRenderTarget()`（`packages/terminal-ui/src/components/hooks/terminal-render-target.ts:69`）里显式写 `style.visibility = 'visible'`——CSS 允许后代用显式 visible 反选祖先的 hidden。于是「隐藏」实例实际完全可见，且槽按 MRU 排序（路由 pane 恒为第一个兄弟 = 画在最底层），旧 pane 整个盖在新 pane 上面。pointer-events 同理被 mount 的显式值反选。

修复：`KeepAlivePaneSlot` 改用 `opacity: 0`（合成阶段生效，后代无法反选）+ `z-index`（可见槽恒在最上层，顺带保证命中测试）。另加 `KEEP_ALIVE_ENABLED` 应急开关（terminal-keep-alive.ts，置 false 即回到 1.1.4 之前的单实例行为）。

复现/验证：`repro-stale-switch.ts`（沿用 measure-switch 的基础设施；随机点击侧栏 200 轮，断言 ①可见槽=路由 pane ②终端区域正中 elementFromPoint 命中的槽=路由 pane ③可见 buffer 只含路由 pane 的标记）。

| 构建 | iterations | mismatches |
|---|---|---|
| 修复前（1.1.4 同源） | 120 | **31**（topmost 命中隐藏槽） |
| 修复后 | 200 | **0** |

```
GATEWAY_SRC_DIR=<worktree> FE_DIST_DIR=<dist> ITERATIONS=200 bun repro-stale-switch.ts
```
