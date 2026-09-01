# G4b 结果 — Review round 2 后端修复

RV2 接受项 2/3/4/5/9；拒绝 1/6/10（第 6 项只写文档 trade-off，不改 fencing-record）。HTTPS+cookie 转发路径已删除。

## 1. Writer forwarding 走已认证 uplink

- 新控制帧 `hub.write-forward`（`UPLINK_CTL_TYPES` 末尾；`legacy: true` 剥成 `{ t }`；版本门控 ≥1.1.13）。payload：`{ id, method, path, headers, body, uid?, ack?, status?, error? }`。headers 只允许 `content-type` / `x-tmex-force-keylog`，**剥离 cookie / authorization**。
- Standby：`forwardWriteToWriter` 经 `writerBridge.sendCtl` + waiter 等 ack。无活的写者 uplink → 409 `HUB_NOT_WRITER`。本 worktree `getDisplayVersion()` 仍是 1.1.12，advertised 会被 `node.status` 覆盖成 1.1.12；门控改为「已知旧版本 **且** 写者 uplink 不在线才拒绝」，活链路仍可转发。
- Writer：`UplinkServer.handleHubWriteForward` → `HubRuntime.executeForwardedWrite`。enroll/redeem/revoke/keylog 靠 payload 自认证；**rename 的 uid 仅因发送方是已授权 hub 而采信**（文档已写明该信任）。
- 已删除 HTTPS fetch + cookie 透传及其测试。

## 2. Retired / unauthorized 不能再进入

- Hub 复制 `allowed()` = `isAuthorizedHub` only（去掉 source 自动放行）。
- Node 侧 `node.list` apply 只排除 `signed-retired`（`filterNotRetiredHubRecords` / `isSignedRetiredHub`），否则普通 node 永远学不到 hub。
- `MeshHubStore.orderedEndpoints({ include: meshHubNotRetired })`；seed URL 若匹配已 retired 的 `publicUrl` 则剔除。
- `pickWriterHub` / `/api/mesh/hubs` / `/api/auth/mode` 用非 retired 集合（含 self，除非 self 已 retired）。
- 测试：retired hub 经 seed 重连不能回到 `mesh_hubs` / candidates / writer。

## 3. `hub.tokens` 加固

- 复制前（writer）与 apply（standby）都 `stripEnrollmentReplicationSecrets`：去掉 `entry_sid` / callback / session 元数据。本地 apply 用 `mergeEnrollmentJsonPreservingLocalSecrets` 保住本机已有 `entry_sid`，避免 enroll.redeemed 推不到创建会话。
- 非 ACK `hub.tokens` 只接受当前 writer：发送方 hubNodeId === `pickWriterHub()` 且其 `writerEpoch` ≥ 本地已知 max；否则 drop+log。
- apply 按 `live.userId` 限定行。
- 连接快照分页 ≤48 KiB（`HUB_TOKENS_FRAME_MAX_BYTES`）+ `more`；发送前 `encodeHubUplinkCtl` 断言大小。

## 4. Force-keylog 端到端

- `key.log.append` 增加可选 `force?: boolean`（末尾字段，legacy 剥离）。
- HTTP `X-Tmex-Force-Keylog: 1` → `handleKeyLogHubSync(..., force)` → uplink append。
- Writer uplink gate 与 HTTP force 同警告日志。测试：old-node-present + force → append 经 uplink 成功。

## 5. 服务端 epoch 分配

- `mode:'active'` 且省略 `writerEpoch` → 目标分配 `max(env, own row, all mesh_hubs)+1` 并 `console.info`。
- 显式 epoch 仍走严格 `>` 检查。契约注释已对齐。

## 6. 文档

`docs/hub/2026090104-multi-hub-standby.md`：

- 写入围栏改为 uplink `hub.write-forward`；写明 rename uid 信任（已授权 standby 断言本机会话用户）。
- 已知限制新增 11（节点会话即目标机完全控制权）、12（被 admit 的 hub 获得围栏权 / 失陷影响范围是 hub 控制面）。

## 文件

修改：

- `packages/shared/src/uplink/codec.ts`、`codec.test.ts`
- `apps/gateway/src/hub/{writer-forward,hub-tokens,hub-replication,hub-role-routes,hub-runtime,uplink-server,uplink-protocol,hub-authorization,index}.ts` 及对应 `*.test.ts`
- `apps/gateway/src/auth/{user-store,mesh-hub-store}.ts` 及 `*.test.ts`
- `apps/gateway/src/mesh/{mesh-runtime,mesh-routes,auth-routes,uplink-key-log-sync,uplink-client}.ts` 及对应 `*.test.ts`
- `apps/gateway/src/mesh/integration/multi-hub.integration.test.ts`（`stampHubCtlVersions`，避免 1.1.12 覆盖 1.1.13）
- `docs/hub/2026090104-multi-hub-standby.md`

未改：`uplink-pool.ts`、`apps/gateway/src/api/**`、`system/**`、`tunnel/**`、`apps/fe/**`。

## 测试 / tsc

| 包 | bun test | tsc `--noEmit` |
|---|---|---|
| `packages/shared` | **427 pass / 0 fail** | **0** |
| `apps/gateway` | **3474 pass / 0 fail**（329 files） | **0** |

Biome：变更源文件 `biome check` 干净。

## 未做 / 注意

- `getDisplayVersion()` 本 worktree 仍是 1.1.12。活的 writer uplink 即使 advertised 被覆盖成 1.1.12 也允许 `hub.write-forward`；仅「已知旧版本且 uplink 不在线」才 409。发版切到 1.1.13 后可收紧为纯版本门控。
- 集成测试用 `stampHubCtlVersions` 把 A/B 的 stored version 钉在 1.1.13，避免 `node.status` 回写 1.1.12。
- 未改 fencing-record（RV2 拒绝项 6）；围栏仍可自报 epoch，trade-off 只写进文档。
