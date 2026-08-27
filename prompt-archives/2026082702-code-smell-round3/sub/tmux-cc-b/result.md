# tmux-cc-b 结果

## 改了什么

`apps/gateway/src/tmux-client` 里三个高 CC 函数按职责拆开，公开签名与行为不变。抽出的纯函数都有自己的单测；原测试未改内容且保持绿色。

### 1. `pane-emulator.ts` `create`（原 CC≈17 / ~79 行 → CC 2 / 26 行）

选项解析、retention/legacy 播种、流回调都进 `pane-emulator-create.ts`：

| 函数 | 职责 |
| --- | --- |
| `resolveEmulatorOptions` | cols/rows/scrollback 缺省（≤0 或缺失 → 80×24，scrollback 5000） |
| `hasRetentionSource` | 四个 retention API 是否齐全 |
| `subscribePaneStream` | 只转发本 pane 的 output/marker；未提供的 handler 不挂到 listener |
| `seedFromPaneText` | legacy `capturePaneText` 播种，换行归一化，错误吞掉 |
| `seedFromRetention` | identity → attach → screen → replay；失败关 lease 并 `terminal.free()` |

`PaneEmulator.create` 只做：取 pane info → 建 terminal → retention 或 legacy 两条路径。

### 2. `metadata/hierarchy-builder.ts` `buildDesired`（原 CC≈18 / ~76 行 → CC 2 / 10 行）

按层拆成 `buildDevice` / `buildServer` / `addSession` → `addWindows` → `addPanes`。名称/标题回退进 `hierarchy-fields.ts`：

- `pickFallbackName(preferred, fallback)`：`??`（空字符串算有值，不落到 fallback）
- `setDefinedStringField` / `setDefinedU16Field`：`!== undefined` 才写（title/layout/left/top，空串也会写）
- `setTruthyStringField`：自定义名；空串不写字段
- `applyPaneHints`：unknown pane hints 覆盖 title/path/command

### 3. `retention/replay-store.ts` `readHistory`（原 CC≈17 / ~74 行 → CC 7 / 37 行）

范围判定与 chunk 拼接分开：

- `selectHistoryRange`：epoch mismatch → `epoch_changed`；`beforeSeq > latest` → `pane_gap`；`beforeSeq < oldest` → `cache_evicted`；边界上 `beforeSeq === oldest` 算合法空页
- `sliceReplayChunk` / `assembleHistoryChunks`：从 cursor 向前取不超过 `limit` 的尾部字节
- `gapHistoryPage`：gap 页仍用 `latestSeq` 填 `seqStart`/`seqEnd`（与拆前一致）

抽出函数均 CC ≤ 12、≤ 60 行。`buildReplayPlan` 未动（不在范围）。

## 文件

改：

- `apps/gateway/src/tmux-client/pane-emulator.ts`
- `apps/gateway/src/tmux-client/metadata/hierarchy-builder.ts`
- `apps/gateway/src/tmux-client/metadata/hierarchy-builder.test.ts`（只追加表驱动，原 3 条原文未动）
- `apps/gateway/src/tmux-client/retention/replay-store.ts`
- `apps/gateway/src/tmux-client/retention/replay-store.test.ts`（只追加 `readHistory` 边界用例）

新：

- `apps/gateway/src/tmux-client/pane-emulator-create.ts`
- `apps/gateway/src/tmux-client/pane-emulator-create.test.ts`
- `apps/gateway/src/tmux-client/metadata/hierarchy-fields.ts`
- `apps/gateway/src/tmux-client/metadata/hierarchy-fields.test.ts`
- `apps/gateway/src/tmux-client/retention/history-range.ts`
- `apps/gateway/src/tmux-client/retention/history-range.test.ts`

## Bug

无行为 bug。本次是等行为拆分。

TDD：helper 先空实现，相关断言失败（27 fail / 23 pass，pass 的是原测试 + stub 碰巧满足的空值路径）；实现后目标文件 50 pass / 0 fail。

## 测试

```
cd apps/gateway && bun test \
  src/tmux-client/pane-emulator-create.test.ts \
  src/tmux-client/pane-emulator.test.ts \
  src/tmux-client/metadata/hierarchy-fields.test.ts \
  src/tmux-client/metadata/hierarchy-builder.test.ts \
  src/tmux-client/retention/history-range.test.ts \
  src/tmux-client/retention/replay-store.test.ts
# 50 pass / 0 fail（原 12 + 新增 38）
```

新增覆盖：

- emulator 选项：null / 0 / 负数尺寸走默认；正数与显式 scrollback 保留
- retention 播种：checkpoint+replay 写入、identity 缺失、screen 缺失/抛错、replay gap；均 free terminal 且关掉 lease
- subscribe：只转发本 pane；未传 `onOutput` 时 listener 上没有 `onTerminalOutput`
- 名称回退表：host 优先、host 缺失用 snapshot、空 host 不回退且不写字段
- history 边界：exact start 空页、mid-chunk 拼接、past end `pane_gap`、丢掉前缀后 `cache_evicted`

全包：`bun test` → **1817 pass / 2 fail**（任务说明基线 1615；本任务 +38）。2 个失败均不在范围，属并行 agent，未修：

- `src/agent/tools/run-command-buffer.test.ts`：`多字节 UTF-8 在字节上限处截断`（收到 6，期望 ≤ 4）
- `src/agent/tools/run-command-spawn.test.ts`：`按当前 nonce 记录匹配的 D 标记并累积字节`（旧 nonce 的 D 标记被记下）

## tsc / biome

- `bunx tsc --noEmit -p .`：30 个 `error TS`（基线 27）。**本任务文件 0 条**。多出的 3 条及现有清单均在并行改动文件（`src/push/supervisor.test.ts`、`src/ws/issue45-cross-bug.test.ts`、`src/tmux/ssh-auth.ts` 等）。
- `bunx biome check --write` 对本任务 12 个实现/测试文件：干净。

## 没做的 / 原因

- 未改 `buildReplayPlan`、registry 驱逐、`pane-emulator.test.ts` 原文（任务要求原测试原样通过）。
- `seedFromRetention` 仍含 attach/capture/replay 的失败清理（CC 8）；再拆会把「必须一起回滚的 lease+terminal」拆散。
- 未把 `EmulatorStreamSource` 类型挪出 `pane-emulator.ts`：公开类型仍从原模块导出，helper 只用 `import type`，运行时无环。
