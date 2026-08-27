# e2e 回归：`terminal-mouse-drag-recovery.spec.ts:173` 切窗往返只剩提示符

分支 `feat/sidebar-tabs-ui`（HEAD `b953213`），失败用例：
`apps/fe/tests/terminal-mouse-drag-recovery.spec.ts:209` —— `page.goto(otherPath)` 后
可见文本只有 `sh-3.2$` + 空行，`PANE1_READY` 永远等不到。

## 复现与定位过程

1. tip 复现：4/4 失败，失败点固定在切到第二个 window 后的首屏轮询。
2. `git bisect start b953213 3bc0746` 自动跑该用例（`-g "window round-trip"`），
   报 `fc891b7` 为 first bad。**但复核时 `fc891b7` 又能通过**——该 commit 处于
   50/50 的竞态边界，bisect 结果不可直接当作根因（详见「关于 bisect」）。
3. 在浏览器侧临时插桩（`tmux-event-router` 收到的事件、`transport-command-encoder`
   发出的命令、`usePaneSinkRegistration` 的 sink 回调、`use-pane-size-sync` 的决策），
   对比 tip 与 `f4ffb14`/`fc891b7` 的完整时间线后拿到确定证据。插桩已全部移除。

## 根因

前端（`WebSocketGatewayTransport.capabilities.atomicScreen === false`，见
`packages/ws-client/src/websocket-transport.ts:20`）走的是 **legacy TERM_HISTORY**
首屏重建路径，不是 canonical snapshot 路径。

- gateway 用 `capture-pane -S - -E - -e -J -N -p`
  （`apps/gateway/src/tmux-client/external/session-commands.ts:340`）拍整屏，
  再由 `appendCursorRestore()`
  （`apps/gateway/src/tmux-client/capture-history.ts:123`）在末尾拼
  `ESC[<paneHeight-1-cursorY>A ESC[<cursorX+1>G`。
  **这份载荷的行数与光标恢复量都以 tmux pane 的高度为基准。**
- canonical 路径早就处理了这件事：`writeCanonicalSnapshot()` 写正文前先
  `target.terminal.resize(snapshot.cols, snapshot.rows)`
  （`packages/terminal-ui/src/components/terminal-snapshot.ts:122`）。
- **legacy 路径没有这一步**：`usePaneSinkRegistration.onApplyHistory` 直接
  `normalizeHistoryForTerminal(data)` → `terminal.write(...)`，不管本地终端多高。

失败序列（tip 实测，pane `%974`）：

| t(ms) | 事件 |
| --- | --- |
| 179 | `select-pane cols=120 rows=45`（终端还没 boot，用的是 tmux 快照里的 pane 尺寸） |
| ~183 | gateway select barrier + capture，拿到 **45 行**载荷，尾部 `ESC[43A ESC[9G` |
| 238 | 终端 boot 完成，`terminal-sync-size 112x35` 上报（本地实测尺寸），置 `pendingLocalSize` |
| 252 | `TERM_HISTORY` 到达；`sink:reset:select` 时终端是 **35 行 × 112 列** |
| 253 | 45 行写进 35 行终端 → 顶部 10 行被挤进 scrollback，`viewportY=10`、`length=45`；`ESC[43A` 被裁到首行 |
| 280 | `use-pane-size-sync` 回灌 effect 才跑到，因 `pendingLocalSize` 命中守卫 → `resize:false`，画面再没人修 |

于是 `readVisibleTerminalText()` 读 `viewportY..viewportY+rows`，`PANE1_READY`
（绝对行 0）落在视口上方 10 行的 scrollback 里，只剩 `sh-3.2$` + 34 行空行。

对照 `f4ffb14`（通过）：boot 后没有那次早到的 `terminal-sync-size`，
`use-pane-size-sync.ts:123` 的回灌先跑到（`resize:true`），把本地终端拉到
120×45 并顺带 `fetchPaneHistory`，45 行载荷正好装满 → `viewportY=0`；
随后 post-select 的 112×35 上报再把终端缩回去（缩行只丢底部空行，内容保留）。

