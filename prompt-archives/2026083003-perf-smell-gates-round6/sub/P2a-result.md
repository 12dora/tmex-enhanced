# P2a 结果 — 终端 I/O 路径：单趟 LF 规范化、history 批量重排、有界输出合并

## 1. LF 规范化改单趟 + 复用暂存区

`packages/terminal-ui/src/components/normalization.ts`

旧实现对每个 live 块扫两遍（先 `for...of` 数裸 LF，再分配新数组 `for...of` 抄一遍），
每块一次分配。现实现：

- `indexOfBareLF()` 用下标循环扫到**第一个**裸 LF；整块没有裸 LF 时原样返回入参（零拷贝，
  与旧实现在该分支的行为一致）。
- 有裸 LF 时只从该位置起改写：前缀用 `set()` 整段搬一次，其余逐字节补 CR，写进
  常驻暂存区 `normalizeScratch`（≤256 KiB 复用，超过则单独分配，避免被 MB 级
  history 正文永久撑大），返回 `subarray(0, writeIndex)` 视图。
- `endedWithCR` 只取决于最后一个字节，空块沿用上一块状态；`previousEndedWithCR` 跨块语义不变。

返回值可能是复用暂存区的视图，只在下次调用前有效。两个调用点
（`writeLiveOutput` → `terminal.write()`、`buildCanonicalSnapshotPayload` → `concatChunks`/
`terminal.write()`）都是同步消费，`bindings.writeVt` 同步拷进 WASM，安全；已在函数文档注释里写明。

**等价性**：测试文件里保留旧的两趟实现作参照，1000 组随机分块（字母表 `LF/CR/A/B/ESC/NUL`，
1~5 块、每块 0~23 字节，固定种子可复现）逐字节 + `endedWithCR` 全等。另加「无裸 LF 返回同一对象」
「空块沿用 CR 状态」「超暂存区上限走独立分配」三个用例。

**测量**（`bun packages/terminal-ui/bench/normalization.bench.ts`，10 MiB / 320 × 32 KiB，10 轮中位数）：

| 载荷 | 旧（两趟） | 新（单趟） |
| --- | --- | --- |
| 裸 LF（`y\n`） | 180.3 ms | **7.8 ms**（23×） |
| 已是 CRLF（`y\r\n`） | 102.7 ms | **8.1 ms**（13×） |

（X2 报告基线 192–194 ms，同量级。提升里既有「省掉第二趟 + 每块分配」，也有把
`for...of`（迭代器）换成下标循环的收益。）

## 2. history 分页批量重排

`packages/terminal-ui/src/components/TerminalSurface.ts`

`commitHistoryPage()` 不再每页立刻 `writeSnapshot()`，改为攒一个显示帧窗口
（`HISTORY_BATCH_MS = 16`，可通过新增的 `scheduleHistoryFlush` option 注入，测试用）：

- **末页立即落地**：`nextCursor` 为空说明不会再有页，等窗口只是白等一帧。
- **预算耗尽立即落地**：`rejectHistoryPage()` 的 limit 分支（页数/字节上限）也立刻 flush。
- **live 输出前强制落地**：`write()` 先 `flushHistory()` 再写 live 字节。重排会 `reset()`
  终端，顺序反了 live 字节会被清掉——这条保证了 live/history 的交织顺序与改动前逐字节一致。
- `replace()` / `dispose()` 清掉 pending（页随快照作废）；已排的定时器到点时是空操作。
- `getNextHistoryCursor()` 仍在 commit 时立刻更新，续拉请求不被窗口拖慢。

**观测行为变化**（任务允许）：同一窗口内成串到达的页只重建一次终端，中间态不再逐页闪一遍；
非末页的可见延迟最多 +16 ms。真正成串到达的场景：sink 挂载时 `PaneSinkRegistry` 一次回放
最多 16 页、快链路上的连续分页。慢链路上一次只有一页在途时，行为与改动前等价（等 16 ms 后重排）。

**测试**：新增「22 页成串到达只触发一次重建」（数 `reset` 次数 = `writeSnapshot` 次数）、
「live 输出到达时先落地攒着的 history 再追加字节」（含窗口到点不重复重建、live 不被清掉）；
原「每页到达都重建一次终端」改写为「一个窗口内到达的多页只重建一次」；其余用例补上显式
`runScheduled()` 驱动窗口。

**测量**（`bun packages/terminal-ui/bench/history-paging.bench.ts`，新增真实 ghostty parser 段，
22 页 × 126 KiB，`HeadlessTerminal` + RIS 复位）：

- 逐页重建：**527.8 ms**
- 整批一次重建：**44.8 ms**（11.8×）

