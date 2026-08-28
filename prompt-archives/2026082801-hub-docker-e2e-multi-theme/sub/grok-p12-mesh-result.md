# grok-p12-mesh 执行结果

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。范围 `apps/gateway/src/hub/**`、`apps/gateway/src/mesh/uplink-protocol.ts`、`apps/gateway/src/mesh/uplink-client.ts`、`packages/shared/src/link/mux.ts`（+ tests）。无 git 操作。未跑 harness。

`review-p11.md` 的 1 条 P1（未认证 uplink 绕过 CTL 64 KiB 上限）已落地。

## 改动摘要

| # | 处理 |
|---|------|
| 1 | Hub inbound decoder 永远 64 KiB，不再用 `key.log.res` 子串放宽到 1 MiB；默认拒绝 `key.log.res`（node-bound）。测试/出站解码走 `allowKeyLogRes`。 |
| 2 | `auth.ok` 前只接受 `auth.response`，其它类型关链 `unauthenticated`。入站先做 64 KiB 硬切，超限 `protocol_error`。认证后收到 `key.log.res` 同样关链。 |
| 3 | Node decoder 仅在 `pendingKeyLogId` 与 `key.log.res.id` 匹配时允许 1 MiB；无 pending / id 不符 / 其它 t 一律 64 KiB。`UplinkClient` 把当前 pending id 传入 decoder。 |
| 4 | Hub CTL 队列硬顶 `HUB_CTL_QUEUE_MAX=8`，溢出关链 `ctl-overflow`。`enqueueCtl` 返回 Promise；mux 在 `onMessage` 返回 thenable 时推迟 CTL WINDOW，处理完才回信用。关闭后不再发 WINDOW。 |

## 测试（先红后绿）

| 测试 | 覆盖 |
|------|------|
| `hub inbound 拒绝 key.log.res 与 1 MiB 帧` | #1 decoder |
| `pre-auth 1 MiB key.log.res 关闭链路` | #2 64 KiB / 方向 |
| `pre-auth 非 auth.response 关闭链路` | #2 handshake |
| `ctl 处理队列溢出关闭链路` | #4 队列硬顶 |
| `1 MiB key.log.res 仅在存在匹配 pending id 时接受` | #3 node decoder |
| `defers CTL WINDOW until a promise-returning onMessage settles` | #4 mux 背压 |

## 数字

| 检查 | 结果 |
|------|------|
| `bun test`（`apps/gateway`） | **2309 pass / 0 fail**（基线 2304；本轮 +5） |
| `bun test`（`packages/shared`） | **331 pass / 0 fail**（基线 330；本轮 +1 mux） |
| `bunx tsc --noEmit -p apps/gateway` | **21** 个 `error TS`（≤ 21；本轮新增 0） |
| `bunx tsc --noEmit -p packages/shared` | **0** |
| `bunx biome check`（改动文件） | 通过 |

## Harness

未跑（commander 负责）。
