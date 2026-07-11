# 终端分屏 Tailwind 扫描修复计划

日期：2026-07-10

## 背景

已确认 `packages/terminal-ui/src` 未被 Tailwind v4 扫描，导致 `SplitTerminalArea` 的 gutter、标题栏背景和 pane 拖拽预览所需 utility CSS 未进入前端产物。DOM 与交互状态机完整，修复应恢复包级 source discovery，不能逐项补内联样式。

## 实施步骤

1. 在 `apps/fe/tests/split-screen-desktop.spec.ts` 先增加视觉回归断言：active／inactive 标题栏背景非透明、gutter 命中区域和视觉线宽度／背景存在、标题栏拖拽时 preview 的尺寸和背景非透明；取消拖拽用 `pointercancel`，不提交 tmux move-pane。
2. 在当前代码上运行该 E2E，确认它因缺失 CSS 而失败，而不是因 DOM、tmux 或测试同步错误。
3. 只在 `apps/fe/src/index.css` 新增 `@source "../../../packages/terminal-ui/src"`，不调整 `SplitTerminalArea` JSX、z-index 或 pointer handler。
4. 重跑同一 E2E 确认转绿；再跑相关 split／terminal E2E、类型检查和前端构建，并在常驻开发服务核验截图。
5. 在 `plan-01-result.md` 与架构记录中写入修复、测试证据和包迁移守则。

## 验收标准

- 三项视觉／命中退化均恢复，且现有 gutter resize 和 split-down 行为继续通过。
- 构建 CSS 含 terminal-ui 专属 class，避免只在开发模式偶然可用。
- 回归测试覆盖 computed style 与拖拽 preview，而非仅检查测试 ID 存在。
