## Blocker

- `apps/gateway/src/hub/hub-runtime.ts:223` — `handleRevoke` 仅凭普通 `node-session` 就直接写入 `nodes.status='revoked'` 并断开 uplink，没有要求根钥或 passkey 签名的 `revoke-node` 记录。这让 hub API 实际决定成员资格，也允许持有被盗会话的 entry 执行持久撤销：攻击者调用该接口后，目标节点后续会在 `uplink-server.ts:197` 被永久拒绝。应要求请求携带签名 key-log 记录，经 `UserKeyService.apply` 完整验证后，再根据已验证的 `revoke-node` effect 更新状态和断链。

- `apps/gateway/src/hub/uplink-server.ts:302`、`apps/gateway/src/hub/hub-test-helpers.ts:55` — `key.log.append` 只校验 base64 和签名长度，随后调用语义未受约束的 `append`；diff 中唯一实现会直接接受随机字节，测试也明确把随机 8 字节记录视为成功。失陷普通节点可推进 hub 的日志 head，导致诚实节点遇到畸形记录或 `seq/prev_hash` 分叉而无法同步。必须把该路径接到 `UserKeyService.apply`，验证 Borsh、uid、seq、prev_hash、epoch、root/passkey 签名及 payload，并新增伪造 `admit-node`、`revoke-node`、`rotate-root` 必须失败的测试。

## Major

- `apps/gateway/src/hub/hub-runtime.ts:311`、`apps/gateway/src/hub/hub-runtime.ts:345` — redeem 采用“查询未使用→无条件标记使用→创建节点”的非原子流程。两个 hub worker 可用同一 enrollment 私钥签出不同 node ID，并同时读到 `used_at=null`，最终创建两个节点。后续仅把 `markEnrollmentUsed` 替换成 `consumeEnrollmentToken` 仍不够：必须检查原子消费的返回值，失败者立即返回 `reused`，且消费与 `createNode` 最好处于同一事务，避免节点创建失败后令 token 永久烧毁。

- `apps/gateway/src/hub/hub-runtime.ts:243` — enrollment 创建把 `authorization_sig` 固定为 64 字节 Ed25519，并始终使用根公钥验签，完全没有按 `authorization.signer` 分流。`createEnrollment(passkeySigner, ...)` 产生的 WebAuthn assertion 会在长度检查或根签名检查处返回 400，因此设计规定的 passkey enrollment 不可用。应先解码 authorization；`root` 分支验 Ed25519，`passkey` 分支解析 assertion、解析 credential，并按 `sha256(authorizationBytes)` 完整验证 WebAuthn。

- `apps/gateway/src/hub/hub-runtime.ts:329` — redeem 没有把 authorization 的 `root_epoch` 与当前用户 epoch 比较。用户生成 enrollment 后执行 `rotate-root`，旧 join token 在十分钟内仍可 redeem、创建 `nodes` 行并取得完整 key log 和证书集合。应在消费前读取当前用户并核对 epoch；根轮换时还应原子失效该用户所有未消费 enrollment token。

- `apps/gateway/src/hub/types.ts:7`、`apps/gateway/src/hub/uplink-server.ts:315` — key-log append 的返回类型丢弃了应用产生的安全 effect。即使生产实现正确应用了 `revoke-node` 并更新 `node_certs`，当前已连接的被撤销节点仍留在 `live`/registry 中；`onIncomingStream` 只检查它已经认证过，因而它还能继续发 relay、RTC 和 key-log 请求。验证服务应返回 effects/被撤销 node ID，hub 在提交成功后立即更新 `nodes`、关闭对应 uplink、清理 RTC 注册；同时每次处理 ctl/新流时应拒绝已撤销的 live identity。

