# LT 结果：第 24 轮真实多进程实测（中继口令加入 / Hub 口令加入 / web 中继设置 / 离开到 relay / rename-node / 版本门）

仓库 `/Users/konata/code/tmex-r24`，**全程只读**（未改、未 git 操作任何仓库文件）。
被测后端与实测时的工作区逐字节一致（`diff -rq apps/gateway/src`、`packages/app/src`、
`packages/shared/src/{auth,relay}` 全空），基线 commit 跑测时为 `c3a003dc`，收尾时仓库 HEAD 已被
其它 agent 推进到 `94e45f77`（发版号提交），后端文件无差异。

**结论：38 条断言 37 PASS / 1 FAIL。**唯一的 FAIL 是一个**真 bug 且阻断发版**：

> **用「Hub 地址 + 密码」加入 Hub 的节点，永远连不上 Hub。**
> 加入流程全程成功（`/api/setup/join` 返回 `restarting:true`、Hub 节点清单里能看到它、
> 本机 env 写对），但它的 uplink 被 Hub 以 `unknown-cert` 拒绝，因为**没有任何一方给它签
> `admit-node`**。补签一条后立刻恢复正常（7.2d 已实证）。

另发现 1 个中等问题（中继口令加入的错误全部退化成 HTTP 500 `internal_error`，前端只能显示
「未知错误 + 英文原文」）、2 条口径观察，以及**前端 `bun run --cwd apps/fe build` 连续 5 次失败**
（tsc 报错，属其它 agent 正在改的在途代码）。

---

## 一、拓扑、隔离与安全边界

| 实例 | 起始 `TMEX_ROLES` | 终态角色 | gateway | peer | 说明 |
|---|---|---|---|---|---|
| R | `relay` | `relay` | 19993 | 19961 | 纯中继 |
| A | `node` | `node` | 19994 | 19962 | 租户主节点（先建用户再接入 R） |
| B | `standalone` | `node` | 19995 | 19963 | 走 `POST /api/setup/relay-join` 口令加入 |
| S | `standalone` | `relay,node` → `relay` | 19996 | 19964 | 走 `POST /api/setup/relay` 建中继，再 `leave → relay` |
| H | `standalone` | `hub,node` | 19997 | 19965 | 走 `POST /api/setup/hub` |
| C | `standalone` | `node` | 19998 | 19966 | 走 `POST /api/setup/join { method:'password' }` |
| N | `standalone` | `standalone` | 19999 | 19967 | 负例专用（口令错 / 未知租户 / 篡改包 / Hub 口令错） |
| B2 | 无进程 | — | — | — | 只有一个库 + 假安装目录，跑 CLI `tmex relay join` |
| 假中继 | 驱动内 `Bun.serve` | — | 19992 | — | 投喂被翻位的密封包（4.3） |

`<live>` = `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c1f43d39-77fb-4832-b1c4-2ca4e9c12e4e/scratchpad/live/r24`

### 1.1 关键隔离手法：**每个实例一份仓库克隆**

`resolveSetupEnvPath()`（`packages/app/src/runtime/setup-shared.ts:204`）在 `NODE_ENV=test` 下恒等于
`<repoRoot>/test.env.local`，而 `repoRoot` 由 `resolveRepoRoot()` 从 `import.meta.dir` 上溯四级得到，
**没有任何 env 覆盖点**。若直接跑仓库源码，`/api/setup/*`、`/api/local/leave` 会往仓库根写
`test.env.local`——它被 `loadEnv()` 以 override 语义加载，会污染同一时间其它 agent 的 `bun test`。

因此驱动给每个实例用 APFS clonefile（`cp -Rc`，写时复制、几乎不占额外磁盘）克隆一份仓库到
`<live>/repos/<NAME>/`（含 `apps`、`packages`、`node_modules`、`test.env` 等），实例进程的 cwd 与入口
都指向克隆。实测确认 `resolveSetupEnvPath('test')` 落到
`<live>/repos/<NAME>/test.env.local`；跑完仓库里**没有** `test.env.local`、**没有** `tmex.db`。

其余按共同规则：进程 env **白名单构造**（不 spread `process.env`），`NODE_ENV=test`、
`TMEX_BIND_HOST=127.0.0.1`、`TMEX_DIRECT_ENABLED=false`、`TMEX_STUN_SERVERS=`、
`TMEX_TMUX_SOCKET=tmex-live24`、`TMEX_MIGRATIONS_DIR`/`TMEX_INSTALL_DIR` 指向克隆与 scratch、
每实例一个库。

### 1.2 生产安全复核（收尾实测）

- 默认 tmux socket：`tmex: 3 windows (created Wed Aug 26 00:26:54 2026) (attached)` ——
  与开跑前**逐字一致**，全程未执行任何针对默认 socket 的 tmux 命令。
