# TASK BUG 结果 — multi-hub 写者选举回归

## 真因

`1aba18f5` 拆 `auth-routes` 本身没有改写者选举逻辑，也没有弄丢 `AuthRoutes` 上被 duck typing 调用的方法。方法名集合差（`handleKeyLog*` / `resolveHub` / `authorizedHubRows` 等）全仓 grep 后，外部没有任何 `?.` / 结构化可选调用；`handleKeyLog` 在这条用例里确实从未进入。

真正被改掉的是**时序**。失败路径是：

1. 测试 `takeDown(A)` 后立刻 `loginSelf(B)`，B/C/D 的 uplink 开始 failover 到 B。
2. B 是 dual-role：自己的 node-side uplink 也会连到自己的 hub-side。
3. 连接认证时 hub-side 生成的 `node.list` 仍是「B=standby/epoch 1，A=active/epoch 1」。
4. `UplinkKeyLogSync.catchUpFromList` 是 async（即使 seq 已对齐也要 `await head`），`finishNodeList` 在 catch-up 结束后才 `emitNodeList`。
5. `loginSelf` 返回后 role API 把 B `applyLocalRole('active', 2)`，`upsertSelfHub` 把 mesh_hubs 写成 B=active/epoch 2。此时 `mode()` 已是 `'active'`。
6. 随后 in-flight 的 catch-up 完成，`applyUplinkNodeList` → `reconcileHubStoreFromNodeList` 对 **B 自己的** `hubStore.replaceAll` 写入那份过期 list，把刚提升的本机行盖回 standby/epoch 1。
7. redeem 走 `UplinkServer.isWriter()` → `pickWriterHub(authorizedHubRecords())` 仍选出 A/epoch 1 → `409 HUB_NOT_WRITER`。

运行时证据（加日志后）：`applyLocalRole` 当下 `meshHubs` 已是 B active e2；紧接着 `replaceAll` 栈顶是 `uplink-key-log-sync.ts:finishNodeList` ← `runCatchUpFromList`。live `currentMode` 仍是 active，所以 `mode()` 断言通过、写者检查失败。

`handleLogin` 抽出 `verifySecondFactors` / `loginRequestContext` 多了一层 `await` 与同步准备工作，改变了 `loginSelf` 相对 catch-up microtask 的完成顺序，把这条原本偶发的 TOCTOU 变成稳定失败。换回未拆分的 `auth-routes.ts` 只是把时序拨回去，洞还在。

对照：`applyReplicatedNodeList`（`hub-replication.ts`）已经会 overlay `self.record`，且 `meta.hubNodeId === ownId` 时直接 return。node-side 的 `reconcileHubStoreFromNodeList` 没有这两条，dual-role 自连时会用过期 snapshot 覆盖本机写者行。

## 为什么类型检查抓不到

这不是丢方法 / 过期引用 / 类型变窄。`AuthRoutes` 上搬走的 key-log 方法本来就是 `private`，调用方从不走它们。tsc 看到的 `replaceAll(recs)` 签名完全合法，过期 list 在运行时才出现。可选调用 `x.foo?.()` 假说与 import 摇树假说均已排除。

## 怎么修的

未回退 auth-routes 拆分。在 `apps/gateway/src/mesh/node-list-apply.ts` 的 `reconcileHubStoreFromNodeList` 里，`replaceAll` 前走 `preferLocalHubRecords`：

- 本机已有 hub 行且不在 incoming 中 → 补回；
- incoming 本机行 epoch 更低，或 epoch 相同但要把 active 降成 standby → 保留本地行。

这与 `applyReplicatedNodeList` 的 self overlay 对齐。更高 epoch 的远端广告仍可覆盖（fence/真正切主）。普通 node（hubStore 里没有自己的 hub 行）行为不变。

未改 `auth-routes.ts` / `auth-key-log-routes.ts`。登录失败码顺序、`TOTP_REQUIRED`/`PASSKEY_REQUIRED` 不计失败、可信源免 passkey 判定均未动。

## 加了哪条测试

`apps/gateway/src/mesh/node-list-apply.test.ts`：

1. **stale node.list does not downgrade a locally promoted writer row** — 本机 active/epoch 2 时，incoming 仍写本机 standby/epoch 1，`pickWriterHub` 必须仍是自己。
2. **plain node still takes the writer hub set from node.list** — 没有本机 hub 行时，仍全量接受 list（新 writer epoch 3 胜出）。

## 验收

- `bun test src/mesh/integration/multi-hub.integration.test.ts`：21 pass / 0 fail。
- 原失败用例连跑三次：均 pass。
- `apps/gateway && bun test`：3827 pass / 4 fail / 0 error。失败均为既有 flake（stream failover、两例 24 MiB mesh push、RtcPeerManager TTL sweep），无 multi-hub。
- `bunx tsc --noEmit -p .`（gateway）：0 error。
- `bunx biome check` 改动文件：通过。
- `bun scripts/complexity/gate.ts`：本任务文件无 violation；全局 3 条为其它包既有项，未改 allowlist。
