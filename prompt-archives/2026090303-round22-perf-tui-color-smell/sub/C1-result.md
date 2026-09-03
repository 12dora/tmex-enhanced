# C1 执行结果

## 完成内容

- `packages/shared/src/ws-borsh/codec.ts`
  - 新增 `encodeTermOutputFrame` 与 `encodeCanonicalEventFrame` 融合编码器，使用精确长度 `Uint8Array`、`DataView` 和批量 `set()` 一次构造完整 frame。
  - PaneData 之外的 canonical event 保持原 schema 编码路径；通用 `encodePayload`、`encodeEnvelope` 保留为 reference 实现。
  - 在不修改非授权 barrel 文件的前提下，通过现有 `encodeEnvelope` 的静态成员向 `@tmex/shared` 消费方暴露快路径。
- `packages/shared/src/ws-borsh/canonical-state.ts`
  - `peekCanonicalPaneDataHeader` 现在同时返回指向原 payload 的 `data` subarray，并继续执行规范编码、协议版本和序列区间校验。
- `apps/gateway/src/ws/legacy-feed-broadcaster.ts`、`apps/gateway/src/ws/index.ts`
  - legacy TERM_OUTPUT 热路径改为直接编码完整融合 frame；超出协商帧上限时，从融合 frame 取 payload view 进入原 CHUNK 流程，并复用已消费的 original seq。
  - 同一轮广播按 per-session seq 缓存不可变 frame；seq 相同的客户端共享同一 buffer，seq 不同则分别编码。单客户端不创建缓存 Map。
  - canonical PaneData 发送切换到融合编码器。
  - 入站完整 `decodeEnvelope` 改为 `decodeEnvelopeView`；payload 会进入异步 handler，因此在边界保留一次 bulk `slice()` 所有权拷贝。
- `packages/ws-client/src/canonical-state-client.ts`
  - PaneData 先走 `peekCanonicalPaneDataHeader`，其他 event 回退完整 schema decode。
  - coalescer 的单 chunk 路径不会复制，因此仅在 PaneData 真正交付前执行一次 bulk `slice()`；gap、epoch 不匹配或重复帧不会产生无用数据拷贝。
- 测试与 bench：
  - 新增 `packages/shared/src/ws-borsh/codec-fused.test.ts`，覆盖空数据、1 B、64 KiB、最大帧、分片边界、Unicode ID、u32/u64 边界及 250 轮固定种子随机输入的逐字节等价性。
  - 扩展 canonical-state 与 canonical client 测试，含 200 轮 header/full-decode 随机字段对照、96 轮连续/重叠/重复/gap/server epoch/pane epoch/空帧行为对照，以及源 payload 改写后的交付数据稳定性。
  - gateway 测试覆盖融合 frame 跨客户端共享、seq 分叉、分片重组与 original/chunk seq 不变量，以及入站 view decoder 选择。
  - 新增 `packages/shared/bench/ws-wire-path.bench.ts`；32 KiB canonical 实际交付快路径若低于 schema 路径 20×，bench 会失败。

## 性能实测

命令：`bun packages/shared/bench/ws-wire-path.bench.ts`。环境：macOS Apple Silicon，Bun 1.3.14。数字为脚本 7 轮样本中位数。

| 路径 | 修改前 | 修改后 | 加速 |
|---|---:|---:|---:|
| TERM_OUTPUT 完整编码，64 KiB data | 437.079 µs | 3.075 µs | 142.2× |
| canonical PaneData 完整编码，32 KiB frame | 221.705 µs | 2.501 µs | 88.7× |
| canonical PaneData 解码，32 KiB frame，纯 view | 95.938 µs | 1.044 µs | 91.9× |
| canonical PaneData 解码并取得交付所有权，32 KiB frame | 95.938 µs | 1.884 µs | 50.9× |
| 入站 envelope 解码并取得 payload 所有权，1 MiB frame | 3166.535 µs | 32.137 µs | 98.5× |

## 验证结果

- 自测基线：shared `464 pass / 2 fail`，ws-client `382 pass / 0 fail`，gateway ws `332 pass / 0 fail`。
- 最终全量：
  - `cd packages/shared && bun test`：`523 pass / 2 fail`。两项失败与基线相同，均为沙箱内当前进程身份/命令行探测返回 `null`；本任务的 `bun test src/ws-borsh` 为 `159 pass / 0 fail`。
  - `cd packages/ws-client && bun test`：`394 pass / 0 fail`。
  - `cd apps/gateway && bun test src/ws`：`344 pass / 0 fail`。
- `bunx tsc --noEmit -p .`：shared、ws-client、gateway 最终均为 0 错误；不高于各自实测基线。
- `bunx biome check <11 个本任务文件>`：通过，无修改建议。
- `bun scripts/complexity/gate.ts`：`complexity gate ok (1289 files, 11893 functions)`。
- 行数门槛：`apps/gateway/src/ws/index.ts` 873 行；`packages/ws-client/src/canonical-state-client.ts` 892 行，均未越过 900 行。

## Buffer 生命周期核对

- Bun 1.3.14 随附文档确认服务端 WebSocket 基于 uWebSockets；uWebSockets 的 `send(std::string_view)` 实现会在调用内直接格式化/写入，发生 backpressure 时把未写完部分 append 到内部 buffer，不改写或跨调用借用输入 view。参考：[Bun WebSockets](https://bun.sh/docs/runtime/http/websockets)、[uWebSockets `WebSocket.h`](https://github.com/uNetworking/uWebSockets/blob/master/src/WebSocket.h#L99-L195)。
- 本地真实 loopback 实验因执行沙箱禁止 `listen` 未能运行：TCP 返回 `EADDRINUSE`，Unix domain socket 返回 `EPERM`。因此另以源码核对和 gateway 对象身份测试锁定共享行为；生产代码只共享编码后不再修改的 frame。

## 修改文件

- `packages/shared/src/ws-borsh/codec.ts`
- `packages/shared/src/ws-borsh/canonical-state.ts`
- `packages/shared/src/ws-borsh/codec-fused.test.ts`
- `packages/shared/src/ws-borsh/canonical-state.test.ts`
- `packages/shared/bench/ws-wire-path.bench.ts`
- `apps/gateway/src/ws/legacy-feed-broadcaster.ts`
- `apps/gateway/src/ws/index.ts`
- `apps/gateway/src/ws/inbound-frame.test.ts`
- `apps/gateway/src/ws/index.test.ts`
- `packages/ws-client/src/canonical-state-client.ts`
- `packages/ws-client/src/canonical-state-client.test.ts`
