# GN 结果（B5 + B11 + R12）

## 结论

三项均落地。`uplink-client.ts` 897 → **719** 行（门禁 750）；`waitSocketOpen` 收到 `@tmex/shared/net`；`defaultRunSync` / `elapsedIfDue` 各一份实现；ws-metrics 窗口在 30 s ± 一事件内关闭，全零窗口仍不打日志。

## 改动

### B5 — uplink 减重 + `waitSocketOpen` 统一

- 新建 `packages/shared/src/net/wait-socket-open.ts`：open / close / error / timeout / abort 五选一，先 `finish` 再 `close`，避免同步 `close` 事件盖掉 abort/timeout 原因。ServerSocketAdapter 鸭型跳过等待。
- `packages/shared/src/net/index.ts` 再导出 `dial-breaker` + `waitSocketOpen`；`package.json` 的已有 `./net` 子路径改指 index（未新增子路径名）。
- `uplink-client.ts` / `peer-ws-race.ts` 改 import；peer 侧 abort 关 socket 理由仍为 `'stopped'`。
- 连接/ctl 错误分类抽到 `apps/gateway/src/mesh/uplink-reconnect.ts`（`classifyUplinkConnectError` 仍从 `uplink-client` 再导出）。`handleCtl` 未动。
- `classifyWsDialFailure` 用 `startsWith('ws-closed')` 兼容新 close 文案，**不增加 CC**（仍锁 35）。

### B11 — 去重

- `apps/gateway/src/tmux/run-sync.ts`：`defaultRunSync` + `RunSyncResult`；`ssh-auth-resolvers.ts` / `local-shell-path.ts` 改 import。
- `elapsedIfDue(now, lastAt, intervalMs)` 放在 `control-stream-metrics.ts`（无额外依赖的叶子），`terminal-output-metrics.ts` 的 `takeIfDue` / `isDue` 共用。

### R12 — 指标窗口真 30 s

- `broadcastTerminalOutput` 保留每 1024 事件快路径，另加 `metrics.isDue(Date.now())`。到期重置 1024 计数并调用原 `reportTerminalOutputMetricsIfDue`（全零抑制仍在 `gateway-metrics-log.ts` 的 `isQuietTerminalOutputSnapshot`）。
- 假时钟测试：5 s 内第 1024 事件才 report；30 s 后第一条事件即 report。

## 测量

| 项 | 前 | 后 |
|---|---:|---:|
| `uplink-client.ts` 行数 | 897 | **719** |
| gateway `tsc --noEmit` | 0 | 0 |
| shared `tsc --noEmit` | 0 | 0 |
| `bun test src/net`（shared） | 10 pass / 2 files | **20 pass / 3 files** |
| 验收命令（gateway，含 `src/tmux` 前缀匹配到 tmux-client） | 698 pass / 69 files | **759 pass / 74 files / 0 fail** |
| 本任务直接相关：uplink-client / peer-ws-race / control-stream-metrics / terminal-output-metrics / legacy-feed-broadcaster / local-shell-path / ssh-connect-config | 43+11+2+2+0+… | 43 / 11 / 3 / 3 / 2 / … 全绿 |

biome：已 `bunx biome check` 本任务改过的文件，通过。

## 门禁

- `uplink-client.ts` ≤ 750：满足（719）。
- `bun scripts/complexity/gate.ts`：**本任务文件无违规**。全仓仍有 1 条：`peer-manager.ts` 1939 > 1930（allowlist 锁 1930）。该文件不在本任务拥有列表，且任务写明另一 agent 正在改 `mesh/peer-manager*`，**未改**。

## 未做 / 未碰

- 未改 `peer-manager*.ts`、`mesh-runtime.ts`、`pane-stream*`、`tmux-client/runtime/*`、`control-mode*`。
- 未改 `scripts/complexity/allowlist.json`。
- `packages/shared/package.json` 仅把已有 `./net` 指向 `src/net/index.ts`（任务允许「若需要则改 package.json」）。
