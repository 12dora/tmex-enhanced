# BE 结果：hub uplink-server key-log 分页 + node.list broadcast 排序

## 探索声明核验

### 1. key-log 分页 O(n²) 重编码 — **成立（路径与引用略有偏差）**

`handleKeyLogReq`（原 `uplink-server.ts` 约 649–679 行）在 shrink 循环里每丢掉一条记录就对**整页剩余记录**调用 `encodeUplinkCtl`。Hub 侧 `encodeUplinkCtl` 是 `encodeHubUplinkCtl` = `JSON.stringify` 整帧，循环体内还对每条记录做 `bytesToB64url`（即 `encodeBase64url`）。数百条、逐步收缩时就是数百次整页 Base64 + stringify，最后 `this.send` 再编一次。

任务里点名的 `packages/shared/src/uplink/codec.ts:453-465` 是 **`encodeMeshUplinkCtl`**（对 `Uint8Array` 再 Base64），**hub 出站不走这条路径**。性能问题在 hub 自己的 shrink 循环，不在 mesh codec。未改 `packages/shared`。

### 2. node.list 旧拓扑配上更新 version — **部分成立，修复仍值得做**

`buildNodeList` 先 `await keyLogSource.head()`，**节点/在线集是在 await 之后读的**，所以并发 build 对 registry/userStore 通常看到的是更新快照，并不是「先拍拓扑再 await」。

真正会脏的是 `head()` 在**调用时刻**拍下的 `key_log_head`：慢 build 若带着旧 head 完成，会在对方已发送新 head 之后再 `listVersion++` 并覆盖缓存。客户端按 version watermark 抑制后续更新，就会短暂（若无下一轮 trigger 则一直）停在「更高 version + 过期 head」。

`node.status`（原 :626）与 `onLinkClosed`（原 :987）确实会并发触发 `broadcastNodeList`。按 userId 串行 + generation 丢弃 + trailing rebuild 能堵住这条竞态，并顺带避免空 registry 短路径与 in-flight build 互相覆盖缓存。

## 改动

范围仅 `apps/gateway/src/hub/**`：

- 新增 `key-log-page.ts`：`trimKeyLogPageToByteLimit` 先把记录编成 wire（Base64 一次），用空信封 JSON 字节 + 每条 `JSON.stringify` 长度 + 逗号做前缀累计，选出最长可放入 `KEY_LOG_PAGE_MAX_BYTES` 的前缀，**整页只在 `this.send` 时序列化一次**。
- `handleKeyLogReq` 改为调用上述函数。
- `broadcastNodeList`：每 userId 一个 generation；已有 in-flight 则 coalesce 到同一 Promise；await 之后若 generation 已前进则**不 bump version、不写缓存、不发送**；循环最多再跑一轮 trailing rebuild。摘掉 inflight 与 generation 比较放在同一同步段，避免 await 后再删丢失新 trigger。
- 空 registry 短路径保留（最后一条链路关闭仍不 `head()`），与原测试一致。

未改 allowlist（`uplink-server.ts` 1206 行，allowlist 上限 1226）。未改 mesh/ws/agent/tmux-client，未改 shared codec。

## 设计取舍

- **分页**：不用二分 + 全量 encode 探测，用累计尺寸 O(n)；n≤256。超限时**至少丢掉最后一条再把 `has_more` 置 true**，避免 `has_more: false` 只超 1 字节时靠改成 `true` 塞进同一前缀（旧 while 也不会这么做）。
- **信封尺寸**用与 `encodeHubUplinkCtl` 相同的 `JSON.stringify` + UTF-8，不调用 `encodeUplinkCtl`，以免测试里 spy 把空信封也算进去。
- **broadcast**：generation 在入口 bump；in-flight 结果 stale 则丢弃；burst 期间只允许 1 次 in-flight + 1 次 trailing。

## 风险

- 累计尺寸公式若与 `JSON.stringify` 整帧不一致会选错前缀；对比测试（含随机页、超大单条、false→true 少 1 字节）锁住与旧算法相同的前缀。
- coalesce 后，auth 路径 `await broadcastNodeList() === 'unchanged'` 再补缓存帧：若本次 trigger 被并入 trailing 且 trailing 已 `sent`，返回 `'sent'`，新节点从广播里拿到列表，不再补发。与「新节点已在 registry 之后 rebuild」一致。
- 当前 `tsc` 22 个错误（任务写 21），**全部在 hub 之外**（tmux-client / telegram / ws 测试等），本改动文件无新错误；多出的 1 个视为并行 agent / 既有漂移。

## 测试

| 套件 | 结果 |
|------|------|
| 改前基线（任务给定） | gateway 2800 pass / 0 fail；shared 未动 |
| `cd apps/gateway && bun test` | **2841 pass / 0 fail** |
| `bunx tsc --noEmit -p .`（gateway） | 22 个预存错误，hub 无新增 |
| `bunx biome check`（改动文件） | 通过 |
| `bun scripts/complexity/gate.ts` | ok |

新增/加长用例：

- `key-log-page.test.ts`：与旧 shrink-from-end 算法对比（空页、能放下、后缀裁切、单条过大→空页+has_more、首条过大仍丢整前缀、大 seq、false→true 少 1 字节、40 组伪随机页）。
- `uplink-server.test.ts`：超限页 `encodeUplinkCtl('key.log.res')` **恰好 1 次**；慢/快交错 build 最终 `key_log_head.seq` 为最新且 version 单调；20 次 burst 期间 `head()` 次数 ≤ 2。
