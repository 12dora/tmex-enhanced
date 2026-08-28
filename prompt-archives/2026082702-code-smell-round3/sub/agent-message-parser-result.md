# agent-message-parser 拆分 + tmux reorder 去 O(n²)

## 任务 1：`parsePersistedMessages` 提纯

**新增** `packages/stores/src/agent-message-parser.ts`（纯解析层，无 store 依赖）：

- `isRecord` / `extractText` / `unwrapToolOutput`（含 `UnwrappedToolOutput`）从 `agent-thread.ts` 平移过来；
- `parseUserMessage(seq, content): UiThreadBlock | null`；
- `parseAssistantParts(seq, content): UiThreadBlock[]`（string content 与 parts 数组两种形态，内部 `parseAssistantPart` 逐 part 判定）；
- `applyToolResult(part, calls): boolean`（单个 `tool-result` part 按 `toolCallId` 回填，未配对返回 `false`）；
- 组合函数 `parsePersistedMessages(messages): ParsedPersistedMessages`（`{ blocks, toolBlocksById }`）。

类型 `UiToolCall` / `UiThreadBlock` 一并移入解析层，`agent-thread.ts` 通过 `export type { ... } from './agent-message-parser'` 与 `export { ... }` 原样再导出，故 `packages/stores/src/index.ts` 的 `export * from './agent-thread'` 及现有外部 import（`agent-event-router.ts`、`agent-state.ts`、`agent-delta-buffer.ts`、`agent-history-sync.ts`、panels/fe）全部无需改动。

`agent-thread.ts` 从 259 行降到 113 行，只剩 inProgress 合并（`buildThreadBlocks`）、`emptyInProgress`、`maxMessageSeq`、`lastUserMessageText`。原 82 行 / CC≈18 的函数被拆成 4 个 ≤22 行、CC≤7 的小函数。

**行为差异（均为收紧，向更安全一侧）**：

1. 原实现里 `tool-result` 缺失 `toolCallId` 时会退化成用 `''` 去查表，若历史中存在 `toolCallId: ''` 的 tool-call 会被误配对；现在缺失/非 string 直接忽略。
2. `tool-call` part 的 `toolCallId` 为空串时不再登记为块（原会生成一个永远无法配对的块）。

**新增测试** `packages/stores/src/agent-message-parser.test.ts`（35 个用例，表驱动）：
`parseUserMessage` 7 例（string / text parts 换行拼接 / 畸形 part / 空内容 / 非数组对象 / undefined）；
`parseAssistantParts` 8 例（string、空 string、非数组、text+reasoning+tool-call 混排、空文本 part、畸形 part 且 key 索引保持、`toolName` 缺省回落 `unknown`、tool-call 原样携带 input）；
`applyToolResult` 8 例（text / error-json / execution-denied / 原始返回值 / 不匹配 id / 缺 id / 非 tool-result / 非 record）；
`parsePersistedMessages` 5 例（角色矩阵有序输出、结果未配对、`content` 非 ModelMessage record、未知 role 与 tool content 非数组、同 id 重复 tool-call 以后者为配对目标）。
`agent-thread.test.ts` L57–121 未改动，仍通过。

## 任务 2：reorder 的 O(n²)

`packages/stores/src/tmux.ts`：

- `reorderWindows`（原 L280）：`session.windows.filter((w) => !windowIds.includes(w.id))` → 先 `const requested = new Set(windowIds)`，filter 里 `!requested.has(w.id)`；
- `reorderPanes`（原 L360）：`Set` 提到 `session.windows.map(...)` 之外构建一次（原先每个 window 迭代都会跑一遍 `includes`），filter 改用 `requested.has(p.id)`。

`known` 侧本来就走 `Map`，未动；重复 id、未知 id 的既有语义保持不变。

**新增测试** `packages/stores/src/tmux-reorder.test.ts`（7 个用例，复用 `tmux-reselect-retry.test.ts` 的 core mock 模式）：200 窗口部分重排（前 100 逆序 + 后 100 保持原序）、200 窗口全量重排、未知 id 丢弃、空列表 no-op；200 pane 部分重排且不影响同快照其他 window、未知 pane id 丢弃、未知 windowId 不改快照。同时断言下发的 `reorder-windows` / `reorder-panes` 命令。

## 验证

- `cd packages/stores && bun test` → **156 pass / 0 fail**（基线 121，新增 35）。
- `cd packages/stores && bunx tsc --noEmit -p .` → 仅剩既有的 `src/host-services.test.ts(93,23)` 错误，无新增。
- `cd packages/panels && bunx tsc --noEmit -p .` → 0 错误；`cd apps/fe && bunx tsc --noEmit -p .` → 0 错误。
- `bunx biome check --write`（5 个文件）→ 干净，仅格式化了两个新测试文件。

## 改动文件

- 新增 `packages/stores/src/agent-message-parser.ts`
- 新增 `packages/stores/src/agent-message-parser.test.ts`
- 新增 `packages/stores/src/tmux-reorder.test.ts`
- 修改 `packages/stores/src/agent-thread.ts`
- 修改 `packages/stores/src/tmux.ts`（仅 reorderWindows / reorderPanes 两处）
