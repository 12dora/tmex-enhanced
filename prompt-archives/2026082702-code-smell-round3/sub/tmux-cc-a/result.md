# tmux-cc-a 执行结果

## 背景

gateway 热路径上三处 smell：`resolvePaneContext` CC≈23；`bellDedup` 按 pane 无限增长、无 TTL；snapshot 对 windows 重复 sort。公开行为保持不变。

## 改了什么

### 1. `tmux/bell-context.ts`

`resolvePaneContext` 只做编排：读 raw id → 无 session 早退 → `findPane` → 表驱动 window/pane fallback → `buildContext`。

| 函数 | 职责 |
| --- | --- |
| `findPane` | 按 paneId 在 windows 里找 `{window, pane}` |
| `resolveWindowTitle` | 表驱动：matched window → windowId → active → 第一扇 |
| `resolvePane`（未导出） | 表驱动：matched pane → paneId → active → 第一格 |
| `buildContext` | 拼 paneUrl / index / title / command，缺解析则回落 raw id |

`resolvePaneContext` 签名未改。

复杂度（阈值 12 / 60 行）：

| 函数 | CC | 行数 |
| --- | --- | --- |
| `resolvePaneContext` | 2 | 21（原 ≈23 / 58） |
| `findPane` | 4 | 15 |
| `resolveWindowTitle` | 2 | 11 |
| `resolvePane` | 2 | 11 |
| `buildContext` | 5 | 18 |

### 2. `tmux-client/external-tmux-core.ts`（仅 bellDedup）

抽出纯函数 `noteBellDedup` / `pruneBellDedupEntries`。`recordBell` 写入后按 **每 32 次 insert 或每 `BELL_DEDUP_WINDOW_MS`（200ms）** 扫一次过期 key（`now - ts >= window`）。窗口内去重语义不变（`< 200ms` 抑制，刚好 200ms 放行）。`bellDedup` 仍以 getter 暴露底层 Map，避免子类/测试直接读字段时断掉。

### 3. `tmux-client/external/snapshot-projector.ts`

pane 仍在 `parseSnapshotPanes` 里按 index 排一次。windows 的 index 排序抽成 `windowsInIndexOrder`，`performSnapshot` **每个 snapshot 只 sort 一次**，结果同时喂给 `getExpectedPaneIds`（已排序数组不再排）和 `emitSnapshot`（可选第三参）。独立调用 `getExpectedPaneIds(Map)` / `emitSnapshot(host)` 仍会自己排序，单测与其它调用方行为不变。

## Bug 修复

无行为 bug。bellDedup 慢性泄漏按性能项修；snapshot 输出对乱序 tmux 行仍稳定。

## 测试

先写特征化/失败用例再改实现：

- `bell-context.test.ts`：原 3 条仍过；补 windowId / 无 active window / 无 active pane / 空 windows / 非法 raw id；`findPane` / `resolveWindowTitle` / `buildContext` 各 fallback 单独测。
- `external-tmux-core.test.ts`：窗口内去重、刚好窗口边界放行、每 N 次才 prune、时间到了即使未满 N 也 prune、prune 后窗口内去重仍有效。
- `snapshot-projector.test.ts`：乱序 window/pane 行 → `getExpectedPaneIds` + `emitSnapshot` 与 canonical 相同；`performSnapshot` 乱序 list-windows/list-panes 输出 `@1,@2` / `%1,%2,%3`。

相关文件：`bun test src/tmux/bell-context.test.ts src/tmux-client/external-tmux-core.test.ts src/tmux-client/external/snapshot-projector.test.ts src/tmux-client/external-tmux-core.host.test.ts` → **45 pass / 0 fail**。

## 文件清单

- 修改：`apps/gateway/src/tmux/bell-context.ts`、`bell-context.test.ts`
- 修改：`apps/gateway/src/tmux-client/external-tmux-core.ts`（仅 bellDedup）、`external-tmux-core.test.ts`
- 修改：`apps/gateway/src/tmux-client/external/snapshot-projector.ts`、`snapshot-projector.test.ts`
- 未改：`external/constants.ts`、`connection-cleanup.ts`、其它 tmux-client 文件

## 验证

- `bunx biome check --write` 上述 6 个文件：通过。
- 相关测试：45 pass / 0 fail。
- `cd apps/gateway && bun test`：1815 pass / 2 fail（基线任务说明为 1615 / 0）。失败均不在本任务文件：
  - `pane-emulator-create.test.ts` `seedFromRetention`（并行 screen-capture）
  - `createByteOutputBuffer` 多字节 UTF-8 截断（并行 session-state）
- `bunx tsc --noEmit -p .`：49 个 error，**均不在本任务文件**。基线 27；增量来自并行任务（agent tools 缺模块、push supervisor SiteSettings、ssh-connect-config 等）。本任务改动未新增 tsc error。

## 未做 / 为何

- 未在 disconnect 时额外 `bellDedup.clear()`：对象随 connection 回收；本次只补 TTL sweep。`constants.ts` 超出 scope，prune 间隔常量放在 `external-tmux-core.ts`。
- 未把 `snapshotWindows` Map 改成插入即有序：避免改 Map 迭代顺序影响其它消费者；hot path 已只 sort 一次。
- `resolvePane` 未导出：pane fallback 由 `resolvePaneContext` 用例覆盖。
