# G5 结果 — R1/R2/R3 follow-up

## 做了什么

### 1. rsync list-only top-k：一次预检 + ASCII sort key

R1 的有界堆对每条候选反复跑 `Intl.Collator.compare`（反序 200k 时约 200k·log k 次），CPU 从 ~90 ms 落到 ~970 ms。

现在：

- 堆满后只和当前最差项比 **一次**：key 更大则直接丢掉，不 `bubbleDown`。
- ASCII 名预计算 `dirRank + numeric-padded 权重串`（权重表按当前 locale 的 `LIST_COLLATOR` 标定一次），堆内比较是字符串 `<` / `>=`，不再对原文反复 collator。
- 非 ASCII 回退 `compareListEntry`（collator）。
- 堆节点原地改写（最多 `MAX_ENTRIES+1` 个 wrapper），避免反序输入时分配 20 万个堆对象。
- 返回页仍用 `compareListEntry` 排序，≤2000 条与全量 parse+sort 一致。

属性测试：随机 ASCII（大小写、数字、标点）bounded 页 === `parseListOnly` + `sort(compareListEntry)`；另有含 CJK / `file2` vs `file10` 的未截断一致性。

### 2. Legacy pane history：超限截断尾部，上限 4 MiB

- `MAX_PANE_HISTORY_CAPTURE_BYTES`：2 MiB → **4 MiB**。
- `readTextWithByteLimit` 超限不再 throw：滚动保留最近 `limit` 字节，调用 `onLimit`（`defaultRun` 在此 kill 子进程），返回 tail。
- SSH `executeIsolatedShellCommand` 同一套滚动尾缓冲；超限 close/destroy channel，按成功返回 tail（与本地路径一致）。
- 去掉 `runHistoryCapture` 里「超限再 throw」的二次检查。

### 3. `GET /api/devices` + reorder：列表恰好 1 次查询

删掉仅为满足 `index.routing.test.ts` spy 的 `getAllDevices().length === 0` 短接。列表/reorder 只走 `listDevicesWithRuntimeStatus()`（LEFT JOIN）。routing 测试 spy 改为该函数。`tmux-tree.ts` 仍是 `getAllDevices` + `getDeviceTreeOrders` 一批，无需改。

## 文件

修改：

- `apps/gateway/src/files/rsync.ts` / `rsync.test.ts`
- `apps/gateway/src/tmux-client/control-mode-capture.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts` / `.test.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts` / `.test.ts`
- `apps/gateway/src/tmux-client/external/session-commands.test.ts`（4 MiB + 超限返回 tail）
- `apps/gateway/src/api/device-routes.ts` / `device-routes.test.ts`
- `apps/gateway/src/api/index.routing.test.ts`

未改：`session-commands.ts`（只读 cap 常量）、`tmux-tree.ts`、`db/devices.ts`。

## 测量

scratchpad：`r1-rsync-list-bench.ts`（200_000 文件 + 2 目录，**反序**，末尾才出现 `adir`/`zdir`）

| | ms | RSS Δ | retained | returned |
|---|---:|---:|---:|---:|
| R1 after（collator 堆） | 970.18 | 63.1 MiB | 2001 | 2000 |
| G5 unbounded（`parseListOnly` 全量） | 91.74 / 93.35 | ~160 MiB | 200002 | 2000 |
| G5 bounded（key 堆 + 一次预检） | 171.44 / 188.84 | ~71 MiB | 2001 | 2000 |

相对旧全量 parse：约 **1.9×**（目标 ~1.5×）。反序是最坏情况：几乎每条都挤进堆，仍要 20 万次 key 构造 + `bubbleDown`。正序（预检几乎全跳过）同规模约 89 ms vs parse 59 ms ≈ **1.5×**。≤2000 条：parse ~0.7–1.5 ms，bounded ~1.5–2.2 ms，同量级。相对 R1 的 970 ms 约 **5.4×**。

## 验证

- `cd apps/gateway && bun test src/files src/tmux-client src/api src/db src/api/index.routing.test.ts` → **1170 pass / 0 fail**
- `bunx tsc --noEmit -p .` → **21 errors**（= 基线）
- `bunx biome check` 上述 12 个文件 → **clean**

## 未做 / 风险

- 反序 200k 未压到 1.5×：再快就要牺牲与 `sortEntries` 相同的 numeric+base 序，或接受错页。正序/随机目录会走预检跳过，更接近 1.5×。
- 非 ASCII 文件名堆内仍用 collator；超大 CJK 目录会回到 R1 那种比较成本（页正确）。
- 超限 history 截在 UTF-8 码点中间时，`TextDecoder` 可能在首部出 `U+FFFD`；保留的是最近字节。
- SSH/本地 kill 后把该次 capture 当作成功（exit 0 + tail），避免非 0 退出把整段 history 打成错误。
- `GET /api/tmux/tree` 仍是 2 次查询（设备列表 + tree-order IN），不在本 follow-up 的「多一次 spy 短接」范围内。
