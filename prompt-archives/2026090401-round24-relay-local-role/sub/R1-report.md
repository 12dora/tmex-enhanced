## BLOCKER

1. Relay 的 kick／令牌轮换存在 TOCTOU，可让旧令牌重新建立有效链路  
   `apps/gateway/src/relay/relay-uplink-server.ts:381`、`:410`、`:476`、`:333`；`apps/gateway/src/relay/relay-runtime.ts:232`

   失败场景：旧令牌连接在 `checkAuthPreconditions()` 通过后，于 `await Promise.resolve()` 期间发生 `passwd --kick` 或 token reissue。清理逻辑扫描不到尚未注册的连接，随后 `finishAuth()` 使用旧的 tenant 快照将其注册。更严重的是后续消息只复查 `tokenHash` 和 `kicked`，没有复查 `live.tokenEpoch < minTokenEpoch`；`--kick` 又不改变 token hash，因此该连接可以持续存活并打开 relay stream。新 HTTP `/pack`、`/keylog` 路由也在读取异步 body 前完成一次鉴权，kick 后仍可能凭旧快照落库。

   建议修复：在注册连接和数据库写入的最后临界点重新读取 tenant，同时验证 token hash、kicked、token epoch 和全局 min epoch；`dispatchAuthenticated()` 每条消息也必须检查 min epoch。管理员变更应推进一个 auth generation，覆盖 pending 与 live 连接。HTTP 写路由应在事务内对鉴权快照做 CAS。补充可控地卡在 auth/body-read 处再执行 kick/reissue 的竞态测试。

2. Relay 密码加入先提交本地链、后逐条提交远端，正常并发或网络故障会制造不可恢复分叉  
   `packages/app/src/lib/relay-password-join.ts:337`、`:367`、`:372`、`:383`；`packages/app/src/lib/relay-password-join.ts:181`

   失败场景：`commitJoin()`、本地 `admit-node + meta-key` 和 relay secrets 已提交后，另一节点抢先追加远端日志，或第一条 HTTP append 成功、第二条失败。新节点会留下本地用户和更长的 head，而 Relay 可能停在旧 head 或只收到 admit；重试又会被 `local_user_exists` 拒绝。客户端还完全忽略成功响应里的 `member_ignored/member_error`，所以 Relay 拒绝成员副作用时仍会上报加入成功。

   建议修复：增加 Relay 端带 `expected_head` 的原子 batch append；冲突时先重新下载、重建两条记录，不能提交本地状态。用持久化 join journal 保存可恢复的加密材料和阶段，在远端、本地、env 任一步失败后都能幂等续跑；显式拒绝 `member_ignored`。补充 head 竞争、第一／第二条 append 失败、pack 上传失败和进程中断恢复测试。

3. 加入客户端把未经根签 relay 列表授权的 URL 自动加入，绕过 relay allowlist  
   `packages/app/src/lib/relay-password-join.ts:161`、`:371`

   失败场景：恶意 Relay 复制合法 Relay 上的 KDF、密封包和密文日志，并在另一个受系统 CA 信任的域名提供服务。密封包没有绑定 host；用户若被诱导使用该 URL，日志回放得到的根签 `set-relays` 明明不包含它，`relaysForPersist()` 却会主动 `unshift`，将恶意 Relay 设为最高优先级。

   建议修复：回放后必须要求规范化后的 `(url, tenantId)` 精确存在于根签 `set-relays` 投影；不存在立即拒绝。匹配行应使用包内当前 token 替换对应 token，而不是新增目标。可考虑在下一版 pack AAD 中再绑定 relay host。缺少“复制合法 pack/log 到未授权 URL”测试。

## MAJOR

4. 持有 tenant bearer token 即可伪造 passkey admit sidecar，把任意节点加入 Relay 注册表  
   `apps/gateway/src/relay/relay-member.ts:130`、`:144`；`apps/gateway/src/relay/relay-uplink-server.ts:442`

   失败场景：租户已有一个 admitted 节点时，攻击者只需 tenant token 和公开的 root epoch，即可构造 `signer:'passkey'` 的假 `admit-node`；代码既不验 passkey 签名，也不验 authorization／certificate 签名。随后攻击者用自己控制的 Ed25519 key 完成 uplink challenge，成为 admitted relay 节点。

   该行为虽被设计文档 §13 当作边界，但实际把“tenant token”提升成了完整成员准入能力，而不是仅允许“已承认节点提交 sidecar”。

   建议修复：首次 `relay.auth` 只接受根签 sidecar；passkey admit 应由已认证成员额外签署包含 tenant、epoch、seq、record hash 和 node id 的 relay attestation，或要求根钥 countersign。否则必须明确把 token 定义为成员准入密钥并相应收紧其暴露、轮换与恢复模型。

5. 多 Relay 只按第一台的 tenantId/token 密封一次，却把同一 ciphertext 上传给全部 Relay  
   `packages/app/src/lib/relay-pack-upload.ts:30`、`:42`、`:48`、`:95`；`packages/shared/src/relay/relay-pack.ts:79`

   失败场景：每台 Relay 有不同 tenant ID 和 token，但代码用第一条记录生成一次 KEK/AAD和明文，然后原样 POST 给其它 Relay。其它 Relay 虽会存储，却因 tenant ID 不同无法解包；即便 ID 碰巧相同，包内 token 仍属于第一台。所有非 primary Relay 的密码加入都会失败。

   建议修复：逐 Relay 使用各自 tenant ID、token 重新 seal 并上传；Gateway 转发 API也应接收每目标独立的 pack。补充两个 Relay、不同 tenant ID/token 的加入测试。

