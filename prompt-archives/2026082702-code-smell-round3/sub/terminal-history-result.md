# TerminalSurface / terminal-snapshot：history 分页重写与校验拆分

## 结论速览

- 改动文件：`TerminalSurface.ts`、`terminal-snapshot.ts`、新增 `terminal-history-validation.ts`，配套测试三份，新增 `bench/history-paging.bench.ts`。
- 验证：`bun test` **233 pass / 0 fail**（基线 205，新增 28）；`bunx tsc --noEmit -p .` **0 错误**；`bunx biome check` 全部干净。
- 终端字节流**逐字节不变**（先写特征化测试固定，再改实现，全程绿）。
- 基准（64 页 × 128 KiB）：write 调用 **4288 → 64**（-98.5%），重排耗时 **≈133 ms → ≈21 ms**（-84%），字节量 263.4 MiB 未变——原因见下节，这是分页方向决定的，不是实现遗留。

## 一、与任务描述的一个事实性偏差（重要）

任务要求「后续页只做 append（按正确顺序）追加到终端」。**这在本仓库的分页语义下不成立**，证据：

- `apps/gateway/src/tmux-client/pane-history-reader.ts:224` `const lineStart = beforeLine - selectedRows;`，`:242` `nextCursor: lineStart > 0 ? ... : null`；
- `pane-history-reader.test.ts:43/49` 断言连续两页 `lineStart` 为 3、1。

即 gateway 的 history 是**自新向旧回溯**，行号 0 是最老的一行，每到一页 `lineStart` 递减。终端渲染顺序必须是「行号升序（最老在上）→ 快照正文（当前屏在最下）」，所以**新到的一页永远要插到已渲染内容的最前面**。终端只有 append 原语，没有向 scrollback 顶部插入的能力，因此每页到达都必须 reset + 整屏重排，单次代价 O(i)、滚到底总代价 O(P²) —— 这是**语义上不可消除的**，除非改变「每页到达即刻可见」的产品行为（例如攒到最后一页再渲染，但页是随用户滚轮逐页拉的，中间页必须立刻可见）。

因此本次把优化落在「同一次重排内部」，把 O(P²) 的 **WASM 调用次数与 JS 规范化开销**降到 O(P)，字节量保持不变并如实记录。

## 二、改动内容

### 1. 重排批量化（`terminal-snapshot.ts`）

- 新增 `buildCanonicalSnapshotPayload(snapshot, historyPages)`：一次性拼出「清屏前缀 + 升序 history + 快照正文」的完整载荷。
- `writeCanonicalSnapshot` 由「前缀 / 每页正文 / 每页 `\r\n` / 正文」共 `2P+2` 次 `terminal.write()` 改为**单次 write**；`reset` / `resize` / `restoreModeSnapshot` / `forceFullRepaint` 的次数与顺序原样保留（仍是每次重排各一次，最后一次必要重绘）。
- 每页规范化字节用 `WeakMap<GatewayPaneHistoryPage, Uint8Array>` 缓存：`TextDecoder.decode` + 两次正则改写此前每次重排都要对全部页重做（O(P²) 字符串开销），现在每页只算一次。页对象是 `TerminalSurface` 持有的稳定副本，`replace()` 丢弃数组后条目自然被 GC。

副作用：单次 write 意味着少了 `2P+1` 次 `renderCoordinator.schedule()`，也不再有重排中途被 rAF 刷上屏的中间态。

### 2. `applyHistoryPage` 拆分（`TerminalSurface.ts`，原 CC≈18）

新增 `terminal-history-validation.ts`，`validateHistoryPage()` 返回判别联合：

```ts
type HistoryPageValidation =
  | { ok: true }
  | { ok: false; action: 'recover';     reason: HistoryPageRejectionReason }
  | { ok: false; action: 'stop_paging'; reason: HistoryPageLimitReason };
```

- `recover`（7 种）：`pane_mismatch` / `pane_epoch_mismatch` / `cursor_pane_epoch_mismatch` / `history_epoch_mismatch` / `line_end_mismatch` / `inverted_line_range` / `next_cursor_mismatch`；
- `stop_paging`（2 种）：`page_limit_reached` / `byte_limit_reached`。

原实现里「结构性断链要重取首屏」与「容量到顶只停止分页」两类失败混在三段 `if` 里，现在类型上就分开了，且结构性判定**优先于**容量判定（有测试固定）。`applyHistoryPage` 降到 CC 3，只在校验通过后才落状态：

```
applyHistoryPage → historyValidationContext() → validateHistoryPage() → rejectHistoryPage() | commitHistoryPage()
```

`bytesEqual` 一并移入校验模块（原 `TerminalSurface.ts` 内只有这一处用）。

