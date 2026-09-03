# OJ — 首屏瘦身：base-ui 弹层懒加载 / sonner 懒挂 / 主题 CSS 幽灵 / motion 死导出

工作区：`/Users/konata/code/tmex-r22`（分支 `feat/round22-perf-tui-color-smell`）
说明：本轮多 agent 并行改同一 worktree，下文所有「前后」数字都标注了测量方式；跨时间点的对比含他人改动，**唯一干净的归因数字是 §1.2 的同树 A/B**。

---

## 1. base-ui 弹层组懒加载（§8 ①）

### 1.1 做法

`packages/ui` 内新建一层「公开面 / 实现」边界，**对外导出的组件名与签名一字未改**，apps/fe 与 packages/panels 的静态 import 边全部原样编译。

| 新文件 | 作用 |
| --- | --- |
| `packages/ui/src/lazy-overlay.tsx` | loader（成功缓存 / 失败不缓存）、`useOverlayModule`、`useOverlayGate`、`createOverlayPart`、`OverlayTrigger` 占位、`recoverFromOverlayLoadFailure` |
| `packages/ui/src/overlay-impl-loader.ts` | 五族共用的**唯一** loader 与 `warmOverlay` |
| `packages/ui/src/components/overlays-impl.ts` | 五族实现的单一按需入口（合并成一个 chunk） |
| `packages/ui/src/components/{tooltip,dialog,alert-dialog,sheet,dropdown-menu}-impl.tsx` | 原实现逐字搬迁，未改一行渲染逻辑 |

被改写成公开面的：`tooltip.tsx`、`dialog.tsx`、`alert-dialog.tsx`、`sheet.tsx`、`dropdown-menu.tsx`。

关键设计点：

- **闭合态同步渲染，零抖动**：触发器用 base-ui 自己的 `useRender`（本来就在入口 chunk 里，`sidebar-menu.tsx` 已在用）渲染占位，`render` / `className` / `title` / `children` / `data-slot` 与实现侧逐字一致。`data-slot` 的覆盖顺序也对齐了实现侧（`{ 'data-slot': slot, ...props }`）——侧栏菜单按钮会用 `sidebar-menu-button` 盖掉默认值，占位不能反着盖回去（`app-sidebar-footer.test.tsx` 正是按它计数，已补回归用例）。
- **弹层内部件**（Content / Header / Item / …）在实现到货前渲染 `null`，与 base-ui 闭合态不挂 Portal/Popup 一致；**没有外层 Root 时回落到模块级缓存**，保证 `DropdownMenuLabel` 这类「must be used within …」的抛错契约不因懒加载消失（`apps/fe/src/pages/devices/add-device-menu.test.tsx` 依赖这条）。
- **不用 `React.lazy`**：与 `deferred-watch-dialog` 同一理由（reject 被永久缓存、`Suspense` 接不住异常）。失败路径 = 最多 2 次就地重试 → 用户确实在等这个弹层时才整页刷新，且**每会话至多刷新一次**（`sessionStorage` + 进程内双保险），杜绝「新版也 404」的刷新循环。
- **`warmOverlay` 在模块求值时就发起 `import()`**：与入口 chunk 的其余启动工作并行，首帧前基本已到货，用户碰不到「替换」这一帧。这也是让 `renderToStaticMarkup` 系单测（panels / fe 共约 20 个文件）继续同步拿到实现的前提——改成 idle 调度会让那批不属于本任务的测试全红。
- 触发器交互兜底：`pointerenter` / `focus` 提前加载；`pointerdown` / `Enter|Space|Arrow` 在 menu / dialog / sheet 上还会置 `defaultOpen`，实现到货后直接以打开态挂载（tooltip 不做，避免鼠标已移开却弹出一个关不掉的气泡）。

### 1.2 收益（同树 A/B，唯一干净归因）

把五个公开面临时换成 `export * from './*-impl'`（纯静态）后构建，再换回懒加载版构建，两次构建之间**只有这一处差异**：

| | 入口 JS raw | 入口 JS gzip |
| --- | ---: | ---: |
| 静态（对照） | 1,096,410 | **338,343** |
| 懒加载（本次） | 948,370 | **290,878** |
| Δ | −148,040 | **−47,465（−14.0%）** |

