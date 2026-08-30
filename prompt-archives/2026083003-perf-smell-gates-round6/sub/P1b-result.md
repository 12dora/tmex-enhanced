# P1b 执行结果 — 流式 markdown 增量分块 / 输入区隔离 / persist 写盘门控

## 1. 流式 markdown：增量分块（X1 item 3）

`packages/panels/src/markdown/streaming-markdown.tsx`

- 块级 memo（`MarkdownBlock = memo(...)`，props 只有 `content` 源字符串）改动前**已存在**，本轮保留不动：内容未变的块用同一字符串值命中浅比较，不会被 ReactMarkdown 重 parse。key 继续用块序号而非内容（内容做 key 在重复段落时会撞 key），memo 的比较键本身就是 `content`。
- 新增增量分块 `advanceMarkdownSplit(prev, text)`：
  - 只有「以 `\n` 结尾、且在围栏外的空行」才是**终局边界**，其之前的块被封口（`sealed`）后不会再被追加改写；末行没有换行符时它的空白与否还可能被下一段 delta 改写，所以不能据它封口。
  - 因此每次 delta 只从 `openStart`（最后一个未封口块的起点）重扫，`openStart` 处必不在围栏内（封口的前提就是围栏外）。
  - 新文本不以上次文本为前缀（切会话、重放）时自动退回全量扫描。
- `splitMarkdownBlocks(text)` 保留为 `advanceMarkdownSplit(EMPTY_MARKDOWN_SPLIT, text).blocks`，对外行为不变。
- 组件里用 `useRef` 承载上次分块结果；`advanceMarkdownSplit` 对同一文本幂等，并发/StrictMode 下重复求值结果一致。

### 测量（150 KB 答案、1 KB delta、151 次）

脚本：`<scratchpad>/md-bench.tsx`（`bun run`，含 warmup）

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| 仅分块（151 次累计） | 42.8 ms | **2.5 ms**（−94%，17×） |
| 端到端：分块 + 只 parse 未命中 memo 的块（SSR 模拟 memo 缓存） | 464.7 ms | **389.0 ms**（−16%） |

端到端剩下的 389 ms 基本全是「当前未封口块每次 delta 必须重 parse」的固有成本（平均 2.6 ms/delta，未超 16.7 ms 帧预算）。若要再降只能节流富文本 parse，属行为改变，未做。

### 回归测试

