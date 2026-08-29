# f-motion-foundation 执行结果

任务：为 tmex 前端补一套零依赖的共享动效基础（motion foundation），并把既有共享 primitive 的时长/缓动统一、补齐 reduced-motion 支持。

## 一、新增文件

### `packages/theme/src/motion.css`
纯 CSS 动效基础，已在 `packages/theme/package.json` 的 `exports` 中加上 `"./motion.css": "./src/motion.css"`，
并在 `apps/fe/src/index.css` 的 theme 导入区追加 `@import "../../../packages/theme/src/motion.css";`（紧跟 `themes.css` 之后）。

**时长 token（`:root`）**

| token | 值 | 用途 |
| --- | --- | --- |
| `--tmex-motion-fast` | `100ms` | 控件级即时反馈（button/switch/input/badge 配色、按下缩放） |
| `--tmex-motion-standard` | `150ms` | 弹层进出场、tab 切换、进度条、hover 显隐 |
| `--tmex-motion-layout` | `200ms` | 布局尺度位移（sheet、sidebar 宽度） |
| `--tmex-motion-slow` | `300ms` | 预留，暂无消费方 |

**缓动 token**

- `--tmex-ease-out: cubic-bezier(0.22, 1, 0.36, 1)`（ease-out-quart）
- `--tmex-ease-in: cubic-bezier(0.55, 0, 1, 0.45)`
- `--tmex-ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)`

**stagger token**：`--tmex-stagger-step: 35ms`、`--tmex-stagger-index: 0`

**keyframes**：`tmex-fade-in`、`tmex-fade-up`（opacity 0→1 + translateY(6px)→0）、`tmex-scale-in`（0.97→1）

**工具类**

| class | 效果 |
| --- | --- |
| `.tmex-reveal` | `tmex-fade-up`，standard 时长，`animation-fill-mode: both` |
| `.tmex-fade` | `tmex-fade-in`，standard 时长，`both` |
| `.tmex-scale-in` | `tmex-scale-in`，standard 时长，`both` |
| `.tmex-stagger > *` | 直接子元素套 `tmex-fade-up`，`animation-delay = var(--tmex-stagger-index, 0) * 35ms` |

> `.tmex-stagger > *` 自带动画，容器加上类、子项带 index 即可出逐项入场效果，无需再叠 `.tmex-reveal`。
> 延迟无上限，列表过长会明显拖尾，**由调用方控制条目数量**（建议 ≤ 12 项）。

**全局 reduced-motion 兜底**

```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

该规则是 **unlayered CSS**，优先级高于 Tailwind 的 `@layer utilities`，且带 `!important`，
即使组件上的 `motion-reduce:` 变体没覆盖到也能兜住。

### `packages/ui/src/components/motion.tsx`

导入路径：`import { ... } from '@tmex/ui/motion'`（走 `"./*": "./src/components/*.tsx"` 子路径，无需改 `index.ts`）。

导出 API：

```ts
// 与 motion.css 的 token 一一对应，单位 ms
export const motionDurations = { fast: 100, standard: 150, layout: 200, slow: 300 } as const;
export type MotionDurationName = keyof typeof motionDurations;

export const revealClassName  = 'tmex-reveal';
export const fadeClassName    = 'tmex-fade';
export const scaleInClassName = 'tmex-scale-in';
export const staggerClassName = 'tmex-stagger';

export function staggerItemStyle(index: number): React.CSSProperties;   // { '--tmex-stagger-index': max(0, index) }
export function revealDelayStyle(delayMs?: number): React.CSSProperties | undefined; // { animationDelay: 'Nms' }

export type RevealProps = React.ComponentProps<'div'> & { as?: React.ElementType; delayMs?: number };
export function Reveal(props: RevealProps);   // 默认 <div>，带 data-slot="reveal" + .tmex-reveal，透传 className/children/其余 div props

export type StaggerProps = React.ComponentProps<'div'> & { as?: React.ElementType; startIndex?: number };
export function Stagger(props: StaggerProps); // 默认 <div>，带 data-slot="stagger" + .tmex-stagger

