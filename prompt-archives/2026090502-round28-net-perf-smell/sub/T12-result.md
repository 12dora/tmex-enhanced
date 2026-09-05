# T12：ChatThread 复杂度门禁归零

- 起因：T5 加入行级 content-visibility 包裹 + rAF 滚动合帧后，`ChatThread` 从 134 行涨到 155 行，超出 allowlist 锁定值。
- 处理：不动 allowlist，按职责拆成两个同级模块，`ChatThread` 仅保留装配与 JSX。
- 新增 `packages/panels/src/agent/use-chat-scroll.ts`：吸底 / 上滚冻结 / 窗口展开的全部 ref、state 与副作用收进 `useChatScroll(blocks, running)`，一并搬走 `windowStartIndex`、`isPinnedToBottom`、`stickToBottom`、`bottomAnchor`、`restoreBottomAnchor`、`createScrollCoalescer` 等纯函数。
- 新增 `packages/panels/src/agent/chat-thread-rows.tsx`：`threadRows`、`CHAT_ROW_SKIP_RENDER_THRESHOLD`、跳渲样式，以及新的 `ThreadRows` 组件（原来内联的 `flex flex-col` 行包裹层与 rowStyle 判定）。
- `chat-thread.tsx` 原样 re-export 上述公开符号，测试与 `agent-tab.tsx`/`index.ts` 的 import 路径零改动，DOM 结构与 props 语义未变（`onScroll` 只是 `handleScroll` 改名后的同一函数）。
- 结果：`ChatThread` 75 行（限 134），`useChatScroll` 84 行、`threadRows` 35 行、`ThreadRows` 12 行，均在默认阈值内；三个文件分别 117 / 72 / 190 行。
- 验证：`cd packages/panels && bun test` → 949 pass / 0 fail；`bunx tsc --noEmit -p packages/panels` 无错误。
- 验证：`bunx biome check` 三个改动文件干净；根 `bun run lint` → biome 2716 文件无问题、`complexity gate ok`（0 violation，只剩既有的 near-limit 提醒）。
- 遗留：allowlist 里 `chat-thread.tsx:ChatThread: 134` 条目已远高于实测值，可在后续统一 `--tighten` 时收紧，本轮按要求未改。