与 X2 报告的 522–542 ms → 45–46 ms 吻合。原有的纯拼装段（64 页 × 128 KiB）未受影响。

## 3. 输出合并器改有界调度

`packages/ws-client/src/pane-output-coalescer.ts`

默认调度从 `queueMicrotask` 换成 `setTimeout(flush, DEFAULT_PANE_OUTPUT_FLUSH_MS = 4)`。
原因：每条 WebSocket 消息是独立宏任务，微任务边界只能合并同一条消息里的连续帧，
实际上等于不合并（X2 实测两次 `setTimeout` 分帧推送产出两次 1 字节下发）。

- 没选 rAF：一帧 16.7 ms 的回显延迟比 4 ms 差，且 worker/测试环境没有 rAF。
- **最大附加延迟：4 ms**（浏览器定时器 clamp 下实测 ≤ ~5 ms）。攒够 32 KiB 立即同步下发；
  任何控制事件（reset / applyHistory / screenSnapshot / historyPage / rebase / sink 换绑与注销 /
  history gate 放行）都在 `PaneSinkRegistry` 里先 `flush(key)`，这条既有约束未改。
- 跨窗口暂存字节的安全性：每帧字节来自各自的解码结果，没有跨帧复用的缓冲（已核对
  `transport-message-decoder` 的 `decodePayload` 路径无共享 scratch），头部注释同步更新。

**测试**：新增「同一宏任务内的连续帧合并为一次下发」「窗口内跨宏任务到达的帧同样合并」
「控制事件的 flush 立即下发、窗口到点不补发空帧」三个用例，都跑默认调度器（真实定时器）。

受影响的既有测试（合并边界从微任务变成定时器）：`pane-sink-registry.test.ts` 的
`flushOutputs` 助手、`connection.test.ts` 的两处 `await Promise.resolve()` 改成等窗口，
均只动测试助手，未改被测逻辑。

## 文件清单

产品代码（净 +57 行）：

- `packages/terminal-ui/src/components/normalization.ts`（+36 −20）
- `packages/terminal-ui/src/components/TerminalSurface.ts`（+41 −3）
- `packages/ws-client/src/pane-output-coalescer.ts`（+8 −5）

测试 / bench：

- `packages/terminal-ui/src/components/normalization.test.ts`
- `packages/terminal-ui/src/components/TerminalSurface.test.ts`
- `packages/terminal-ui/bench/normalization.bench.ts`（新增）
- `packages/terminal-ui/bench/history-paging.bench.ts`
- `packages/ws-client/src/pane-output-coalescer.test.ts`
- `packages/ws-client/src/pane-sink-registry.test.ts`（仅 `flushOutputs` 助手）
- `packages/ws-client/src/connection.test.ts`（仅等待方式）

`packages/terminal-ui/src/components/terminal-snapshot.ts` 在 scope 内但**未改动**：它的两个
规范化调用点（`buildCanonicalSnapshotPayload` 的快照正文、`writeLiveOutput`）直接受益于
单趟实现，本身没有可去掉的多余拷贝。

## 验证

| 包 | bun test | tsc --noEmit |
| --- | --- | --- |
| terminal-ui | 323 pass / 0 fail（基线 318/0） | 0 error（基线 0） |
| ws-client | 268 pass / 0 fail（基线 262/0） | 0 error（基线 0） |
| stores（回归确认） | 325 pass / 0 fail | 未跑（未触碰） |
| apps/fe（回归确认，`bun test src/`） | 868 pass / 0 fail | 未跑（未触碰） |

`bunx biome check` 覆盖全部 10 个改动文件：无问题。
（stores/fe 的用例数高于本轮基线，是其它 agent 并行加的测试，不属本任务改动。）

## 风险与遗留

- **暂存区视图外泄**：`normalizeLiveOutputForTerminal` 返回值只在下次调用前有效。当前两个
  调用点都同步消费，注释已写明；将来若有人把结果存起来跨帧使用会静默出错。
- **history 窗口 16 ms**：非末页可见延迟 +16 ms。慢链路（一次一页在途）拿不到批处理收益，
  只是多等一帧——收益集中在 sink 挂载回放与快链路连续分页。
- **输出延迟 +4 ms**：低吞吐输入下的回显最多晚 4 ms。若实测手感有回退，把
  `DEFAULT_PANE_OUTPUT_FLUSH_MS` 调小或对小载荷走立即下发即可（单常量）。
- history bench 用 `\x1bc`（RIS）代替 `terminal.reset()`：`HeadlessTerminal` 没有 reset API，
  两者对解析耗时的量级影响可忽略，但不是逐位等价的复位。