- `apps/gateway/src/hub/uplink-server.ts:346` — relay 隔离使用可变的 `nodes.userId` 推断发起方和目标用户，而不是已认证证书身份；同时没有核对 `targetEntry.userId`。例如 `node_certs` 已由 `admit-node` 写入但节点尚未上报 status 时，另一用户可用自选的相同 node ID redeem 出一条不同用户的 `nodes` 行，之后 relay 判定会基于错误元数据。发起方必须只使用 `live.userId`；目标必须存在未撤销的 `node_certs`，且 `targetCert.userId`、`targetEntry.userId` 都必须等于 `live.userId`。`nodes` 只能提供元数据，不能参与授权。

- `apps/gateway/src/hub/uplink-server.ts:24`、`apps/gateway/src/hub/uplink-server.ts:96`、`apps/gateway/src/hub/uplink-server.ts:320` — RTC 注册只保存两个 node ID，没有用户、浏览器会话身份或过期时间，转发时也不检查双方属于同一用户；注册不会在浏览器或链路关闭时清理。重复 authorize 会令 Map 无限增长，旧 `rtcSession` 泄露后还可继续注入 SDP；上层若传入另一用户的目标 ID，本层也会跨用户转发。注册应绑定 uid、认证 browser session/capability、目标节点和短 TTL，使用服务端随机 session ID，并在转发、超时及任一相关链路关闭时删除。

- `apps/gateway/src/hub/uplink-server.ts:81`、`apps/gateway/src/hub/uplink-server.ts:125` — 未认证 uplink 没有认证超时，且 `stop()` 只关闭 registry 中已认证链路。攻击者可以持续打开 `/hub/uplink` 后不发送 `auth.response`，这些 WebSocket 永远不进入心跳也不会被 stop 关闭。应显式维护所有 accepted links，为 challenge 设置短期限计时器，并在认证、关闭、替换或 stop 时清理计时器并关闭连接。

- `apps/gateway/src/hub/uplink-server.ts:151`、`apps/gateway/src/hub/uplink-server.ts:382` — 任意合法 ctl 消息都会把 heartbeat misses 清零，且判断使用 `>`，配置为 3 时实际第四次 miss 才关闭。一个下行已经失效但仍每十秒上报 `node.status` 的节点将永远显示在线，relay 会持续选择不可写链路。只应由匹配 outstanding ping 的 `pong` 清零计数，并在 `misses >= heartbeatMissLimit` 时关闭。

- `apps/gateway/src/hub/uplink-server.ts:85` — 每个 ctl 回调以 `void this.onCtl(...)` 并发执行，没有逐链路串行队列。节点连续发送两条合法的 N+1、N+2 key-log 记录时，两次异步验证可能同时读取旧 head，导致第二条错误返回 `seq_gap`；恶意节点也能并发触发大量数据库操作。应为每条 link 建立 Promise chain/消息队列，严格按帧顺序完成 ctl 处理，并统一捕获失败后关闭或限流链路。

- `apps/gateway/src/uplink-protocol.ts:106`、`apps/gateway/src/hub/uplink-server.ts:137`、`apps/gateway/src/hub/uplink-server.ts:248` — hostile ctl 的边界不足：`seq` 接受非安全整数及任意长度十进制，`inventory/endpoints` 接受任意深度 JSON，解码失败则静默忽略并保持链路。约 800 KiB 的深层 `inventory` 可通过 JSON.parse；首次持久化 stringify 虽被捕获，但原对象仍进入 registry，随后广播时 `JSON.stringify(node.list)` 抛出 `RangeError`，破坏该用户所有 node.list 广播。应限制 ctl 类型对应的大小、深度、数组数量和字符串长度；`seq` 严格限定为 u64（number 必须 safe，字符串至多 20 位并检查上限）；协议违规应关闭或记分限流，而不是无限接受重试。

## 结论

该 diff 的 relay 字节搬运及 END/RST 基本方向正确，未知/已撤销证书和重复 uplink 替换也有处理，但成员撤销、key-log 写入、enrollment 单次消费及 RTC 隔离仍存在直接违反 §2/§5 安全边界的问题。当前版本允许普通会话执行持久撤销，并允许未验证日志进入 hub 状态，因此不应合入；至少需先修复两个 blocker，并补齐原子 redeem、revocation effect、跨用户检查和 hostile ctl 测试。