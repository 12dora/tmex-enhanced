# packages/shared/src/ws-borsh 代码异味整改结果

范围：`packages/shared/src/ws-borsh/**` 与 `packages/shared/bench/`。未改动 `schema.ts` 线格式语义，未改动 gateway / ws-client 任何文件。

## 1. Bug：PaneData 序号区间只在编码端校验（已修）

`encodeCanonicalEventPayload()` 校验 `seqEnd - seqStart === data.byteLength`，但解码路径只做长度上限、结构与规范编码检查，因此**手工构造的原始 payload 可以带着错位的 `seqEnd` 通过解码**——下游按 `seqEnd` 推进游标就会静默丢/重数据。

- 新增 `canonical-state-validation.ts`，导出 `assertCanonicalEventSemantics(event)`（同时覆盖 `seqEnd < seqStart` 与区间长度不等两种情形），编码端与解码端共用。
- `encodeCanonicalEventPayload()` / `decodeCanonicalEventPayload()` 都调用它；解码端在规范编码校验之后、返回之前调用，错误码保持 `ERROR_INVALID_FRAME` + `retryable=false`，消息仍为 `PaneData sequence range mismatch`。
- 回归测试：`packages/shared/src/ws-borsh/canonical-state.test.ts` → `decode rejects raw payloads whose PaneData range mismatches the data length`。测试直接在合法 payload 上用 `DataView.setBigUint64` 改写 `seqEnd`（改大、改小、空 data 三种），断言解码抛错；对应 gateway 侧只测编码拒绝的用例（`apps/gateway/src/ws/borsh/canonical-state.test.ts` L217-246）保持不变。

## 2. Perf：`assertCanonicalEncoding()` 的重新序列化比对 → 单遍 reader 扫描（已替换，等价性有测试背书）

原实现每条入站命令/事件都 `schema.serialize(decoded)` 再逐字节比对。对 32 KiB 的 `PaneData` 而言，`bytes` 分支是**逐字节 `DataView.setUint8`**，成本远高于解码本身。

**等价性论证**（zorsh 0.4.0 `registry.js` / `binary-io.js` 逐节点核对）：`reencode(decode(x)) === x` 当且仅当每个节点都是「其解码值的规范编码」。除以下三类外，各节点的读写互为双射（定长整数、定长/变长 `bytes`、`vec`、`struct`、`enum` 标签合法时都原样回写）：

| 非规范来源 | 旧实现如何拒绝 | 新扫描如何拒绝 |
| --- | --- | --- |
| 尾随字节 | 重编码更短 | 扫描结束后 `offset !== byteLength` |
| `bool` 字节 > 1 | `Boolean(byte)` 回写 0/1 | 直接判 `byte > 1` |
| `option` tag > 1 | 读成 None 后回写 0 | 直接判 `tag > 1` |
| 非法 UTF-8 字符串 | `TextDecoder` 产出 U+FFFD，回写字节不同 | 手写 UTF-8 良构校验（拒绝过长编码、代理区、> U+10FFFF） |
| 长度前缀越界 | 读越界抛错 / 截断后重编码更短 | 游标边界检查 |
| 非法 enum tag | 解码即抛错 | 变体表查不到即拒绝 |
| 定长整数、`bytes(16)`、`vec`/`struct` 结构 | 双射，恒等 | 仅推进游标 |

扫描放在 `deserialize` 之后（顺序不变），因此结构性错误仍先由解码抛出 `ERROR_PAYLOAD_DECODE_FAILED`，错误码分布与改动前完全一致。

实现：`canonical-scan.ts`。schema 结构静态不变，首次使用时把 schema 树**编译成扫描闭包**并按 schema 对象 `WeakMap` 缓存，扫描期零对象分配。

**等价性测试**（`canonical-state.test.ts`）：
- `accepts or rejects exactly what the re-encode comparison did`：对 5 个代表性 payload（命令/事件、含 string / option / bool / vec / bytes / enum / unit 变体）做系统性变异（追加尾字节、截断、每个字节位改写为 `00/01/02/80/fe`），凡能成功解码的候选都要求「扫描裁决 === 旧重编码裁决」。本轮共 1000+ 组比对，其中约一半被判非规范（`rejected > 100` 已写成断言），无一处分歧。
- `rejects the known malformed encoding families`：尾随垃圾、非规范 bool、非规范 option tag、错误 string 长度前缀、非法 UTF-8、非法 enum tag、截断，逐项断言解码抛 `WsBorshError`。
- `covers every schema node reachable from the canonical envelopes`：遍历两个 envelope schema 的全部节点类型，断言扫描器都支持——将来往 schema 里引入新节点类型（如 `hashMap`、`f64`）会立即让这条测试失败，而不是悄悄漏校验。

