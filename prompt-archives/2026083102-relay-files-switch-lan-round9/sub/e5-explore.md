# E5 报告：节点为何停止接收新 admission

## 结论

最符合现象的代码路径是：

```text
Hub 发送 node.list(seq/head 变更)
  → node 请求 key.log.req(from_seq=5)
  → 本地 applyMany(seq 5/6)
  → 只有 catch-up 完成后才 emitNodeList()
  → emitNodeList() 才写入 peer_cache
```

当前版本把普通 peer 写入从 `ingestNodeList()` 移到了 catch-up 成功之后。因此只要 seq 5 的 key-log 记录校验失败、响应超时、序列断档或 head 不一致，`node_certs` 停在 seq 4，同时新节点也不会进入 `peer_cache`。`apps/gateway/src/mesh/uplink-key-log-sync.ts:158-183`

## 1. 节点列表传播及 peer_cache

Hub 的 `node.list` 由 `UplinkServer.publishNodeList()` 发送给同一用户的所有已认证 uplink：

```ts
if (prev === fingerprint) return 'unchanged';
this.listVersion += 1;
msg.version = this.listVersion;
...
for (const entry of this.registry.listForBroadcast(userId)) {
  this.sendBytes(entry.link, bytes);
}
```

`apps/gateway/src/hub/uplink-server.ts:329-356`

当前 Hub 会在以下事件触发广播：

- uplink 认证成功：`apps/gateway/src/hub/uplink-server.ts:539-615`
- 收到 `node.status`：`apps/gateway/src/hub/uplink-server.ts:617-665`
- key-log append effects：`apps/gateway/src/hub/uplink-server.ts:367-382`
- uplink 断开：`apps/gateway/src/hub/uplink-server.ts:996-1008`
- rename：`apps/gateway/src/hub/hub-runtime.ts:298-308`
- redeem 已存在节点：`apps/gateway/src/hub/hub-runtime.ts:485-499`

首次 redeem 新节点时，`existing` 为空，所以：

```ts
replacedExisting: Boolean(existing)
```

为 `false`，`finishRedeem()` 的直接广播分支不会执行。首次 admission 依赖对应 key-log append 的 effects 广播。`apps/gateway/src/hub/hub-runtime.ts:612-695`

当前 `list_version` 是 Hub 进程内的全局递增值，不是 key-log seq，也不持久化。只有投影指纹变化才递增；指纹包含 `key_log_head`：

```ts
function nodeListFingerprint(msg: NodeListMessage): string {
  return JSON.stringify({ ...msg, version: 0 });
}
```

`apps/gateway/src/hub/uplink-server.ts:343-350,1065-1129,1140-1142`

节点接收后只有认证完成且消息类型为 `node.list` 才进入同步：

```ts
else if (msg.t === 'node.list') this.keyLog.ingestNodeList(msg);
```

`apps/gateway/src/mesh/uplink-client.ts:513-529`

版本 guard 是：

```ts
if (list.version < this.listVersionWatermark) return;
```

等于 watermark 的列表仍会处理；不是“必须大于 peer_cache.list_version”。重连时 watermark 重置为负无穷。`apps/gateway/src/mesh/uplink-key-log-sync.ts:109-127,158-165`

`peer_cache` 写入发生在：

```ts
private emitNodeList(list: UplinkNodeList): void {
  this.persistAdmittedPeers(list);
  this.onNodeListCb?.(list);
}
```

`apps/gateway/src/mesh/uplink-client.ts:566-569`

普通节点的精确跳过条件：

```ts
if (node.id === this.identity.nodeId) continue;
const cert = this.userStore.getCert(node.id);
if (!cert || cert.userId !== this.userId || cert.revokedLogSeq != null) continue;
```

`apps/gateway/src/mesh/uplink-client.ts:571-585`

因此：

- 没有“新 `list_version` 必须大于旧值”的 peer-cache 写入 guard。
- 没有在这里重新验签；证书应已由 key-log 校验后写入。
- `name`、`inventory` 不会使普通节点跳过写入；`jsonText()` 会把字符串保留为合法 JSON，其他值直接 `JSON.stringify()`。`apps/gateway/src/mesh/json-text.ts:1-11`
- Hub peer 另有“没有可用名称”和“证书缺失/跨用户/已撤销”的 return guard。`apps/gateway/src/mesh/uplink-client.ts:590-608`
- 所有 upsert 都是覆盖更新，没有比较旧 `list_version`。`apps/gateway/src/auth/user-store.ts:367-390`

