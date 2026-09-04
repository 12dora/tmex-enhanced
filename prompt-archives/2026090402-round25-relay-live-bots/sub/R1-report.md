结论：**Request changes**。共发现 2 个 blocker、8 个 should-fix；未发现值得报告的 style nit。

## Blocker

1. **Telegram 已授权群聊可被任意群成员通过 `/start` 接管命令权限**

   位置：[telegram/service.ts:158](/Users/konata/code/tmex-r25/apps/gateway/src/telegram/service.ts:158)、[db/telegram.ts:193](/Users/konata/code/tmex-r25/apps/gateway/src/db/telegram.ts:193)、[messaging/authorize.ts:16](/Users/konata/code/tmex-r25/apps/gateway/src/messaging/authorize.ts:16)

   已授权的 group/supergroup 依赖数据库中的 `chat.userId === actor.userId`。但任何群成员发送精确的 `/start` 后，`handleStart()` 都会把当前 `fromId` 传入 `createOrUpdatePendingTelegramChat()`；后者即使发现记录已经 `authorized`，仍然更新 `userId`，且保持授权状态。

   因而只要 `allowAuthRequests` 仍开启，攻击者发送一次 `/start` 就能把自己设为命令主体，随后执行 `run` 向终端输入内容，或执行 `approve` 批准 agent 操作。

   最小修复：已授权记录不得通过 `/start` 更新 `userId`。重新绑定必须显式回到 pending 并经管理端审批。迁移后 `user_id IS NULL` 的历史群也不能允许第一个发送 `/start` 的成员自动认领。

2. **docker-node 默认把无鉴权 setup API 暴露到全部主机接口**

   位置：[scripts/docker-node/run.sh:43](/Users/konata/code/tmex-r25/scripts/docker-node/run.sh:43)、[scripts/docker-node/entrypoint.sh:100](/Users/konata/code/tmex-r25/scripts/docker-node/entrypoint.sh:100)、[setup-routes.ts:97](/Users/konata/code/tmex-r25/packages/app/src/runtime/setup-routes.ts:97)、[assemble-routes.ts:482](/Users/konata/code/tmex-r25/packages/app/src/runtime/assemble-routes.ts:482)

   容器内部使用 `--host=0.0.0.0`，而 `docker run -p "${HTTP_PORT}:9883"` 默认发布到宿主机全部接口。standalone 下 `/api/setup/hub`、`/api/setup/join` 等路由没有来源或会话鉴权，并且被安排在 mesh auth guard 之前。

   新鲜容器启动后，同一网络中的攻击者可以抢先调用 setup API，把实例加入攻击者控制的 hub，或创建由攻击者掌握密码的 hub。

   最小修复：默认发布到宿主机回环地址，例如 `-p "127.0.0.1:${HTTP_PORT}:9883"`；若确实需要远程初始化，应增加一次性 bootstrap token，而不是直接公开 setup 写接口。

## Should-fix

3. **tenant token 可伪造 passkey enrollment**

   位置：[relay-enroll-create.ts:55](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-enroll-create.ts:55)、[relay-public-routes.ts:55](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-public-routes.ts:55)

   新 HTTP 路由只验证共享 tenant token。`verifyRelayAuthorization()` 对 root signer 验签，但对 `signer === 'passkey'` 直接成功，不检查断言或 credential。持有一次 r3 join material 的客户端已经获得 tenant token，因此可以构造任意 enrollment key、随机 passkey assertion 并创建、redeem 任意 pending relay node。

   这不会直接产生经过真实 key log 承认的 mesh 节点，但可以伪造 pending 节点并耗尽 enrollment/node 配额，且把原本需要 root/passkey 用户操作的 enrollment 创建权限降级为 tenant bearer 权限。

   最小修复：HTTP 请求额外携带当前 admitted node 对 enrollment payload 的签名，由 relay 使用登记的节点公钥验证；或者仅允许 relay 能验证的 root-signed authorization。不能把 tenant token 本身等同于 passkey 验证。

4. **缺少版本缓存的未撤销远端证书会绕过版本门禁**

   位置：[hub-authorization.ts:219](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:219)、[hub-authorization.ts:225](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-authorization.ts:225)

   只要存在任意已知 member，`skipUncached` 就会跳过其他没有 `nodes`/`peer_cache` 行的未撤销证书。这是实际可达状态：节点刚加入、尚未收到 node list、缓存被重建或旧库尚未刷新。

   例如一个未缓存的 1.1.22 节点会被排除在 `set-relays`/`meta-key` 的 1.1.23 最低版本检查之外；未缓存的 1.1.23 节点也可绕过 `rename-node` 的 1.1.24 门禁。

   最小修复：除显式 `localNodeId` 外，任何未撤销证书缺少版本信息都应作为 `version: null` blocker。bootstrap 豁免应在 `inspectHubAuthRecordCompat()` 的“没有其他未撤销证书”条件中处理，而不是逐条跳过未知远端。

