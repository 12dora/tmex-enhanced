# OP1 — 前端复查 1 / 2 / 3 / 11 修复（弹层懒加载的交接、兜底与吐司排队）

工作区：`/Users/konata/code/tmex-r22`（分支 `feat/round22-perf-tui-color-smell`）
范围：`packages/ui/src/**` + `apps/fe/src/main.tsx`（仅 Toaster 挂载点）。未碰他人文件。

---

## 1（MED）触发器替换：焦点丢失 / hover 丢失 / 缺 ARIA

**先说结论：「保持同一个 DOM 节点」做不到。** React 在同一位置上元素类型从 `OverlayTrigger`
换成实现侧 `DialogTrigger` 时必然卸载重建宿主节点，没有 reparent API；用 `render={<button ref/>}`
也只是让 base-ui 克隆出一个新元素，仍在新的 fiber 位置。所以按任务给的次选路线做，并把
「为什么做不到」写进了 `lazy-overlay.tsx` 的注释与 `planTriggerHandoff` 的文档。

落地（`packages/ui/src/lazy-overlay.tsx`）：

- 新增 `useTriggerHandoff(id?)`：挂在**公开面触发器组件**上（它跨替换不卸载），持有
  - 稳定 id：占位与实现共用同一个（`props.id ?? useId()`），替换前后辅助技术看到同一个触发器；
  - 交互记账 `record({focused|hovered})`：占位的 `onFocus/onBlur/onPointerEnter/onPointerLeave` 写入
    （节点被移除时浏览器不派发 blur / pointerleave，所以标记会保持替换前的状态）；
  - `adopt(node)`：作为 ref 传给实现侧触发器，在 **ref 回调（layout 阶段）** 里判断并补。
- 纯函数 `planTriggerHandoff(activity, env)`：
  - 焦点只在「占位曾持有焦点 **且** 当前 `activeElement` 是 body/空」时抢回来——用户主动移走的焦点不抢；
  - hover 在「记录到 hover **或** 新节点此刻 `:hover`」时补发。
- `applyTriggerHandoff`：focus 同步执行；hover 补发**推迟一帧**（`requestAnimationFrame`）。
  这一点是实测 base-ui 源码后定的：`floating-ui-react/hooks/useHover.js` 真正开气泡的是
  passive effect 里 `trigger.addEventListener('mouseenter', …)`，而 trigger 元素本身要先经过
  ref → store → 再渲染才注册，microtask 里派发根本没人接。补发前再查一次 `:hover`，
  避免指针已移开却弹出一个关不掉的气泡。派发序列：
  `pointerover / pointerenter`（React 委托合成 onPointerEnter）→ `mouseover / mouseenter`
  （后者直达 base-ui 原生监听）→ `mousemove`。
- 占位 ARIA/语义补齐，按族区分（`OverlayTriggerSemantics`）：dialog/sheet/alert-dialog 补
  `aria-haspopup="dialog"` + `aria-expanded="false"` + `tabIndex=0`（+ `role="button"`/`data-disabled`
  跟随 `nativeButton=false`/`disabled`），menu 补 `aria-haspopup="menu"`，tooltip 不补（base-ui 的
  `useRole` 对 tooltip 返回空对象，实测 SSR/客户端都没有 popup 语义）。
  唯一**故意不补**的是 `data-base-ui-click-trigger`：它只被 `FloatingFocusManager` 在弹层已打开时读，
  贴在一个不属于任何弹层的占位上反而会让别处打开的弹层误判焦点归属。
- 实现侧五个 `*-impl.tsx` 的 Trigger 签名加上 `React.RefAttributes<HTMLElement>` 并显式转发 `ref`
  （已实测 React 19.2.4 把 ref 当普通 prop 传给函数组件）。

验证方式（无 DOM 环境）：`renderToStaticMarkup` + `useRender` 的**渲染函数形态**把合并后的
elementProps 捞出来，直接调用 `onKeyDown/onFocus/onPointerEnter` 等 handler 断言行为；
`applyTriggerHandoff` 用注入的 `TriggerHandoffEffects` 打桩测调度与 `isConnected` 守卫。
另在 `overlay-deferral.test.tsx` 加了**逐族标记对齐**测试：解析开标签属性，断言实现侧 SSR 出现的
每个属性占位一个不少（`data-base-ui-click-trigger` 与 id 值除外）。

## 2（MED）chunk 彻底取不到时的兜底面板

- `useOverlayModule` 返回 `{ impl, unavailable, retry }`；失败升级逻辑抽成纯函数
  `planOverlayLoad(failures, urgent) → 'load' | 'wait' | 'escalate'`。
  `escalate` 时先走原来的整页刷新；`recoverFromOverlayLoadFailure()` 返回 false（本会话已刷过）
  即置 `unavailable`。
- `useOverlayGate` 增加 `showFallback = unavailable && (openByProps || forceOpen)`：只有用户
  **确实要打开**（受控 open / 按过触发器）才弹兜底，光是 hover 预加载失败不打扰。