所谓 prune 实际只删除无有效证书、跨用户或已撤销的 peer。有效但不在新列表中的旧行不会被删除：

```ts
if (cert && uid && cert.userId === uid && cert.revokedLogSeq == null) return false;
...
userStore.deletePeer(nodeId);
```

`apps/gateway/src/mesh/mesh-runtime.ts:842-876`

## 2. key-log 复制及 seq 4 停止条件

`node_certs` 的唯一实际写入路径是 key-log replay 的 `persistApplied()`：

```ts
if (record.type === 'admit-node') {
  ...
  userStore.upsertCert({
    nodeId: nodeIdToHex(certificate.node_id),
    userId,
    admitRecordSeq: seq,
    ...
  });
}
```

`apps/gateway/src/auth/user-key-persistence.ts:166-178`

`enroll.redeemed` 只转发给入口浏览器，不直接写 `node_certs`。`apps/gateway/src/mesh/mesh-runtime.ts:883-903`

catch-up 流程：

1. `node.list.key_log_head` 保存为远端目标 head。
2. 读取本地 head。
3. 本地 seq 小于目标时，请求 `from_seq = local.seq + 1`。
4. 调用 `applyMany()`。
5. 重新读取本地 head。
6. 目标 seq/hash 相同后才调用 `finishNodeList()`。

`apps/gateway/src/mesh/uplink-key-log-sync.ts:273-299,338-386,450-467`

`applyMany()` 对整个页面逐条 replay；任意一条失败都会返回 `applied: 0`，不会提交已准备的前缀：

```ts
for (const input of records) {
  const stepped = await this.replayStep(input, state, { userId });
  if (!stepped.ok) return { ok: false, applied: 0, error: stepped.error };
  ...
}
```

`apps/gateway/src/auth/user-key-service.ts:359-378`

seq 5 可能失败的校验包括：

- record 解码失败：`malformed_payload`
- `seq_gap`
- `prev_hash_mismatch`
- `epoch_mismatch`
- root/passkey record 签名失败：`bad_signature`
- 未知 passkey/signature signer：`unknown_signer`
- signer 类型不允许：`signer_not_allowed`
- 非 genesis 的 reset：`reset_not_genesis`
- admission payload/authorization/certificate 解码失败：`malformed_payload`
- authorization 不是用户 root/passkey 有效签名：`bad_authorization_sig`
- certificate 不是 enrollment key 签名：`bad_cert_sig`
- `enroll_pk` 不匹配：`enroll_pk_mismatch`
- UID 不匹配：`uid_mismatch`
- revoke 未知节点：`unknown_node`
- 重复 node id：`node_id_reused`

`apps/gateway/src/auth/user-key-service.ts:631-665`  
`packages/shared/src/auth/key-log.ts:94-115,218-281,330-400`

具体签名域没有从 `fa7f91e` 到当前改变：

```ts
export const DOMAIN_AUTHORIZATION = 'tmex/enroll/v1';
export const DOMAIN_CERTIFICATE = 'tmex/nodecert/v1';
export const DOMAIN_KEY_LOG = 'tmex/keylog/v1';
```

`packages/shared/src/auth/encoding.ts:10-15`

远端 head 同 seq 但 hash 不同会触发 fork：

```ts
if (local.seq === target.seq && !bytesEqual(local.hash, target.hash)) {
  this.failFork(local, target);
}
```

`apps/gateway/src/mesh/uplink-key-log-sync.ts:450-466`

`failFork()` 会设置永久进程内 latch：

```ts
this.keyLogForked = true;
this.host.tearDown('key_log_fork');
```

但 `reset()` 不清除 `keyLogForked`；之后所有 catch-up 的 `catchUpAliveCtx()` 都会返回 false。`apps/gateway/src/mesh/uplink-key-log-sync.ts:69-74,109-127,185-197,621-625`

复制不是周期性任务：

- Hub key-log catch-up 只由收到并接受的 `node.list` 触发。
- 当前 Hub 把 key-log head 放入 node-list fingerprint，因此 head 变化会产生新 `list.version`。
- peer-to-peer 路径只在已建立 peer 发送 `node.status.key_log_head` 且远端 seq 更大时请求；它没有可靠重试，`applyMany()` 返回错误也被忽略。`apps/gateway/src/mesh/peer-manager.ts:1771-1850`

## 3. 可 grep 的日志及静默点

macOS launchd 将 stdout 写入 `tmex.log`，stderr 写入 `tmex.err.log`。`packages/app/src/lib/service.ts:109-112`

Hub uplink catch-up 相关日志均为 `console.warn`，在 `tmex.err.log`：

