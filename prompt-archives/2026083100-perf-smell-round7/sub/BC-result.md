# BC：snapshot 未变化时跳过全量 reprojection

## 探索结论核对

E1 证据属实，已对照源码：

- `event-bridge.ts` 原先用 `stateSnapshotsEqual` 算出 `changed`，但只拿它挡 `onSnapshot` 广播。
- `metadata.reconcile`、`paneRetention.reconcilePanes`、对每个 pane 的 `historyReader.invalidatePane` 每次成功 snapshot 都跑。
- `MetadataProjection.reconcile` 无论有无 diff 都会 `hierarchy.buildDesired`（5000 pane 量级约 10.9ms）；`reconcilePanes` 末尾无条件 `policy.refreshModes`。
- `changed === false` **不能**一刀切跳过：`setServerEpoch` 会清空投影（`revision=0`、`established=false`），tmux 拓扑可能完全一样，但仍必须 re-establish；查询窗口内的 source event 靠 `baseRevision` vs 字段 revision 做 conflict，不能用「快照没变」覆盖掉。

## 改了什么

仅 `apps/gateway/src/tmux-client/runtime/event-bridge.ts` 及其测试。

`onSnapshot` 拆成两个 dirty 维度：

1. **Metadata rebuild**：仅当投影未建立（`revision === 0`）、快照字段相对 `lastSnapshot` 有变化、或 `baseRevision` 与当前 revision 不一致时调用 `metadata.reconcile`。
2. **Retention + history invalidation**：仅当投影未建立，或 pane id 集合变化（增/删/换 id）时跑 `syncPaneRetention`。标题、layout、cwd 等字段变化不走这条。

`changed` 仍只控制广播，语义不变。

## 设计决策

- **未**在 `changed === false` 时无条件跳过 metadata。查询期间若发生 source event（`baseRevision < revision`），仍走 `planReconcile` 的 conflict 路径，避免把更新字段写回过期 snapshot。这条路径相对少见，buildDesired 成本可接受。
- 用 `revision === 0` 作为「未建立」代理，避免给 `MetadataProjection` 加新 API：`establish` 后 revision 至少为 1；`setServerEpoch` 会清回 0。epoch 重置后即便 tmux 快照与 `lastSnapshot` 相同，也会强制 metadata + retention。
- Retention 只看 pane **id 集合**，不看字段。pane 在窗口间移动（id 不变）不触发 retention/history；parent 变化由 metadata reconcile 处理。epoch 旋转走「未建立」分支，不会漏掉 `rotatePaneEpoch`。
- `invalidatePane(id, epoch)` 在 epoch 未变时本就是 no-op，但会扫全部 history session；跳过可去掉 5000 pane 的空转。

## 风险

- `lastSnapshot` 若被 `onPatch` 改过，而随后 snapshot 字段相同，会按「未变」跳过 metadata。此时内存投影已是新值，conflict 本来也会保留，可观察结果一致。
- 未传 `baseRevision` 时（测试/命令失败路径）视为「与当前 revision 一致」，允许 skip。生产 `SnapshotProjector` 总会传入 `beginMetadataReconcile()` 的值。
- 跳过 retention 时不再调用 `refreshModes`。订阅态变化由 ingest/subscription 路径刷新，不依赖无变化 snapshot。
- 未改 `metadata-projection.ts` 内部：有 diff 时仍全量 `buildDesired`。进一步缓存 desired map 超出本任务安全边界。

## 测试

新增 `event-bridge.test.ts` 用例（spy `reconcile` / `reconcilePanes` / `invalidatePane`）：

- 连续相同 snapshot + 匹配的 `baseRevision`：不调用 retention/history，metadata revision 不变，`reconcile` 不再进入。
- 增加 / 删除 pane：metadata + retention + history 全路径仍走。
- 仅 title 变化：metadata revision 前进且字段落地，retention/history 调用次数不变。
- 查询期间 source event + 过期 snapshot：不回滚新 title；pane 集合未变则跳过 retention。
- `onSourceReady` 换 epoch 后相同 tmux 快照：强制 re-establish，retention 再跑一次。

## 验证计数

| 范围 | 基线 | 本次 |
| --- | --- | --- |
| `event-bridge.test.ts` | 3 pass / 0 fail | **9 pass / 0 fail** |
| `apps/gateway/src/tmux-client/**` | — | **648 pass / 0 fail** |
| `cd apps/gateway && bun test` | 2800 pass / 0 fail | **2820 pass / 13 fail**（失败全在 `ws/`、`mesh/`、`hub/`，并行 agent 进行中；`tmux-client` 无失败） |
| `bunx tsc --noEmit -p apps/gateway` | 21 | event-bridge 无新增；全量多出的条目来自并行 agent 的 hub/mesh，不在本任务文件 |
| `bunx biome check` 改动文件 | — | 通过 |

未跑 benchmark（任务未要求）。
