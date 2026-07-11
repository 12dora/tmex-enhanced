# 终端分屏 Tailwind 扫描修复结果

日期：2026-07-10

## 已实施

- 在 `apps/fe/src/index.css` 增加 `@source "../../../packages/terminal-ui/src"`。
- 扩展 `apps/fe/tests/split-screen-desktop.spec.ts`，通过 computed style 验证 active／inactive 标题栏、gutter 命中与视觉线、标题栏拖拽 drop preview；断言不只检查 DOM 存在。
- 按用户反馈降低 gutter 按下拖动时的强调度：主拖拽线为 `bg-primary/60`，参考线为 `bg-primary/45`；非拖拽时保留既有 hover 色阶。

## 验证证据

1. 新视觉断言先在未声明 terminal-ui source 的版本失败，titlebar 的 computed background 为透明。
2. 增加 source 后，`bun run --filter @tmex/fe test:e2e -- split-screen-desktop.spec.ts` 通过。
3. `bun run build:fe` 通过（CSS 137.36 kB），证明修复进入生产构建产物，而非只在开发态生效。

## 结论

修复恢复的是包迁移时漏掉的 Tailwind source discovery；未修改 SplitTerminalArea 的拖拽几何、z-index 或 pointer 事件语义。以后新增含 Tailwind utility 的 workspace package 时，前端入口必须同步声明该包的 `@source`。