### 3. 插入顺序

`push + sort((a,b)=>a.lineStart-b.lineStart)` 改为 `insertHistoryPage()`：找第一个 `lineStart` 更大的位置插入，找不到则 push。行号相同时先到者仍在前，与原「push + 稳定排序」结果**完全一致**（不是直接 `unshift`，避免同 `lineStart` 空页时与旧行为产生差异）。

## 三、测试

先写特征化测试（对当前实现 12/12 绿），再改实现，改完仍 12/12 绿：

- `TerminalSurface.test.ts`（新增，12 例）：以真实的 `writeCanonicalSnapshot` / `writeLiveOutput` 接入假终端，断言**每次页到达后终端收到的完整字节流**（如三页倒序到达后为 `ESC[2J ESC[H l1..l6 current`）、cursor 推进、reset/resize/repaint 计数、CR 状态复位、live 续写、alt-screen 模式位与尺寸、乱序页触发恢复、页数/字节上限只停分页不恢复、`replace` 清空累积、`dispose` 后不再写、64 页累积后行号升序。
- `terminal-history-validation.test.ts`（新增，13 例）：逐个 rejection reason 直测，含「结构性失败优先于容量失败」。
- `terminal-snapshot.test.ts`（更新）：多页拼接、空页只贡献一个换行；原「四次 write」的断言改为「一次 write、字节相同」——这是本次唯一的可观测行为变化（调用边界，非字节内容）。

> 说明：特征化测试断言的是**写入字节流的拼接结果**而非 write 调用边界，因为调用边界正是本次要优化掉的东西；字节流才是渲染语义的不变量。调用次数在 `terminal-snapshot.test.ts` 里另行断言为 1。

`window.__tmexE2eXterm` 相关文件（`useTerminalBootSurface.ts`、`Terminal.tsx`、`useTerminalResize.ts`）未触碰。

## 四、基准数据

`packages/terminal-ui/bench/history-paging.bench.ts`（纯 `performance.now()`，假终端统计调用数与字节数），跑法：

```
cd packages/terminal-ui && bun run bench/history-paging.bench.ts
```

64 页 × 128 KiB、80×24（8 MiB 上限下 64 页的满载工况），三次运行：

| 实现 | write 调用 | 交给终端的字节 | 耗时 |
| --- | --- | --- | --- |
| legacy（逐页 write + 每次重排重新规范化） | 4288 | 263.4 MiB | 147.2 / 133.3 / 127.6 ms |
| batched（本次实现） | 64 | 263.4 MiB | 19.8 / 21.1 / 21.1 ms |

- write 调用 **-98.5%**（4288 → 64，即 `2P+2` 每页降为 1 每页），对应同等数量级的 WASM FFI 进出、入参拷贝与渲染调度减少；
- CPU 耗时 **-84%**（≈133 ms → ≈21 ms），省掉的是 O(P²) 的 `TextDecoder` + 正则改写，剩下的主要是 O(P²) 的 memcpy；
- 字节量不变，理由见第一节：新页恒更旧、终端无法向上插入。

## 五、需要上游确认的发现（超出本次改动范围，未动代码）

用 `ghostty-wasm` 绑定直接建终端做了一次探针：`createTerminal(80, 24, max_scrollback)` 分别传 `10000 / 100000 / 1000000`，各写入 20000 行 78 列文本后读 `readScrollbar()`，**三者结果完全相同**：`{ total: 1153, offset: 1129, len: 24 }`。

即实际保留的 scrollback 恒为约 1129 行，与 `useTerminalBootSurface.ts:27` 的 `TERMINAL_SCROLLBACK = 10000` 无关（`ghostty-wasm.ts:500` 把它写进 `GhosttyTerminalOptions.max_scrollback`）。若该观测成立，有两个后果：

1. 客户端最多累积 8 MiB / 64 页 history，但终端只留得下约 1129 行；重排是「最老在上」写入，被挤掉的恰好是用户刚滚上去要看的**最老**内容——深层 history 可能根本不可见；
2. 上述 O(P²) 字节量里，绝大部分是写进去立刻被淘汰的。

我没有 zig 侧源码可查（仓库内无 `.zig`），无法判定 `max_scrollback` 的单位（字节 or 行）与该构建是否忽略此字段，故**只报告不下结论**，也未据此改任何行为（相关文件 `useTerminalBootSurface.ts` 亦在本次禁改范围内）。建议由 ghostty-terminal 的 owner 验证；若属实，`MAX_SURFACE_HISTORY_BYTES = 8MiB / 64 页` 的预算与 scrollback 容量应对齐，届时字节量问题会自然消失大半。
