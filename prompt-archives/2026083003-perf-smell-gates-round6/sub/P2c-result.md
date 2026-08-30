# P2c 执行结果 —— ws-client：TERM_OUTPUT 零拷贝解码

## 结论

X2 报告的"Borsh decoding copies live bytes twice"属实，且比报告描述更糟：`@zorsh/zorsh@0.4.0` 的
`bytes` handler 是**逐字节** `DataView.getUint8()` 循环写进新 `Uint8Array`
（`node_modules/.bun/@zorsh+zorsh@0.4.0/.../dist/src/registry.js:395-402`），
1 MiB 的 envelope payload + 1 MiB 的 `TermOutput.data` 各来一遍，
再加上 `readString()` 每次 `new TextDecoder()`。这才是 30 ms/10 帧的主因。

已按"专用的校验型快路径"实现（没有改通用 schema 解码器的语义，也没有动 `decodeEnvelope`
——它被 gateway/fe 大量复用，改成视图会外溢到本任务范围之外）。

## 改动

### packages/shared/src/ws-borsh/codec.ts（+65 行）

新增两个零拷贝解码函数，`bytes` 字段一律返回入参缓冲的 `subarray` 视图：

- `decodeEnvelopeView(data): Envelope` —— envelope 是定长头（magic2+version2+kind2+flags2+seq4+payloadLen4=16B）
  + payload，直接用 `DataView` 读头、`subarray` 取 payload。
- `decodeTermOutputView(payload): TermOutputView` —— 手写 `deviceId`/`paneId`（u32 长度 + UTF-8）、
  `encoding`(u8)、`data`（u32 长度 + 视图）；`TextDecoder` 提到模块级复用。

校验与旧路径等价（错误类型/错误码一致，仅 message 文案不同）：

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 帧 < 12 字节 / magic 错 | `WsBorshError(1002)` | 同（文案不变） |
| 帧头截断（12~15 字节） | zorsh `DataView` RangeError → `WsBorshError(1002)` | 显式检查 → `WsBorshError(1002)` |
| payload 长度前缀越界（含 0xFFFFFFFF） | 同上 → 1002 | 显式检查 → 1002 |
| TERM_OUTPUT payload 截断 / 长度前缀越界 | zorsh RangeError → `WsBorshError(1004)` | 显式检查 → `WsBorshError(1004)` |
| 尾部多余字节 | 忽略、解码成功 | 同样忽略（有对拍测试） |

`TermOutputView` 直接取 `b.infer<typeof TermOutputSchema>`，保证返回结构与 schema 解码逐字段同型。

### packages/shared/src/ws-borsh/index.ts（+3 行）
导出 `decodeEnvelopeView` / `decodeTermOutputView` / `TermOutputView`。

### packages/ws-client/src/protocol-dispatcher.ts（+2 行）
`handleFrame` 里 `decodeEnvelope` → `decodeEnvelopeView`。这样所有 kind 的 `payload` 都变成帧缓冲视图；
其余 kind 的下游（chunk 重组 / HELLO / `transport-message-decoder` 里其它 schema 解码 /
`stores/agent-event-router` / `panels/watch-events-init`）全部在同步栈内用通用（拷贝）解码器再解一遍，
不会长期持有视图，语义不变。

### packages/ws-client/src/transport-message-decoder.ts（±1 行）
`KIND_TERM_OUTPUT` 分支 `decodePayload(TermOutputSchema, …)` → `decodeTermOutputView(…)`。
其它 kind 一律保留通用解码器（Item 2）。

### 测试（新增 134 行）
- 新文件 `packages/shared/src/ws-borsh/codec-view.test.ts`（9 例）：与 `decodeEnvelope`/`decodePayload`
  的结果对拍、视图 `buffer` 同一性（旧路径断言 **不** 同一）、截断/错 magic/头部截断/长度前缀越界/
  尾部垃圾/空 data/非 ASCII deviceId、以及"整帧端到端零拷贝"（`data.buffer === frame.buffer`）。
- `packages/ws-client/src/protocol-dispatcher.test.ts` +2 例：payload 借用原始帧缓冲；payload 长度前缀
  越界的帧被丢弃（不 crash）。