```text
[uplink] key.log.req from_seq=5 id=...
[uplink] key-log catch-up request failed ...
[uplink] key-log applyMany rejected: <error> applied=0
[uplink] key-log catch-up seq gap ...
[uplink] key-log catch-up incomplete ...
[uplink] offline reason=key-log-apply-failed
[uplink] offline reason=key_log_fork
```

对应代码：`apps/gateway/src/mesh/uplink-key-log-sync.ts:349-375,388-467,574-618`

`node.list` 解码/处理失败：

```text
[uplink] ctl decode error type=node.list len=... err=...
[uplink] ctl handler error type=node.list len=... err=...
```

`apps/gateway/src/mesh/uplink-client.ts:438-453,676-683`

但以下情况可能没有有效错误日志：

- `key.log.res` 没有 pending request：直接 return。
- 非空错误 `id` 不匹配：直接 return；只有缺失 id 首次打印 warning。`apps/gateway/src/mesh/uplink-key-log-sync.ts:129-149`
- catch-up 被 reconnect/generation/epoch 取消。
- `aborted`、`applier-timeout` 被显式吞掉。`apps/gateway/src/mesh/uplink-key-log-sync.ts:241-263`
- Hub `publishNodeList()` 捕获所有异常后只返回 `'failed'`。`apps/gateway/src/hub/uplink-server.ts:339-357`
- Hub append effects 捕获所有异常后忽略。`apps/gateway/src/hub/uplink-server.ts:838-844`
- Hub 单 link 发送失败被忽略。`apps/gateway/src/hub/uplink-server.ts:441-450`
- catch-up 异步异常通过 `warnCtl()` 映射成通用的 `type=unknown err=handler_error`。`apps/gateway/src/mesh/uplink-client.ts:173-175,676-683`

peer-to-peer 的控制异常使用 stdout：

```text
[mesh][rtc] ctl failed peer=... kind=... reason=...
```

`apps/gateway/src/mesh/peer-manager.ts:756-763`  
`apps/gateway/src/mesh/rtc/rtc-log.ts:44-46`

## 4. 版本漂移检查

以 `fa7f91e` 为 2026-08-29 基线，相关提交实际表现如下：

- `c9aa0319`：Hub/mesh uplink codec 合并到 shared；node.list、key.log.req/res 的字段形状未改变。
- `7fd2c308`：catch-up 拆分 helper；提交说明明确保持已提交前缀语义。
- `8be3c4e6`：key-log sync 从 `UplinkClient` 抽出；提交说明明确协议逻辑不变。
- `b095b237`：改变 `list_version` 语义；从每次 build 递增变成投影未变则不广播。
- `8b575725`：广播变三态；build 失败时不再把旧缓存补发给新认证节点。
- `e52a2b5f`：加入 per-user generation/in-flight/trailing rebuild，避免旧 build 覆盖新状态。
- `c279221e`：把 `key_log_head` 纳入 fingerprint，并把 peer-cache 持久化移到 catch-up 成功后的 `emitNodeList()`。

旧 Hub 的 node.list 类型与当前 shared codec 的必需字段一致：`version`、`key_log_head`、`rtc`、`nodes`；节点条目仍要求 `id/name/online/direct_capable`。`fa7f91e:apps/gateway/src/mesh/uplink-protocol.ts:56-80`  
`packages/shared/src/uplink/codec.ts:162-180,237-325`

旧 Hub 的 key.log.res 也已有 `records/id/has_more/retry_after_ms`；旧客户端同样要求 pending request 的 id 匹配。`fa7f91e:apps/gateway/src/mesh/uplink-protocol.ts:320-338`

因此，基于仓库可审计代码，没有发现 1.0.2→1.1.3 间新的必需 node.list 字段、key-log record 字段或 signature domain 改动。真正显著的是上述广播、fingerprint、catch-up 后持久化语义变化。若线上 Hub 比 `fa7f91e` 更旧，才需额外怀疑“不回显 request id”等协议差异。

## 5. 对用户的实际影响

`/api/mesh/nodes` 不是简单读取 `peer_cache`：

```ts
return [...new Set([this.deps.nodeId, ...certs.map((c) => c.nodeId)])]
```

节点集合来自自身 ID 加未撤销 `node_certs`；`peer_cache` 提供 inventory/direct 能力，内存中的 `lastNodeList` 只提供 listed name。`apps/gateway/src/mesh/mesh-routes.ts:195-230`

所以当前观察下，新节点没有 `node_certs`：

