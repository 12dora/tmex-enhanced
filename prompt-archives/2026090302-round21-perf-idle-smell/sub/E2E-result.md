# E2E：canonical 默认开启后的三条回归

## 结论

三条都已在 **canonical 默认开启**（未改 `canonicalStateEnabled()`）下跑绿。

| 用例 | 判断 | 处理 |
|---|---|---|
| `single-pane-window-switch-resize` | **产品行为回归**：切到另一单 pane 窗口后 resize 被 viewport 去重吞掉 | 修 gateway：`lastAppliedViewport` 按窗口记账，快照尺寸碰巧一致时仍强制 apply |
| `ws-borsh-history` / `ws-borsh-pane-route` | **用例只覆盖 legacy 协议**：pane 内容有上屏，只是不再走 `TERM_HISTORY` | 按当前 feed 分别断言；两条路径都保留 |

## 1. 切窗口 resize

### 现象

canonical 把 `TMUX_SELECT.wantHistory` 强制为 `false`，不再走 legacy 的 `selectPaneWithSize`（冷 select 即使快照已是目标尺寸也会打到 tmux）。尺寸改走 viewport 仲裁。

仲裁原先把 **snapshot 里的 live 几何** 当作「已经 apply 过」：

```ts
applyWinnerGeometry(winner, liveWindowGeometry(entry, windowId) ?? lastApplied)
```

切到窗口 B 时：

- `lastAppliedViewport` 只有窗口 A 的记录；
- 窗口 B 的 snapshot 仍可能是 webapp 视口尺寸（轮询还没追上外部 `resize-window`，或默认尺寸碰巧相同）；
- live == claim → 返回 null → **不调 tmux resize**；
- 同时 `select-window` 会把 B 拉到 control client 尺寸（例如 `112x35`），于是断言失败。

legacy 冷 select 靠 `selectPaneWithSize` 总能打到目标窗口，所以 main / canonical-off 都过。

### 修复

`applyWinnerGeometry(winner, lastApplied, live)`：

- 跳过条件改为：**本窗口已经 apply 过且 live 也一致**；
- 本窗口从未 apply、或 live 相对 last-applied 漂移 → 返回 `force: true`，让 `applyTermResizeToEntry` 不要再信 snapshot 去重。

`handleTermResize` / canonical `ResizePane` 与 `TMUX_SELECT` 共用这条路径，切窗口后的 post-select sync 也不会再被吞。

单测：

- `viewport-policy.test.ts`：从未 apply / live 漂移 / 尺寸变化；
- `viewport-claims.test.ts`：warm select 首 apply、跨窗口 snapshot 已匹配仍 resize；
- `tmux-command-handlers.test.ts`：`wantHistory:false` + 与快照相同的 80×24 仍 `resizePane`。

## 2. `TERM_HISTORY` 两条

### 判断依据

`apps/fe/test-results/` 当时是空的，依据是实现与随后的 e2e：

- canonical 客户端丢掉 `KIND_TERM_HISTORY` / `SWITCH_ACK` / `LIVE_RESUME` 主数据面，首屏改 `RequestScreen` → `ScreenBegin/Chunk/Commit`（外加 `PaneData`）；
- 编码器对 `TMUX_SELECT` 强制 `wantHistory=false`，gateway 屏障不再发 `TERM_HISTORY`；
- 新用例在 canonical 下断言 **可见终端含 `PANE0_READY`/`PANE1_READY`**，且 canonical screen/output 含该标记、`TERM_HISTORY` 不含；两条都过。说明原失败是协议断言超时，不是首屏没写上。

`SWITCH_ACK` / `LIVE_RESUME` 仍在控制面发送，canonical/legacy 都继续断言。

### 用例改动

`apps/fe/tests/helpers/ws-borsh.ts` 增加 `attachPaneFeedCollector`，同时收 legacy `TERM_HISTORY` 和 canonical `Screen*` / `PaneData`。

每个 spec 拆成两条：

- canonical（默认，不写 kill switch）；
- legacy（`localStorage['tmex.disable-canonical-state']='true'`）。

没有关默认 canonical，也没有删协议断言。

## 验证

e2e（`TMEX_MESH_E2E_BUILD_FE=1`，5 tests / 3 files）：

```
✓ single-pane window switch resizes target window to webapp viewport
✓ ws-borsh: canonical screen feed applies pane ready marker on initial load
✓ ws-borsh: legacy TERM_HISTORY applies pane ready marker on initial load
✓ ws-borsh: canonical feed preserves encoded pane id and loads target pane
✓ ws-borsh: legacy TERM_HISTORY preserves encoded pane id and loads target pane
5 passed (12.5s)
```

单测 / 类型 / 门禁：

| 检查 | 结果 |
|---|---|
| `packages/ws-client && bun test` | 381 pass |
| `packages/stores && bun test` | 435 pass |
| `apps/fe && bun test src/` | 1744 pass |
| gateway `viewport-*` / `tmux-command-handlers` / canonical 定向 | 全绿 |
| `tsc --noEmit` | gateway 0（基线 21）、stores 1（基线 1）、fe 0 |
| `biome check` 改动文件 | pass |
| `bun scripts/complexity/gate.ts` | ok（未改 allowlist） |

`canonicalStateEnabled()` 仍默认开启。未碰生产 tmex、未碰名为 `tmex` 的 tmux session。

## 改动文件

- `apps/gateway/src/ws/viewport-policy.ts`
- `apps/gateway/src/ws/tmux-command-handlers.ts`
- `apps/gateway/src/ws/viewport-policy.test.ts`
- `apps/gateway/src/ws/viewport-claims.test.ts`
- `apps/gateway/src/ws/tmux-command-handlers.test.ts`
- `apps/fe/tests/helpers/ws-borsh.ts`
- `apps/fe/tests/ws-borsh-history.spec.ts`
- `apps/fe/tests/ws-borsh-pane-route.spec.ts`
