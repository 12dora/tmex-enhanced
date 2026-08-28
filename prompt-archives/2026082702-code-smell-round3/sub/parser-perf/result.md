# parser-perf 结果

## 背景

热路径：每个 tmux control-mode `%output` 块先 `unescapeControlModeData`，再进 `pane-stream-parser.push`。原实现每字节 switch + `number[]` push，最后再拷成 `Uint8Array`；unescape 即使没有反斜杠也整段分配；DCS passthrough 结束时用 `processByte` 逐字节递归回放。

## 改动

### unescape

- `indexOf(0x5c)` 扫描；**无反斜杠时直接返回 `line.subarray(start)`**（零拷贝 view）。
- 有反斜杠时先 `set` 拷前缀，再走原来的逐字节八进制解码（避免密集体 escape 上反复 `indexOf`+`set` 短 run）。
- `notifications.ts` 调用签名未变，未改该文件。

### pane-stream-parser

- 输出改为可增长 `Uint8Array`（`ParserOutput`），plain run 用 `buf.set` 整段拷贝。
- `normal` / OSC body / screen-title / DCS body 按区间扫描；只有控制序列进 handler。
- `findFirstOf2` 先 SIMD `indexOf` 主终止符，再在 `[start, limit)` 线性找次终止符，避免「找不到 BEL 就扫到 chunk 末尾」的 O(n²)。
- 同一 chunk 内完整的 `ESC [` CSI：整段 `writeRun` 透传，并仍收集 params 以识别 `?2031`。
- tmux passthrough flush 不再 `processByte` 递归；inner content 入栈迭代扫描；DCS 前缀用 `dcsPrefixLength` + `TMUX_PASSTHROUGH_PREFIX_BYTES`，mismatch 时 `writeRun` 回填。

未做 unescape+parser 单 pass：control-mode 行帧与 pane 解析阶段不同，融在一起可读性差。

## 文件

| 路径 | 说明 |
|---|---|
| `apps/gateway/bench/pane-stream-parser.bench.ts` | 新建，`bun run bench:parser` |
| `apps/gateway/package.json` | 增加 `bench:parser` |
| `apps/gateway/src/tmux-client/control-mode/unescape.ts` | 无反斜杠快路径 |
| `apps/gateway/src/tmux-client/control-mode/unescape.test.ts` | 新建：view 身份、行尾 `\`、offset |
| `apps/gateway/src/tmux-client/pane-stream-parser.ts` | 区间扫描 + 输出缓冲 + passthrough 栈 |
| `apps/gateway/src/tmux-client/pane-stream-parser.test.ts` | chunk 切在 ESC / CSI / DCS prefix / 加倍 ESC |
| `apps/gateway/src/tmux-client/pane-stream/parser-state.ts` | `ParserOutput`、write helpers、`dcsPrefixLength` |
| `apps/gateway/src/tmux-client/pane-stream/{normal,esc,csi}-handler.ts` | 写缓冲而非 `number[]` |
| `apps/gateway/src/tmux-client/pane-stream/tmux-passthrough-handler.ts` | 去递归、前缀 index |
| `apps/gateway/src/tmux-client/pane-stream/*.test.ts` | 适配新 context 形状 |

## 基准（1 MiB，`performance.now()`，heap 仅供参考，受 GC 噪声影响）

BEFORE（优化前）：

| 输入 | 吞吐 | 粗略堆/iter |
|---|---|---|
| parser/plain-ascii | 75.8 MB/s | 1.65 MiB |
| parser/ansi-heavy | 41.8 MB/s | 噪声 |
| parser/osc-kitty-clipboard | 28.4 MB/s | 噪声 |
| parser/tmux-passthrough | 34.1 MB/s | 0.81 MiB |
| unescape/unescaped | 1382.5 MB/s | 噪声 |
| unescape/escaped | 1146.0 MB/s | ~0.03 MiB |

AFTER：

| 输入 | 吞吐 | 加速 |
|---|---|---|
| parser/plain-ascii | 1639.6 MB/s | **21.6×** |
| parser/ansi-heavy | 46.1 MB/s | **1.10×** |
| parser/osc-kitty-clipboard | 28.6 MB/s | **1.01×** |
| parser/tmux-passthrough | 38.5 MB/s | **1.13×** |
| unescape/unescaped | 40233 MB/s | **29.1×**（`indexOf` + 返回原 view，无拷贝） |
| unescape/escaped | 1129.1 MB/s | **0.99×**（与原 tight loop 持平） |

plain ASCII 是大块 `%output` 的主形态。ANSI/OSC 仍必须逐序列检查（2031 / kitty / clipboard / OSC 133），memcpy 赢面被控制序列密度吃掉。

## 测试

范围测试：`pane-stream-parser*.test.ts`、`pane-stream/**`、`control-mode/**`、`control-mode-parser*.test.ts` → **144 pass / 0 fail**。

新增：

- unescape 无反斜杠返回同源 `ArrayBuffer` view（优化前 fail，优化后 pass）
- 行尾 `\`、start offset 后的 `\`、空 payload view
- parser：ESC 后切 chunk、CSI 参数中切、`tmux;` 前缀中切、passthrough 内加倍 ESC 中间切、不完整 CSI flush

`bunx biome check --write`：范围内 12 个文件干净。

`bunx tsc --noEmit -p .`：范围内 **0 个新错误**。全包 33 个 `error TS`，均在 push/supervisor、ssh 测试、ws issue45 等范围外文件（基线 27，其它 agent 在飞）。

全包 `bun test`：1599 pass / 3 fail / 1 error。失败均与本任务无关，未修：

- `src/tmux-client/pane-history-page.test.ts`：找不到 `./pane-history-page`（其它 agent）
- `src/db/agent-watch.test.ts`：两条 query index 断言（其它 agent 的 schema）

## 未做

- unescape + parser 单 pass（可读性）
- OSC/kitty 密集输入的进一步加速（瓶颈在 payload 解码 / `atob` / 回调，不是拷贝）
- 改 `notifications.ts` 调用点（API 兼容，无需改）