- `tmux -L tmex-live24 ls` → `no server running`（隔离 socket 已 `kill-server`）。
- 端口 19992–19999、19961–19967 全部释放；`pgrep -fl "scratchpad/live/r24"` 为空。
- 生产服务 `127.0.0.1:9883`（pid 83665）仍在监听，全程未发过一个请求、未 kill、
  未读写 `~/Library/Application Support/tmex/`。
- 仓库 `git status`：只有其它 agent 在改的前端/i18n 文件与 prompt-archives，**没有一处是本任务产生的**。

---

## 二、逐条断言（37 PASS / 1 FAIL）

驱动 `<live>/live24.ts`（约 1000 行），日志 `<live>/run3.log`（最终一轮，100.4 s 跑完）。
`run1.log` 是首轮（36/36 全绿，尚未含 7.2c/7.2d），`run2.log` 是发现 7.2c 时的中断轮。

### 1. 中继 R（3/3）

| 断言 | 证据 |
|---|---|
| 1.1 `GET /api/relay/health` 200 | `{"ok":true,"version":"1.1.24","tenants":0,"nodesOnline":0,"uptimeMs":462}` |
| 1.2 admin API 设 ≥8 位租户口令 | `POST /api/relay/password` 200；`hasPassword=true passwordEpoch=1`（口令 18 位） |
| 1.3 `GET /api/relay/tenants/<random>/kdf` → 404 | `HTTP 404 {"error":{"code":"RELAY_TENANT_NOT_FOUND",...}}` |

### 2. 节点 A 接入 + 密封包上传（6/6）

| 断言 | 证据 |
|---|---|
| 2.0 A 登录 | `uid=a1ece1aa-… nodeId=c182a968…` |
| 2.1 `POST /api/mesh/relay/enroll`（带中继口令） | 200，`tenantId=1570428b26161e4726fa3f396e9b0f4f` |
| 2.2 `set-relays` 后 attached | `{online:true, attached:true, kicked:false}` |
| 2.3 status 带 `tenantId` / `rttMs` / `quota.currentNodes` | `rttMs=27`（首个心跳前为 null，心跳后变数值）、`quota={"maxNodes":16,"maxStreams":64,"bandwidthBytesPerSec":null,"currentNodes":1}` |
| 2.4 `POST /api/mesh/relay/pack` 上传密封包 | 走浏览器同一条路径：`GET /api/mesh/relay/join-material?scope=all` + `GET /api/auth/keylog/head` + `sealRelayPack`（每中继一份，`packs[]` 形态）→ `{"ok":true,"results":[{"url":"http://127.0.0.1:19993","ok":true,"status":200}]}` |
| 2.5 中继库落库 | `sqlite3 R/tmex.db` → `sealed_pack len=141`、`kdf_params_json={"salt":"qNFPkquy-fvV1Jr1Ctlzew","memory_kib":65536,"iterations":3,"parallelism":1}` |

### 3. 节点 B 口令加入（web + CLI，6/6）

| 断言 | 证据 |
|---|---|
| 3.1 `POST /api/setup/relay-join` | 200 `{"ok":true,"relayUrl":"…19993","tenantId":"1570428b…","username":"a1ece1aa-…","direct":"skipped","restarting":true}` |
| 3.2 写出的 env + exit 0 后重启 | 进程 `exit=0`；`<live>/repos/B/test.env.local` = `{TMEX_ROLES:"node", TMEX_HUB_URL:"", TMEX_HUB_PUBLIC_URL:""}` |
| 3.3 B 的 `/api/mesh/relay/status` | `mode=relay`、`attached:true`、`nodesViaRelay=1` |
| 3.4 A 15 s 内看到 B | **5 ms**；`/api/mesh/nodes` → `[{c182a968:"self"},{7db860e7:"B"}]` |
| 3.5 中继注册表 | `relay_nodes.status=admitted` |
| 3.6 CLI 形态 | `tmex relay join http://127.0.0.1:19993 --tenant … --password … --name B2 --install-dir <scratch> --no-restart` → exit 0，输出 `joined relay … (tenant 1570428b…)`；中继侧 `relay_nodes.status=admitted`；假安装目录 `app.env` 被改写成 `TMEX_ROLES=node`。CLI 可以指向 scratch 库（经 `--install-dir` 的 `app.env` 里的 `DATABASE_URL`），无需起 gateway |

### 4. 负例（3/3，但错误码本身有问题，见 §三.2）