- `packages/ws-client/src/transport-message-decoder.test.ts` +1 例：`terminal-data.frame.data` 是 payload
  视图；截断 / 长度前缀越界的 payload 抛错。

净行数：生产代码 +70，测试 +134。

## 测量（十帧 1 MiB TERM_OUTPUT，bun 1.3.14，M 系列 macOS）

bench 脚本：`/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/6c2fc705-32ec-470c-8790-255ad37938cd/scratchpad/p2c-bench.ts`
（解码期间把 `globalThis.Uint8Array` 换成计数子类，统计 `new Uint8Array(number)` 的字节数）。

| 路径 | 10 × 1 MiB 解码耗时 | 分配（拷贝）字节 |
| --- | --- | --- |
| before：`decodeEnvelope` + `decodePayload(TermOutputSchema)` | 30.89 / 31.89 / 31.62 / 31.63 ms | 20.00 MiB |
| after：`decodeEnvelopeView` + `decodeTermOutputView` | 0.04 ms（四次一致） | 0.00 MiB |

即每帧省掉 2 次全量字节拷贝，1 MiB 帧的解码从约 3.1 ms 降到约 4 µs（后续写入 WASM 的那次拷贝不在本项范围内）。

## pane-output-coalescer 复核（未修改）

`pane-output-coalescer.ts` 确实按引用暂存帧字节（`buffer.chunks.push(frame.data)`，
`concatChunks` 单块时直接返回原引用），报告描述属实，未编辑。

注意与并行任务的交互：另一个 agent 正在把 coalescer 的 scheduler 从 `queueMicrotask` 改成
`setTimeout(…, 4ms)`，于是帧字节会跨宏任务被引用最多 4 ms。这对零拷贝仍然安全——每条 WebSocket 消息
拿到的是各自独立的新 `ArrayBuffer`（`onmessage` 不复用缓冲），视图既不会被改写也不会串帧；
代价只是 4 ms 内多留住整帧缓冲（TERM_OUTPUT 的 data 本来就占整帧绝大部分，可忽略）。

## 验证

- `packages/shared`：`bun test` → 374 pass / 0 fail（基线 365，+9 新增）；`bunx tsc --noEmit -p .` → 0 error。
- `packages/ws-client`：`bunx tsc --noEmit -p .` → 0 error；
  我改动的文件 `bun test src/protocol-dispatcher.test.ts src/transport-message-decoder.test.ts
  src/client.test.ts src/carrier-switch.test.ts` → 75 pass / 0 fail。
  在并行 agent 动 coalescer 之前的整包 `bun test` → 265 pass / 0 fail（基线 262，+3 新增）。
- `bunx biome check <7 个改动文件>` → 无问题。
- 交叉验证（未改这些包）：`apps/gateway/src/ws/borsh/session-state.test.ts` 6 pass；
  `packages/stores/src/agent-event-router.test.ts` 13 pass。

## 已知的非本任务失败（供交叉核对，勿归因于本项）

- `packages/ws-client` 整包现有 5 个失败（`pane-sink-registry` 4 例 + `connection.test.ts` 1 例），
  全部是 `flushOutputs()` 微任务刷新假设被并行 agent 的 coalescer `setTimeout` 改动打破所致，
  与 borsh 解码无关（我改动的文件单独跑全绿）。
- `apps/fe` `bun test src/` 现有 1 个失败：`SettingsPage 标签栏 > \`?tab=\` 选中对应标签的面板`，
  来自并行 agent 对 `SettingsPage.tsx/test.tsx` 的改动，与本项无关（fe 其余 865 pass）。

## 风险

- 手写 wire 解析与 schema 存在漂移风险：`EnvelopeSchema` / `TermOutputSchema` 的字段顺序或类型若变更，
  必须同步改 `decodeEnvelopeView` / `decodeTermOutputView`。`codec-view.test.ts` 里所有用例都与通用
  schema 解码器**对拍**，schema 一旦变动，这些测试会立刻失败提示。
- 视图的使用约束已写进 codec.ts 的注释：调用方不得改写返回的视图、不得跨帧长期持有。
  当前所有消费者（coalescer → 终端写入 WASM）都满足。
