# F-chat：修复 review-fe-chat-report.md 的三条 should-fix

## 1. 动作依赖快照不再在渲染期写入
`packages/panels/src/agent/use-agent-tab-actions.ts`

- `deps.current = {...}` 从渲染体移到提交后的 effect：模块级 `useCommitEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect`（无 DOM 的 SSR / bun test 降级成 `useEffect`，避免 React 警告），依赖数组 `[state, view, navigate, host, setSidebarTab]`。`useRef` 的初值仍是首帧快照（属于初始化写入，允许）。
- 效果：A→B 会话切换的那一帧若被中断/丢弃，屏幕上仍属于 A 的按钮不会打到 B 上（send/stop 走错会话）。

`packages/panels/src/agent/composer-isolation.test.ts`

- 拆出 `depsOf(state)`（一次渲染算出的快照）与 `commit(ref, state)`（提交才写 ref），测试不再靠「渲染即写 ref」。
- 新增中断帧断言：提交 s1 → 只 `depsOf(s2)` 不提交 → `onStop()` 仍停 s1 → 提交 s2 后才停 s2，期望 `['s1','s1','s2']`。
- 「50 次 flush 后 composer props 0 次变化」的断言原样保留（改用 `commit`）。

## 2. 未吸底时冻结渲染窗口
`packages/panels/src/agent/chat-thread.tsx`

- 新增导出纯函数 `windowStartIndex(total, windowSize, frozenStart)`：`frozenStart === null` 时起点 = `max(0, total - windowSize)`（吸底，最近 200 条）；非空时起点冻结并夹到 `max(0, total-1)`（会话切换块数缩水时不越界）。
- 新增 state `frozenStart`：`handleScroll` 里一旦不吸底就记下当前起点，重新吸底置 null；`scrollToBottom`（跳到底部）也置 null，窗口回到最近 200 条。
- 「显示更早」两态都可用：冻结态把 `frozenStart` 前移一个 `WINDOW_STEP`，吸底态仍是 `windowSize += WINDOW_STEP`；锚点回写的 `useLayoutEffect` 依赖加上 `frozenStart`，滚动锚定行为不变。
- 效果：用户上滚阅读时新块只往下追加，首个可见块不会被顶掉。

`packages/panels/src/agent/chat-thread.test.tsx`：新增 `windowStartIndex` 的纯函数用例（吸底跟随 / 冻结不动 / 显示更早前移 / 缩水夹取）。

## 3. 落在 500 行上限之外的选中文件
`packages/panels/src/files/files-tab.tsx`

- `DirNode` 里读 `useSelectedFilePath()`；仅当该目录条目数超过 `DISPLAY_CAP` 且选中项属于本 root 时，把上限撑到选中项的下标（`Math.max(DISPLAY_CAP, idx + 1)`），`hidden`/`visible` 改用这个 `cap`。
- 效果：路由直达第 1000 项时该行真实挂载并高亮，不再需要用户先点「显示其余」。未超上限的目录不做 `findIndex`，正常路径零额外开销。

`packages/panels/src/files/files-tab.test.tsx`：`renderExpandedRoot` 增加可选 `selectedPath`，用 `hostAppPath(runtime.host, fileRoute(...))` 设置 `MemoryRouter` 初始路由；新增用例断言 2000 项中选中第 1000 项时该行存在、共挂 1000 行、剩余 1000 项收在「显示其余」后。

## 验证
- `cd packages/panels && bun test`：**606 pass / 0 fail**（基线 604，新增 2 个用例）
- `bunx tsc --noEmit -p .`：**0 error**（基线 0）
- `bunx biome check` 六个改动文件：Checked 6 files, no fixes applied
- 净行数：+98 / −39（其中 composer 测试 57 行属改写，非净增）

## 备注 / 风险
- bun test 无 DOM，第 1 条只能在「渲染 vs 提交」的语义层测；真正的并发中断需要浏览器/DOM 环境（仓库无 happy-dom / testing-library，本轮不引入依赖）。
- 冻结窗口期间新块会持续挂载在窗口下方（起点冻结、终点不封顶）；这是保证「跳到底部」即时可用的取舍，阅读会话内增量有限。