| 断言 | 证据 |
|---|---|
| 4.1 口令错 | `HTTP 500 {"code":"internal_error","message":"relay password join failed: HTTP 401 RELAY_BAD_PROOF"}`；`users=0`、`node_identity.user_id=''`（本机库确实没建用户） |
| 4.2 未知租户编号 | `HTTP 500 {"code":"internal_error","message":"relay tenant kdf failed: HTTP 404 RELAY_TENANT_NOT_FOUND"}` |
| 4.3 密封包被篡改 | 从 R 库**只读**取出真密封包、翻掉最后一个字节，由驱动自建的假中继（19992）投喂给真实例 N 走完整 `/api/setup/relay-join` → `HTTP 500 {"message":"pack authentication failed"}`、`users=0`；同时驱动内 `openRelayPack()` 对同一份密文抛 `pack authentication failed` |

### 5. 中继模式 rename-node（3/3）

| 断言 | 证据 |
|---|---|
| 5.1 A 用根钥签 `rename-node` + `?hub=sync` | `HTTP 200 {"ok":true,"seq":8,"hash":"HQwZcASD…","hubAck":true,"localApply":true}` |
| 5.2 A 的节点列表 | `[{c182a968:"self"},{7db860e7:"B-renamed"},{44db4db9:"44db4db98cc8…"}]` |
| 5.3 B 本机身份名 | `B/tmex.db` `node_identity.name=B-renamed` |

> 第三行 `44db4db9` 是 CLI 加入的 B2：它只有库、没有 gateway 进程，不会往中继发状态封，
> 所以主节点侧只能回落显示 node id。**这是预期行为**，不是 bug。

### 6. Web 中继设置 + 离开到 relay（6/6）

| 断言 | 证据 |
|---|---|
| 6.1 `POST /api/setup/relay {role:'relay,node'}` | 200 `{"role":"relay,node","relayPublicUrl":"http://127.0.0.1:19996","hasPassword":true,"restarting":true,"fingerprint":"12f0702d…"}` |
| 6.2 重启后 `/api/local/status.relay` | env 写出 `TMEX_ROLES=relay,node` + `TMEX_RELAY_PUBLIC_URL` + 自动生成的 `TMEX_RELAY_ADMIN_TOKEN`；status → `role:"relay,node"`、`relay:{publicUrl:"http://127.0.0.1:19996", hasPassword:true, tenantCount:0, nodesOnline:0, currentNodes:0}` |
| 6.3 / 6.3b S 自环接入自己的中继侧 | `POST /api/mesh/relay/enroll` 200，`tenantId=a35b2482…`；`set-relays` 后 `{online:true, attached:true}` |
| 6.4 `POST /api/local/leave {expectedRole:'relay,node', targetRole:'relay'}` | 200 `{"fromRole":"relay,node","targetRole":"relay","restarting":true}` |
| 6.5 落盘效果 | env → `TMEX_ROLES=relay`（`TMEX_RELAY_PUBLIC_URL` / `TMEX_RELAY_ADMIN_TOKEN` 保留）；中继表**原样保留** `relay_tenants=1 relay_config=1 relay_nodes=1`；mesh 表**全清** `users=0 node_identity=0 mesh_relays=0 mesh_secrets=0 user_key_log=0 node_certs=0`；重启后 `/api/relay/health` 200（`tenants:1`） |

### 7. Hub 口令加入（6/7，含唯一 FAIL）

| 断言 | 结果 | 证据 |
|---|---|---|
| 7.1 `POST /api/setup/hub` | PASS | 200 `{"fingerprint":"15fc6981…","restarting":true}` |
| 7.1b 重启后角色 | PASS | env `{TMEX_HUB_PUBLIC_URL:"http://127.0.0.1:19997", TMEX_ROLES:"hub,node"}`；`/api/local/status.role=hub,node` |
| 7.2 C `POST /api/setup/join {method:'password'}` | PASS | 200 `{"hubUrl":"http://127.0.0.1:19997","username":"hubadmin","restarting":true}`（http 回环需带 `insecureLocal:true`，见 §四.3） |
| 7.2b H 的节点清单里出现 C | PASS | `/api/hub/nodes` → `[{ddb87000,"tmex",enrolled},{b77b40e1,"C",enrolled}]`；C 的 env 写成 `{TMEX_ROLES:"node", TMEX_HUB_URL:"http://127.0.0.1:19997"}` |
| **7.2c C 的 uplink 应接上 H** | **FAIL** | 45 s 内 `online=false`；H 库 `select count(*) from node_certs where node_id='b77b40e1…'` = **0**；C 的 `server.log`：`[uplink] try hub=http://127.0.0.1:19997 mode=active epoch=0 idx=1/1 transport=ws` → `[uplink] candidate failed hub=… err=unknown-cert fails=1` |
| 7.2d 补签 `admit-node` 后立刻恢复 | PASS | 由持根钥的一方（H 的会话）用 H 库里 C 的 `enrollment_tokens.authorization_json/_sig` + 节点清单里的 `certificate/cert_sig` 拼 `admit-node` → `POST /api/auth/keylog?hub=sync` 返回 `{"ok":true,"seq":3,"hubAck":true}`；随后 C `online=true`、`node_certs(C)=1` |
| 7.3 错误口令走 `/api/setup/join` | PASS | `HTTP 400 {"code":"join_failed","message":"password enrollment failed: invalid_proof"}`；N 的库 `users=0` |
| 7.3b 直连 `/api/hub/enrollments/by-password` 两次错口令 | PASS | 两次都 `HTTP 401 {"error":"invalid_proof"}` |
| 7.4 同 IP+uid 累计 10 次错误后正确口令被限流 | PASS | 失败序列 `[400,401,401,401,401,401,401,401,401,401]` → 用**正确**口令的第 11 次 `HTTP 429 {"error":"rate_limited"}`（`HUB_ENROLL_FAIL_LIMIT=10 / 窗口 60 s`） |

