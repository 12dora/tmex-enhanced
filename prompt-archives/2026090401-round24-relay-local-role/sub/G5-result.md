# G5 结果 — password-join 后端复杂度拆分

## 结论

P1 引入的 gateway / app / shared 圈复杂度门禁已清掉，未加 allowlist，行为保持不变。`applyRelayKeyLogAppend` 实测未超 CC 15，未改。

## 拆分

| 原热点 | 处理 |
|---|---|
| `performRelayPasswordJoin` CC 24 / 175 行 | 编排留在 `relay-password-join.ts`；四阶段迁到 sibling `relay-password-join-flow.ts`：kdf+proof+pack / 日志下载+校验+回放 / 自承认+persist / 上传 pack+CA pin |
| `kdfParamsFromWire` CC 19 | 抽出 `kdfIntInRange` |
| `routePublic` CC 23 | sibling `relay-public-routes.ts` 路由表（`matchPath` + `methodMatches`）；keylog 仍先鉴权再 405 |
| `handleMeshRelayPack` CC 16 | `selectPackTargets` + `forwardPackToRelay` + `readForwardErrorCode` |

## 其它任务项

- HTTP redeem `notifyQuota(tenant.id)`：`relay-routes.test.ts` 用 `spyOn(uplink, 'notifyQuota')` 断言。
- `sealRelayPack` / `openRelayPack`：工作副本 seed/KEK/编码明文、subtle 入参副本均 `fill(0)`；seal 结束后清零传入的 `log_key`/`token`（不碰 `head_hash`，避免污染调用方 key-log head）。open 在清零工作缓冲前拷出返回值。
- 未改 allowlist、文档、`apps/fe/**`。

## 改动文件

### 新增
- `packages/app/src/lib/relay-password-join-flow.ts`
- `packages/app/src/lib/relay-password-join-flow.test.ts`
- `apps/gateway/src/relay/relay-public-routes.ts`

### 修改
- `packages/app/src/lib/relay-password-join.ts`（编排 + 再导出 `RelayPasswordJoinError`）
- `packages/app/src/commands/relay-password-join.test.ts`（非法 URL）
- `packages/shared/src/relay/relay-pack.ts` + `relay-pack.test.ts`
- `apps/gateway/src/relay/relay-runtime.ts`
- `apps/gateway/src/relay/relay-routes.test.ts`
- `apps/gateway/src/mesh/relay-pack-routes.ts` + `relay-pack-routes.test.ts`

## 测试

- shared pack：round-trip 先快照再 seal；**seal 后明文密钥缓冲全零**；kdf 边界（iterations=0 / parallelism=17 / 合法下限）
- app flow：`pinHead` 过短/哈希不符/命中；`relaysForPersist` 前置去重；非法 URL → `invalid_url`
- gateway：redeem 调用 `notifyQuota`；pack 转发 urls 不匹配 404；全失败 502（`RELAY_KEY_MISSING` + `RELAY_UNREACHABLE`）

## 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` shared / app / gateway | 0 |
| `bun test` shared | **646 pass**（基线 645，+1 seal 清零） |
| `bun test` app | **841 pass / 1 skip / 0 fail**（基线 835，+6） |
| `bun test` gateway | **4202 pass / 0 fail / 2 errors**（基线 4198，本任务 +3；多 1 条疑似并行 agent） |
| `biome check` 本任务文件 | 通过 |
| complexity gate（本范围） | 通过 |

### gateway「Unhandled error between tests」来源

两处相同栈，均来自 `apps/gateway/src/relay/relay-hardening.test.ts:18` 的 `afterEach` → `harness.close()` → `RelayRuntime.stop` → `RelayUplinkServer.stop` → mux `close` 时 `LinkError: relay-rst`（`packages/shared/src/link/mux.ts:247`，经 `relay-stream-router.ts:abortBoth`）。测试本身 pass，是 harness 关流时未吞掉的 RST。

## 需要指挥官处理

### 1. FE 复杂度（未改，按任务交给其它 agent）

当前 `bun scripts/complexity/gate.ts` 仅剩：

- `apps/fe/src/pages/settings/nodes/setup/join-relay-form.tsx:35 JoinRelayForm`: 184 行 > 120
- `apps/fe/src/pages/settings/nodes/relay/use-relay-actions.ts:104 useRelayActions`: 167 行 > 120
- `apps/fe/src/pages/settings/use-node-rename-channel.ts:51 useNodeRenameChannel`: CC 16 > 15

### 2. `applyRelayKeyLogAppend`

任务点名超限，实测未进门禁（CC ≤ 15），故未动 `apps/gateway/src/relay/relay-pack-http.ts`。
