# review1-backend-fixes

## 背景

Code review 确认两处缺陷：

1. `finalizeConnect` 的 generation 守卫覆盖了 epoch / session options / control attach，但漏了最后一步 `requestSnapshotInternal()`。`SnapshotProjector.performSnapshot()` 只在发三条 tmux 命令前检查 `host.connected`，`Promise.all` 完成后无条件 parse + `emitSnapshot()`。因此 `disconnect()` 发生在 snapshot 命令 in-flight 时，仍会写入内部 snapshot 状态并广播。
2. `parseNonNegativeSafeInt` 用 `Number(raw)`：`Number(' ')===0`、`Number('0x10')===16`、`Number('1e2')===100` 都能过 `Number.isSafeInteger`。

## 改动

### 1. connect snapshot 竞态

- `external-tmux-core.ts`：`finalizeConnect` 最后一步改为  
  `await this.awaitConnectStep(generation, () => this.requestSnapshotInternal())`。
- `snapshot-projector.ts`：
  - `SnapshotProjectorHost` 增加 `connectGeneration`。
  - 发命令前记下 generation；三条命令返回后、parse / emit 前再检查 `connected` 且 generation 未变；不满足则直接 return，不改 `snapshotSession` / `snapshotWindows`、不 `onSnapshotSuccess`、不 `emitSnapshot`。
- collaborator host 暴露 `connectGeneration` getter。

### 2. offset 解析

- `file-http.ts`：`parseNonNegativeSafeInt` 先要求 `/^\d+$/`，再 `Number` + `isSafeInteger`。

## 文件

生产：

- `apps/gateway/src/tmux-client/external-tmux-core.ts`
- `apps/gateway/src/tmux-client/external/snapshot-projector.ts`
- `apps/gateway/src/api/file-http.ts`

测试：

- `apps/gateway/src/tmux-client/external/snapshot-projector.test.ts`
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- `apps/gateway/src/tmux-client/external-tmux-core.host.test.ts`
- `apps/gateway/src/api/files.test.ts`

## 修复的 bug

1. **disconnect 期间 snapshot 泄漏**：命令 blocked 时 disconnect / generation 递增后，不再更新内部 snapshot、不再广播。覆盖 projector 单测、local connect 路径、core `finalizeConnect` 路径（SSH 共用此路径）。
2. **offset 宽松解析**：空白、十六进制、科学计数 → 400；`'0'` / `'12'` 仍合法（session 不存在时 404）。

## 测试 / tsc

TDD：先写回归（RED：offset 被 Number 收下后 404；snapshot 在 disconnect 后仍 emit），再改生产代码（GREEN）。

- 相关：`bun test src/api/files.test.ts src/tmux-client/external/snapshot-projector.test.ts src/tmux-client/external-tmux-core.host.test.ts src/tmux-client/local-external-connection.test.ts` → 82 pass / 0 fail
- 全量 gateway：`bun test` → **1867 pass / 0 fail**（基线 1826；本任务新增 7 条，其余增量来自并行 agent）
- `bunx tsc --noEmit -p .` → **25 errors**，与基线一致，无新增
- `bunx biome check --write <scoped files>` → clean

## 未做 / 原因

- **未改 `ssh-external-connection.test.ts`**：不在 Scope。SSH `connect()` 走同一套 `finalizeConnect` + `SnapshotProjector`；core host 测 + projector 测已覆盖共享路径。若需要 SSH 文件级对称测例，需另开任务改该文件。
- **未动 `retention/`、`snapshot-format.ts`**：其他 agent 在改。
- **`beginMetadataReconcile` 仍在发命令前调用**：abort 路径本来就会提前 return（`shouldAbortSnapshot` 亦如此）；不在本次 review 范围内。
