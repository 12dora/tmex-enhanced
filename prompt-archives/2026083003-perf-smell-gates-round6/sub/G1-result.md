# G1 result — Gateway mesh forwarder leak / PaneData peek / frame-sizer bound

X3 items 1、3、7 均已在代码中核实并落地。未改 `mesh-http.ts`（close 已转给 `handleForwardSocketClose`）。未改 `canonical-feed-session.ts`（选了按 UTF-8 字节长度做 cache key，比 detach 驱逐更小）。

## 改了什么、为什么

### 1. pending stream 泄漏（X3 #1）

`handleRemoteWs` 在 browser `open` 之前把 remote stream 放进模块级 `pendingStreams`。browser 若在 `open` 前关掉，`handleForwardSocketClose` 找不到 pump 就直接 return，token 与 stream 永久残留。

- close 且无 pump 时：按 `ws.data.token` 删除 map 条目并 `stream.close()`。
- 第二层网：upgrade 成功后 15s 身份校验 TTL（`pendingStreams.get(token) === stream` 才收）；`takePendingForwardStream` / discard 清 timer。timer `unref()`，避免挂住测试进程。

### 2. PaneData 不再全量 decode（X3 #3）

`StreamReplayState.noteInbound()` 对 `PaneData` 只走 `peekCanonicalPaneDataHeader`：校验 header、抽出 device/pane/epoch/seqEnd，跳过 length-prefixed `data`，不分配 payload。其它 canonical 事件仍 `decodeCanonicalEventPayload`。畸形帧仍 throw，被现有 `catch {}` 吞掉，不写 cursor。

### 3. frame-sizer cache 有界（X3 #7）

`maxDataByKey` 改为按 `utf8ByteLength(deviceId/paneId)` + epoch 字节长度键控（结果实际只依赖这些），不再按身份字符串无限增长。

## 文件

- `packages/shared/src/ws-borsh/canonical-state.ts`（+ `canonical-state.test.ts`，`index.ts` 导出）
- `apps/gateway/src/mesh/forwarder.ts`（+ `forwarder.test.ts`）
- `apps/gateway/src/ws/canonical/frame-sizer.ts`（+ `frame-sizer.test.ts`）

## 测量（10 MiB 合成流）

scratchpad：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/g1-pane-data-peek.bench.ts`  
Bun 1.3.14 / macOS arm64。

| 合成流 | 全量 decode payload | peek payload | 旧 noteInbound（envelope+decode） | 新 noteInbound（envelope+peek） |
| --- | --- | --- | --- | --- |
| 10,240 × 1 KiB（~10.87 MiB） | 43.5 ms | 7.1 ms | 86.0 ms | 47.6 ms |
| 349 × 30 KiB（~10.25 MiB） | 32.8 ms | 0.25 ms | 66.0 ms | 34.0 ms |

replay 检查路径约降一半，与 X3 预估一致；大帧上 peek 几乎不碰 data 字节。

## 测试 / tsc / biome

- `packages/shared`：`bun test src/ws-borsh` **129 pass / 0 fail**；`tsc --noEmit` **0**
- `apps/gateway`：`bun test src/mesh/forwarder.test.ts src/ws/canonical/frame-sizer.test.ts` **53 pass / 0 fail**
- `apps/gateway`：`bun test src/mesh src/ws` **687 pass / 0 fail**（70 files）
- gateway `tsc --noEmit` **21**（等于本轮 baseline 21；G1 文件 0 条）
- `bunx biome check` 上述 7 个文件：**clean**

新增行为测试：

- upgrade → close-before-open → pending count 回到 prior，remote `closedOnce`
- expiry 身份校验：错 stream 不删不关；对上才关
- peek 抽出 header；非 PaneData 返回 null；seq mismatch / truncated / trailing 与 decode 一样 throw
- 畸形 PaneData 不改 failover cursor；合法 PaneData 仍 patch（原有用例）
- 循环 10k 个不同 id，`maxDataByKey.size < 32`；CJK 与 ASCII 同 JS 长度缓存值不同

## 残留 / 风险

- `PANE_DATA_VARIANT = 3` 与 zorsh enum 声明顺序绑定；顺序变了会测挂。
- 15s TTL：若 upgrade 成功后 `open` 超过 15s 才到，会关仍 pending 的 remote stream（正常路径 `open` 几乎立刻 `take`）。
- 个别现有用例 upgrade 后既不 open 也不 close，条目改由 TTL 回收，不再永久泄漏。
- `expirePendingForwardStream` / `pendingForwardStreamCount` 是测试缝，生产路径只用内部调用。
