# G5 result — CLI + runtime wiring + multi-hub ops doc

G2-result.md / G3-result.md 在本任务开始时不存在。先完成 **B (CLI)** 与 **C (docs)**，再对照工作树里已经落地的 G2/G3 签名做 **A (runtime wiring)**（未等到正式 result 文件）。

## Commands / flags shipped

全部走既有 auth spawn（`cli-auth-entry.ts`，Bun），要求已 `tmex init`。`hub join` 行为未改。

| 命令 | 标志 | 行为 |
|---|---|---|
| `tmex hub standby --public-url <https-url>` | `--priority <n>`（缺省 200）、`--insecure-local`、`--no-restart`、`--install-dir`、`--service-name` | 已加入的 node → `hub,node` + standby |
| `tmex hub promote` | `--yes`（非 TTY 必填）、`--no-restart`、`--no-interactive` | 设 active，epoch = max(env, max(mesh_hubs.writer_epoch))+1 |
| `tmex hub demote` | `--no-restart` | 只改 `TMEX_HUB_MODE=standby` |
| `tmex hub list` | `--install-dir` | 打印本机 `mesh_hubs`，写者行加 `*` |

URL 规则与 `hub join` 相同：默认 https；本机回环 HTTP 仅非 production + `--insecure-local`。没有单独的 `--allow-insecure`。

拒绝：

- standby：无 `node_identity`；已是 `hub,node` 且 mode=active（提示先 `demote`）；空 `TMEX_HUB_URL`。
- promote / demote：不是 `hub,node`。
- promote：无 `--yes` 且非交互 / 用户取消。

`pickWriterHub` 在 CLI 内重实现（不引 gateway 模块）：active 中 epoch 最大，并列 priority 更小，再并列 `hubNodeId` 字典序。

## Env keys written

| 命令 | 写入 |
|---|---|
| `standby` | `TMEX_ROLES=hub,node`、`TMEX_HUB_MODE=standby`、`TMEX_HUB_PUBLIC_URL`、`TMEX_HUB_PRIORITY`；**保持** `TMEX_HUB_URL` |
| `promote` | `TMEX_HUB_MODE=active`、`TMEX_HUB_WRITER_EPOCH` |
| `demote` | `TMEX_HUB_MODE=standby` |

`mesh_hubs` 不可读时 promote 退化为 `env+1`（env 缺省按 1）。

辅助：`packages/app/src/lib/install.ts` 新增 `applyHubModeEnvKeys`（不改 `init` 默认 env）。

## Runtime wiring

`packages/app/src/runtime/assemble.ts`：

1. 每个进程在 `roles.hub \|\| roles.node` 时构造一次 `MeshHubStore(gateway.db)`。
2. 经 `createMeshRuntime` 传入：
   - `meshHubStore`（G2 prompt 名）
   - `meshHubs`（G3 实际 `HubRuntimeOptions` 字段）
   - `config.hubMode / hubPriority / hubWriterEpoch / hubUrls`（G2 已写入 `MeshRuntimeConfig`）
   - `config.hubNodeId`（本机 `node_identity.nodeId`，供 G2 转发到 `HubRuntimeConfig.hubNodeId`）
3. 双角色同进程：`mesh.onNodeList((list, meta) => hub.applyReplicatedNodeList(list, meta))`；`stop()` 先 unsubscribe。假 runtime 没有这两个方法时跳过。
4. hub 角色启动日志：`[hub] mode=<active\|standby> priority=<n> writerEpoch=<n> publicUrl=<url>`。

对照到的 in-tree 签名（无正式 G2/G3 result 文件）：

```ts
// G2 MeshRuntime
onNodeList(cb: (list: UplinkNodeList, meta: { hubNodeId: string | null; generation: number }) => void): () => void

// G3 HubRuntime
applyReplicatedNodeList(list: UplinkNodeList, meta: { hubNodeId: string | null }): void
HubRuntimeOptions.meshHubs?: MeshHubStore   // 不是 prompt 里的 meshHubStore
HubRuntimeConfig.{ mode, priority, writerEpoch, hubNodeId }
```

**G2 仍未消费传入的 store：** `mesh-runtime.ts` 目前 `const hubStore = new MeshHubStore(db)`，构造 `HubRuntime` 时也还没填 `mode/priority/writerEpoch/hubNodeId/meshHubs`。assemble 已把这些值放进 opts；G2 应收成 `opts.meshHubStore ?? opts.meshHubs ?? new MeshHubStore(db)`，并写入 `HubRuntime` 构造参数。G5 不能改 `apps/gateway/src/mesh/**`。

## Docs

- 新：`docs/hub/2026090104-multi-hub-standby.md`
- 交叉链接：`docs/hub/2026082800-hub-node-operations.md`（部署矩阵段、常见排障 `HUB_NOT_WRITER` / 双 active、参考列表）

## Tests / tsc / build

| Check | Before | After |
|---|---|---|
| `packages/app && bun test src` | **598 pass / 0 fail**（59 files） | **613 pass / 0 fail**（59 files，+15） |
| `bunx tsc --noEmit -p .` | 1 既有：`Cannot find type definition file for 'node'` | **仍 1**，未新增 |
| `bunx biome check`（本任务改过的 ts） | — | **clean** |
| `bun run build:cli`（`--target node`） | — | **成功**（`cli-node.js` 204.61 KB） |

新增覆盖：standby env 写入/缺省 priority/拒绝未加入与 active hub/http URL；promote `--yes`、取消、epoch=max(env,db)+1、表不可读退化；demote；list 写者标记；args/help；assemble store + onNodeList 订阅/退订 + 启动日志。

## Files touched

Owned:

- `packages/app/src/commands/hub.ts`、`hub.test.ts`
- `packages/app/src/lib/args.ts`、`args.test.ts`
- `packages/app/src/cli/help.ts`
- `packages/app/src/lib/install.ts`（`applyHubModeEnvKeys`）
- `packages/app/src/runtime/assemble.ts`、`assemble.test.ts`
- `docs/hub/2026090104-multi-hub-standby.md`
- `docs/hub/2026082800-hub-node-operations.md`

命令要能被 `tmex hub …` 调到，另外改了（否则只是死函数）：

- `packages/app/src/lib/auth-spawn.ts`（`AUTH_COMMANDS`）
- `packages/app/src/cli-auth-entry.ts`（dispatch）
- `packages/app/src/i18n/index.ts`（中英消息；zh-CN 未用「你」）

未改 `apps/gateway/**`、`packages/shared/**`、`apps/fe/**`。无 git 操作。

## Open risks

1. G2 若继续自建 `MeshHubStore`、构造 HubRuntime 时不带 mode/epoch/store，则 assemble 传入的单例与 config 不会生效。进程内 `onNodeList → applyReplicatedNodeList` 仍可用（挂在 `mesh.hub` 上）。
2. G3 option 名是 `meshHubs` 不是 prompt 的 `meshHubStore`；两边都传了。
3. enrollment token 不复制、无自动选主：已写进运维文档。
4. CLI 在 Node 外壳里 spawn Bun 跑 auth 入口（与 join/leave 相同）；`build:cli` 只打 `cli-node.js`。