移出去的字节落在两个 chunk（与差值几乎一致，交叉验证）：

| chunk | raw | gzip | 内容 |
| --- | ---: | ---: | --- |
| `overlays-impl-*.js` | 57,521 | **16,342** | 五族实现 + base-ui menu/dialog/tooltip/alert-dialog 部件 |
| `ToolbarRootContext-*.js` | 80,512 | **28,975** | `floating-ui-react` + `tabbable` + `@floating-ui/*` 等共享部分（与 `select-*.js`、`files-node-roots-*.js` 共用） |

产物核对（按 `data-slot` 定位）：

```
tooltip-content / dialog-content / sheet-content
alert-dialog-content / dropdown-menu-content   →  overlays-impl-*.js    （已离开入口）
tooltip-trigger / dropdown-menu-trigger        →  入口（占位）+ overlays-impl（实现）
tabs-list / scroll-area / collapsible-content  →  入口（未受影响）
context-menu-content                           →  files-node-roots-*.js （本来就不在入口）
select-trigger                                 →  select-*.js           （本来就不在入口）
```

入口 chunk 内已搜不到 `tabbable` / `safePolygon` / `FloatingFocusManager` / `useListNavigation` / `floating-ui` 任何一个标记 —— **`tabs`/`scroll-area`/`collapsible` 确认只吃 `floating-ui-react/utils.js` + `composite`，没有把 `floating-ui-react` 拖回来**。

### 1.3 与 EX5 预估（−62,676）的差额说明

EX5 是用 `manualChunks` 把「overlay 组 + composite」整组强行切走量的。真实懒加载边界下：

- `composite`（≈7.9 KB gz）被入口的 `tabs` 静态需要，必须留在入口；
- `@base-ui/utils` / `use-render` 同理（`sidebar-menu.tsx` 直接在用）；
- `context-menu` / `select` 本来就已经不在入口（本轮实测复核，见上表），对它们再做懒加载**收益为 0**，因此未动——EX5 把它们算进了同一组。

差额基本由这三项解释。

### 1.4 chunk 数

第一版按族各切一个 `*-impl` chunk 时，rollup 把 base-ui 内部件（`DialogRoot` / `DialogTrigger` / `InternalBackdrop` / `safePolygon` / `useClick` / `useRole` / `popupStateMapping` …）拆成了十几个几百字节的碎片。改成 `overlays-impl.ts` 单一入口后碎片消失，五族只多两个请求。

---

## 2. sonner 懒挂（§8 ⑤）—— **做了，但首屏字节没减，原因见下**

`apps/fe/src/main.tsx`：`import { Toaster } from 'sonner'` 改成 `import type { ToasterProps }` + 新增 `useDeferredToaster()`，首个 effect 里 `import('sonner')`，失败最多重试 2 次后静默放弃（吐司弹不出来不该拖垮整页）。Toaster 不再参与首帧渲染。

**但 `sonner` 仍然留在入口 chunk**（产物里 `data-sonner-toaster` 仍只出现在 `index-*.js`）。真因：入口静态图上还有 4 个模块直接 `import { toast } from 'sonner'`。用从 `main.tsx` 出发的静态可达性 BFS（324 个模块）跑出来的完整名单：

```
apps/fe/src/lib/sonner-notification-sink.ts          ← main.tsx → node/node-runtimes.ts → 这里
packages/panels/src/device-tree/use-sidebar-device-reorder.ts
packages/panels/src/watch/use-watch-rules.ts
packages/panels/src/watch/watch-rule-form.tsx
```

这 4 个文件都不在我的可改范围（任务只授权「Toaster 的挂载点」，且 `packages/panels/**` 明令禁改）。**要真正拿到 −13.3 KB gz，必须把这 4 处的 `toast` 换成一层 `await import('sonner')` 的转发队列**（`sonner-notification-sink.ts` 是天然的集中点）。建议交给拥有这些文件的 agent 或后续单独一刀。

---

## 3. 主题 CSS 幽灵（§5.2）

`packages/theme/src`：

