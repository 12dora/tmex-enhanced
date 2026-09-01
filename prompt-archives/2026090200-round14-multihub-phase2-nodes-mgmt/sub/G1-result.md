# G1 结果 — 远程干净卸载节点（backend + CLI）

## 做了什么

入口「卸载 tmex」走 `POST /api/mesh/nodes/:id/uninstall`：禁止卸载自己，要求目标已登录且可达，经 peer link 转发 `POST /api/system/uninstall`。目标校验 CLI 安装 / 非 managed / 无升级进行中后，把 `current/cli` 拷到 `tmpdir/tmex-uninstall-<id>/`，detached 拉起 `tmex uninstall --yes --purge --delay-ms 1500`，立即 202 `scheduled`。入口把长事务写入 `gateway_kv`（`mesh.node-op.<nodeId>`），`GET /api/mesh/nodes` 每行带 `operation`，刷新后仍显示卸载中。FE 的 `revoke-node` 未实现（按合同）。

CLI 新增 `--delay-ms`；`--yes --purge` 停服务、删安装目录（含 db trio）、只删带 tmex 标记的 shim，并尽量删除临时自拷贝。不碰 installDir / unit / 已标记 shim 以外的路径。

## 文件

**新增**
- `apps/gateway/src/system/uninstall.ts`
- `apps/gateway/src/system/uninstall.test.ts`
- `apps/gateway/src/mesh/node-operations.ts`
- `apps/gateway/src/mesh/node-operations.test.ts`
- `packages/app/src/commands/uninstall.test.ts`

**修改**
- `apps/gateway/src/api/system.ts`（`uninstall` capability + POST/GET `/api/system/uninstall`）
- `apps/gateway/src/api/system.test.ts`
- `apps/gateway/src/mesh/mesh-routes.ts`（卸载中继、operation CRUD、列表投影）
- `apps/gateway/src/mesh/mesh-routes.test.ts`
- `packages/app/src/commands/uninstall.ts`
- `packages/app/src/lib/args.ts`
- `packages/app/src/cli/help.ts`
- `docs/hub/2026082800-hub-node-operations.md`（「远程卸载」）

未改：`system-routes.ts`（已有 `/api/system/*` 前缀转发）、`install-info.ts`（路径解析放在 `uninstall.ts`）。

## 验证

| 包 | 命令 | 结果 |
|---|---|---|
| `apps/gateway` | `bun test` | **3405 pass / 0 fail**（基线 ≈3346；含本任务与并行 agent 新增） |
| `apps/gateway` | `bunx tsc --noEmit -p .` | **0 errors** |
| `packages/app` | `bun test src` | **640 pass / 0 fail**（基线 629 + 本任务 11） |
| `packages/app` | `bunx tsc --noEmit -p .` | **1 error**（既有 `TS2688` Cannot find type definition file for 'node'，未新增） |
| biome | `bunx biome check` 上述源文件 | 通过 |

`packages/app` 全量 `bun test`（含 `scripts/`）会因缺少 `dist/runtime/server.js` 失败 `scripts/build-runtime.test.ts`（与本任务无关，未构建 dist）。

## 未做 / 留给别人

- 前端节点管理页「卸载 tmex」与 `revoke-node`（FE / api-client / shared 不在范围）。
- 未改 `apps/gateway/src/tunnel/**`。