5. **hub 侧两个 key-log 写路径仍会被本机旧版本记录误挡**

   位置：[hub-runtime.ts:651](/Users/konata/code/tmex-r25/apps/gateway/src/hub/hub-runtime.ts:651)、[uplink-server.ts:1601](/Users/konata/code/tmex-r25/apps/gateway/src/hub/uplink-server.ts:1601)

   mesh 本地路由已经向兼容检查传入 `localNodeId`，但 writer 处理 forwarded key-log、以及 hub uplink 处理 `key.log` 时没有传。升级后的本机如果 `nodes.version` 仍为旧值或 null，同一条记录直接提交可以通过，经 standby 转发或 uplink 提交却会被本机证书挡住。

   最小修复：两处均传入 `this.config.nodeId ?? this.config.hubNodeId`；继续对其他旧节点 fail-closed。

6. **1.1.23/1.1.24 relay 缺少新 HTTP 路由时不会回退到旧 uplink 协议**

   位置：[relay-enrollment-fanout.ts:52](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-enrollment-fanout.ts:52)、[relay-enrollment-fanout.ts:124](/Users/konata/code/tmex-r25/apps/gateway/src/mesh/relay-enrollment-fanout.ts:124)

   attached relay 若是 1.1.23/1.1.24，会对新增的 HTTP collection route 返回 404/405。当前仅把 timeout 和 `RELAY_UNREACHABLE` 当作 uplink fallback 条件，因此不会调用旧版本已支持的 `relay.enroll.create`。

   单 relay 部署会得到零个 accepted relay，并返回 `RELAY_ENROLL_FANOUT_FAILED`，导致升级节点后无法再添加节点。

   最小修复：仅对 attached relay，把 `RELAY_NOT_FOUND`、`RELAY_METHOD_NOT_ALLOWED`、`HTTP_404`、`HTTP_405` 也视为 capability miss 并回退到 uplink。

7. **leave-to-relay 可能删除错误租户或留下本机幽灵租户**

   位置：[membership-reset.ts:137](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:137)、[membership-reset.ts:185](/Users/konata/code/tmex-r25/packages/app/src/runtime/membership-reset.ts:185)

   `localRootPublicKey()` 使用无排序、无身份绑定的 `listUsers()[0]`。存在多个用户或旧用户残留时，这不一定是当前 `node_identity.userId` 对应的用户。随后 membership 被全部清空，却可能按错误 root key 删除另一个 relay tenant，或漏掉机器自己的 tenant。

   最小修复：在清理前读取 `node_identity.userId`，精确查询对应用户的 root public key；无法唯一确定时应拒绝转换，而不是选择第一行。

8. **小数 `exp` 可让 tenant-token enrollment route 抛出 500**

   位置：[relay-enroll-create.ts:130](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-enroll-create.ts:130)、[relay-enroll-create.ts:54](/Users/konata/code/tmex-r25/apps/gateway/src/relay/relay-enroll-create.ts:54)

   解析只要求 `exp` 是有限 number，因此 `Date.now() + 300000.5` 可以通过。后续 `BigInt(input.exp)` 对小数抛出未捕获的 `RangeError`，最终成为 500。

   最小修复：解析阶段使用 `Number.isSafeInteger(body.exp)`；非法值返回协议规定的 400。

9. **Telegram 长消息切块可能截断 HTML entity，导致回复被拒绝并丢失**

   位置：[messaging/adapter.ts:20](/Users/konata/code/tmex-r25/apps/gateway/src/messaging/adapter.ts:20)、[messaging/adapter.ts:59](/Users/konata/code/tmex-r25/apps/gateway/src/messaging/adapter.ts:59)

   实现先把 `<`、`>`、`&` 转成 `&lt;`、`&gt;`、`&amp;`，再按字符位置硬切。边界可以落在 `&lt;` 中间；Telegram 收到的 `<pre>...&l</pre>` 是无效 HTML，发送异常只会记录日志，对应 tail 输出直接丢失。超长非 code block 还可能被切断标签。

   最小修复：使用不会拆分 entity/标签的 HTML-aware splitter；或者先按原文切块，再逐块 escape，并按 escape 后长度重新调整边界。

10. **远端 agent 的 credential warning 会标成当前本地节点**

   位置：[run-notify.ts:176](/Users/konata/code/tmex-r25/apps/gateway/src/agent/run-notify.ts:176)、[notification-format.ts:78](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/notification-format.ts:78)、[notification-format.ts:177](/Users/konata/code/tmex-r25/apps/gateway/src/events/channels/notification-format.ts:177)

   `run-notify` 已把远端 `nodeId/nodeName` 写入事件 payload，但所有格式化路径都调用无参数的 `nodeLabelLine()`，它只读取当前进程的本地 `node_identity`。credential warning 的专用格式又不显示 device 行，因此远端会话的凭据告警只会显示错误的本地节点名。

   最小修复：令 `nodeLabelLine(event)` 优先使用 `event.payload.nodeName`，其次使用 `nodeId`，只有事件没有远端上下文时才回退到本地 identity。

## 其余结论

- migration 0044 的两个 `DEFAULT 0 NOT NULL` 列和 nullable `user_id` 对既有 SQLite 数据安全，managed migration 与 journal 已接线。
- 1.1.22 本身没有当前 relay enrollment 协议；1.1.23/1.1.24 的实际兼容回归是上述 HTTP 404/405 未走 uplink fallback。
- 未发现本轮新增的 timer、socket 或 Map 存在明确的无界泄漏路径。
- 现有相关定向测试均通过，但没有覆盖上述攻击和兼容场景；版本门禁的“存在一个已缓存 peer、另一个未缓存 active cert”路径已可在内存库复现。