### 8. canonical v1.1 版本门（2/2）

裸 WS（带 A 的 node-session cookie）打 `ws://127.0.0.1:19994/ws`：

| 断言 | 证据 |
|---|---|
| 8.1 `clientVersion:'1.1.22'` | ERROR `{"refSeq":1,"code":1001,"message":"canonical-state-v1.1 required: client 1.1.22 < 1.1.23","retryable":false}`，随后 close `{code:1002, reason:"canonical-state-v1.1 required"}` |
| 8.2 `clientVersion:'1.1.24'` | HELLO_S2C `{"serverImpl":"tmex-gateway","serverVersion":"1.1.24_dev","selectedVersion":1,"maxFrameBytes":1048576,"heartbeatIntervalMs":15000,"capabilities":["canonical-state-v1","canonical-state-v1.1"]}` |

---

## 三、发现的问题

### 3.1 【阻断发版·真 bug】口令加入 Hub 的节点永远连不上 Hub（缺 `admit-node`）

**现象**：`/api/setup/join { method:'password' }`（以及 CLI `tmex hub join <url> --password …`）全程成功，
Hub 的 `nodes` 注册表里也有这台机器（`status:'enrolled'`、带 `certificate`/`cert_sig`），
但它的 uplink 每次都被 Hub 以 `unknown-cert` 拒掉，永远 `online:false`，因此**任何跨节点功能都不可用**。

**根因链（全部读码确认 + 7.2d 实测反证）**：

1. Hub 侧的口令 enrollment 落库时 `entryNodeId: null`、`joinMaterial: true`
   —— `apps/gateway/src/hub/hub-password-enroll.ts:243-252`。
2. redeem 完成后，Hub 只在 `stored.entry_node_id` 非空时才把证书经 uplink 推给「发起方节点」
   —— `apps/gateway/src/hub/hub-runtime.ts:992-1001`。口令加入没有发起方节点，**这一步整个跳过**。
3. Hub 侧唯一写 `node_certs` 的地方是密钥日志里 `admit-node` 记录的投影
   —— `apps/gateway/src/auth/user-key-persistence.ts:201-214`。
4. uplink 认证读 `node_certs`，读不到就拒 `cert_not_admitted / unknown-cert`
   —— `apps/gateway/src/hub/uplink-server.ts:1286-1289`。
5. 加入方自己也不签 `admit-node`：`performHubJoin` 只做 redeem + `commitVerifiedJoin`
   —— `packages/app/src/commands/hub.ts:490-569`；`joinHub` 也只是包一层
   —— `packages/app/src/runtime/setup-service.ts:468-568`。
6. token 加入之所以没事，是因为**发起方的浏览器**会签 `admit-node`
   —— `apps/fe/src/node/enrollment-engine.ts:756,782` → `apps/fe/src/node/enrollment.ts:491`
   （`buildAdmitNodeRecord`）。口令加入的 enrollment 是**被加入方自己造的**，不在任何运营者浏览器的
   pending 列表里，那条回路根本不会触发。
7. Hub 的 `NodeStatus` 只有 `'enrolled' | 'revoked'`（`apps/gateway/src/auth/types.ts:10`），
   **没有「待承认」状态**，前端也就没有任何「手工承认这台机器」的入口——用户遇到这个状态无自救路径。

**反证（7.2d）**：手工补一条 `admit-node`（authorization 取自 H 库
`enrollment_tokens.authorization_json/authorization_sig`，certificate 取自 `/api/hub/nodes` 行）
→ `POST /api/auth/keylog?hub=sync` 200 → C 秒级 `online:true`、`node_certs(C)=1`。
**除这一步外，口令加入链路其余部分全部正确。**

