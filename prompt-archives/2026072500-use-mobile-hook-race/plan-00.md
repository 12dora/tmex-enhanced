# use-mobile hook 竞态修复

## 背景与根因

`packages/ui/src/hooks/use-mobile.ts` 的 `useIsMobile()` 存在三个叠加缺陷，导致
移动端有概率被永久误判为桌面端（症状：左上角渲染 `PanelLeftIcon` 而非 `Menu`，
且侧栏本体由 CSS `md:` 独立判定被隐藏，按钮点击无响应）：

1. `matchMedia` change 回调里读 `window.innerWidth` 而非 `event.matches`。移动
   浏览器/WebView 加载期 layout viewport 从桌面宽度收敛到 device-width 时，change
   派发瞬间 `innerWidth` 可能仍是旧值；一次错读后 MQL 已处于 `matches: true` 不再
   翻转，没有第二次事件纠正，状态永久卡在桌面。
2. 初始值 `undefined` 经 `!!` 变 `false`，首帧必按桌面渲染，真实测量迟至 mount
   effect。
3. 无 resize/orientationchange 兜底通道。

另有口径分裂：JS 硬编码 768px，CSS 走 Tailwind v4 `md`（48rem），用户调大默认
字号时两者错位。

## 方案

hook 收敛为单一真源 `window.matchMedia('(min-width: 48rem)')`（与 Tailwind `md:`
完全同口径），惰性初始化同步取 `matches`（首帧即正确），change 回调只信
`event.matches`。SSR 环境（无 window）回退 false。

## 验证

- `bun test` 相关包全绿；
- tmex fe：worktree 起 dev server，Playwright 移动视口断言汉堡按钮、桌面视口断言
  PanelLeftIcon、视口跨断点切换后图标跟随；复跑既有 mobile e2e spec；
- 消费同一组件的下游 webapp 以相同断言实测。
