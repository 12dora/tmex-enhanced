发现 8 个真实缺陷：

1. P1（高）— key-log 失败路径仍可能被当作完成  
   [uplink-client.ts:565](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:565)、[uplink-client.ts:619](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:619)、[uplink-client.ts:708](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:708)

   场景：本地日志领先 hub 时，`pushMissingToHub()` 遇到 append timeout/NACK 只是 `return`，调用方仍执行 `finishNodeList()`。本地落后时，`applyMany()` 返回 `invalid_signature`、`fork` 等错误或 head 不前进，也只是警告后返回，连接继续保持 `online`，不会重连或触发硬分叉。

   部分成功应用的前缀由逐条事务保证内部一致，但同步状态会停在中间且没有恢复触发。实测 `applyMany` 返回错误后得到 `state:"online", linkStillPresent:true`。

   修复：让 push/apply/stalled 全部分支返回明确结果；任何未达成目标 head 的情况不得 finish。普通失败执行有界重试后断链；`fork` 调用 `failFork()`；partial apply 后重读 head，使下次连接从已提交前缀继续。

2. P2（中）— `authenticated` 没有真正绑定连接代次  
   [uplink-client.ts:226](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:226)、[uplink-client.ts:426](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:426)、[uplink-client.ts:442](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:442)

   场景：已经认证后，若用公开的 `connectWithLink()` 替换连接而旧连接尚未 teardown，方法会增加 generation、替换 link，却不会清除 `authenticated`。新连接可在自己的 `auth.ok` 前发送 `node.list` 并污染 `hub_meta`。已用两条内存连接复现，认证前的 `https://preauth.invalid` 被持久化。

   旧连接回调本身会被 generation 检查拦截，但新代次继承旧布尔值仍破坏认证门闩。

   修复：新连接开始时清理所有连接级状态，或记录 `authenticatedGeneration`，处理受保护帧时要求其严格等于回调捕获的 generation。

3. P2（中）— key-log 响应仍允许无 ID，关联并不严格  
   [uplink-client.ts:447](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:447)、[uplink-protocol.ts:72](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-protocol.ts:72)

   场景：请求 A 超时后请求 B 使用不同 `from_seq`；A 的迟到响应若未带 `id`，当前条件会直接把它交给 B。旧版 hub、滚动升级或恶意 hub 均可触发，造成错误查询结果或无谓断链。

   修复：带 ID 发出的请求只接受完全相等的响应 ID。若必须兼容无 ID hub，发生超时后必须先断链，禁止在同一连接复用请求槽。

4. P2（中）— list epoch 仍不能阻止“新版本先到、旧版本后到”  
   [uplink-client.ts:498](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:498)、[uplink-client.ts:536](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:536)

   `listEpoch` 只表示到达顺序，不校验同一连接内的 `version`。收到 v2 后再收到 v1，v1 会成为 `latestList` 并立即覆盖 metadata。实测最终持久化 `name:"old", listVersion:1`。

   修复：每个连接代次维护最高已接受 version，拒绝更低版本；连接代次变化时重置 watermark，以兼容 hub 重启后版本归零。

5. P2（中）— hub list 的在线状态在 uplink 断开后无限陈旧  
   [mesh-runtime.ts:888](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:888)、[mesh-routes.ts:232](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-routes.ts:232)

   场景：最后一份 list 标记节点在线，随后本机 uplink 和该节点都断开、且没有真实 peer link。`lastNodeList` 不会清除，API 仍返回 `online:true, reach:null`，但实际请求会失败。

   `getLink()` 仍在拨号前要求有效、未撤销且同用户证书，因此没有信任绕过；缺陷是 UI 状态失真。

   修复：只有 `uplink.state === 'online'` 时才使用 hub presence；断线时发送 offline/state 事件。更完整的方案是把 `hubPresence` 与真实 `online/reach` 分字段。

6. P2（中）— `resolveUserId()` 在多用户数据库中任取第一张证书  
   [mesh-runtime.ts:533](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/mesh-runtime.ts:533)

   场景：self cert 缺失且数据库存在多个用户的证书时，`listCerts()` 的第一行决定 uplink user，没有排序或唯一性检查。错误用户会导致 catch-up 验签失败、peer 被错误过滤；恶意 hub 还可投递该错误用户的有效日志。

   “只有一行 users”本身不会在数据库内部选错用户；空表也不会越界，但会返回空字符串，随后客户端认证成功却永久跳过 catch-up。

   修复：join 时持久化并显式传递节点所属 userId。兼容回退只能在所有证据唯一指向同一 user 时使用；空或歧义应阻止 uplink 上线，而不是返回 `''`。

7. P2（中）— hub 的 key-log 请求告警没有限频  
   [uplink-server.ts:447](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/hub/uplink-server.ts:447)

   任一被攻陷的已认证节点可连续发送 `key.log.req`，每帧都查询日志并写一条 `console.warn`，造成 hub 日志/磁盘压力。客户端的五秒 ctl 错误限频不能保护这里。

   修复：按 nodeId 做 token bucket 或固定窗口限频，并聚合输出被抑制数量；同时限制 key-log 请求频率。

8. P3（低）— ctl 告警仍可记录任意 payload 内容并注入日志  
   [uplink-client.ts:826](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:826)、[uplink-client.ts:852](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-client.ts:852)、[uplink-protocol.ts:201](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/mesh/uplink-protocol.ts:201)

   非法 `t` 会同时进入 `type` 和 `err.message`。恶意 hub 可把换行符、伪造日志或敏感文本放入 `t`，每五秒写入日志。现有测试只验证合法 `t:"node.list"` 时不记录其他字段，没有覆盖非法 type。

   修复：type 只允许协议枚举，否则记为 `unknown`；错误原因映射成固定错误码，不直接记录异常消息，并转义控制字符。

Verdict：Request changes。严格请求关联、认证代次隔离以及所有 key-log 失败不得 finish/保持在线，应在合并前修复。

验证：不需要监听端口的定向测试为 47 pass / 0 fail；包含 `mesh-runtime.test.ts` 的运行是 54 pass / 4 fail，4 项均因沙箱禁止 `Bun.serve({port:0})` 绑定。