**建议修法（不在本任务范围内实施）**：照抄中继口令加入已经做对的那套——
`packages/app/src/lib/relay-password-join-flow.ts:331-410` 的 `joinSelfAdmitAndPersist`
（内部用 `apps/gateway/src/auth/user-key-self-admit.ts` 的 `buildSelfAdmitAndMetaKey`）。
具体到 Hub 路径：`requestEnrollmentByPassword` 现在在
`packages/app/src/lib/hub-password-join.ts:179-208` 立刻把根种子清零，需要改成把根钥透给
`performHubJoin`（或新开一个 `performHubPasswordJoin`），在 redeem 成功、拿到自己的证书之后，
用根钥签一条 `admit-node` 追加到 Hub 的密钥日志（可复用「用根钥代理登录 Hub 的 node-session +
`POST /api/auth/keylog?hub=sync`」，本次实测证明这条通路可用），成功后再落本机状态、写 env。
失败必须整体回滚（与中继路径「先远端后本地」的口径一致），否则会留下一台永远连不上的节点。
另建议补一条会真起 Hub + 节点两个进程的集成/实测用例——现有测试
（`apps/gateway/src/hub/hub-password-enroll.test.ts`、`packages/app/src/lib/hub-password-join.test.ts`、
`packages/app/src/runtime/setup-routes.test.ts`）全是打桩单测，覆盖不到「加入之后能不能真连上」。

### 3.2 【中等】中继口令加入的所有错误都退化成 HTTP 500 `internal_error`，前端只能显示「未知错误 + 英文原文」

**现象**（4.1 / 4.2 / 4.3 的实测原文）：

- 口令错 → `500 {"code":"internal_error","message":"relay password join failed: HTTP 401 RELAY_BAD_PROOF"}`
- 未知租户 → `500 {"code":"internal_error","message":"relay tenant kdf failed: HTTP 404 RELAY_TENANT_NOT_FOUND"}`
- 密封包被篡改 → `500 {"code":"internal_error","message":"pack authentication failed"}`

**根因**：`handleRelayJoinRequest`（`packages/app/src/runtime/relay-join-routes.ts:47-61`）直接
`await perform(...)`，让 `RelayPasswordJoinError` 逃到
`handleSetupRequest` 的 `mapError(error)`（`packages/app/src/runtime/setup-routes.ts:102`），
而 `mapError` 只认 `SetupError`，其余一律 `internal_error` + 500
（`packages/app/src/runtime/http.ts:16-22`）。
对照组：Hub 加入路径有 `asSetupJoinError` / `joinHttpStatus`
（`packages/app/src/runtime/setup-service.ts:215-233`），所以 7.3 拿到的是规规矩矩的
`400 join_failed`。

**后果**：
1. 用户输错口令属于 4xx，却报 500（对监控/日志也是误导）。
2. 前端 `KNOWN_ERROR_CODES`（`apps/fe/src/pages/settings/nodes/setup/validation.ts:282-302`）里没有
   `internal_error`，`describeSetupError` 会走
   `nodes.setup.errors.unknown`（`apps/fe/src/pages/settings/nodes/setup/error-messages.ts:51-59`），
   把 `relay password join failed: HTTP 401 RELAY_BAD_PROOF` 这种英文内部串直接甩给用户。
3. 这一轮专门为中继路径准备的文案 `nodes.setup.errors.relay.join_failed`
   （`error-messages.ts:28-43` 的 `RELAY_SPECIFIC_CODES`）成了死代码——后端在这条路上永远不会发
   `join_failed`。

**建议修法**：在 `relay-join-routes.ts` 里把 `perform(...)` 包一层 try/catch，把
`RelayPasswordJoinError.code` 映射成 `SetupError`（参照 `joinHttpStatus`）：
`invalid_url` → 400、`local_user_exists` → 409、`head_hash_mismatch` → 400、
`join_failed` → 400（网络类可给 502），保持 message 作为 detail（`join_failed` 已在
`DETAIL_BEARING_CODES` 里，前端会拼成「加入失败：<原因>」）。
`packages/app/src/runtime/relay-join-routes.test.ts` 目前只有两条成功路径断言，没有任何负例，
建议一并补上。

### 3.3 【观察】`leave → relay` 之后，本机自己的旧租户会以「幽灵租户」留在中继注册表里

