# G10 结果 — rsync 截断次序、UTF-8 尾部裁剪、强化测试

## 做了什么

针对 review-be3：rsync 有界收集器 / UTF-8 rolling tail / 三处测试前提不足。

### 1. rsync 输入序号作最终 tie-breaker

`RankedEntry` 增加 `seq`。`compareRanked` 在 sort key 与 collator 都相等时用输入序号决胜，堆替换与 `snapshot` 排序都走该比较器。`file1`/`File1`/`FILE1`/`file01` 在截断边界保持输入顺序。

保留「先全局排序再取前 MAX_ENTRIES」的新契约；`rsync.test.ts` 原 200k 用例改名为中文并注明这不是旧的「先截前 N 再排序」兼容。

### 2. UTF-8 尾部不完整序列

`decodeRollingTail` 在去掉头部 continuation 之后用 `TextDecoder.decode(slice, { stream: true })`，截在 lead / 3 字节中段 / 4 字节中段时不再产出 U+FFFD。SSH 路径已从本文件 import，未改 `ssh-external-connection.ts`。

### 3. uplink stale-generation 测试

阻塞点从 `head()` 挪到 `applyMany()`：先走 catch-up 拿到 records，在 `applyMany` 内挂起，reset + bump generation，再以 `{ error: 'fork' }` 放行。断言无 fork 回调、无 teardown。

### 4. forwarder TTL

scaled TTL = 40 ms。先等到旧 15 s 边界（scaled +5 ms）断言流仍在，再等到 TTL 之后断言过期关闭。忽略 setter 或退回 15 s 常量都会 fail。

### 5. peer-handshake-timeout 计时器 seam

第四参 `timers`（默认 `globalThis`）。resolve / reject 路径 spy `clearTimeout` 并断言调用一次。

## 文件

- `apps/gateway/src/files/rsync.ts`
- `apps/gateway/src/files/rsync.test.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- `apps/gateway/src/mesh/uplink-key-log-sync.test.ts`
- `apps/gateway/src/mesh/forwarder.test.ts`
- `apps/gateway/src/mesh/peer-handshake-timeout.ts`
- `apps/gateway/src/mesh/peer-handshake-timeout.test.ts`

未改：`ssh-external-connection.ts`（共享 decoder）、`reconnect-control-channel.ts`。

## 测量

rsync 截断（修前）：`zzz, FILE1, file01, File1` cap=2 → `File1, FILE1`（后到的 collator 相等项挤进页）。修后 → `FILE1, file01`（与稳定 sort 一致）。

5k 行 cap=200：bounded 7.00 ms vs 全量 sort 12.00 ms，页内容一致。

`decodeRollingTail` 20k × 4KiB（头 continuation + 尾残缺 3 字节）：41.69 ms（2.08 µs/call）。`stream:true` 相对默认 decode 无额外缓冲分配。

## 验证

- G10 范围：`rsync.test.ts` + UTF-8 + handshake + uplink-key-log-sync + forwarder TTL → 均 pass；`src/files` **96 pass / 0 fail**
- `bunx tsc --noEmit -p .`（apps/gateway）→ **21 errors**（= 基线；曾因 `timers = globalThis` 变成 22，已 `as HandshakeTimeoutTimers` 收回）
- `bunx biome check` 上述 8 个文件 → **clean**

RED 已确认：rsync 截断返回 `File1, FILE1`；尾部残缺解码为 `a�` / `bcd�`；handshake spy `cleared.length === 0`。

全量 `bun test src/files src/tmux-client src/mesh`：1215 pass / 3 fail / 1 error，失败均不在本任务范围：

- `SnapshotRefreshCoordinator` 两条（quiet wait / same-tick requestImmediate）— 并行 agent 的 coordinator 改动
- `src/mesh/rtc/bulk.test.ts` 加载失败（`BULK_UPLOAD_QUEUE_BUDGET_BYTES` 未导出）— 并行 agent 的 bulk 改动
- 另：`local-external-connection.test.ts` 的 `concurrent snapshot demands...` 依赖 coordinator，在 coordinator WIP 下会 `waitFor timeout`；与 UTF-8 改动无关

## 未做 / 风险

- 未改 SSH 连接文件：decoder 已共享。
- handshake 超时路径不 `clearTimeout`（定时器已触发）；只覆盖 inner resolve/reject。
- forwarder TTL 用 scaled 真时钟（40 ms），不用 fake timers；与 `bootMesh` 真实 I/O 兼容。
