# 选区复制弹两条「已复制到剪贴板」—— 根因与修复

## 结论（先说答案）

根因**不在前端选区/指针链路**，而在 gateway 的 OSC 52 解析：
`apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts` 的 `case '52'` **完全忽略了 Pc
（选区目标）参数**，把 `primary`/`secondary`/`cut buffer` 的写入全都当成系统剪贴板写入。

pane 内开着鼠标上报的编辑器（nvim/vim/helix 等）双击选词或拖拽选区时，**一次复制会连发两条
OSC 52**——一条 `p`（primary，对应寄存器 `*`）、一条 `c`（clipboard，对应寄存器 `+`）。
nvim 0.10 内置 OSC 52 provider 就是这么映射的（`copy('+')`→`c`，`copy('*')`→`p`），在
`clipboard=unnamed,unnamedplus` 下每次选区变化两条都发。两条都被判成剪贴板写 →
`onClipboardWrite` 触发两次 → 两个 `clipboard-write` 帧 → 前端 `writeClipboardText` 两次、
`terminal.copied` 提示两条。两条 payload 是同一段 base64，所以提示文案**完全一致**，与用户
描述一致。

**这是老问题，不是今天的回归**：忽略 Pc 的写法自 `e417ae3`（2026-06-29，OSC 52 特性首次落地）
起就在，今天的 `eeabb97`（parser 拆模块）只是搬了位置。今天改动的
`terminal-selection.ts` / `terminal-pointer-handlers.ts`（`a84aec4`、`9467c23`）与本 bug 无关。

顺带说明：浏览器里根本没有 PRIMARY 选区，把 `p` 写进系统剪贴板本身就是错的——在 vim 里
**每划一次鼠标就会覆盖一次系统剪贴板**。所以这次不只是去重，是把行为改对。

## 排查过程（按 prompt 给的候选逐条排除）

先确定「自动复制并提示」这条路到底在哪：全仓 `terminal.copied` 只有两个调用点。

1. `packages/terminal-ui/src/components/hooks/useTerminalClipboard.ts:48` —— **选区工具条
   「复制」按钮**（`SelectionToolbar` 的 `onCopy`），必须点击才触发，一次点击一次 toast。
2. `packages/stores/src/tmux-event-router.ts:190` —— **`clipboard-write` 事件**（gateway 解析
   pane 流里的 OSC 52 后下发），这是唯一的「自动复制并提示」。

因此凡是「选完就弹提示」，一定走的是 (2)。据此逐条排除 prompt 的候选：

- **(a) selection-change 回调在 drag-move 与 mouseup 各触发一次 / dblclick 与第二次 mouseup
  各触发一次**：不成立。`onSelectionChange` 的唯一订阅者是 `useTerminalClipboard`，回调里只
  `setHasSelection(Boolean(text))`，**不复制、不提示**；而且 `terminal.ts:751` 的
  `updateSelectionTextProbe` 有 `lastNotifiedSelectionText` 去重，同值不会重复通知。
  今天新增的 `dragMove` 里 `event.buttons === 0` 分支（`terminal-pointer-handlers.ts:174`）
  只走 `finishPointerSelection`，且 `dragUp` 有 `mouse.dragActive` 守卫，重复进入会直接 return。
- **(b) 两个订阅者 / 旧 Terminal.tsx 路径与新 hook 同时注册**：不成立。`Terminal.tsx` 只调用
  一次 `useTerminalClipboard`，`SelectionToolbar` 全仓只在 `Terminal.tsx` 渲染一处；
  `SplitPaneView` 也只是每 pane 挂一个 `<Terminal>`。hook 的 effect 有 `disposable.dispose()`
  清理。
- **(c) StrictMode 双跑 effect**：与本条无关。即便 effect 双跑，它注册的也只是
  `setHasSelection`，不产生 toast。事件侧 `setupTransportHandlers` 有 `initialized` 一次性守卫，
  `transport.onEvent` 用 Set 保存 handler，`createTmuxEventRouter` 的分发是 `handlers[event.type]`
  单表单次派发；`<Toaster/>` 在 `apps/fe/src/main.tsx` 只挂一个。
- **(d) 工具条动作与自动复制同时触发**：也不成立——mouseReporting 打开时
  `consumeReportingMousedown` 直接吃掉 mousedown，本地选区根本不会建立，工具条不出现；
  关闭时不发鼠标上报，pane 内程序不会复制。两条路互斥。
- 还核对了下游链路，均为单路径：pane parser 每 pane 一个实例（`control-mode/pane-registry.ts`
  的 Map）、`onClipboardWrite` 单条回调链（registry → subscription → lifecycle → event-bridge →
  ws）、`broadcastClipboardWrite` 遍历的是 `Set<client>`、`attachRuntime` 每个连接条目只挂一次、
  ws-client 解码表按 kind 单次 `emit`。OSC 状态机（BEL / ST 两种终止）也只在终止符上
  `finishOsc` 一次，tmux passthrough 的内层数据只重扫一遍，都不会重复 emit。

