# P1a 结果 — Agent 对话流：历史解析缓存 / 行 memo / 有界窗口 / rAF 吸底

## 改了什么

### 1. `buildThreadBlocks()` 不再每次 flush 全量重解析（X1 item 2）

`packages/stores/src/agent-thread.ts`

- 新增模块级 `WeakMap<AgentMessageDto[], HistoryCache>`，按 `messages` 数组引用缓存
  `parsePersistedMessages()` 的结果（`base` 块数组 + `toolCallId → 下标` 索引）。
- 流式 tool-result 不再原地改写历史块，改为写时复制：`patchResolved()` 只克隆一次数组、
  只替换命中的那一个 `tool-call` 块（新块 + 新 `call` 对象），其余块对象引用原样保留；
  补丁结果存进缓存的 `patched`，同一结果再次 flush 直接命中、不再产生新对象。
- `base` 与 `patched` 分开：`inProgress` 为 `undefined` 时仍返回未打补丁的 `base`，
  与改造前语义一致，且解析出的历史对象永不被外部改动污染。
- 流式尾部（live tool-call / reasoning / text）按 `inProgress` 段对象引用走
  `WeakMap` 缓存：`agent-delta-buffer` 只替换正在增长的那个段对象，其余段跨 flush
  保持同一个块对象 → React.memo 能命中。
- `messages ?? []` 换成模块级 `EMPTY_MESSAGES` 常量，否则每次调用新建数组会让 WeakMap 失效。

`packages/panels/src/agent/agent-thread-blocks.ts`（1 行）：`buildBlocksWithConfirmations()`
在无待确认项时直接返回 `merged`，省掉每次 flush 对全量块建 `Set` 的 O(n) 扫描。

`use-agent-tab-model.ts` 未改动：`blocks` 的 `useMemo` 依赖不变即可，缓存做在纯函数层，
不需要再加一层 hook 级缓存（少写代码）。

### 2. 行组件 memo 化（X1 item 1）

- `messages/{user-message,assistant-message,reasoning-block,tool-call-card}.tsx`：
  导出的行组件包一层 `React.memo`（无任何逻辑改动）。
- `chat-thread.tsx` 新增导出的纯函数 `threadRows(blocks, confirmationByToolCallId, onDecide)`，
  ChatThread 渲染直接用它；key 一律取 `block.key`（消息/块 id，非 index）。
- `onDecide` 上游 `useAgentTabActions()` 每次渲染新建，会击穿 `ToolCallCard` 的 memo；
  ChatThread 内用 latest-ref + `useCallback` 稳定成常量引用后再下发
  （与 `connection-indicator.tsx` 已有的 render 期写 ref 写法一致）。

### 3. 有界窗口（item 3）

默认只渲染最后 200 个块，顶部出现「显示更早的 N 条消息」按钮，每点一次 +200。
展开前记录「距底距离」`scrollHeight - scrollTop`，`useLayoutEffect` 在提交后按同一锚点
回写 `scrollTop`，视口内容不跳。无虚拟化库。

新 i18n key `agent.panel.showEarlier`（zh_CN / en_US / ja_JP 三份，带 `{{count}}`），
已跑 `bun run build:i18n` 重生成 `resources.ts` / `types.ts`。

### 4. 吸底改 rAF 合并（item 5）

pinned 时不再每次提交都读 `scrollHeight` 写 `scrollTop`，改为最多一帧调度一次
（`frameRef` 去重，回调里再确认仍 pinned），卸载时 `cancelAnimationFrame`。
「用户上滚 ⇒ unpin + 显示回到底部按钮」的判定抽成导出的纯函数 `isPinnedToBottom()`，
阈值 48px 与行为完全不变。

## 测量

`packages/stores/bench/agent-thread.bench.ts`（新建，`bun run packages/stores/bench/agent-thread.bench.ts`），
2000 条消息（user/assistant 交替，assistant 带 text + tool-call，共 3001 块）× 500 次 flush：

| 实现 | 总耗时 | 每次 flush |
| --- | --- | --- |
| 改造前（每次 flush 全量重解析） | 77.8–80.2 ms | 0.156–0.160 ms |
| 改造后（WeakMap 按 messages 引用缓存） | 8.6–8.7 ms | 0.017 ms |