**结论：这不是某一个 commit 的逻辑 bug，而是「legacy 首屏几何对齐」本来就依赖
`use-pane-size-sync` 的回灌抢在 TERM_HISTORY 之前跑完这一竞态。**今天 42 个
commit 里的终端 boot / resize 上报重构（`d7151f9` 抽 resize reporter、`5090153`
终端生命周期状态机等）把 boot 后的尺寸上报提前到了 history 之前，竞态从
「基本能赢」变成「稳定输」，于是用例 100% 失败。

## 关于 bisect

`git bisect start b953213 3bc0746` 的结论是 `fc891b7`，但同一 commit 复跑通过
（`fc891b7`：1 失败 / 1 通过；`f4ffb14`：3/3 通过；tip：4/4 失败）。
bisect 落点落在竞态翻转区，只能说明「概率从这里开始变高」，不能当作引入缺陷的
commit。修复因此没有回滚任何 commit 的优化，全部保留。

## 修复

`packages/terminal-ui/src/components/terminal-snapshot.ts`

- 新增纯函数 `resolveHistoryRestoreGeometry(remote, current)`（:162）：
  远端几何缺失 / 非法 / 与当前一致时返回 `null`，否则返回要 resize 的尺寸。
- 新增 `writeRestoredHistory(target, payload, remoteGeometry)`（:173）：
  **先按 tmux pane 几何 resize，再 restoreModeSnapshot / write / forceFullRepaint**，
  与 canonical 路径的 `writeCanonicalSnapshot` 对齐；alt 屏同样对齐
  （`ESC[y;xH` 绝对定位同样以 pane 高度为前提）。

`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts`

- `onApplyHistory` 改为调用 `writeRestoredHistory`，几何取自 tmux 快照里该 pane 的
  `width/height`（`remotePaneGeometry()`，同步读 store 不订阅，避免 pane 尺寸变化
  重建 sink）——gateway 正是按这个尺寸 capture 的，是唯一权威来源。

收敛路径不变：写完后 `onReset('select')` 已排的 post-select `sync` 上报会把实测
尺寸报给 tmux，tmux 回灌新尺寸，`use-pane-size-sync` 再把终端缩回并重取 history，
最终稳定；缩行只丢底部空行，顶部内容保留。

## 测试

新增回归测试 `packages/terminal-ui/src/components/terminal-snapshot.test.ts`
（`resolveHistoryRestoreGeometry` 5 例 + `writeRestoredHistory` 4 例），核心断言是
**resize 必须早于 write，且落到 tmux pane 的行列数**。去掉修复里的 resize 一行后
该组测试 2 fail，确认能抓到这个回归。

验证结果：

- 单元：terminal-ui 307 pass / 0 fail；ws-client 100、stores 214、shared 183、
  ghostty-terminal 188、panels 347 全绿。
- `tsc --noEmit`（terminal-ui）通过；改动文件 `biome check` 干净。
- e2e（`TMEX_E2E_GATEWAY_PORT=9765 TMEX_E2E_FE_PORT=9985`，串行）：
  - `terminal-mouse-drag-recovery.spec.ts` 2/2 通过（目标用例从 21s 超时变成 3.0s 通过，复跑 2 次稳定）
  - `terminal-selection-canvas.spec.ts` 4/4 通过
  - `split-selection-persistence.spec.ts` 4/4 通过（首轮有一次 90s 超时 flake，
    单跑与整文件复跑均通过，且该用例在**未打补丁**的基线上同样是 35s 边缘用例）
  - `terminal-mouse-recovery.spec.ts` 6/7 通过；唯一失败
    `:384 focus restore repaints a cleared terminal canvas...` 已确认为**打补丁前
    就存在**的基线失败（revert 后单跑同样失败）
  - 额外回归：`ws-borsh-resize`(6)、`terminal-mouse-row-alignment`(1)、
    `terminal-render-regressions`(5)、`ws-borsh-history`(1) 全绿

工作区最终状态：`feat/sidebar-tabs-ui`，仅上述 3 个文件改动，无 commit / stash / push。