- `tokens.css`：删 `:root` 与 `.dark` 的 `--chart-1..5`（10 行）、11 个 `--fc-*`、`--display-weight: 700`。
- `preset-css.ts`：删 `--chart-1..5` 的 5 行映射与整段 `fc` 数组（11 项）。
- 跑 `bun scripts/theme/build-theme-presets.ts` 重新生成 `themes.css`（**未手改生成物**）：**791 → 553 行**。`hljs-terminal-theme.css` 无变化（up to date）。
- `presets.test.ts`：删掉已随之失效的两处——`semanticTokensFromRoot()` 里对 `--display-weight` 的排除、`expect(semantic).toContain('--fc-today-bg-color')`。其余断言（每个 preset 覆盖全部语义 token、生成物未过期）自动跟随，52 pass 不变。
- `preset-palettes.ts` 的 `ui.charts` 数据**保留**：它没有从 `@tmex/theme` 的 barrel 导出，不进前端 bundle，0 字节代价；`presets.test.ts:253` 的对比度断言继续有效。若产品确认永不做图表，可作为后续单独清理项。

`apps/fe/src/index.css`：

- 删 `@theme inline` 里的 `--animate-scroll` + `@keyframes scroll` + `@keyframes pulse-dot`（2 个未用 keyframes）。
- 删 `--color-chart-1..5` 映射（`--chart-*` 已不存在，留着就是悬空引用）。
- 删悬空的 `--font-display: var(--display-family)` 与自引用的 `--display-weight: var(--display-weight)`：`--display-family` 全仓从未定义，`themes.css` 只定义了 `--text-family`（→ `--font-sans`，活的）。设计真正意图的字体栈是 `--text-family` / `--font-mono` 两条，没有第三条 display 栈，所以是**删**不是补。
- 删 `@layer base` 里唯一消费 `--display-weight` 的 `.font-display` 类（全仓 0 引用）。

`motion.css` 未动：`tmex-fade` / `tmex-scale-in` / `tmex-stagger` 三个类在业务代码里以字符串字面量被使用（16 / 5 / 2 处）。

---

## 4. motion.tsx 死导出（§5.3）

`packages/ui/src/components/motion.tsx` 删 5 个：`fadeClassName`、`scaleInClassName`、`staggerClassName`、`Stagger`、`StaggerProps`（EX5 提到的 `MotionDurationName` 在本分支已不存在）。`motion.test.ts` 同步去掉对已删符号的 import 与 3 条断言（只删「测已删符号」的部分，其余断言未动）。
`motionDurations.slow` 按 EX5 结论**保留**（`--tmex-motion-fast` 产物里有 47 处，成对留着更好读）。

---

## 5. 产物对照表

**A. 同树 A/B（只差「弹层懒加载」这一处，干净归因）**

| | raw | gzip |
| --- | ---: | ---: |
| 入口 JS（静态对照） | 1,096,410 | 338,343 |
| 入口 JS（懒加载） | 948,370 | **290,878（−47,465 / −14.0%）** |

**B. 我开工时 → 收工时（含并行 agent 的改动，仅供参考）**

| | 开工 `index-Dg25hTeR.js` / `index-DflXGMdH.css` | 收工 | Δ |
| --- | ---: | ---: | ---: |
| 入口 JS raw | 1,133,947 | 948,370 | −185,577 |
| 入口 JS gzip | 348,313 | **290,878** | −57,435 |
| 入口 CSS raw | 147,046 | 139,327 | −7,719 |
| 入口 CSS gzip | 23,050 | **22,321** | **−729** |
| js chunk 数 | 125 | 175 | +50（绝大多数来自并行 agent：hljs 按语言拆分、i18n core/rest 拆分、highlight worker） |

CSS 的 −729 gz 里，本任务贡献的是 `--fc-*` + `--chart-*` + 三处 index.css 幽灵；EX5 单量 fc+chart 为 −394 gz，余量来自 index.css 与并行改动，未再做隔离 A/B（改回生成物再跑一遍构建，在多 agent 共享 worktree 里风险不划算）。

**C. 新增按需 chunk**

