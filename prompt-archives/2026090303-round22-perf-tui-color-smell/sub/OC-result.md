# TASK OC 结果：F8 + F5 + G2

worktree `/Users/konata/code/tmex-r22`，分支 `feat/round22-perf-tui-color-smell`。

## 一句话结论

**F8 与 G2 已完成并全绿；F5 无法在不改他人文件的前提下完成，已放弃并给出可直接执行的补救步骤（见 §F5）。**

---

## F8 —— `createTmuxStore` 抽出窗口/pane 域动作

### 改动

| 文件 | 动作 | 行数 |
|---|---|---|
| `packages/stores/src/tmux-window-actions.ts` | 新建 | 123 |
| `packages/stores/src/tmux-window-actions.test.ts` | 新建 | 118 |
| `packages/stores/src/tmux.ts` | 改 | 303 → 222 |

新模块与已有三个 `tmux-*-actions.ts` 完全同构：`export type TmuxWindowActions = Pick<TmuxState, ...>` + `export interface TmuxWindowActionsDeps` + `createTmuxWindowActions(core, deps)` 返回纯对象，在 `tmux.ts` 里以 `...createTmuxWindowActions(core, { setState: set, paneSubscriptions })` 展开，位置紧跟已有的 `...createTmuxViewportActions(...)`。

搬走的 15 个动作（逐字搬移，无逻辑改动）：

- 结构增删改：`createWindow`、`clearPendingCreateWindow`、`closeWindow`、`closePane`、`renameWindow`、`splitPane`、`renamePane`、`movePane`、`breakPane`
- 终端输入：`sendInput`、`paste`
- pane 数据订阅门面：`subscribePanes`、`mountPane`、`requestPaneScreen`、`fetchPaneHistory`

留在 `tmux.ts` 的仍是装配根职责：`shouldSkipDuplicateConnect` / `sendWindowStyleForCurrentTheme` / `handleReady` / `setupTransportHandlers`（selectMachine 回调 + 事件路由 + 主题订阅）+ 状态字段 + 设备错误面（`clearDeviceError` / `hydrateDeviceErrors`）+ 对三个 actions 模块的转发。

`deps` 只吃 `setState` 与 `paneSubscriptions` 的 4 个方法（`Pick<PaneSubscriptionManager, ...>`），不吃 `getState`，依赖面比 `tmux-device-actions` 更窄。

### 度量

| 指标 | 改前 | 改后 |
|---|---:|---:|
| `tmux.ts` 行数 | 303 | 222 |
| `createTmuxStore` 函数行数 | 277 | **195** |

allowlist 里 `packages/stores/src/tmux.ts:createTmuxStore` 的锁值 `lines=277` **未动**（common 规则禁止手改 allowlist）。锁值高于实测值不会触发违规，但下次 `bun scripts/complexity/gate.ts --tighten` 会把它收到 195 —— 请指挥官知悉：EX4 §1.7 「本轮 `--tighten` 无 diff」的结论因此失效。

### 为什么没有停在「只搬窗口结构动作」

只搬 9 个结构动作只能把 `createTmuxStore` 压到 226 行，离 backlog §2.8 的「~180 行」目标差得远。把同样操作窗口/pane 的输入下发与 pane 订阅门面一并搬走后到 195 行，模块语义仍然内聚（都是「对某个 window/pane 做一件事」的下发层，无本地状态，除 `pendingCreateWindowAt` 一处记账外均为纯 transport/subscription 转发）。

### 新增测试

`tmux-window-actions.test.ts` 4 个用例、10 个断言，锁住三件事：命令下发形状（9 条命令逐条比对）、守卫子句（空 `deviceId`/`paneId`、`movePane` 自移动一律静默返回且不发命令）、`pendingCreateWindowAt` 的写入/删除语义（`clearPendingCreateWindow` 用 `delete` 而非置 `undefined`，断言 `'d' in state === false`）、pane 订阅门面的透传参数（含 `fetchPaneHistory` 的 `cursor` 缺省为 `null`）。

这些守卫此前只有间接覆盖（`pane-subscriptions.test.ts` / `tmux-shared-transport.test.ts`）。三个既有的 `tmux-*-actions.ts` 都没有直接单测，本次新增没有改变它们。

---

## G2 —— `terminal-pointer` 破环

### 改动

| 文件 | 动作 | 行数 |
|---|---|---|
| `packages/ghostty-terminal/src/terminal-pointer-shared.ts` | 新建 | 99 |
| `packages/ghostty-terminal/src/terminal-pointer.ts` | 改 | 132 → 58 |
| `packages/ghostty-terminal/src/terminal-pointer-handlers.ts` | 改 | 仅 2 行 import 重定向 |

`terminal-pointer-shared.ts` 收纳叶子内容：7 个 `GHOSTTY_MOUSE_BUTTON_*` 常量、`SYNTHETIC_MOUSE_SUPPRESS_MS`、类型 `InputRoutingState`/`MouseInputState`/`MouseInputRequest`/`TerminalLinkHit`/`PointerEventContext`、函数 `createMouseInputState`/`mouseButtonFromEvent`/`mouseButtonFromButtons`。唯一外部依赖是 `./types` 的 `GhosttyViewportGesture`（type-only）。

`terminal-pointer.ts` 现在只剩 `bindMouseEvents`（注册/注销，注释里的「注册顺序是行为契约」原样保留）+ 对 shared 的全量 re-export。