6.5 的读数：S 从 `relay,node` 退到 `relay` 后，mesh 表全清（含 `node_identity`、`mesh_secrets`），
但中继侧 `relay_tenants=1 / relay_nodes=1` 原样保留，`/api/relay/health` 报 `tenants:1`。
保留中继表本身是对的（这台机器还要替别人转发），但**这一行租户正是刚刚被清掉身份的本机自己**——
它的根钥、K_log、令牌都已经不存在，永远不可能再接回来，运营者页会一直看到一个 1 节点、0 在线的
僵尸租户。建议 `leaveMesh` 在 `targetRole:'relay'` 分支里顺手把「本机作为租户」的那一行
（可用离开前 `mesh_relays` 里记的 tenantId 定位）从 `relay_tenants`/`relay_nodes` 里删掉，
或者至少在运营者页给一个删除入口的提示。相关代码：
`packages/app/src/runtime/membership-reset.ts:133-137`（`clearMembershipForTarget`）与
`apps/gateway/src/auth/mesh-membership-store.ts:39-45`（`wipeRelayOperatorState`，`relay` 分支不调）。

### 3.4 【观察】Hub 节点清单里 `status` 只有 `enrolled`，看不出「已承认 / 未承认」

7.2b 里 C 的 `status` 是 `enrolled`，和真正能连上的 H 自己完全一样——从清单上分不出 3.1 那个坏状态。
考虑到 3.1 修好之前用户可能已经有一批这样的节点，建议 `/api/hub/nodes` 顺带回一个
「是否有未吊销的 `node_certs` 行」的布尔（或把 `admit_record_seq` 暴露出来），前端在节点表上标出
「未承认」，否则这类故障在界面上完全不可见。

---

## 四、实测过程中的其它记录

1. **前端构建 5 次全失败**（按共同规则「等 60 s 重试至多 5 次」执行，日志
   `<live>/../fe-build.log`）。最后一次（11:31:46）的 tsc 报错：
   ```
   src/node/relay-pack.test.ts(67,21):  TS2769  Argument of type 'boolean' is not assignable to parameter of type 'RelayPackRefreshResult'.
   src/node/relay-pack.test.ts(147,21): TS2769  同上
   src/pages/settings/nodes/relay/use-relay-actions.ts(148,25): TS2339  Property 'ok' does not exist on type 'never'.
   src/pages/settings/nodes/relay/use-relay-actions.ts(151,39): TS2339  Property 'transportError' does not exist on type 'never'.
   src/pages/settings/nodes/relay/use-relay-actions.ts(151,67): TS2339  Property 'failed' does not exist on type 'never'.
   ```
   这些文件此刻正被另一个 agent 改动（`git status` 里 `use-relay-actions.ts`、`relay-pack.ts` 都是 M），
   属**在途代码**，不作为本轮结论；但**发版前必须确认 `apps/fe` 能 tsc 通过**。
   本轮全部断言都是 API / DB / WS 层，不依赖 `apps/fe/dist`，因此不受影响
   （实例以 `TMEX_FE_DIST_DIR` 指向不存在的 dist 启动，静态资源 404，与被测面无关）。

2. **`tmex relay join` 可以完全脱离安装版跑**：给一个假安装目录写
   `app.env`（`DATABASE_URL` / `TMEX_MASTER_KEY` / `TMEX_MIGRATIONS_DIR` / `TMEX_ROLES=standalone`），
   再 `--install-dir <该目录> --no-restart`，就能把加入结果落到 scratch 库、把 env 改写在 scratch。
   不需要起 gateway，也不会碰安装版。这条路子建议写进下次实测的常备手法。

3. **http 回环加入 Hub 必须显式带 `insecureLocal: true`**：`assertHubJoinUrl`
   （`packages/app/src/lib/hub-client.ts:101-125`）对 `http://127.0.0.1` 只有在 `insecureLocal`
   为真且非 production 时才放行；`/api/setup/join` 从 body 的 `insecureLocal` 读这个开关
   （`packages/app/src/runtime/setup-routes.ts:74`）。中继侧则不需要——`normalizeRelayUrl`
   （`packages/shared/src/relay/join-token.ts:54-74`）对回环 http 是默认放行的。**两条路径口径不一致**，
   不算 bug，但值得知道。

4. **限流窗口会互相影响**，排实测顺序时要注意：中继侧 `RelayEnrollLimiter` 是「同 IP 15 分钟 5 次失败」
   （`apps/gateway/src/relay/types.ts:26-27`），本驱动因此把所有中继负例排在成功加入之后
   （`handleRelayJoin`/`handleRelayEnroll` 成功时会 `limiter.reset(ip)`）；
   Hub 侧是「同 IP 或同 uid 60 s 内 10 次失败」+「同 uid 每小时 5 次成功」
   （`apps/gateway/src/hub/hub-enroll-limiter.ts:1-4`），所以 C 的成功加入必须排在 10 次错误口令之前。

