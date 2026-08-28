# grok-p1b-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`，只改 `apps/gateway/**`，无 git 操作。未改 `packages/app`。

## 根因（file:line）

Docker 里 `node.list` 已经落库（`list_version=6`、`hub_meta` 在），但 `user_key_log` 停在 join 当时的快照：node-a 只有 seq 1–2，node-b 只有 seq 1–3。不是 Caddy/WS 丢帧，也不是 `key.log.res` 解码失败。

生产 `assembleTmex`（`packages/app/src/runtime/assemble.ts`）创建 mesh 时**不传 `userId`**。`createMeshRuntime` 用 `resolveUserId`：

```ts
// 修复前 apps/gateway/src/mesh/mesh-runtime.ts resolveUserId
return userStore.getCert(nodeIdHex)?.userId ?? '';
```

CLI `hub join` 的 redeem 在 hub 写入该节点自己的 `admit-node` **之前**就把 key log 拷走。node-a 启动时 `node_certs` 里没有自己，只有 hub 的 seq 2。`getCert(self)` 为 null → `UplinkClient.userId === ''`。

随后 `catchUpFromList` 调用 `keyLogApplier.head('')` 得到 `{seq:0n}`，或 `applyMany('', records)` 走 `UserKeyService.applyInternal`（`apps/gateway/src/auth/user-key-service.ts` 约 L261）返回 `unknown_user`。`ingestNodeList` 的 `.catch(() => undefined)` 和 `applyMany` 失败后的 `break` + `finishNodeList()` 把这次失败当成同步完成（评审 #1）。进程内 `mesh.integration.test.ts` 一直绿，是因为它显式传了 `userId: a.boot.userId`，并且 `enrollNodeB` 在拷 log **之前**就 `signAndApply(admit-node)`，self cert 已存在。

容器证据（本轮修复后的对照）：

```
# 修复前 node-a：seq 1–2，certs 只有 hub
# 修复后 node-a 日志：
[uplink] key-log catch-up start local=2 target=3
[uplink] key.log.req from_seq=3 id=d7d4a2f3-...
[hub] key.log.req node=ce55494e... from_seq=3 records=1
[uplink] key-log catch-up result local=3 target=3
[uplink] key-log catch-up start local=3 target=4
[uplink] key.log.req from_seq=4 id=b000f702-...
[hub] key.log.req node=ce55494e... from_seq=4 records=1
[uplink] key-log catch-up result local=4 target=4
```

node-b：`local=3 target=4` 同样一次 `key.log.req` 拉齐。两边 `user_key_log` seq 1–4、`node_certs` 三张、`peer_cache` 含对端。

## 评审修复

| # | 处理 |
|---|---|
| 1 | `key.log.req` 超时 / 空响应不再 `finishNodeList`；带关联 `id`；有界重试后 `tearDownLink('key-log-catch-up-failed')`；迟到响应按 id 丢弃 |
| 2 | 每条连接代次维护 `listEpoch` / `latestList`；旧 catch-up 完成时若已被更新 list 取代则不 persist |
| 3 | 删除 `listReach` 的推测 `relay` overlay。`reach` 只来自 `PeerManager` 已建立链路；`online` 由 hub `node.list`（`listHubOnline`）与真实 reach 并集 |
| 4 | 每条连接 `authenticated`，仅在处理过 `auth.ok` 后接受 `node.list` / key-log / RTC / enrollment；断线清除 |
| 5 | `handleCtl` 区分 decode / handler，限频 `console.warn`（type、len、err，不含 payload）；catch-up start/result 与 `applyMany` 拒绝原因入库 |

## 改动文件

- `apps/gateway/src/mesh/mesh-runtime.ts` — `resolveUserId` 回退到已有 cert / 唯一 `users` 行；去掉 overlay；`listHubOnline`
- `apps/gateway/src/mesh/uplink-client.ts` — 诊断、超时语义、list epoch、auth 门闩、请求 id
- `apps/gateway/src/mesh/uplink-protocol.ts` / `apps/gateway/src/hub/uplink-protocol.ts` — `key.log.req/res` 可选 `id`
- `apps/gateway/src/hub/uplink-server.ts` — 回显 id，打 `key.log.req` 日志
- `apps/gateway/src/mesh/mesh-routes.ts` / `mesh-deps.ts` — hub-list online 与 reach 分离
- `apps/gateway/src/auth/user-store.ts` — `listUsers()`
- 对应单测 / 集成测试（含生产形态：redeem 后才 admit、不传 `userId`）

## 测试

- `bun test`（`apps/gateway`）：**2244 pass / 0 fail**
- `bunx tsc --noEmit -p apps/gateway`：**21** 个 `error TS`（基线 ≤ 23）
- `bunx biome check`（改动文件）：通过

## Harness（pkg4 tarball）

`scripts/hub-e2e/out/report.md`（2026-08-28T06:20:01Z）：

| scenario | result |
|---|---|
| 1a–1c | PASS |
| 2a–2c | PASS |
| 3a–3g | PASS（3f `reach=relay` 来自 hub 上真实 uplink，不是 overlay） |
| 4a | PASS |
| **4b** | **PASS**（node-a 能看到 node-b 并经 `/n/<b>` 登录；修复前永远缺席） |
| **4c** | **FAIL**（见下） |
| **4d** | **PASS** |
| 5 | PASS |
| **6a / 6b / 6c** | **PASS**（hub down 后面板/文件仍通，mesh 仍列出 node-b） |
| 7a–7b | PASS |
| 8 | SKIP（native 缺失） |

### 4c 说明（与本次 catch-up 修复无关）

4c 在 `docker network connect lan` 后 60s 内要求 node-a 看 node-b `reach:'lan'`。超时快照（`wait-reach`）：

```
node-b online=true reach=relay loggedIn=true isHub=false
```

同一次 run：

- 4b 已在 **连 lan 之前** 经 node-a 登录 node-b，`PeerManager` 上留下一条 live **relay**
- `dial()` 对已有 relay 仍会尝试更高 rank 的 `ws-secure`，但当时 node.list 缓存的 endpoint 主要是 `uplink-b` 地址（`ws://172.24.0.2:39001/peer`），node-a 不在该网，LAN iface 尚未重广告
- 场景 6 停 hub 后，同一入口 `/api/mesh/nodes` 变为 `reach:'lan'`，且 6a 终端 marker 在 hub down 时仍通 → LAN 最终建立，只是没在 4c 的 60s 窗口内替换掉 4b 的 sticky relay

删除 overlay 不会造成这次 4c 失败：overlay 只会在**没有 live link** 时填 `relay`；4c 要的是真实 `lan`。4b 之后 listReach 报 `relay` 是因为真有 uplink relay。这是路径升级/endpoint 重广告时序，不在本轮 key-log catch-up 范围内。
