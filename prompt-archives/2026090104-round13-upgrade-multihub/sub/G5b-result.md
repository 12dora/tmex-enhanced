# G5b result — CLI `hub allow|disallow`、standby 打印 node id、allowlist 文档

## Commands / flags shipped

| 命令 | 标志 | 行为 |
|---|---|---|
| `tmex hub allow <nodeId> [<nodeId>...]` | `--no-restart`、`--install-dir`、`--service-name` | 仅 `hub,node`：校验 32-hex（大小写不敏感，写入小写），追加到 `TMEX_HUB_PEERS`（去重、保序），打印结果名单并重启 |
| `tmex hub disallow <nodeId>` | 同上 | 从 `TMEX_HUB_PEERS` 删除，打印结果名单并重启 |
| `tmex hub standby …` | （既有） | 结束时额外打印本机 node id，以及 `tmex hub allow <thisNodeId>`；说明在 active 执行之前本机广告会被忽略 |
| `tmex hub promote` | （既有） | 始终提醒原写者 `tmex hub allow <本机 id>`；`TMEX_HUB_PEERS` 为空时额外红字警告 |
| `tmex hub list` | （既有） | 增加 `AUTH` 列：`yes` 当且仅当该 id ∈ 本机 `TMEX_HUB_PEERS` 或是 self |

拒绝：

- allow / disallow：非 `hub,node`；缺 node id；非 32 位 hex（不写 env）
- allow 非法 id 整次失败，已有名单不变

## Env helper

`packages/app/src/lib/install.ts`：

- `parseHubPeerIds`：逗号分隔、trim、小写、跳过非法、去重保序
- `applyHubModeEnvKeys` 增加 `hubPeers`（`string | readonly string[]` → `TMEX_HUB_PEERS`）

## Runtime wiring（item 4）

**未改 `assemble.ts`。** 检查时 `apps/gateway/src/mesh/mesh-runtime.ts` 的 `MeshRuntimeConfig` 仍无 `hubPeers` 字段（有 `hubMode` / `hubPriority` / `hubWriterEpoch` / `hubUrls`）。按 prompt：没有该字段则不接线。

hub 侧按 G3b 会读 `config.hubPeers ?? gatewayConfig.hubPeers`；生产路径只要 `TMEX_HUB_PEERS` 进 `gatewayConfig.hubPeers`（G3b 的 `config.ts`）即可生效，不依赖 assemble 再传一遍。

若 G2b 之后给 `MeshRuntimeConfig` 补上 `hubPeers?: string[]`，assemble 的 `createNodeMesh` 应加一行：`hubPeers: gatewayConfig.hubPeers`。

## Docs

`docs/hub/2026090104-multi-hub-standby.md`：

- 操作手册：两步流程（standby 打印 id → active `tmex hub allow` → 才进 `hubs[]`）；allow/disallow 用法；promote 提醒；list 的 AUTH 列；恢复顺序补上 allow
- 新节「授权 allowlist」：威胁模型「任意点失陷只影响该点」下为何必须 allowlist；phase 2 应改为用户签名的 `admit-hub` key-log
- fencing 跨重启：被 fence 的 hub 启动仍为 standby，直到显式 `promote`
- 环境变量表增加 `TMEX_HUB_PEERS`

未改 `docs/hub/2026082800-hub-node-operations.md`（G3b 负责那一行）。

## Tests / tsc / biome / build

| Check | Before（G5） | After |
|---|---|---|
| `packages/app && bun test src` | **613 pass / 0 fail**（59 files） | **623 pass / 0 fail**（59 files）。本任务新增 9：args allow/disallow 解析 1 + hub 8（allow 校验/去重/非 hub/`--no-restart`、disallow、standby hint、promote 空名单、list AUTH） |
| `bunx tsc --noEmit -p .` | 1 既有：`Cannot find type definition file for 'node'` | **仍 1**，未新增 |
| `bunx biome check`（本任务改过的 ts） | — | **clean**（`--write` 只动了本任务文件的格式） |
| `bun run build:cli` | cli-node.js 204.61 KB | **成功**（`cli-node.js` 207.65 KB） |

## Files touched

Owned:

- `packages/app/src/commands/hub.ts`、`hub.test.ts`
- `packages/app/src/cli/help.ts`
- `packages/app/src/lib/args.ts`、`args.test.ts`
- `packages/app/src/lib/install.ts`（`parseHubPeerIds` + `applyHubModeEnvKeys.hubPeers`）
- `packages/app/src/i18n/index.ts`
- `docs/hub/2026090104-multi-hub-standby.md`

未改：`assemble.ts`（见上）、`apps/gateway/**`、`packages/shared/**`、`apps/fe/**`、`docs/hub/2026082800-hub-node-operations.md`。无 git 操作。

## Commander 必须补的接线（本任务按 common-rules 未改这两文件）

否则 `tmex hub allow|disallow` 解析得出 `hub.allow` / `hub.disallow`，但 Node 外壳不会 spawn Bun auth 入口，auth 入口也会落到 unknown command。函数与测试已直接覆盖 `runHubAllow` / `runHubDisallow`。

**1. `packages/app/src/lib/auth-spawn.ts` `AUTH_COMMANDS`：**

```ts
  'hub.list',
  'hub.allow',
  'hub.disallow',
  'mesh.reset-root',
```

**2. `packages/app/src/cli-auth-entry.ts` `switch`，紧挨 `hub.list`：**

```ts
    case 'hub.allow': {
      const { runHubAllow } = await import('./commands/hub');
      await runHubAllow(parsed, nested.rest);
      return;
    }
    case 'hub.disallow': {
      const { runHubDisallow } = await import('./commands/hub');
      await runHubDisallow(parsed, nested.rest[0] ?? '');
      return;
    }
```

## Open risks

1. 上述 dispatch 未合入前，CLI 用户跑 `tmex hub allow` 会报未知命令。
2. `MeshRuntimeConfig` 若始终不加 `hubPeers`，assemble 不传也不影响：G3b 可从 `gatewayConfig.hubPeers` 读 env。
3. `TMEX_HUB_PEERS` 是各机 `app.env`，不会随 mesh 复制；两边都要 allow 才能互相 fencing。
4. 被 fence 后的 standby 跨重启行为由 G3b 实现；文档已写操作后果，CLI 本身不改 `mesh_hubs` 行。