| chunk | raw | gzip | 何时下载 |
| --- | ---: | ---: | --- |
| `overlays-impl-*.js` | 57,521 | 16,342 | 入口执行时并行发起（`warmOverlay`），不阻塞首帧 |
| `ToolbarRootContext-*.js` | 80,512 | 28,975 | 同上；与 `select-*.js` / `files-node-roots-*.js` 共用 |

---

## 6. 验收

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `packages/ui` `bun test` | 62 pass / 0 fail | **77 pass / 0 fail**（新增 11 条 lazy-overlay 断言 + 4 条闭合态契约；motion 的 3 条随死导出一并删除） |
| `packages/ui` `bunx tsc --noEmit -p .` | 0 error | **0 error** |
| `packages/theme` `bun test` | 52 pass / 0 fail | **52 pass / 0 fail** |
| `packages/panels` `bun test` | 865 pass / 0 fail | **889 pass / 0 fail**（增量来自并行 agent） |
| `packages/terminal-ui` `bun test` | 398 pass / 0 fail | **398 pass / 0 fail** |
| `apps/fe` `bun test src/` | 1744 pass / 0 fail | **1762 pass / 0 fail** |
| `apps/fe` `bunx tsc --noEmit -p .` | 2 error（`packages/ghostty-terminal/src/canvas-renderer.ts`，他人在改） | 21 error，全部落在 `packages/ghostty-terminal/src/canvas-renderer.ts` 与 `apps/fe/src/node/node-runtimes.test.ts`——**均为并行 agent 的在途改动，我的文件 0 error** |
| `bunx biome check`（全部改动文件，生成物除外） | — | **clean** |
| `bun scripts/complexity/gate.ts` | ok | **ok**（1292 files / 11915 functions） |
| e2e | 按要求未跑 | — |

生成物 `packages/theme/src/themes.css` 由脚本重建，**未手改、未 lint**。

---

## 7. 改动文件清单

新增
- `packages/ui/src/lazy-overlay.tsx`
- `packages/ui/src/lazy-overlay.test.tsx`
- `packages/ui/src/overlay-impl-loader.ts`
- `packages/ui/src/components/overlays-impl.ts`
- `packages/ui/src/components/overlay-deferral.test.tsx`
- `packages/ui/src/components/{tooltip,dialog,alert-dialog,sheet,dropdown-menu}-impl.tsx`

改写
- `packages/ui/src/components/{tooltip,dialog,alert-dialog,sheet,dropdown-menu}.tsx`
- `packages/ui/src/components/motion.tsx`、`motion.test.ts`
- `packages/theme/src/tokens.css`、`preset-css.ts`、`presets.test.ts`
- `packages/theme/src/themes.css`（脚本重建）
- `apps/fe/src/index.css`
- `apps/fe/src/main.tsx`（仅 Toaster 挂载点）

未动（按 ownership）：`packages/ui/src/components/sidebar/resize-controller.ts`、`apps/fe/src/pages/**`、`apps/fe/src/components/page-layouts/**`、`packages/panels/**`。

---

## 8. 没做到 / 需要别人接手

1. **sonner 的 13.3 KB 拿不到**：必须改 §2 列出的 4 个 `import { toast } from 'sonner'`，全在我的可改范围外。Toaster 挂载点已经改好，接上转发队列即可兑现。
2. **`context-menu` / `select` 未做懒加载**：实测二者本来就不在入口 chunk（分别落在 `files-node-roots-*.js` / `select-*.js`），再包一层只会多两个碎片 chunk，收益 0。
3. **`composite` / `@base-ui/utils` / `use-render` 仍在入口**：被入口静态需要的 `tabs` 与 `sidebar-menu.tsx` 钉住，属结构性，不是遗漏。
4. **CSS 的隔离 A/B 未做**：多 agent 共享 worktree，为了量一个 ~400 B 的数字把生成物来回改两遍不划算；给出的是含并行改动的观测值。
5. **`warmOverlay` 是「求值即发起下载」而不是 idle 调度**：改成 idle 会让 panels / fe 那批 `renderToStaticMarkup` 单测（不在我可改范围）全部拿到占位而红。若后续给这些包补上 `bunfig.toml` 的 test preload（预热实现模块），可以再把 `warmOverlay` 降级成 idle，进一步把这 45 KB 挪出启动期的网络争抢窗口。