5. **`rename-node` 的版本门在中继租户下是按空 `nodes` 表放行的**
   （`apps/gateway/src/hub/hub-authorization.ts:158-217`）：`MIN_RENAME_NODE_RECORD_VERSION='1.1.24'`，
   而中继租户没有 `nodes` 注册表，`isNodeSideRecordType` 因此把 `rename-node` 和中继两类记录一起放过。
   本次 5.1 正是走的这条分支（跑的本来也是 1.1.24，两种口径下都会通过），
   门禁真正生效的场景（hub 模式下有旧节点）本轮未覆盖。

---

## 五、复跑方式

```bash
export PATH="/opt/homebrew/bin:$PATH"
L=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c1f43d39-77fb-4832-b1c4-2ca4e9c12e4e/scratchpad/live/r24
cd /Users/konata/code/tmex-r24

bun $L/live24.ts                # 首跑：为 7 个实例各克隆一份仓库（约 7×7 s）后跑全部断言
bun $L/live24.ts --skip-clone   # 复跑：复用克隆，只重置 inst/ 与各克隆的 test.env.local
# 退出码：0 全绿 / 2 有断言 FAIL / 1 中途中止；SUMMARY 段逐条 PASS/FAIL
```

脚本清单（全部在 `$L`）：

| 文件 | 作用 |
|---|---|
| `live24.ts` | 主驱动（7 实例 + 1 个只有库的 CLI 实例 + 假中继，38 条断言，含收尾） |
| `clone-repo.sh` | `cp -Rc` 克隆仓库到 scratch（隔离 `test.env.local`） |
| `helper-bootstrap-user.ts` | 独立进程建首个本地用户（**必须动态 import**，先设 `DATABASE_URL` 再 import，否则写错库） |
| `run1.log` / `run2.log` / `run3.log` | 三轮完整日志（run3 为最终结论） |
| `inst/<NAME>/server.log` | 各实例的 gateway 日志（C 的那份里有 `err=unknown-cert` 原始证据） |
| `repos/<NAME>/` | 各实例的仓库克隆（含它自己那份 `test.env.local`） |

复跑注意：

- 全程只用隔离 socket `tmex-live24`；本轮实际没有起过任何 tmux 会话（未测 tmux 转发），
  收尾仍执行了 `tmux -L tmex-live24 kill-server`。
- 端口占用 19992–19999、19961–19967，启动前会逐个 `canBind` 预检，占用即拒绝启动。
- 驱动自己 import 的是**真仓库**的 `packages/shared/src/{auth,relay,ws-borsh}`（只读），
  实例跑的是各自的克隆。

---

## 复测（G7 后）

指挥官修完 §三.1 与 §三.2 两个问题后按要求只复跑**场景 4（中继负例）**与**场景 7（Hub 口令加入）**。

- 被测 commit：`d2be4c99`（含修复 `1f4d0917`「Hub 密码加入后由加入方用根钥自签 admit-node 并在重启前推到 Hub；
  中继密码加入错误映射为稳定 setup 错误码」）；工作区干净，克隆是当次重新做的（未复用旧克隆）。
- 驱动新增 `--retest` 模式：只起 R / A / H / C / N 五个实例（B、S 及场景 3/5/6/8 跳过），
  但保留场景 4 的前置 1、2（中继要有一个带密封包的真租户）。日志 `<live>/run4-retest.log`。
- 并发环境规避：本轮实测端口 19992–19999 / 19961–19967、tmux socket `tmex-live24`；
  e2e 套件占用的 9665 / 9885 与 socket `tmex-e2e` 全程未发过请求、未执行任何写操作
  （只在收尾做过一次只读 `tmux -L tmex-e2e ls` 确认互不干扰）。前端未用到（两个场景都是 API/DB 层）。

**结论：22 条断言全 PASS。两个问题都已确认修复。**

### A. 场景 4：中继负例的错误码（4/4 PASS，含新增的 4.4）

| 断言 | 复测前 | 复测后（证据） |
|---|---|---|
| 4.1 口令错 | `500 internal_error` | **`HTTP 401 {"code":"relay_password_invalid","message":"relay password join failed: HTTP 401 RELAY_BAD_PROOF"}`**；N 的库 `users=0`、`node_identity.user_id=''` |
| 4.2 未知租户编号 | `500 internal_error` | **`HTTP 404 {"code":"relay_tenant_unknown","message":"relay tenant kdf failed: HTTP 404 RELAY_TENANT_NOT_FOUND"}`** |
| 4.3 密封包被篡改（假中继 19992 投喂翻位密文） | `500 internal_error` | **`HTTP 409 {"code":"relay_pack_invalid","message":"pack authentication failed"}`**；`users=0`；驱动内 `openRelayPack()` 同样抛 `pack authentication failed` |
| 4.4 中继不可达（本轮新增：假中继停掉后再打同一地址） | — | **`HTTP 502 {"code":"relay_unreachable","message":"Unable to connect. Is the computer able to access the url?"}`** |

