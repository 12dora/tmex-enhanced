# OF 结果：前端零散性能项 U3 / U10 / U8 / U11 / U12

分支 `feat/round22-perf-tui-color-smell`（worktree `/Users/konata/code/tmex-r22`），全部改动落在 `packages/panels`。

## 基线（改动前实测）

```
cd packages/panels && bun test          → 786 pass / 0 fail
cd packages/panels && bunx tsc --noEmit -p .  → 0 error
```

## 终态

```
cd packages/panels && bun test          → 865 pass / 0 fail
cd packages/panels && bunx tsc --noEmit -p .  → 0 error
bunx biome check <本次改动的 14 个文件>  → clean
bun scripts/complexity/gate.ts          → complexity gate ok (1284 files, 11888 functions)
```

本任务新增 32 个用例（786 → 865 的差额里还含并行 agent 同期落地的用例），无既有断言被删改（唯一例外：`use-terminal-shortcuts-editor.test.ts` / `directory-picker-modal.test.tsx` / `tool-brief.test.ts` 是**追加**用例，原用例原样保留）。

期间遇到两次并行 agent 的中间态（`@tmex/api-client` 少 `fetchCapabilities` 导出、`code-viewer` 3 fail、`files/file-leaf-menu.tsx` 4 个 tsc 错），均与本任务文件无关，稍后重跑即恢复；终态那一轮全绿。

---

## U3 — 流式 markdown 未封口围栏短路

`packages/panels/src/markdown/streaming-markdown.tsx`

