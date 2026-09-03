# GK 结果：T11 WebRTC 直连单片零拷贝

## 结论

击键帧（`total === 1`）不再进 Map / order / `slice` / 二次拼接。返回的是入参的 payload 视图，契约与主 ws 路径 `decodeEnvelopeView` 一致：调用方不得改写，也不得跨回调长期持有。多片在末片一次性分配输出、每片只拷一次。网关 inbound 去掉冗余 `copyBytes`。

未做 datachannel 用户态压缩（EX1「不值得做」：直连卖点是 RTT，再加 deflate 是拿唯一长处换通常不需要的字节）。

## node-datachannel 缓冲生命周期

`node-datachannel` 0.33.1 `src/cpp/data-channel-wrapper.cpp` 的 `onMessage`：

```cpp
auto bin = std::get<rtc::binary>(std::move(message));
args = {Napi::Buffer<std::byte>::Copy(env, bin.data(), bin.size())};
```

每条二进制消息都 `Napi::Buffer::Copy` 出**独立、JS 持有的 Buffer**，回调返回后不复用。`pendingFrames` 留存视图是安全的。9 字节 liveness 探针只在回调内 `parseLivenessChunk` 读完，不留存，无需另拷一份。

因此 inbound 路径可以 0 拷：`toUint8Array(msg)`（Buffer 即 Uint8Array，恒等）→ `assemble` 单片返回 `subarray` 视图。

## 改动文件

- `packages/shared/src/link/fragment-core.ts`：`total===1` 早退；多片存视图、末片一次 `set`；`expire` 空表 / `now < earliestDeadline` 早退
- `packages/shared/src/link/fragment-core.test.ts`：零拷贝 / 多片逐字节 / 乱序 / 过期 / 微基准
- `apps/gateway/src/mesh/rtc/data-channel-carrier.ts`：去掉 inbound `copyBytes`，注释所有权
- `apps/gateway/src/mesh/rtc/data-channel-carrier.test.ts`：视图共享 `buffer`；无监听时排队的视图在回调返回后仍有效

未改 `websocket-link.ts`、`*peer-manager*`、`liveness.ts`、`direct-carrier-controller.ts`。

## 微基准（同一脚本，Bun 1.3.14 / Apple Silicon）

| 场景 | 改前 | 改后 | 加速 |
|---|---:|---:|---:|
| 70 B 击键（total=1） | 266.4 ns | 98.5 ns | 2.7× |
| 32 KiB 帧（total=1） | 3447.8 ns | 89.9 ns | 38× |
| 两片重组（~64 KiB + 100 B） | 6786.7 ns | 3245.4 ns | 2.1× |

32 KiB 从「两次 memcpy」变成「只读 8 字节头」，与 70 B 同量级。两片仍需末片一次拼接拷贝，省掉的是每片 `slice()`。

## 测试 / tsc / biome / gate

| 项 | 改前 | 改后 |
|---|---|---|
| `cd packages/shared && bun test src/link` | 60 pass / 0 fail | **66** pass / 0 fail |
| `cd apps/gateway && bun test src/mesh/rtc` | 161 pass / 0 fail | **163** pass / 0 fail |
| shared `tsc --noEmit` | 1（`locale-consistency.test.ts` 预存） | **0** |
| gateway `tsc --noEmit` | 0 | **0** |
| `bunx biome check`（本任务 4 文件） | — | 通过 |
| `bun scripts/complexity/gate.ts` | — | **ok**（1284 files / 11887 functions） |

所有权断言：单片 `out.buffer === chunk.buffer`，改源字节对消费者可见（与 `decodeEnvelopeView` 相同）；多片输出是新缓冲，改源不可见。

## 未能完成

无。
