# 终端分屏视觉与交互退化排查结果

日期：2026-07-10

## 根因

三项现象共用一个根因：`e0811f9` 将终端组件从 `apps/fe/src/components/terminal/` 以 R100 迁移到 `packages/terminal-ui/src/`，但没有在 `apps/fe/src/index.css` 为 Tailwind v4 增加 `@source "../../../packages/terminal-ui/src"`。

当前 `index.css` 只扫描 `packages/ui/src` 与 `packages/panels/src`。因此 `@tmex/terminal-ui` 中 JSX 仍会渲染、pointer handler 与拖拽状态也仍会运行，但该包独有的 Tailwind utility CSS 不会进入产物。

## 三项症状对应关系

| 症状 | JSX／逻辑仍在 | 缺失的 utility CSS |
| --- | --- | --- |
| split handle 不可见 | `SplitTerminalArea.tsx` 的 gutter 与 `onPointerDown` | `w-px`、`bg-foreground/[0.08]`、部分 cursor／inset 工具未生成；视觉线退化为 0px／透明 |
| pane 标题栏背景消失 | 标题栏继续渲染 | `bg-foreground/10` 与 `bg-foreground/[0.04]` 未生成，计算背景透明 |
| pane 拖拽预览色块消失 | drop preview 元素和落点计算继续渲染 | `bg-primary/20`、`ring-primary/60` 未生成，预览区域无颜色／边框 |

## 证据

- `git show --find-renames e0811f9` 显示 `SplitTerminalArea.tsx` 仅迁移，`apps/fe/src/index.css` 未同步修改。
- `git blame apps/fe/src/index.css:3-4` 显示 UI、Panels 拆包时都各自补了 `@source`，terminal-ui 拆包没有对应条目。
- 当前构建 CSS 中，`bg-foreground/[0.08]`、`bg-foreground/10`、`bg-primary/20`、`ring-primary/60`、`cursor-row-resize` 均不存在；这些 class 的唯一源码归属为 `packages/terminal-ui/src/components/SplitTerminalArea.tsx`。`cursor-col-resize` 仅因 `packages/ui` 复用而偶然仍存在，不能说明 terminal-ui 已被扫描。
- 运行中开发页面仍有 2 个 titlebar 和 1 个 gutter DOM；titlebar 的 computed `background-color` 为透明，gutter 视觉线的 computed width 为 `0px` 且背景透明。

## 实施结果

已在 `apps/fe/src/index.css` 与现有两个 `@source` 并列添加 terminal-ui source 声明，并扩展 `apps/fe/tests/split-screen-desktop.spec.ts`：除 DOM 与 tmux resize 外，覆盖 titlebar 非透明背景、gutter 视觉线宽度和背景、标题栏拖拽时 drop preview 的非透明背景。

先在缺失 source 的状态下运行新增断言，titlebar background 为透明而失败；补齐 source 后同一桌面分屏 E2E 转绿。前端 `bun run build:fe` 成功，生成 CSS 137.36 kB。gutter 拖动时主线颜色进一步从不透明 primary 调为 `primary/60`，参考线从 `primary/70` 调为 `primary/45`，保留 hover 色阶。

本轮相关 E2E 汇总时还暴露了移动端堆叠布局的独立竞态，已按 `plan-02.md` 修复并以 10 次重复移动端 E2E 验证。远端单 pane resize 的一条偶发失败已记录在 `plan-03.md`，本提交不包含该问题的行为修改。

## 风险范围

这是包级 Tailwind 扫描遗漏；除三项已报现象外，`packages/terminal-ui` 内其他仅由该包引用的 utility class 也可能缺失。修复应以增加扫描范围为主，而不是逐个补内联样式。

Tailwind source discovery 是本轮三项原始视觉退化的直接修复；其他后续竞态均在各自计划中独立记录，避免混淆因果关系。