- `/api/mesh/nodes` 根本不会返回新节点。
- peer manager 不会把新节点加入 reach map。
- RTC 不会对新节点发起拨号。
- ws-secure/DC/relay 均不能信任新节点。

信任 guard 是：

```ts
if (!cert || cert.revokedLogSeq != null) return false;
return !!uid && cert.userId === uid;
```

`apps/gateway/src/mesh/peer-manager.ts:681-685`

peer handshake 也直接读取 `node_certs`：

```ts
if (!cert) {
  throw new PeerHandshakeError('unknown', `no node_certs for ${nodeIdHex}`);
}
```

`apps/gateway/src/mesh/peer-protocol.ts:143-155`

## 6. 排名、诊断与修复

### 1）seq 5/6 catch-up 失败，导致整个 node.list 不 emit

最符合“证书和 peer_cache 同时停在 seq 4”。

诊断：

```sql
SELECT id,key_log_head_seq,hex(key_log_head_hash) FROM users;
SELECT seq,type,length(record_bytes),length(sig)
FROM user_key_log WHERE user_id='...' ORDER BY seq;
SELECT node_id,admit_record_seq,user_id,revoked_log_seq
FROM node_certs ORDER BY admit_record_seq;
SELECT node_id,list_version,last_seen_at
FROM peer_cache ORDER BY list_version;
```

grep：

```text
tmex.err.log: [uplink] key.log.req from_seq=5
tmex.err.log: [uplink] key-log applyMany rejected:
tmex.err.log: [uplink] offline reason=key-log-apply-failed
```

修复重点：先修复 Hub 上 seq 5 的 record/签名/链状态；代码涉及 `apps/gateway/src/auth/user-key-service.ts`、`packages/shared/src/auth/key-log.ts`、`apps/gateway/src/auth/user-key-persistence.ts`。之后必须让 Hub 重新发送包含新 head 的 node.list。

### 2）Hub 没有发布新 node.list，或 publish 失败被静默吞掉

诊断：

- Hub authenticated session 执行 `GET /api/hub/nodes`。
- Hub authenticated session 执行 `GET /api/auth/keylog/head`。
- 节点执行 `GET /api/mesh/nodes`、`GET /api/auth/keylog/head`。
- 节点无 `key.log.req from_seq=5`，而 Hub 已有 seq 5/6，则优先确认此项。

修复重点：升级 Hub；涉及 `apps/gateway/src/hub/uplink-server.ts`、`apps/gateway/src/hub/hub-runtime.ts`。首次 admission 的广播不应只依赖 `replacedExisting` 分支。

### 3）`list.version` 被旧 watermark 丢弃

精确条件：

```ts
if (list.version < this.listVersionWatermark) return;
```

但本次节点进程重启会把 watermark 重置为 `-Infinity`，所以对“今天 16:44 已重启”的观察，优先级低于前两项。

诊断：检查 node.list 解码日志和 peer_cache 的 version；修复涉及 `apps/gateway/src/mesh/uplink-key-log-sync.ts`，根本上仍应升级 Hub，避免旧/回退 list version。

### 4）旧 Hub 发来的 node.list/key-log wire shape 不兼容

当前仓库对 `fa7f91e` 未发现字段级不兼容；只有在线上实际版本早于该基线时才提高优先级。

诊断：

```text
tmex.err.log: [uplink] ctl decode error type=node.list
tmex.err.log: [uplink] ctl decode error type=key.log.res
tmex.err.log: [uplink] key.log.res dropped: missing id
```

修复：Hub 与 node 一起升级；协议实现涉及 `packages/shared/src/uplink/codec.ts`、`apps/gateway/src/hub/uplink-server.ts`、`apps/gateway/src/mesh/uplink-client.ts`。

### 5）Hub node.list 有新 ID，但节点证书被 guard 跳过

精确条件是证书缺失、用户 ID 不匹配或已撤销；普通 name/inventory 不会跳过普通 peer。

诊断：对照 Hub `/api/hub/nodes` 的 `id/status/certificate` 与节点 `node_certs`；若 node.list 已到达但没有 `key.log.req`，检查这些 guard。

修复：修复 key-log replay/用户 ID/证书链；涉及 `uplink-client.ts`、`user-key-service.ts`、`key-log.ts`。不要直接手改生产数据库。

最终判断：必须先通过日志确认“没有收到新 node.list”还是“收到后从 seq 5 catch-up 失败”。若存在 `key.log.req from_seq=5`，根因范围基本收敛到 seq 5 记录、响应格式、签名/链校验或 head fork；若完全没有该日志，则优先处理 Hub 广播/版本语义。