**微基准**（`packages/shared/bench/canonical-validation.bench.ts`，`bun run packages/shared/bench/canonical-validation.bench.ts`；`deserialize` 两条路径都要付，单列出来做参照）：

| 场景 | deserialize | 重编码比对（before） | reader 扫描（after） | 提速 |
| --- | --- | --- | --- | --- |
| PaneData 64 B（141 B payload） | 1.33 µs | 2.53 µs | 0.36 µs | 6.9x |
| PaneData 4 KiB | 7.38 µs | 51.58 µs | 0.12 µs | 421x |
| PaneData 31 KiB | 93.96 µs | 355.61 µs | 0.12 µs | 2970x |
| SetPaneSubscriptions x16（1017 B） | 10.90 µs | 22.91 µs | 1.76 µs | 13.0x |
| Error 事件（41 B） | 0.59 µs | 2.64 µs | 0.31 µs | 8.6x |

即校验开销从「解码成本的 2~4 倍」降到「解码成本的 5%~25%」。

## 3. CC：`applyPaneFields()` 拆表 + legacy diff 改写时复制

**字段表**：新增 `legacy-pane-fields.ts`，导出共享的值类型守卫工厂（`numberField` / `booleanField` / `stringField` / `nullableNumberField` / `nullableStringField`）与 `PANE_FIELD_SETTERS`（`Map<number, LegacyFieldSetter<TmuxPane>>`）。`applyPaneFields()` 退化成一层 `Map.get(field)?.(pane, value)`，CC 由 ~28 降到 2。window / session 表同样用这批工厂，放在 `legacy-window-fields.ts`（`applyWindowFields` / `applySessionFields`）。`LegacyMetadataFieldValue` 类型移到 `legacy-pane-fields.ts` 并由 `state-snapshot-diff.ts` 原样再导出，`@tmex/shared` 的公开导出面未变。

测试 `legacy-pane-fields.test.ts`：表驱动覆盖全部 10 个 pane 字段的写入、6 个可空字段的 `null` 清除、值类型不匹配 / 未知字段 / `SOURCE_FIELD_PANE_EPOCH` 被忽略、同字段多次写入的顺序语义；另有一条断言「表的键集合恰好等于用例覆盖的字段集合」，防止以后加字段忘了加测试。

**写时复制**：新增 `legacy-snapshot-draft.ts`（`LegacySnapshotDraft`），`applyLegacyStateSnapshotDiff()` 缩成「建草稿 → 先 removals 后 upserts → 收敛」，外层 removal / move / upsert 的处理顺序与旧实现完全一致。

- 未被 diff 触碰的 window 对象、pane 对象、以及只改了 window 字段时的 `panes` 数组，都保持原引用；只有被触碰的对象才浅拷贝。
- pane 定位优先在**目标 window 内**直接命中（绝大多数 upsert 是原地改字段），只有跨 window 移动 / 新建 pane 时才构建全局 `id → window` 索引，构建后增量维护。
- 需要说明的一个中间结论：最初实现是「每次 apply 都建一遍全量 `id → 槽位` 索引」，实测**比旧的全量克隆更慢**（P 个 Map 条目 + P 个位置对象的分配不比 P 次浅拷贝便宜）。改成上面的「目标 window 直查 + 懒建全局索引」后才真正变快，基准数据见下。

测试：
- `state-snapshot-diff.test.ts` 新增 5 条：未触碰 window 保持 `toBe` 同一引用（同 window 内未触碰 pane 也保持引用）、只改 window 字段时 `panes` 数组不重建、移除 window 后同名 pane 的 upsert 重新创建而非复活旧对象、同一批 diff 内先删 session 再 upsert 能重建干净会话、不修改输入快照。
- `legacy-snapshot-draft.test.ts`：与旧算法（在测试内保留一份逐行等价的参考实现）做**差分测试**——500 组随机快照 × 随机 diff、以及 200 步连续 diff 的滚动应用，结果必须逐字段相等。随机 diff 会产生跨 window 移动、移动后再移回、删后重建等组合。

**微基准**（`packages/shared/bench/legacy-snapshot-diff.bench.ts`）：

| 场景 | 全量克隆 + findIndex（before） | 目标 window 直查 + 写时复制（after） | 提速 |
| --- | --- | --- | --- |
| 4 windows × 4 panes，1 upsert | 1.06 µs | 0.76 µs | 1.4x |
| 10 × 8，2 upserts | 2.67 µs | 1.20 µs | 2.2x |
| 20 × 10，5 upserts | 6.58 µs | 2.54 µs | 2.6x |
| 40 × 16，10 upserts | 19.36 µs | 4.89 µs | 4.0x |