四个码都在前端 `KNOWN_ERROR_CODES` 的映射范围内（`relay_password_invalid` / `relay_tenant_unknown` /
`relay_pack_invalid` / `relay_unreachable` / `local_user_exists` / `relay_not_authorized` / `join_failed`），
不会再退化成「未知错误 + 英文内部串」。未覆盖到的三个码（`local_user_exists`、`relay_not_authorized`、
`join_failed`）本轮没有构造对应场景，仅由代码路径确认（`relay-join-routes.ts` 的 `RELAY_JOIN_ERROR_STATUS`）。

### B. 场景 7：Hub 口令加入（9/9 PASS，原 FAIL 项转绿）

| 断言 | 结果 | 证据 |
|---|---|---|
| 7.1 / 7.1b `POST /api/setup/hub` + 重启 | PASS | `{"fingerprint":"ca0dd370…","restarting":true}`；env `{TMEX_HUB_PUBLIC_URL:"http://127.0.0.1:19997", TMEX_ROLES:"hub,node"}`；`/api/local/status.role=hub,node` |
| 7.2 C `POST /api/setup/join {method:'password'}` | PASS | 200 `{"hubUrl":"http://127.0.0.1:19997","username":"hubadmin","restarting":true}` |
| 7.2b H 的节点清单里出现 C | PASS | `[{5ce4073f,"tmex",enrolled},{16a87d7f,"C",enrolled}]`；C 的 env `{TMEX_ROLES:"node", TMEX_HUB_URL:"http://127.0.0.1:19997"}` |
| **7.2c C 的 uplink 接上 H** | **PASS（原 FAIL）** | `online=true`；H 库 `node_certs(C)=1`；C 的 `server.log`：`[uplink] try hub=http://127.0.0.1:19997 …` → **`[uplink] online hub=127.0.0.1:19997 after_ms=30`**（复测前是 `err=unknown-cert`） |
| 7.2d 自签的 `admit-node` 落到 Hub 密钥日志 | PASS | H 库 `user_key_log` 里 `type='admit-node'` 的 seq = `[2,3]`（2 是 Hub 自己 bootstrap 的、3 是 C 的）；`node_certs(C).admit_record_seq=3`。**本轮不再需要人工补签**（驱动在自承认已生效时改为核对链上记录，避免重复 admit 污染密钥日志） |
| 7.3 错口令走 `/api/setup/join` | PASS | `HTTP 400 {"code":"join_failed","message":"password enrollment failed: invalid_proof"}`；N 的库 `users=0` |
| 7.3b 直连 `/api/hub/enrollments/by-password` 两次错口令 | PASS | 两次都 `HTTP 401 {"error":"invalid_proof"}` |
| 7.4 限流 | PASS | 失败序列 `[400,401,401,401,401,401,401,401,401,401]` → 第 11 次用**正确**口令 `HTTP 429 {"error":"rate_limited"}` |

时序上值得记一笔：C 重启后 **30 ms** 就 `online`，说明 admit-node 是在重启**之前**由加入方推上去的
（`packages/app/src/lib/hub-password-self-admit.ts` 的 `publishHubJoinSelfAdmit`），
不存在「重启后先被拒一次再靠退避重连」的窗口。

### C. §三.3 / §三.4 两条观察

本轮未复测（不在指定范围）：`leave → relay` 的幽灵租户、Hub 节点清单看不出「未承认」。
后者在 3.1 修好之后严重性下降（新加入的节点不会再卡在未承认态），但对**存量**用 1.1.24 之前
口令加入过的节点仍有意义，是否处理由指挥官决定。

### D. 复测后的安全复核

- 默认 tmux socket：`tmex: 3 windows (created Wed Aug 26 00:26:54 2026) (attached)` —— 与首轮开跑前逐字一致。
- `tmux -L tmex-live24 ls` → `no server running`。
- e2e 的 `tmex-e2e` socket 与 9665 / 9885 端口原样在跑，未被触碰。
- 19992–19999、19961–19967 全部释放；`pgrep -fl "scratchpad/live/r24"` 为空。
- 生产 `127.0.0.1:9883`（pid 83665）仍在监听，全程未触碰。
- 仓库 `git status` 干净（除本文件的本次追加与指挥官自己的 `plan-00-result.md`），
  无 `test.env.local`、无 `tmex.db` 残留。

复跑命令：

```bash
export PATH="/opt/homebrew/bin:$PATH"
L=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/c1f43d39-77fb-4832-b1c4-2ca4e9c12e4e/scratchpad/live/r24
cd /Users/konata/code/tmex-r24 && bun $L/live24.ts --retest    # 只跑场景 1、2、4、7
```
