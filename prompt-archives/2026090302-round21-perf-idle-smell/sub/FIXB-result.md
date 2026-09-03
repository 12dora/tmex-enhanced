# FIX-B（前端懒加载边界健壮性）执行结果

分支 `feat/round21-perf-idle-slim` / worktree `/Users/konata/code/tmex-r21`。五条问题全部落地，每条都补了测试。

## 1（MED）监视对话框 chunk 加载失败会炸掉整条路由

`packages/panels/src/watch/deferred-watch-dialog.tsx` 整体重写：去掉 `React.lazy` + `Suspense`，
换成与 `deferred-terminal-settings-sheet` 同一套机制——显式 loader（`loadWatchDialog`，成功缓存组件、
失败不缓存）+ 有限次就地重试（`loadAttempt` 触发 effect 重跑）+ 兜底整页刷新。

兜底条**直接复用**既有实现：`import { MAX_SHEET_LOAD_RETRIES, TerminalSettingsFallback, type TerminalSettingsFallbackView } from '../device-console/deferred-terminal-settings-sheet'`。
`TerminalSettingsFallback` 只认一个 view 对象，本身与终端设置无关，可以原样用；新增的
`watchDialogFallbackView(failureCount)` 复用现成 i18n key（`watch.rules.loadFailed` +
`settings.terminal.loadFailedHint` + `settings.terminal.reloadApp`），**没有新增任何 i18n key**
（locale 源文件不在本任务可动范围）。未失败时该函数返回 `null`，模态框保持「加载中什么都不显示」的原语义。

新增测试注入点 `setWatchDialogImporterForTests`（bun test 无 DOM，真 WatchDialog 走 Base UI portal 渲染不了）。

## 2（MED）拖拽 chunk 首次失败后永不重试

`packages/panels/src/device-tree/device-tree-dnd.tsx`：

- `requestDeviceTreeDnd()`：统一的加载请求入口，失败计数 + 指数退避重排下一次（`dndRetryDelayMs`：
  800ms 起翻倍、封顶 30s），自动重试次数封顶 `MAX_DND_AUTO_RETRIES = 4`（发版后旧 chunk 404 时浏览器
  把失败 URL 记进 module map，就地重试没用，不能无限空转）。
- 模块级 `readyListeners` 广播：重试可能由别的列表 / 手柄交互 / 退避定时器发起，`useDndImpl` 订阅广播
  而不是只 await 自己那一次 promise，否则会漏掉别处的成功。
- **交互即重试**：空样板的 `dragHandleProps` 挂上 `onPointerDown` / `onKeyDown` → `requestDeviceTreeDnd()`，
  不受退避次数限制、并抢在待办退避之前发起。这不改 DOM 结构（手柄本来就在），侧栏里**不加任何错误 UI**。

## 3（MED）拖拽实现落地时重挂子树，清掉真实局部状态

**结论：「保持树深度不变」在 React 语义下做不到，只能提升状态。** 理由两条：

1. React 以元素 `type` 判定复用，空壳分支的占位组件与 `DndContext`/`SortableContext` 类型不同，
   即使凑成同样深度也照样卸载重挂；这两个组件本身就在懒加载 chunk 里，加载前根本拿不到。
2. 更硬的一条：`useSortableRow` 空样板是 0 个 hook，真实现（`useSortable`）是一串 hook。
   若子树**不**重挂，同一个组件实例上换实现会直接抛「渲染的 hook 比上次多」。
   也就是说这次重挂是当前设计的正确性前提，不能消除（消除它要把 device-row / window-row / pane-row /
   `apps/fe` 的 app-sidebar 全改成 render-prop 桥接，那些文件不在本任务范围内）。

因此按任务给出的第二方案落地：新增 `packages/panels/src/files/show-all-entries.tsx`，把 `DirNode` 的
`showAll` 提到 `SortableVerticalList` **之上**（`FilesNodeRoots` 里 `SelectedFileProvider` →
`ShowAllEntriesProvider` → `SortableVerticalList`）。发布方式与 `selected-file` 一致：外部 store +
`useSyncExternalStore` 逐节点按自己那一位布尔订阅，撑开一个目录不会惊动其余目录。

副作用（有意）：目录折叠再展开后 `showAll` 仍然保持——与展开态本身持久化在 fileTree store 里的行为一致。
菜单/点击被重挂吞掉的隐患仍然存在（见上面的不可消除性），但那条路径上没有可丢的持久状态。

## 4（LOW）功能关掉仍预热 watch chunk

`page-actions.tsx` 提出 `watchAvailable = Boolean(model.watchUi && model.deviceId && model.resolvedPaneId)`，
**同一个值**既决定 `DeferredWatchDialog` 渲不渲染，也作为 `useWatchDialogPreload(enabled)` 的开关。
hook 内部委托给可测的纯函数 `schedulePreloadWatchDialog(enabled, schedule?)`：关掉时一次空闲调度都不排。

## 5（LOW）同一个根下换文件会惊动该根所有目录节点