## 4. chunk.ts：删掉失效参数与冗余调用，锁定超限策略

`cleanup(_force)` 的参数从未被使用，`addChunk()` 在函数开头已经 `cleanup()` 过一次，容量检查里的 `cleanup(true)` 在同一次调用内不可能再淘汰出新配额——是纯死代码。

选择**删除**而不是实现 `evictOldestStream()`：现网语义一直是「并发流只由超时窗口淘汰，不做 LRU 驱逐」，实现驱逐会改变协议行为（把别人正在重组的流悄悄扔掉），不属于本次整改范围。

- `cleanup(_force = false)` → `cleanup()`；删掉容量分支里的 `cleanup(true)`，超限直接抛 `ERROR_INVALID_FRAME: Too many concurrent chunk streams`。
- `index.test.ts` 里唯一的 `cleanup(true)` 调用点同步改为 `cleanup()`（该文件在本任务范围内）。
- 新增测试 `并发流达到上限后拒绝新流，且不驱逐已有流；过期后才腾出配额`：填满 `MAX_CHUNK_STREAMS` 条流 → 第 101 条抛错且活跃流数不变 → 已有流补齐分片仍能正常重组并让出配额 → 时间推进越过超时窗口后新流被接受、过期流被清理。

## 变更文件

新增：
- `packages/shared/src/ws-borsh/canonical-scan.ts`
- `packages/shared/src/ws-borsh/canonical-state-validation.ts`
- `packages/shared/src/ws-borsh/legacy-pane-fields.ts`
- `packages/shared/src/ws-borsh/legacy-window-fields.ts`
- `packages/shared/src/ws-borsh/legacy-snapshot-draft.ts`
- `packages/shared/src/ws-borsh/canonical-state.test.ts`
- `packages/shared/src/ws-borsh/legacy-pane-fields.test.ts`
- `packages/shared/src/ws-borsh/legacy-snapshot-draft.test.ts`
- `packages/shared/bench/canonical-validation.bench.ts`
- `packages/shared/bench/legacy-snapshot-diff.bench.ts`

修改：
- `packages/shared/src/ws-borsh/canonical-state.ts`
- `packages/shared/src/ws-borsh/state-snapshot-diff.ts`
- `packages/shared/src/ws-borsh/chunk.ts`
- `packages/shared/src/ws-borsh/index.test.ts`
- `packages/shared/src/ws-borsh/state-snapshot-diff.test.ts`

## 验证

| 命令 | 结果 |
| --- | --- |
| `cd packages/shared && bun test` | 175 pass / 0 fail（基线 141/0，新增 34 条） |
| `cd packages/shared && bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check packages/shared/src/ws-borsh packages/shared/bench` | 无问题 |
| `cd apps/gateway && bun test src/ws/borsh` | 25 pass / 0 fail |
| `cd apps/gateway && bun test src/ws/borsh/canonical-state.test.ts` | 7 pass / 0 fail |
| `cd apps/gateway && bunx tsc --noEmit -p .` | 27 error（= 基线，全部在未触碰的既有文件里，无新增） |
| `cd packages/ws-client && bun test` | 82 pass / 0 fail |
| `cd apps/gateway && bun test src/tmux-client/runtime src/ws/legacy` | 41 pass / 0 fail（legacy diff 的实际消费方） |
| `cd packages/stores && bun test` | 156 pass / 0 fail（前端 legacy diff 消费方） |

## 需要上游注意的两点

1. **写时复制的共享语义**：`applyLegacyStateSnapshotDiff()` 返回的快照现在会与入参快照**共享未触碰的 window / pane 对象**（以前是全量深拷贝）。已核查现有消费方（`apps/gateway/src/tmux-client/runtime/event-bridge.ts`、`apps/gateway/src/ws/legacy-feed-broadcaster.ts`、`packages/stores/src/tmux-event-router.ts`）都是「整体替换 lastSnapshot / state，只读不改」，没有就地改写返回快照的地方。今后若有人想原地 mutate 返回值，必须先自行拷贝。
2. **重复 id 的边缘差异**：旧实现的 window/pane 移除走 `filter`，会一次删掉所有同 id 条目；新实现按 id 索引只处理一个。tmux 的 window/pane id 在同一 session 内唯一，实际不会出现重复 id；此处仅作记录，未额外加防御。