- 新增 `OverlayLoadFallback`：原生 `<dialog>` + `showModal()`（上顶层，不怕 SidebarInset 的
  keyboard-avoidance transform 把 fixed 定位拽回文档流；showModal 抛错时退回 `open` 属性），
  提供 Retry / Reload page 两个出口，`Retry` 走 `gate.retry()` 重新跑一轮「3 次重试 → 刷新」。
  接进 Dialog / AlertDialog / Sheet / DropdownMenu 四族的 Root；Tooltip 不接（气泡打不开不构成死路）。
- **没有渲染 children**：闭合态下 `DialogContent`/`AlertDialogTitle` 这些部件本来就返回 null，
  塞进兜底面板只会是一个空壳，所以只给文案 + 两个按钮。
- 文案未走 i18n：`packages/ui` 全包不依赖 i18n（现存文案如 `sr-only` 的 "Close" 也是英文硬编码），
  按任务要求写成极简英文，未新增任何 i18n key。

## 3（MED）Toaster 订阅前的通知丢失

- `packages/ui/src/components/toast.tsx`：门面内加队列。`markToasterReady()` 之前的 `toast.*()`
  一律入队（上限 32，超出丢最旧），ready 后按序 flush；之后的调用直接下发。
  导出 `markToasterReady()` 与 `resetToastQueueForTests(importer?)`。
- `apps/fe/src/main.tsx`：`ThemedToaster` 里 `useEffect(() => { if (Toaster) markToasterReady(); }, [Toaster])`。
  sonner 2.0.7 的 Toaster 在自己的 `React.useEffect` 里 `ToastState.subscribe`（已核对 dist 源码），
  子 effect 先于父 effect 执行，所以补发时订阅一定已经建立。
- 顺带确认：`sonner` 已经**离开入口 chunk**（构建产物里 `data-sonner-toaster` 落在独立的
  `index-BYATJnaq.js`，入口是 `index-DhlUM7NW.js`）——OJ §8 提到的 4 个 `import { toast } from 'sonner'`
  已由并行 agent 改成 `@tmex/ui/toast`，本次门面保持唯一的动态 import 边。

## 11（LOW）占位打开键按族区分

`OverlayTriggerSemantics.openKeys`：dialog / sheet / alert-dialog 只接受 `Enter` 与 `Space`；
menu 额外接受 `ArrowDown` / `ArrowUp`；tooltip 无（本来就不传 `onOpen`）。已加正反用例。

---

## 改动文件

改写
- `packages/ui/src/lazy-overlay.tsx`（失败升级 / 兜底面板 / 触发器交接 / 按族语义）
- `packages/ui/src/overlay-impl-loader.ts`（新增共享 `NO_OVERLAY_GATE`，替掉五份重复的 NO_GATE）
- `packages/ui/src/components/{dialog,alert-dialog,sheet,dropdown-menu,tooltip}.tsx`
- `packages/ui/src/components/{dialog,alert-dialog,sheet,dropdown-menu,tooltip}-impl.tsx`（Trigger 转发 ref）
- `packages/ui/src/components/toast.tsx`
- `packages/ui/src/lazy-overlay.test.tsx`、`packages/ui/src/components/overlay-deferral.test.tsx`
- `apps/fe/src/main.tsx`（仅 `markToasterReady` 接线与 import）

新增
- `packages/ui/src/components/toast.test.ts`

## 验收

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `packages/ui` `bun test` | 77 pass / 0 fail | **110 pass / 0 fail**（+33） |
| `packages/ui` `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `apps/fe` `bun test src/` | 1769 pass / 0 fail | **1783 pass / 0 fail**（增量含并行 agent） |
| `apps/fe` `bunx tsc --noEmit -p .` | 2 error（`packages/ws-client/src/client.ts`，他人在改） | **同样 2 error，全在同一文件；我的文件 0 error** |
| `packages/panels` `bun test` | — | 905 pass / 0 fail（未回归） |
| `bunx biome check`（我改动的文件） | — | **clean** |
| `bun scripts/complexity/gate.ts` | — | 仅剩 `packages/panels/src/files/file-leaf-menu.tsx` 一条（他人文件，复查第 10 项）；我的文件 0 条 |
| `bunx vite build` | — | 通过；`overlays-impl-*.js` 仍独立，`overlay-load-fallback` 在入口（兜底不能依赖 chunk），`sonner` 不在入口 |
| e2e | 按要求未跑 | — |

## 没做到 / 需要知道的

1. **同一个 DOM 节点保不住**（见上，React 结构性限制），走的是任务给的次选方案：layout 阶段补焦点 +
   下一帧补 hover + 占位补 ARIA。
2. **hover / focus 的补发没有 DOM 集成测试**：`packages/ui` 没有 DOM 测试环境（bun test 无 happy-dom，
   根 preload 也没注册），只能把决策与调度拆成纯函数/可注入 effects 来测；真正的 `dispatchEvent`
   与 `focus()` 那几行属于薄封装，未被覆盖。要覆盖需要给包接 DOM 测试环境，超出本任务范围。
3. **兜底面板不渲染 children**（原因见 §2），文案为英文硬编码（`packages/ui` 无 i18n，且不许加 key）。
4. 兜底面板只接了 dialog / alert-dialog / sheet / dropdown-menu 四族，tooltip 未接。