**re-export 是刻意的**：`terminal.ts`、`terminal-input-bridge.ts`、`terminal-links.ts`、`terminal-render-coordinator.ts`、`terminal-pointer.test.ts` 五个文件都从 `./terminal-pointer` 取这些符号，其中 `terminal-render-coordinator.ts` 明确被告知另有 agent 在改 —— 用 re-export 保住导入路径，这五个文件一行未动。

### 验证环已断

写了一次性脚本（仅统计值导入，`import type` 不计）扫 `packages/ghostty-terminal/src` 全部非测试 `.ts`：改前报 `terminal-pointer.ts <-> terminal-pointer-handlers.ts`，改后输出 `no 2-node value cycles`。

现在的边：`terminal-pointer → terminal-pointer-handlers → terminal-pointer-shared`，`terminal-pointer → terminal-pointer-shared`，无回边。

---

## F5 —— `writeTextToClipboard` 合一：**未做，被 package 边界挡住**

### 为什么做不了

任务说明假定「`packages/ghostty-terminal/package.json` 已依赖 `@tmex/shared`」。**实测不成立**：

```
packages/ghostty-terminal/package.json → devDependencies 只有 typescript，无 dependencies 字段
packages/ghostty-terminal/node_modules/ → 只有 typescript
```

本仓 bun 用的是 isolated node_modules（每包一份 `node_modules`，`@tmex/*` 按 package.json 声明逐包 link，仓库根 `node_modules` 下**没有** `@tmex` 目录）。因此在 `selection-clipboard.ts` 里写 `import { writeTextToClipboard } from '@tmex/shared'` **运行时直接解析失败**，不是风格问题而是硬失败。

且 `selection-clipboard.ts:57-58` 的既有注释已经把这条边界写死了：

> `// 与 @tmex/shared 的 browser-clipboard 同实现：本包是零依赖的可独立发布包，`
> `// 不能引入 workspace 私有包，故保留本地副本。`

`packages/ghostty-terminal/package.json` 带 `publishConfig.access: public` + `files: ["src"]`，而 `@tmex/shared` 是 workspace 私有包（`version 0.1.0`，无 publishConfig，未发布 npm）。加这条依赖会让 ghostty-terminal 的 npm 包在装到外部工程时缺依赖直接坏掉。

反向（让 shared import ghostty-terminal）同样要改 `packages/shared/package.json`，且会把 wasm 重包拖进 shared 的浏览器入口，更差。

按 common 规则「若认为必须改他人文件，停下并把原因写进结果文件」，我没有动 `package.json`，`selection-clipboard.ts` 与 `browser-clipboard.ts` 两个文件保持原样、零改动。

### 若指挥官决定推进，完整步骤

1. `packages/ghostty-terminal/package.json` 增 `"dependencies": { "@tmex/shared": "workspace:*" }`，并同时决定放弃「零依赖独立发布」定位（或把 `@tmex/shared` 改为可发布包）。
2. 跑一次 `bun install` 重建 link —— **注意这会动整个 worktree 的 node_modules，需等所有并行 agent 收工后再做**。
3. `selection-clipboard.ts`：删掉 `:57-92` 的 34 行副本与那两行注释，改成 `export { writeTextToClipboard } from '@tmex/shared';`。`packages/ghostty-terminal/src/index.ts:7` 的 `export { isMacPlatform, writeTextToClipboard } from './selection-clipboard'` 与 `terminal-input.ts:5` 的导入均可保持不变。
4. `packages/shared/src/browser-clipboard.ts` 无需改动（它已是保留侧）。

补充：`packages/shared/src/browser-clipboard.ts` 的 16 个既有测试全部通过，未受影响。

---

## 验收结果（全部对齐或优于基线）

| 检查 | 基线 | 改后 |
|---|---|---|
| `packages/stores` `bun test` | 435 pass / 0 fail | **439 pass / 0 fail**（+4 新增） |
| `packages/stores` `bunx tsc --noEmit -p .` | 1 error（`src/host-services.test.ts`，与本任务无关） | **1 error**（同一条） |
| `packages/ghostty-terminal` `bun test` | 280 pass / 0 fail | **280 pass / 0 fail** |
| `packages/ghostty-terminal` `bunx tsc --noEmit -p .` | 9 error（全在 `src/terminal-render-coordinator.force-repaint-shift.test.ts`，属他人在改的文件） | **9 error**（同一批） |
| `packages/shared` `bun test src/browser-clipboard*` | 16 pass / 0 fail | **16 pass / 0 fail** |
| `bunx biome check <本任务全部文件>` | — | **8 files checked, No fixes applied** |
| `bun scripts/complexity/gate.ts` | — | 唯一违规是 `packages/panels/src/settings/integration-account-form-modal.tsx:IntegrationAccountFormModal 131 > 120`，**属并行的 F9 任务，不是本任务文件**；本任务文件零违规 |

## 未触碰的文件（确认）

`canvas-renderer.ts`、`terminal-render-coordinator.ts`、`terminal.ts`、`terminal-input-bridge.ts`、`terminal-links.ts`、`terminal-pointer.test.ts`、`packages/stores/src/index.ts`、任何 `package.json`、`scripts/complexity/allowlist.json`。全程无 git 操作。
