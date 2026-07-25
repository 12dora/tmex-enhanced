# 执行结果：use-mobile hook 竞态修复

分支 `vibex/use-mobile-hook-race`，改动：

- `packages/ui/src/hooks/use-mobile.ts`：媒体查询统一为 `(min-width: 48rem)`（与
  Tailwind v4 `md` 同口径），惰性初始化同步取 `matches`（无 window 时回退 false），
  change 回调只读 `event.matches`；移除 `innerWidth` 读数与首帧 `undefined→false`
  桌面默认。
- `apps/fe/tests/mobile-nav.spec.ts`：补移动视口下触发器必须为汉堡形态
  （`svg.lucide-menu`）的回归断言。

## 验证

- fe e2e：`mobile-nav.spec.ts`（含新断言）+ `mobile-sidebar-safe-area.spec.ts`
  全绿（run-e2e 自起 gateway+vite）。
- 跨断点动态切换（临时 spec，验后即删）：1280→390→1280 视口切换，触发器
  PanelLeft ↔ Menu 正确跟随，全绿。
- 消费同一 `@tmex/ui` 的下游 webapp（独立 vite + 真实登录会话，iPhone UA +
  390×844 首屏）：首屏即汉堡形态、点击可开抽屉、跨断点切换正确、回移动端
  恢复汉堡，PASS。

竞态本身（change 派发瞬间 innerWidth 陈旧）无法在 Playwright 稳定复现，按根因
消除处理：判定唯一信源改为 matchMedia 的 matches，读数路径不复存在。