`selected-file.tsx`：`useSelectedPathInRoot` → `useSelectedChildPath(rootId, dirPath)`，
派生值改为「选中文件是不是**该目录的直接子项**」。`DirNode` 的 `entries` 就是直接子项，
`entries.findIndex(e => e.path === selected)` 只可能命中直接子项，所以行为完全等价，但未受影响的目录
快照恒为 `null`，`useSyncExternalStore` 直接 bail。`useLocation()` 仍然只在 provider 读一次，
本轮早先去掉逐行 `useLocation()` 的成果未回退。

- 同目录内换文件（`src/a.ts` → `src/b.ts`）：只有 `src` 一个节点的快照变。
- 跨目录换文件：只有得失选中子项的那两个目录变。

## 测试

新增/扩充：

- `packages/panels/src/watch/deferred-watch-dialog.test.tsx`（重写）：失败不缓存、下一次请求重新 import、
  并发只发一次、兜底 view 的三档（0 次失败无 UI / 首次失败给重试+刷新 / 到上限只留刷新）、
  `schedulePreloadWatchDialog` 的开关语义。
- `packages/panels/src/device-tree/device-tree-dnd.lazy.test.tsx`（追加）：退避时长指数增长+封顶、
  失败后排重试而不是躺平、自动重试封顶、失败后再请求会重发 import 且成功清零、
  空样板手柄带 `onPointerDown`/`onKeyDown` 且触发会真的再试一次。
- `packages/panels/src/files/selected-file.test.ts`（追加）：`selectedChildPath` 只认直接子项、
  根 `/` 与末尾多余分隔符、同目录/跨目录换文件时到底哪几个节点的快照会变。
- `packages/panels/src/files/show-all-entries.test.tsx`（新增）：重挂后仍读到已展开的上限、
  撑开一个目录不改其余目录快照、订阅者只在真有变化时被唤醒、缺 provider 直接报错。

结果：

- `packages/panels`：**786 pass / 0 fail**（改前 765 pass，净增 21 条）。
- `apps/fe`：`bun test src/` **1744 pass / 0 fail**。
- `bunx tsc --noEmit -p .`：`apps/fe` 0 错；`packages/panels` 自身 0 错，
  仅剩 `packages/ws-client/src/canonical-state-client.ts` 的若干错（**不是我的文件**，其他 agent 在改）。
- `bunx biome check` 改动文件：通过。
- `bun scripts/complexity/gate.ts`：唯一剩余违规是
  `packages/ws-client/src/direct/direct-carrier-controller.ts: 1133 lines > 1114`（同样是其他 agent 的在途改动），
  我的文件无违规，未动 allowlist。

## 首屏包体

用「把我改过的文件临时 `git show HEAD:` 还原再 build」的方式，隔离出本次改动自身的增量
（其余 agent 在途改动会让绝对值漂移）：

| 变体 | entry gzip |
| --- | --- |
| 当前 worktree，我的文件全部还原到 HEAD | 346,529 B |
| 只带问题 2/3/5 的改动 | 346,769 B（+240） |
| 全部改动（含问题 1/4） | 347,552 B（+1,023） |

最终 build 实测 **347,609 B**（`apps/fe/dist/index.html` 里的入口是 `assets/index-Cs5W3NjL.js`；
数值与上表 347,552 的差是期间其他 agent 又落了改动）。基线口径 345,670 B 与当前 worktree 的 346,529 B
之间那 859 B 不是我造成的。

**+783 B 全部来自问题 1**，原因明确：`DevicePage` 是懒加载的，所以
`deferred-terminal-settings-sheet` 原本待在 DevicePage chunk 里；而 `DeferredWatchDialog` 经常驻侧栏的
`device-tree-dialogs` 是首屏可达的，复用那边的兜底条就把该模块拽进了 entry。
自己在 watch 里再写一份内联兜底条大约能省 400 B，但那正是任务明令禁止的「第二套机制」，所以没做。
用 783 B 换掉「一次 chunk 404 就替换掉整条路由且永不恢复」，这笔账是划算的。

懒加载边界未回退，已核验：`assets/device-tree-dnd-impl-*.js`、`assets/sortable.esm-*.js`、
`assets/watch-dialog-*.js` 仍是独立 chunk；entry 里 grep `DndContext|SortableContext|useSortable\b|DndDescribedBy`
零命中（只有门面自己的属性名 `useSortableRow`），@dnd-kit 没有被拉回首屏。

## 改动文件

- `packages/panels/src/watch/deferred-watch-dialog.tsx`（重写）
- `packages/panels/src/watch/deferred-watch-dialog.test.tsx`（重写）
- `packages/panels/src/device-tree/device-tree-dnd.tsx`
- `packages/panels/src/device-tree/device-tree-dnd.lazy.test.tsx`
- `packages/panels/src/device-console/page-actions.tsx`
- `packages/panels/src/files/selected-file.tsx`
- `packages/panels/src/files/selected-file.test.ts`
- `packages/panels/src/files/files-node-roots.tsx`
- `packages/panels/src/files/show-all-entries.tsx`（新增）
- `packages/panels/src/files/show-all-entries.test.tsx`（新增）
