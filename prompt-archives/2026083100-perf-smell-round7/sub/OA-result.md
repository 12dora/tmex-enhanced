# OA 结果：iOS PWA 终端触摸手势 + 剪贴板复制失败

## 一、改了什么

### 1. 上报模式下的单指语义：拖拽 → 滚动

- `packages/terminal-ui/src/components/touch/gesture-machine.ts`
  - 单指落下仍进 `pending`（tap/长按/双指待定）；**越过 12px 位移阈值后直接转 `scroll`**，
    走 `TouchScrollGesture.handleSingleMove` → `handleViewportGesture`（上报模式下由终端编码成滚轮 64/65）。
    不再发 `press` + 流式 `motion`。
  - 删除 `drag` 状态及 touchmove/touchend/touchcancel 中的全部 drag 分支（含"非主指抬起不结束拖拽"、
    touchcancel 补发 release 的逻辑）——触摸端已不可能进入"左键按住"，无需补救。
  - 新增实例字段 `reporting`（每次首指落下判定，`resetGesture` 复位），把原先只在 touchstart 里做的
    "上报模式只认真正的滚动条元素、不认右缘 36px 热区"判定收进 `bypasses()`，
    touchstart 与 scroll 途中的 bypass 判定因此一致（此前 move 途中在上报模式仍会用 36px 热区，属遗留不一致）。
- `packages/terminal-ui/src/components/touch/mouse-report-gesture.ts`
  - 只保留 `tap()`（内部 press+release，press 失败不补 release），删掉 `motion/release/releaseAt` 与
    `lastDragX/lastDragY`。
- `packages/terminal-ui/src/components/touch/types.ts`
  - `TouchGestureState` 去掉 `'drag'`，状态注释更新（`pending` 现在只通往 tap/scroll/select/wheel）。
- 未改动：tap、长按本地 word 选择（`select`）、双指 `wheel`、非上报单指滚动。

设计取舍：iOS 上「单指滚动、长按选词」是系统级肌肉记忆，优先级高于把触摸映射成 TUI 鼠标拖拽；
TUI 内的框选改由长按本地选择承担（本地选择与 OSC52 无关，不受剪贴板激活限制）。该决定已在
`gesture-machine.ts` 的 pending 分支写了中文注释说明。

### 2. 远端发起复制的延迟写入

- `packages/shared/src/browser-clipboard.ts`（与既有 `writeTextToClipboard` 同文件）
  新增 `createDeferredClipboardWriter(handlers, options)` / `DEFERRED_CLIPBOARD_TTL_MS = 20_000`：
  - `write(text)` 先直接写；成功 → `onSuccess()`（桌面路径完全不变，且会丢弃此前过期的挂起）。
  - 失败 → 挂起文本（**latest wins**），在 `window` 上 capture 阶段一次性挂 `pointerdown` /
    `touchend` / `keydown`，并起 20s TTL；首次挂起才触发 `onPending()`（重复复制不刷屏，但会重置 TTL）。
  - 手势回调里**同步**发起 `writeText`（默认实现第一步就是 `navigator.clipboard.writeText`，
    满足 iOS 的用户激活窗口要求）；成功 → `onSuccess()`，失败 → `onFailure()`（只报一次）。
  - TTL 到期 → `onFailure()` 并拆监听；`dispose()` 静默拆除；无 `window`（SSR/测试）时直接 `onFailure()`。
  - 经 `packages/shared/src/index.ts` 导出（`index.test.ts` 的导出面快照同步补两条）。
- `packages/stores/src/tmux-event-router.ts` `'clipboard-write'`
  - 改为 `clipboardWriterFor(ctx).write(event.text)`；writer 用 `WeakMap<TmuxEventRouterContext, …>` 按
    router 上下文缓存，保证挂起状态跨事件存活（handlers 是模块级常量，无法持有 per-router 状态）。
  - 回调接线：`onPending → notifications.info(t('terminal.copyPending'))`、
    `onSuccess → success(t('terminal.copied'))`、`onFailure → warn 日志 + error(t('terminal.copyFailed'))`。
- i18n：`terminal.copyPending` 加到 `en_US.json` / `zh_CN.json` / `ja_JP.json`（三个 locale 文件都存在，
  保持键面一致；`files.copyFailed` 那一处同名键未动）。**未跑 `bun run build:i18n`，未碰
  `i18n/resources.ts`/`types.ts`**——由 commander 统一再生成。`TranslateFn` 签名是 `(key: string, …)`，
  故无需类型断言。

## 二、测试

| 包 | 基线 | 现在 |
| --- | --- | --- |
| packages/terminal-ui | 323 pass / 0 fail | **325 pass / 0 fail** |
| packages/stores | 334 pass / 0 fail | **345 pass / 0 fail**（其中 +1 为本任务；其余为并行 agent 新增文件） |
| packages/shared | 376 pass / 0 fail | **384 pass / 0 fail** |

- terminal-ui：删掉 4 条 drag 用例，新增 5 条（press 被拒的 tap 不补 release、上报模式单指移动走
  `viewportGesture` 且无 press/motion、滚动后抬指不发 tap、非主指抬起保持 scroll、touchcancel 不留按住状态）
  + 1 条"上报模式下长按仍本地选词且零鼠标上报"；并把"越阈解除长按"用例改成滚动语义。
- shared：新增 8 条 `createDeferredClipboardWriter` 用例（立即成功、失败后手势重试成功、二次失败只报一次、
  TTL 过期、挂起期间 latest-wins + TTL 重置、挂起期间直接成功丢弃过期挂起、无 target 直接失败、dispose）。
- stores：新增 1 条 router 用例（stub `window` → 失败后出 `terminal.copyPending` info、无 error；
  触发 `pointerdown` 后重试成功出 `terminal.copied`）；原有两条（仅当前 pane 生效 / 失败出错误 toast）保持通过
  ——测试环境无 `window`，延迟写入退化为立即失败，行为与改动前一致。

## 三、静态检查

- `bunx tsc --noEmit -p .`：terminal-ui 0 error，shared 0 error，stores 仅 1 条既有错误
  （`src/host-services.test.ts(93,23)`，非本次引入）。
- `bunx biome check <改动文件>`：通过（格式化由 `--write` 应用后复检干净）。
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1057 files, 8730 functions)`。

## 四、注意事项 / 后续

- `terminal.copyPending` 尚未进 `i18n/resources.ts`，前端实际渲染前必须由 commander 跑 `bun run build:i18n`。
- 手势事件集选了 `pointerdown` + `touchend` + `keydown`（capture、一次性）：WebKit 在这三类事件回调内均持有
  user gesture；先到者胜（触摸下 `pointerdown` 先于 `touchend`）。
- 上报模式下"单指移动不足一行"时不再 `preventDefault`（与非上报路径一致），可能出现页面原生回弹；
  如需完全吞掉，可在 scroll 态无条件 preventDefault，但会牺牲滚动条 bypass 的交还能力。
- 未触碰 `packages/ghostty-terminal/src/selection-clipboard.ts`（刻意的零依赖副本），
  `useTerminalClipboard.ts` / `SelectionToolbar.tsx` 也未改——本地复制本来就在用户手势内，无需延迟。