6. Hub 密码加入无法经在线 standby 正确转发到 writer  
   `apps/gateway/src/hub/hub-runtime.ts:572`、`:578`、`:771`；`apps/gateway/src/hub/hub-password-enroll.ts:122`

   失败场景：standby 会转发 `/by-password`，但 writer 的 `dispatchForwardedWrite()` 没有该路由，最终返回 404。即使只补 dispatcher，客户端 proof 绑定的是 standby host，writer 当前却按自己的 `config.publicUrl` 验证，仍会 `hub_host_mismatch`；转发帧也没有保留可信客户端 IP，无法正确执行限流。

   建议修复：由 standby 验证绑定自身 host 的 proof 和入口限流，再向 writer 发送经已授权 hub 认证的结果；或转发并让 writer 按 `fromHubId` 对应的已签 public URL 验证。需要真实双 Hub、live writer bridge 的端到端测试；现有测试只模拟 ACK 或验证无 writer 时返回 409。

7. Hub／Relay 内存限流可通过换 UID、伪造代理头、键表驱逐及并发请求绕过  
   `apps/gateway/src/hub/hub-enroll-limiter.ts:25`、`:66`、`:76`、`:101`；`apps/gateway/src/hub/hub-password-enroll.ts:113`、`:150`；`apps/gateway/src/relay/relay-enroll-limiter.ts:39`、`:57`；`apps/gateway/src/mesh/client-ip.ts:10`

   失败场景：

   - Hub 失败桶是 `(IP, UID)` 组合，而不是独立的 IP 桶和 UID 桶；换 UID 或分布式换 IP即可继续猜目标密码。
   - `TMEX_TRUST_PROXY=true` 时，没有验证 socket 对端确实是可信代理，直接连接者可伪造 `CF-Connecting-IP/XFF`。
   - 大量随机 UID／tenant ID 会把旧的活跃限流桶从有界 Map 中驱逐。
   - 成功限制在异步持久化后才记账，多条并发请求可同时越过五次上限。

   建议修复：独立维护 IP、UID／tenant 三类桶；只接受配置过的代理 CIDR产生的转发头；限流名额使用同步 reservation/commit；驱逐时不得删除仍在窗口内或已受限的桶。缺少随机身份驱逐、代理头直连和并发 burst 测试。

8. Web `POST /api/setup/relay-join` 加入成功后完全没有写角色环境变量  
   `packages/app/src/runtime/relay-join-routes.ts:46`

   失败场景：数据库已经导入用户、证书、日志和 Relay token，接口随后返回 `restarting:true`，但没有写 `TMEX_ROLES=node`，也没有清空 Hub URL。重启后仍是 standalone，留下已加入但无法正常运行、再次加入又被拒绝的敏感状态。

   建议修复：复用 Hub join 的 staged-env/promote 流程，在加入前准备 0600 临时文件，成功后原子写入 `TMEX_ROLES=node`、清空两个 Hub URL，再调度重启；失败应进入可恢复 journal。现有测试只断言调用参数和响应体，明确缺少 env 内容及 env 写失败测试。

9. 匿名 KDF 响应可以在 pack 鉴权前强迫客户端执行最高 4 GiB Argon2  
   `packages/shared/src/relay/relay-pack.ts:261`、`:269`；`packages/app/src/lib/relay-password-join.ts:280`、`:290`；`packages/app/src/lib/hub-password-join.ts:60`

   失败场景：恶意或失陷 Relay 返回 `memory_kib=4194304, iterations=64, parallelism=16`，客户端在看到任何可认证密封包前就调用 Argon2，足以 OOM 或长期阻塞。Hub 客户端甚至没有参数范围检查。

   建议修复：协议 v1 只接受当前固定参数，或设置严格的客户端资源预算；超限应在调用 Argon2 前拒绝。补充恶意 KDF 参数不会触发派生函数的测试。

## MINOR

10. Relay join 的敏感缓冲仅在成功路径清零  
    `packages/app/src/lib/relay-password-join.ts:315`、`:360`、`:414`

    失败场景：解包后若下载、head 校验、本地提交、远端 append 或 pack 上传失败，`pack.log_key`、`pack.token` 以及可能生成的 `metaKey` 不会清零，只能等待 GC；这与 EX3 的内存清理要求不符。

    建议修复：将这些缓冲提升到函数作用域，并在统一 `finally` 中清零；增加解包后每个失败注入点的清零测试。

11. 服务端允许配置一字符 Relay 接入口令  
    `packages/app/src/runtime/relay-setup-service.ts:57`；`apps/gateway/src/relay/relay-admin-routes.ts:76`

    失败场景：绕过前端直接调用 setup 或管理 API即可设置 `"a"`，公共 Relay 的租户创建口令可被快速穷举，且上述限流绕过会进一步放大风险。

    建议修复：setup 与后续改密共用服务端最小长度／最大长度策略，并补充弱口令拒绝测试。

已核对的现有针对性测试均通过；未发现 0041→0043 注册顺序、`rename-node` CHECK 更新或 canonical `1.1.23` 门槛／消息契约本身存在错误。