`packages/panels/src/markdown/streaming-markdown.test.ts`（新增，6 例）：
- 性质测试：60 篇随机文档（含 ``` / ~~~ 围栏、空行、纯空白行、表格行），按 1–7 字节随机 delta 流式追加，**每一个前缀**的增量结果都与参考全量实现逐字符相等（3.7k 次断言）。
- 非前缀输入退回全量、同文本幂等、封口块保持同一字符串值与同一 `sealed` 数组引用（memo 命中前提）。
- SSR 冒烟（临时脚本，已删）确认 `StreamingMarkdown` 渲染输出与预期一致，围栏内空行仍在同一块内。

## 2. 输入区隔离（X1 item 4）

`packages/panels/src/agent/use-agent-tab-actions.ts`、`agent-composer.tsx`

- `useAgentTabActions` 改为「ref 快照 + 恒定动作对象」：每次渲染把 `{state, view, navigate, host, setSidebarTab}` 写进 `deps.current`，动作对象只在首次渲染由 `createAgentTabActions(deps)` 建一次，之后引用恒定；各 action 在**调用时**才读 `deps.current`，不会读到旧 state。`createAgentTabActions` 独立导出，便于无 DOM 测试。
  - 没用 15 个 `useCallback`：`view.queuedItems` 是 `queued ?? []`，无 session 队列时每次渲染都是新数组，依赖数组会立刻失效。
- `AgentComposer` / `ChatInput` 都包 `React.memo`；把原来现造的 `modelPicker` / `writeModeControl` 两个 ReactNode props 删掉，改成传原始值（`modelProviderId`/`modelId`/`writeMode`/`allowControlChars`/`isOrphan`/`hasActiveSession` + 回调），JSX 下沉进 `ChatInput`，写入模式与控制字符开关抽成 memo 化的 `WriteModeControls`。`agent-tab.tsx` 传的 props 名与语义完全没变，**未修改该文件**。
- 于是 `AgentComposer` 收到的 16 个 props 全是原始值或恒定回调，流式 flush 时 memo 浅比较全部命中。

### 渲染次数测试

`packages/panels/src/agent/composer-isolation.test.ts`（新增，3 例）。bun test 无 DOM、仓库也没有 happy-dom/testing-library（不许加依赖），所以按 `React.memo` 默认比较的语义（键集合相同 + 每键 `Object.is`）直接判定：

- 50 次 delta flush（真实 `deriveAgentTabView` + `createAgentTabActions`，只改 `inProgress`）后，AgentComposer 的 props 与首次**一次都没变**（changed = 0），即额外渲染 0 次（要求 ≤1）。
- `AgentComposer.$$typeof === Symbol.for('react.memo')`。
- 动作引用恒定的同时仍作用于最新 state：换 session 后 `onStop()` 停的是新 session（`['s1','s2']`）。

## 3. persist 写盘门控（X1 item 6）

`packages/stores/src/agent.ts`

- 新增 `dedupedStorage()`：`createJSONStorage` 包一层 `StateStorage`，序列化结果与「已落盘值」相同就跳过 `setItem`；`getItem` 顺手把读到的原始串记为已落盘值，所以老用户回访、payload 未变时连首次写都省掉。`removeItem` 清空记录。
- `partialize` 加上 `AgentPersisted` 返回类型；持久化字段仍只有 `activeSessionIdByNode` / `defaultWriteMode`。

### 测量（2000 次真实 delta flush）

脚本：`<scratchpad>/persist-bench.ts`

| | setItem 调用 | 序列化写入量 |
| --- | --- | --- |
| 改前 | 2000 | 175.8 KB |
| 改后 | **0** | **0 KB** |

内存 Storage 下总耗时 4.2 ms → 4.0 ms（差异全在浏览器同步 localStorage 写上，内存实现体现不出）。

### 回归测试

`packages/stores/src/agent-persist-gate.test.ts`（新增，2 例）：
- 100 次 delta flush ⇒ `setItem` 调用数 **0**（且 `inProgress` 确实推进了）。
- 持久化字段真变化时照常落盘一次，同值重复 set 不重复写，落盘内容正确。

## 文件清单

改：
- `packages/panels/src/markdown/streaming-markdown.tsx`（+64 −8）
- `packages/panels/src/agent/use-agent-tab-actions.ts`（+59 −25）
- `packages/panels/src/agent/agent-composer.tsx`（+84 −101）
- `packages/stores/src/agent.ts`（+31 −2）

新增测试：
- `packages/panels/src/markdown/streaming-markdown.test.ts`（115 行）
- `packages/panels/src/agent/composer-isolation.test.ts`（169 行）
- `packages/stores/src/agent-persist-gate.test.ts`（105 行）

生产代码净 +102 行。增量分块本身占 +56（状态类型 + 续扫函数），动作层 ref 化占 +34（依赖快照类型 + 每个回调内取最新 state），persist 门控 +29；composer 因为删掉两个现造 ReactNode props 反而 −17。未改 `agent-tab.tsx`（props 面没变）、未碰 `chat-thread.tsx` / `agent-thread.ts` / `messages/*`。

## 验证

- `packages/panels`：`bun test` **604 pass / 0 fail**（基线 580/0；期间 files-tab 有其他 agent 在改，一度红过，最终全绿）；`bunx tsc --noEmit -p .` **0 error**（基线 0）。
- `packages/stores`：`bun test` **327 pass / 0 fail**（基线 321/0）；`bunx tsc --noEmit -p .` **1 error**，即基线里那条 `host-services.test.ts(93,23)`，与本次改动无关。
- `apps/fe`：`bunx tsc --noEmit -p .` **0 error**（确认 composer/actions 的接口改动没有外溢消费方）。
- `bunx biome check <7 个改动文件>`：无 diagnostics。
- 未执行任何 git 操作，未碰生产 tmex / `tmex` tmux session。

## 风险与留白

1. **persist 去重的跨标签页边界**：去重记录是 store 闭包里的 `lastWritten`。若另一标签页把同一 key 改成别的值，本标签页随后又设回自己上次写过的同一值，会被跳过、storage 保留另一标签页的值。改前多标签页本来就是互相覆盖的竞态，实际影响仅限「上次选中的会话 id」，可接受；真要消除需每次写前读一次 storage 比较，反而把同步读加回热路径。
2. **动作层 ref 在渲染期赋值**：`deps.current = {...}` 写在渲染体内（不是 effect），这是 latest-ref 的常规写法，保证事件回调看到的是最新一次渲染的数据。当前 agent 路径没有 `startTransition`/Suspense，被丢弃的并发渲染不会留下错误快照；若将来给 agent 状态加 transition，需要复核。
3. 端到端流式渲染的大头仍是「未封口块每次 delta 重 parse」（150 KB 全程约 389 ms / 151 次）。要再降需要在流式期间节流富文本 parse 或先渲染纯文本，属可见行为改变，本任务范围内未做，留给后续决策。