- 新增 `openFenceTail(text)`：尾块首行是围栏（`{0,3}` 空格缩进 + 3 个以上 `` ` `` / `~`）且**未封口**时，返回 `{ lang, body }`；否则 `null`。按 CommonMark 记住**围栏字符与长度**——更短或异种的内层围栏（如 ```` ```` `` 里的 ``` ``` ``）不算闭合；反引号栏的 info string 含反引号则不成栏；缩进 0-3 成栏并按缩进量剥离栏内每行，4 空格是缩进代码块（不短路）。
- `StreamingMarkdown` 命中时只渲染 `sealed` 块 + 一个 `<OpenFenceBlock>`（`<pre className={PRE_CLASS}><code className={cn(CODE_CLASS, lang && 'language-x')}>`），把 `pre`/`code` 的 class 提成 `PRE_CLASS`/`CODE_CLASS` 常量与 `markdownComponents` 共用。
- 栏内文本按 mdast→hast 的 `code` 节点语义对齐（去掉末尾一个换行后，非空才补一个换行），**封口那一帧的 HTML 与短路帧逐字相同**（测试直接断言 `render(未封口) === render(已封口)`），不会跳版。
- 为过复杂度门禁（`openFenceTail` 一开始 CC 17 > 15）拆成 `parseFenceOpen` / `closesFence` / `fenceBody` 三个小函数。
- **未动 `advanceMarkdownSplit` / `splitTail` 的分块语义**：它们的 fence 判定是朴素 toggle，而现有 fuzz 测试拿同款朴素实现做对照 oracle，改它就得改 oracle（等于弱化既有断言）。短路发生在渲染层的尾块区（`text.slice(openStart)`），朴素 toggle 误分块的嵌套场景会自然回退到完整 parse，正确性不倒退。

实测（SSR，`react-markdown` 10 + remark-gfm，150 KB 未封口 ts 块分 40 次 flush 追加）：

| | 每次 flush | 总计 |
|---|---:|---:|
| 旧路径（整个尾块喂 react-markdown） | 13.31 ms | 532.5 ms |
| 新路径（短路 `<pre>`） | 1.32 ms | 52.8 ms |

**10.1×**；新路径剩下的 1.32 ms 里绝大部分是 SSR 输出 150 KB 文本节点本身（浏览器端复用 DOM 时更低）。EX1 记的 14% 主线程占用按此比例降到 ~1.4%。

测试 `src/markdown/streaming-markdown.render.test.tsx`（新文件，13 例）：
- `openFenceTail` 正确性：封口/未封口、嵌套反引号、波浪线栏、异种栏不互闭、info 含反引号、缩进 0-3 与 4 空格、列表项内的围栏不短路、只有首行时栏内为空。
- bench 式：用 `mock.module('react-markdown', …)`（**转发真实实现**，只计次和累计 parse 字符数）断言 200 次 flush 里 `parse.calls === 200`、`parse.chars === 200 × 已封口块长度`——即每次 flush 的 parse 成本只与 delta（那个不变的已封口块）有关，与尾块长度无关；对照组（尾块不是围栏）同一节奏下 `parse.chars > 100 KB`。

## U10 — `ToolCallCard` 的 Dialog 与未知工具摘要

`packages/panels/src/agent/messages/tool-call-card.tsx`

- `{dialogMounted && <ToolDetailsDialog … />}`：打开时置 `dialogMounted`+`dialogOpen`，关闭动画播完（base-ui `onOpenChangeComplete(false)`）再卸载。**保留了关闭动画**——直接按 `dialogOpen` 条件渲染会把 `data-closed:animate-out` 吞掉。`ChatThread` 的 `WINDOW_STEP = 200` 下少挂最多 200 个 base-ui Dialog root。

`packages/panels/src/agent/messages/tool-brief.ts`

- 新增 `asBriefText(value, max)`：先 `capForBrief` 按预算裁剪结构（字符串截到 `max`；对象/数组逐项加入，序列化长度 −2 达到预算即停手；`Object.keys` 逐个取值而非 `Object.entries` 一次性读遍；深度上限 32 兜住自引用），再 `JSON.stringify(…, null, 2).slice(0, max)`。`fallbackBrief` 改用它。
- `asText` 未改（详情面板要完整串）。裁剪点选在「序列化长度 − 2 ≥ 预算」是为了让末尾让出的 `\n]` / `\n}` 不落进前 `max` 个字符，因此**输出与旧实现逐字相同**（测试对 9 种形态断言 `asBriefText(v,60) === JSON.stringify(v,null,2).slice(0,60)`）。

实测（2000 键、每值 200 字符，完整序列化 494 KB）：`asText(...).slice(0,60)` 0.557 ms → `asBriefText(..., 60)` 0.032 ms，**17×**。

测试：`tool-call-card.dialog.test.tsx`（新文件）用 `mock.module('@tmex/ui/dialog', …)`（转发真实实现）数 Dialog root 挂载次数，断言 50 张未打开的卡片挂 0 个；`tool-brief.test.ts` 追加 3 例（逐字相同、getter 计数证明不读遍整个 input、循环引用退化为 `String(value)`）。

## U8 — 快捷键编辑器每键 ~6N 次 `JSON.stringify`

`packages/panels/src/settings/use-terminal-shortcuts-editor.ts`

- 删掉 `normItem`，`sameShortcutItems` 改逐字段比较（`id/type/label/payload??null/action??null`）。
- 采纳服务器值的 effect 改用 `draftRef` 读草稿，deps 从 `[data, baseline, items, useIcons, adopt]` 收敛到 `[data, baseline, adopt]`——每次击键不再重跑一遍采纳判定。
  - **语义微调（需知悉）**：以前用户把草稿改回与基线一致时，effect 会重跑并顺手采纳当时最新的服务器值；现在要等下一次 `data`/`baseline` 变化才采纳。方向上更保守（不会在用户手上突然换内容），无测试依赖旧行为。

`packages/panels/src/settings/shortcut-list.tsx`

- 抽出 `LabelInput`：本地草稿 + `onBlur` 提交，`item.label` 变化时同步草稿；`ActionRowFields` 与 `SendRowFields` 的 label 输入框都换成它（payload 早就是这个写法）。每敲一个字符不再 `setItems` → 不再重排 `SortableContext`、不再重跑 N 次 `useSortable`、不再重算 dirty。

实测：12 条默认快捷键的 `sameShortcutItems` 3.16 µs → 0.26 µs（**12×**）；更大的收益是击键路径上整条「setItems → 列表重渲染 → dirty 重算」被去掉。

测试：`shortcut-list.test.tsx`（新文件，3 例）用 `mock.module('@tmex/ui/input', …)` 捕获输入框 props 后直接调回调，断言 `onChange` 连敲三次不回写数据层、`onBlur` 提交一次、action 行走同一套；`use-terminal-shortcuts-editor.test.ts` 追加 5 例（五个字段逐个改动都能识别、多余字段不影响判定、`isShortcutDraftDirty` 三条）。

## U11 — 目录选择器高亮不再全列表 `querySelector`

`packages/panels/src/settings/directory-picker-modal.tsx`

- 新增 `focusPickerRow(rows, highlight)` + `rowRefs` 数组（`DirectoryEntryList` 多一个可选 `rowRefs` prop，行 `ref` 按下标写入），高亮 effect 直接 `rows[highlight].focus()`，删掉 `listRef` 与 `querySelector('[data-picker-index="N"]')`（`data-picker-index` 属性保留——`handleKeyDown` 的 `target.closest` 还在用）。
- 条目数超 `PICKER_SKIP_RENDER_THRESHOLD = 200` 时给行加 `content-visibility: auto` + `contain-intrinsic-size: auto 32px`（后端硬顶 2000 条 ⇒ 6000+ 节点）。阈值内不加，避免小列表白付一层 containment。

测试：`directory-picker-modal.test.tsx` 追加 5 例（按下标聚焦正确的行、无高亮/越界/未挂载安全退出、超阈值行带 `content-visibility:auto` 与 `contain-intrinsic-size:auto 32px`、阈值内不带、`rowRefs` 容器不被组件改写）。

## U12 — 行 action 数组 memo

`packages/panels/src/device-tree/use-row-action-items.ts`

- `useWindowActionItems` / `usePaneActionItems` 都用 `useMemo` 包住 `buildWindowActions` / `buildPaneActions`，deps 为 `t / stores / features.watchUi / tmuxWindow(或 pane) / deviceId / windowId / sessionTargetPane / 各回调 / agent / nav`。
- 没走「菜单打开时才构造」那条路：那需要把 `DeviceActionItem[]` 的生产下沉进 `DropdownMenuContent`，改动面比 memo 大一个量级，而 memo 已经把「输入不变即零重建」拿到了。

测试：`use-row-action-items.test.tsx`（新文件，2 例）。无 DOM 环境下用「渲染期 `setState` 触发同一实例再渲染」的手法在 `react-dom/server` 里做重渲染，断言两次拿到同一个数组引用。

---

## 说明与遗留

- 三个测试文件用了 `mock.module`（`react-markdown` / `@tmex/ui/dialog` / `@tmex/ui/input`）。Bun 的模块 mock 是进程级的，所以三处都**转发真实实现**、只做计数或 props 捕获；`bun test` 全量跑过确认没有污染其它用例（`markdown-preview.test.tsx` 的 hljs 断言、`tool-call-card.test.tsx` 等全绿）。
- U12 的 memo 只在调用方 props 稳定时才真正生效。`pane-row-content.tsx` / `window-row-header.tsx` 上游的 `onRenamePane` 等回调是否稳定不在本任务文件范围内，未改；EX1 的 U6（mesh 侧栏三处不稳定引用）落地后收益才完整。
- 未触碰：`weixin-*` / `telegram-*` / `terminal-settings-panel.tsx` / `files/*` / `device-console/*` / `code-viewer/*`。
- 全程无 git 操作、未起 dev server、未碰 9883 / `~/Library/Application Support/tmex/` / 名为 `tmex` 的 tmux session。

## 改动文件清单

源文件：
- `packages/panels/src/markdown/streaming-markdown.tsx`
- `packages/panels/src/agent/messages/tool-call-card.tsx`
- `packages/panels/src/agent/messages/tool-brief.ts`
- `packages/panels/src/settings/use-terminal-shortcuts-editor.ts`
- `packages/panels/src/settings/shortcut-list.tsx`
- `packages/panels/src/settings/directory-picker-modal.tsx`
- `packages/panels/src/device-tree/use-row-action-items.ts`

测试（新增 4 个 / 追加 3 个）：
- `packages/panels/src/markdown/streaming-markdown.render.test.tsx`（新）
- `packages/panels/src/agent/messages/tool-call-card.dialog.test.tsx`（新）
- `packages/panels/src/settings/shortcut-list.test.tsx`（新）
- `packages/panels/src/device-tree/use-row-action-items.test.tsx`（新）
- `packages/panels/src/agent/messages/tool-brief.test.ts`（追加）
- `packages/panels/src/settings/use-terminal-shortcuts-editor.test.ts`（追加）
- `packages/panels/src/settings/directory-picker-modal.test.tsx`（追加）