export function useReducedMotion(): boolean;  // matchMedia，SSR 安全（首帧 false，effect 内订阅 change）
```

**`<Stagger>` 实现细节（调用方需知）**：用 `React.Children.map` 给每个子节点**外套一层 `<div data-slot="stagger-item">`**
承载 `--tmex-stagger-index`（不用 `cloneElement`，避免依赖子节点接受 `style`）。
副作用是**包装 div 会成为容器的 flex/grid item**——若容器是 flex/grid 且依赖子项直接参与布局，请改用
`staggerItemStyle(i)` 手动挂在自己的元素上，而不是用 `<Stagger>`。

`null` / `undefined` / `false` 子节点原样透传，不会被包装。

### `packages/ui/src/components/motion.test.ts`

`packages/ui` **没有 DOM 测试环境**（既有 3 个测试文件全是纯函数：`utils.test.ts`、`sidebar/storage.test.ts`、`sidebar/width.test.ts`），
因此按要求只对纯函数/常量做测试：`motionDurations` 数值、四个 class 名、`staggerItemStyle`（含负数收敛）、`revealDelayStyle`（含 undefined / 负数）。
新增 7 个 test case。组件渲染行为未测。

## 二、primitive 归一化

统一口径：**弹层 150ms（standard）/ 布局位移 200ms（layout）/ 控件反馈 100ms（fast）**，缓动一律 `ease-out`（替换掉所有 `ease-linear`），
时长全部改用 `duration-(--tmex-motion-*)` 消费 token（不再写死数字）。

| 文件 | 改动 |
| --- | --- |
| `dialog.tsx` | overlay + content：`duration-100` → `duration-(--tmex-motion-standard) ease-out motion-reduce:animate-none` |
| `alert-dialog.tsx` | 同上（overlay + content） |
| `sheet.tsx` | overlay + content 改 `duration-(--tmex-motion-layout) ease-out`；content 的 `ease-in-out` → `ease-out`；补 `motion-reduce:animate-none` / `motion-reduce:transition-none` |
| `tooltip.tsx` | 原本**没有** duration（吃 tailwindcss-animate 默认 150ms），显式补 `duration-(--tmex-motion-standard) ease-out motion-reduce:animate-none` |
| `dropdown-menu.tsx` | Content + SubContent：`duration-100` → standard token + `ease-out` + `motion-reduce:animate-none` |
| `context-menu.tsx` | Content 同上 |
| `select.tsx` | Content 同上；Trigger 的 `transition-colors` 补 fast token + `ease-out` + `motion-reduce:transition-none` |
| `tabs.tsx` | TabsTrigger：`transition-all` → `transition-[color,background-color,border-color,box-shadow]` + standard token + `ease-out`；`after:transition-opacity` 补 `after:duration-(--tmex-motion-standard) after:ease-out`；`pillTabTriggerClassName` 的 `duration-200` → standard token；**TabsContent 新增入场淡入**（见下） |
| `button.tsx` | `transition-all` → `transition-[color,background-color,border-color,box-shadow,scale,transform]` + fast token + `ease-out`；新增 `active:scale-[0.98]` 按下反馈 + `motion-reduce:active:scale-100` + `motion-reduce:transition-none` |
| `collapsible.tsx` | CollapsibleContent 从「无任何样式」改为高度+透明度过渡（见下） |
| `skeleton.tsx` | `animate-pulse` 补 `motion-reduce:animate-none` |
| `progress.tsx` | `duration-150` → standard token + `ease-out` + `motion-reduce:transition-none` |
| `switch.tsx` | Root：`transition-all` → `transition-[background-color,border-color,box-shadow]` + fast token；Thumb：`transition-transform` 补 fast token + `ease-out`；均补 `motion-reduce:transition-none` |
| `badge.tsx` | `transition-all` → `transition-[color,background-color,border-color,box-shadow]` + fast token + `ease-out` |
| `input.tsx` / `textarea.tsx` | `transition-colors` 补 fast token + `ease-out` + `motion-reduce:transition-none` |
| `scroll-area.tsx` | `transition-[color,box-shadow]` 与滚动条 `transition-colors` 补 fast token |
| `sidebar/sidebar-layout.tsx` | sidebar-gap `transition-[width]` 与 sidebar-container `transition-[left,right,width]`：`duration-200 ease-linear` → `duration-(--tmex-motion-layout) ease-out motion-reduce:transition-none`；SidebarRail 的 `transition-all ease-linear` → standard token + `ease-out` |
| `sidebar/sidebar-menu.tsx` | **bug 修复**：SidebarMenuAction 的 hover 显隐声明的是 `transition-transform`，实际变的是 `opacity` → 改为 `transition-opacity duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none`；`sidebarMenuButtonVariants` 的 `transition-[width,height,padding]` 补 layout token + `ease-out` |
| `sidebar/sidebar-primitives.tsx` | SidebarGroupLabel `duration-200 ease-linear` → layout token + `ease-out`；**同类 bug**：SidebarGroupAction 声明 `transition-transform` 但 hover 只变配色 → 改 `transition-colors` + fast token |

### TabsContent 入场淡入（已验证可行）

在 `node_modules/@base-ui/react/tabs/panel/TabsPanel.js` 中确认 `Tabs.Panel` 的 state 经
`transitionStatusMapping` 映射，进场时会挂 `data-starting-style`（退场 `data-ending-style`）。故新增：

```
transition-opacity duration-(--tmex-motion-standard) ease-out data-starting-style:opacity-0 motion-reduce:transition-none
```

关闭方向刻意不加过渡：`useOpenChangeComplete` 靠 `getAnimations()` 判断收尾，退场无属性变化会立刻 resolve，
不会拖慢 panel 卸载。

### CollapsibleContent 高度动画（已验证可行）

在 `node_modules/@base-ui/react/collapsible/panel/` 中确认：
`CollapsiblePanel` 会**内联** `--collapsible-panel-height` / `--collapsible-panel-width`（展开静止态为 `auto`），
且 `collapsibleStateAttributesMapping` 会输出 `data-open` / `data-closed` + `data-starting-style` / `data-ending-style`。
因此按 Base UI 官方推荐的 transition 写法实现了**高度 + 透明度**动画：

```
h-(--collapsible-panel-height) overflow-hidden
transition-[height,opacity] duration-(--tmex-motion-standard) ease-out
data-starting-style:h-0 data-starting-style:opacity-0
data-ending-style:h-0   data-ending-style:opacity-0
motion-reduce:transition-none
```

`CollapsibleContent` 因此新增了 `className` 解构 + `cn()`（原来是纯透传），并 import 了 `../utils`。

**调用方注意**：新增的 `overflow-hidden` 会裁剪展开态内溢出的内容（如贴边的 focus ring）。
现有 4 处消费方（`packages/panels/src/agent/messages/{reasoning-block,tool-call-card}.tsx`、
`apps/fe/src/components/page-layouts/components/{nav-main,sidebar-agent-sessions}.tsx`）都是纵向列表，
且内部下拉菜单走 portal，不受影响。

## 三、验证

**关键验证：用真实的 `apps/fe/src/index.css` 跑了一次 Tailwind v4 编译**（`@tailwindcss/cli@4.1.18`，输出到 scratchpad，未写入仓库），
逐条确认新语法真的能编译出来，而不是靠猜：

- `duration-(--tmex-motion-*)` 同时产出 `transition-duration` 和（经 tailwindcss-animate）`animation-duration` ✓
- `ease-out` 同时产出 `transition-timing-function` 和 `animation-timing-function` ✓
- `motion-reduce:animate-none`（第 4230 行）排在 `data-open:animate-in`（第 3626 行）**之后** → reduced-motion 下能压过 ✓
- `motion-reduce:transition-none`（4235）晚于所有 `transition-property` 声明 ✓
- `motion-reduce:active:scale-100`、`active:scale-[0.98]`（产出 `scale: 0.98`，v4 用 `scale` 属性而非 `transform`，故用 `scale-100` 而非 `transform-none` 复位）✓
- `h-(--collapsible-panel-height)`、`data-starting-style:h-0`、`data-ending-style:h-0`、`transition-[height,opacity]`、`after:duration-(--tmex-motion-standard)` 均正常编译 ✓
- `motion.css` 的 token、3 组 keyframes、`.tmex-reveal` / `.tmex-fade` / `.tmex-scale-in` / `.tmex-stagger > *` 及全局 reduced-motion 块均出现在产物中 ✓

| 检查项 | 基线 | 结果 |
| --- | --- | --- |
| `packages/ui` → `bun test` | 16 pass / 0 fail | **23 pass / 0 fail**（新增 7 个） |
| `packages/ui` → `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `packages/theme` → `bun test`（package.json 仅有 `test` 脚本，无 build） | — | **52 pass / 0 fail** |
| `apps/fe` → `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `bunx biome check <改动文件>` | — | 见下 |

未跑 fe e2e（按要求）。未跑 `vite build`（按要求）。

### biome 说明

`bunx biome check` 对本次改动的文件报 29 个 error，**全部是仓库既有问题，不是本次引入**：
这一批 shadcn 派生的 primitive 用的是「双引号 + 无分号」风格，而 biome 配置要求「单引号 + 分号」，
另有 `import * as React` 的 `useImportType` 提示。已用**未改动的同族文件** `card.tsx` / `separator.tsx` 做对照，
它们同样报 format + `useImportType` error，证明是历史状态。
`apps/fe/src/index.css` 的 `noInvalidPositionAtImportRule` 同理（Tailwind v4 的 `@source`/`@plugin` 夹在 `@import` 之间，
既有 4 处，本次新增的 import 紧贴既有 import，未新增违规位置——报错行号 11/12/14/15/214 里 15 是新增行，但 11/12/14 本就在报）。

因此**没有对这些文件跑 `--write`**：全量格式化会产生与本次任务无关的巨大 diff，且本 worktree 有其他 agent 并行改动，
风险不对等。**仅对我自己新建的 `motion.tsx` 跑了 `biome check --write`**，
现在 `motion.css` / `motion.tsx` / `motion.test.ts` 三个新文件 biome 全绿。

## 四、未能验证 / 遗留

1. **没有做真实浏览器视觉验收**：所有动效结论来自 Tailwind 编译产物 + Base UI 源码，未起 dev server 截图确认观感。
   尤其 `active:scale-[0.98]`（按钮按下缩放）和 CollapsibleContent 高度动画建议人工过一眼。
2. **`--tmex-motion-slow` (300ms) 目前没有消费方**，属预留 token。
3. **`.tmex-stagger` 无延迟上限**：第 N 项延迟 `N * 35ms`，列表长了会明显拖尾，只能靠调用方自律控制条目数。
4. **`<Stagger>` 的包装 div 会改变 flex/grid 布局语义**（见上文），feature 代码在 flex 容器里用需要注意。
5. **`SidebarRail` 仍保留 `transition-all`**：它真正的视觉变化在 `::after` 伪元素上，父元素的 `transition-all` 本来就覆盖不到；
   本次只统一了时长/缓动，没有改这个既有的失效声明（超出本任务范围）。
6. **`tw-animate-css` 依然是装了但没用**，本次未动；动画仍全部走 `tailwindcss-animate`。
7. **CollapsibleContent 的 `overflow-hidden` 是行为变更**（原来完全无样式），若某个消费方依赖内容溢出可见会受影响，
   已排查 4 处消费方均无此依赖，但没有运行时验证。

## 五、给其他 agent 的采用速查

```tsx
import { Reveal, Stagger, useReducedMotion, motionDurations, staggerItemStyle } from '@tmex/ui/motion';

// 单块内容入场
<Reveal className="...">…</Reveal>
<Reveal delayMs={80}>…</Reveal>          // 延后 80ms
<Reveal as="section">…</Reveal>

// 列表逐项入场（注意会给每个子项外套一层 div）
<Stagger className="flex flex-col gap-2">
  {items.map((it) => <Row key={it.id} {...it} />)}
</Stagger>

// 不想被包装时，自己挂 index
{items.map((it, i) => <Row key={it.id} style={staggerItemStyle(i)} className="tmex-reveal" />)}

// 需要在 JS 里分支时
const reduced = useReducedMotion();
```

裸 class 也可直接用：`tmex-reveal` / `tmex-fade` / `tmex-scale-in` / `tmex-stagger`。

Tailwind 侧写动效时**统一用 token，不要再写死数字**：

```
duration-(--tmex-motion-fast)      /* 100ms，控件反馈 */
duration-(--tmex-motion-standard)  /* 150ms，弹层/切换 */
duration-(--tmex-motion-layout)    /* 200ms，布局位移 */
ease-out
motion-reduce:transition-none      /* transition 场景 */
motion-reduce:animate-none         /* animate-in/out 场景 */
```