结论收敛到唯一可能：**同一次复制产生了两条 OSC 52**，而解析侧没有按 Pc 区分。

## 修复

`apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts`

```ts
// OSC 52 的 Pc 是选区集合：c=clipboard、p=primary、q=secondary、s=select、0-7=cut buffer。
function targetsSystemClipboard(targets: string): boolean {
  return targets.length === 0 || targets.includes('c') || targets.includes('s');
}
```

`case '52'` 在取 base64 前先按 `Pc` 过滤：只有目标集为空、含 `c` 或含 `s` 时才写剪贴板。

- 空 `Pc`（tmux 自身复制、大量脚本的 `\e]52;;<b64>`）与 `s`、`pc` 保持旧行为，既有用例
  （`primary selection parameter (s)`、`multiple selection parameters (pc)`）不受影响。
- `p` / `q` / `0-7` 单独出现时忽略，一次复制只剩 `c` 那一条 → 一次剪贴板写、一条提示。

## 回归测试

`apps/gateway/src/tmux-client/pane-stream-parser.test.ts`（端到端 parser 层）

- `primary + clipboard pair from a single copy writes the clipboard once`：把编辑器一次复制
  连发的 `ESC]52;p;aGVsbG8=BEL` + `ESC]52;c;aGVsbG8=BEL` 一次性喂给 parser，断言
  `writes` 恰好为 `['hello']`（修复前为 `['hello','hello']`，即用户看到的两条提示）。
- `primary-only writes are ignored`：只有 `p` 时不写剪贴板，且序列仍被从透传输出里剥掉。

`apps/gateway/src/tmux-client/pane-stream/osc-handlers.test.ts`

- `OSC 52 only honours system-clipboard targets`：空 / `s` / `pc` 放行，`p` / `q` / `0` 忽略。

把 `targetsSystemClipboard` 短路成 `true` 后，前一条用例精确复现线上现象
（`['hello','hello']`）。

## 验证

- `apps/gateway`：`NODE_ENV=test bun test` → **1876 pass / 0 fail**（195 文件，27.7s）。
- `tsc --noEmit -p apps/gateway/tsconfig.json`：改动前后同为 33 个既有报错（全部在
  `ws/issue45-cross-bug.test.ts`、`ws/switch-barrier.issue45.test.ts` 等无关测试文件的
  `TS7006 implicit any`），我的文件零报错。
- `biome check` 三个改动文件：`Checked 3 files. No fixes applied.`
- 未跑 Playwright e2e（按要求）；未碰生产 tmex 服务与 `tmex` session。

## 与并发 agent 的关系

开工时 `packages/ghostty-terminal/src/terminal.ts` 有另一 agent 的未提交改动（e2e 选区探针
归属判定）。工作期间对方已把它提交为 `9728fe6`。**本次改动全部在 `apps/gateway/` 下，与
`terminal-selection.ts` / `terminal-pointer-handlers.ts` / `terminal.ts` 完全不相交**，无冲突。
（中途为了拿 tsc 基线对我自己的 3 个文件做过一次 `git stash push <paths>` + 立即 `pop`，
未触及对方文件，`git stash list` 已空，工作区状态见下。）

## 工作区状态

仅 3 个文件改动，无 commit / push：

- `apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts`
- `apps/gateway/src/tmux-client/pane-stream/osc-handlers.test.ts`
- `apps/gateway/src/tmux-client/pane-stream-parser.test.ts`

## 遗留 / 建议（不在本次范围）

- 若用户改完仍偶发两条提示，说明其编辑器把 `*` 与 `+` **都映到了 `c`**（少数自定义
  `vim.g.clipboard` 会这样），此时两条 OSC 52 的 Pc 都合法，parser 层无从区分。届时的兜底是
  在 toast 出口按「(deviceId, paneId, text) + 时间窗（~500ms）」去重，位置在
  `packages/stores/src/tmux-event-router.ts` 的 `clipboard-write` handler。本次没做，因为它
  需要给 router 引入跨事件状态（handlers 是模块级静态表，直接加模块变量会在
  `tmux-event-router.test.ts` 的多 harness 用例间串味），属于确认症状仍在后再加的第二层。
- 诊断口径：复现时看 gateway 是否连发两帧 `KIND_CLIPBOARD_WRITE`，以及 pane 流里两条 OSC 52
  的 Pc 分别是什么（`p`+`c` 已被本次修复覆盖，`c`+`c` 才需要上面的兜底）。
