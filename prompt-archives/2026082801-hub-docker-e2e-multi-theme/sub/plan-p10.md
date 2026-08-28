# plan-p10：关闭 review-p9 的 5 条 finding

日期：2026-08-28。工作区 `tmex-enhanced-wt-merge`（`chore/merge-hub-tabs`）。无 git 操作。

范围：`apps/gateway/src/mesh/**`、`apps/gateway/src/hub/**`、`apps/gateway/src/auth/user-key-service.ts`、`packages/shared/src/link/mux.ts`、`packages/shared/src/ws-borsh/**`、`packages/ws-client/src/**`、`apps/fe/src/node/mesh-nodes.ts`（+ 其测试）。

每条 finding 先红后绿。

## 1. 入站替换必须经 quiesce fence

`track()` 收到更高优先级入站链时，若 `prev.quiesceCapable !== true`，不得 `retirePeer(prev)`。新链暂存（已认证、不接流）或关闭，直到旧链 ACK；legacy 端主动拨升级时在途 OPEN 不得丢。

测试：legacy peer 在 OPEN 在途时发起 ws-secure 升级。

## 2. applier abort 真正取消底层写入

`head` / `list` / `applyMany` 接收 `AbortSignal`。`applyMany` 在记录之间检查 abort，先整批校验再 head-CAS 提交。uplink 按代次追踪 **原始** applier Promise，重连时 bounded await，禁止两代并发改 key-log。

测试：abort 半批 → 后续记录不提交；重连等待 in-flight commit。

## 3. NODE_EVENT 带上 version / direct_capable / name

扩展 Borsh schema（option 字段；解码兼容旧 4 字段 payload）、gateway 编码器、ws-client 类型、fe `mesh-nodes.ts` patcher。

测试：encode/decode roundtrip + fe patcher。

## 4. overflow 有界、节点公平、显式限流

per-user overflow 带 TTL/sweep，计入 `size`；overflow 内 per-node 子桶 + 节点数硬顶。限流返回 `key.log.res` `error: rate_limited`。测试计数器。

## 5. mux async send 失败先关链

`sendFrame` 异步 rejection 先 `finishClose` 再 reject。fire-and-forget 可吞 rejection。

测试：transport.send 返回 rejected Promise 且不触发 onClose → mux 进入 closed。