约 9 倍；剩余开销主要是每次 flush 把 3000 个历史块与尾部拼成新数组（纯指针拷贝），
块对象本身零分配。

渲染侧：`chat-thread.test.tsx` 的 2000 条历史 + 50 次 delta 场景下，按 React.memo 默认
浅比较语义统计，50 次 flush 累计只有 50 次行重渲染（每帧 1 行，即流式尾行）；
改造前这里是 2001 行 × 50 次全量重渲染。叠加有界窗口后 DOM 里始终只有 ≤200 行。

## 测试 / 类型 / lint

- `packages/stores`: `bun test` 325 pass / 0 fail（基线 321，新增 4 个缓存行为测试，
  含用 `toBe` 断言历史块跨 flush 标识稳定、补丁不污染 base、重复 flush 不产生新对象）。
  `bunx tsc --noEmit -p .` 1 error（= 基线，`host-services.test.ts` 既有）。
- `packages/panels`: `bun test` 595 pass / 0 fail（含新建 `chat-thread.test.tsx` 5 个用例）。
  `bunx tsc --noEmit -p .` 我负责的 `src/agent/**` 0 error。
- `apps/fe`: `bun test src/` 868 pass / 0 fail；`bunx tsc --noEmit -p .` 0 error。
- `packages/shared`: i18n 相关测试通过；tsc/测试各有 1 处失败，来自其他 agent 正在改的
  `src/ws-borsh/canonical-state.ts`（缺 `peekCanonicalPaneDataHeader` 导出），与本任务无关。
  `packages/panels` 的 tsc 里同样能看到别的 agent 在改的
  `device-management/device-card.test.tsx`、`ghostty-terminal/src/render-state.ts` 报错，均非本任务。
- `bunx biome check <改动文件>`：clean。

## 行数

| 文件 | +/- |
| --- | --- |
| `packages/stores/src/agent-thread.ts` | +99 / −42 |
| `packages/panels/src/agent/chat-thread.tsx` | +116 / −36 |
| `packages/panels/src/agent/agent-thread-blocks.ts` | +1 / −0 |
| `packages/panels/src/agent/messages/*.tsx`（4 个 memo 包装） | +20 / −9 |
| 生产代码合计 | **+236 / −87（净 +149）** |
| 测试 `agent-thread.test.ts` | +95 / −1 |
| 测试 `chat-thread.test.tsx`（新建） | 145 行 |
| bench `agent-thread.bench.ts`（新建） | 96 行 |

## 需要知道的取舍与风险

1. **缓存以「`messages` 数组引用不变 ⇒ 内容不变」为前提**。store 里历史更新一律换新数组，
   成立；但如果将来有人原地 `push`/改写已有 `messages` 数组，UI 不会更新。
   `agent-thread.test.ts` 里原有的第二个用例正是先 `makeMessages()` 再改内容——它每次
   返回新数组所以不受影响，这一点已确认。
2. **同一代 `messages` 内，流式补上的 tool-result 会「粘住」**：改造前若某次 flush 的
   `inProgress.toolCalls` 里那条已被清掉，该 tool-call 会退回 pending 显示；现在保持已解决。
   这是更正确的行为（不闪回转圈），且历史增量落库时 `messages` 换新数组即回到权威状态。
3. **有界窗口默认 200 块**：切会话不会重置窗口大小（新会话块数远小于 200，无影响）。
   如果以后加针对「历史里第 N 条消息」的 e2e，需要先点「显示更早」。当前仓库无 agent 相关 e2e。
4. **bun test 无 DOM**，滚动/点击类行为无法端到端断言。因此把可测的部分做成了纯函数
   （`isPinnedToBottom`、`threadRows`）+ `react-dom/server` 静态渲染断言窗口切片，
   rAF 调度与滚动锚点回写只有代码层保证，未被自动化测试覆盖——这是本项唯一的测试缺口。
5. 未动 `streaming-markdown.tsx` 与 composer（归其他 agent）；X1 item 3/4 不在本任务范围。
