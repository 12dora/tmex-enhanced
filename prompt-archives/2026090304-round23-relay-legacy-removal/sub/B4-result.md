# B4 结果：CLI `tmex relay ...`（运营者 + 租户）、`hub join` 识别 r3 串、`init --role relay|relay,node`

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`），未 commit。全部改动落在 `packages/app`。

## 一、改动文件

新增：

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/commands/relay-shared.ts` | 214 | `RelayIo`、`RelayApiError`、`requestRelayJson`、错误码解包、表格/字节/配额格式化、`gatewayBaseUrl`、`relayAdminToken`、确认框 |
| `src/commands/relay-admin.ts` | 382 | 运营者七个命令（status/tenants/passwd/kick/remove/quota/label） |
| `src/commands/relay.ts` | 273 | 租户四个命令（enroll/reauth/leave/list） |
| `src/commands/relay-join.ts` | 362 | `hub join` 的 r3 分支：地址排序、enrollment 查询、redeem、链验证、落库、写 env |
| `src/commands/hub-join-verify.ts` | 72 | 从 `hub.ts` 抽出的 `assertChainUids` / `assertResponseCertsMatchProjections`（行数腾挪，见 §五） |
| `src/lib/relay-session.ts` | 270 | 租户侧本机 gateway 会话：建/开用户、派生根钥、登录、keylog head、签名提交、状态轮询 |
| `src/lib/relay-keylog.ts` | 77 | 中继密钥日志块的明文帧编解码 + 整页打开（**新协议细节，见 §四.1**） |
| `src/lib/relay-store.ts` | 51 | r3 join 的节点侧落库（薄封装 B3 的 `MeshRelayStore`） |
| 测试 | — | `commands/relay.test.ts`(12)、`commands/relay-admin.test.ts`(24)、`commands/relay-join.test.ts`(13)、`lib/relay-keylog.test.ts`(9)、`lib/args-relay.test.ts`(17)，共 **75** 例 |

修改：

- `src/lib/args.ts`：`NestedCommandName` 增 11 个 `relay.*`；`resolveNestedCommand` 改写为查表（`TOP_LEVEL_COMMANDS` / `HUB_SUBCOMMANDS` / `HUB_USER_SUBCOMMANDS` / `RELAY_SUBCOMMANDS` / `MESH_SUBCOMMANDS` + `group()`），行为与旧实现逐条等价（`args.test.ts` 19 例未改动全绿）；`COMMAND_FLAGS` 增 relay 十一条与 `init --relay-public-url`。**必须改写**：直接加 `if (command === 'relay')` 会把 `resolveNestedCommand` 的 CC 从 allowlist 记录的 32 顶到 33，门禁失败。
- `src/cli-auth-entry.ts`：`switch` 改写为 `HANDLERS` 分派表（同理，加 11 个 case 会把 CC 从 allowlist 的 24 顶到 35），并注册 11 个 relay 命令。
- `src/lib/auth-spawn.ts`：`AUTH_COMMANDS` 增 11 个 `relay.*`（**运营者命令也走 Bun auth runtime**，保持一条路径；Node bootstrap 未动，`build:cli` 仍只打 65 个模块）。
- `src/commands/hub.ts`：`runHubJoin` 在读到 `--token` 后先判 `isRelayJoinToken`，命中则动态 `import('./relay-join')`；`<https-url>` 的必填检查移到 r3 分支之后（**r3 不需要 url，也不需要 `TMEX_HUB_URL`**）。`maybeRestart` 改为 export 供 relay-join 复用。抽走两个校验函数后 1233 → 1239 行（allowlist 记录 1298）。
- `src/commands/init.ts`：`--role` 接受 `relay` / `relay,node`；调 `validateRoles` 拒绝 hub+relay；relay 角色跳过 `hub-url` 追问、跳过 tmux 依赖检查（仅 `relay` 单跑）、追问 `TMEX_RELAY_PUBLIC_URL`（非交互必须给 `--relay-public-url`）；结尾打印管理令牌所在的 `app.env` 路径。为压 CC 把角色/上级相关的追问抽成 `buildUplinkConfig()`。
- `src/lib/install.ts`：新增 `generateRelayAdminToken()` 与 `relayEnvDefaults()`；`AppEnvInput` 增 `relayPublicUrl` / `relayAdminToken`；`buildAppEnvValues` 只在 relay 角色下折入 `TMEX_RELAY_PUBLIC_URL` / `TMEX_RELAY_ADMIN_TOKEN`。
- `src/lib/roles.ts`：错误文案改成 `role must be one of standalone | node | hub,node | relay | relay,node`；补出 `rolesFromName` / `validateRoles`。
- `src/types.ts`：`InitConfig` 增 `relayPublicUrl: string`（**范围外的一行**，见 §五）。
- `src/i18n/index.ts`：新增 16 个 `relay.*` key（en + zh-CN），481 → 521 行。
- `src/cli/help.ts`：help 增 11 行 relay 用法，`init --role` 列出 relay。

## 二、命令矩阵

### 运营者（中继机本地）

读安装版 `app.env` 的 `GATEWAY_PORT` + `TMEX_RELAY_ADMIN_TOKEN`，一律打 `http://127.0.0.1:<GATEWAY_PORT>`，鉴权头 `Authorization: Bearer <TMEX_RELAY_ADMIN_TOKEN>`（与 B2 `relay-admin-auth.ts:bearerToken` 一致）。

| 命令 | HTTP | 备注 |
|---|---|---|
| `tmex relay status [--json]` | `GET /api/relay/status` | 非 json 时打印口令状态、口令世代/最小令牌世代、默认配额、租户数、在线/已知节点数、进出流量 |
| `tmex relay tenants [--json]` | `GET /api/relay/status` | 打印 `TENANT LABEL ONLINE STREAMS IN/OUT QUOTA EPOCH STATE LAST SEEN` 对齐表；无租户打 `no tenants` |
| `tmex relay passwd [--clear] [--kick\|--keep]` | `POST /api/relay/password` `{password: string\|null, mode}` | 默认 `keep`；**先打印该模式的后果说明**再隐藏输入两遍；`--clear` 不追问直接发 `null`；`--kick` 与 `--keep` 同时给报错 |
| `tmex relay kick <tenantId>` | `POST /api/relay/tenants/:id/kick` | tenantId 必须 32 位 hex |
| `tmex relay remove <tenantId> [--yes]` | `DELETE /api/relay/tenants/:id` | 默认交互确认；非 TTY 且无 `--yes` 直接报错 |
| `tmex relay quota <tenantId\|default> [--max-nodes N] [--max-streams N] [--bandwidth <KBps>\|unlimited] [--inherit]` | 先 `GET /api/relay/status`，再 `PATCH /api/relay/config` `{defaultQuota}` 或 `PATCH /api/relay/tenants/:id` `{quota}` | 缺省字段从「租户覆盖 → 默认配额 → 内置 8/32/unlimited」继承；`--inherit` 发 `{quota: null}`，对 `default` 报错；未知租户在 PATCH 前就拒 |
| `tmex relay label <tenantId> <text...>` | `PATCH /api/relay/tenants/:id` `{label}` | 多个 positional 用空格拼接；空文本发 `null` |

例：

```bash
tmex relay status --json
tmex relay passwd --kick                    # 隐藏输入两遍，旧令牌全部作废
tmex relay quota default --max-nodes 16 --bandwidth 512
tmex relay quota abcd...ef --inherit
tmex relay label abcd...ef 上海 A 机
tmex relay remove abcd...ef --yes
```

### 租户（任意节点本地）

需要本机用户密码（与 `tmex enroll` 同一套：`TMEX_PASSWORD` 或隐藏输入），登录本机 gateway 拿 node-session 后打 `/api/mesh/relay/*`。

| 命令 | 顺序 |
|---|---|
| `tmex relay enroll <url> [--password <p>] [--username <n>]` | ① `GET <url>/api/relay/health`（不鉴权，直连中继）→ ② 无本地用户则按 `hub user add` 建（用户名取 `--username`，交互默认 `admin`）/ 有则派生并核对根钥 → ③ `GET /api/auth/mode`（passkey 二次验证则拒绝，TOTP 则追问）→ ④ `POST /api/auth/challenge` + `POST /api/auth/login` 拿会话 → ⑤ `POST /api/mesh/relay/enroll/proof-material {url}` → ⑥ `signRelayEnrollProof` → ⑦ `POST /api/mesh/relay/enroll {url, password?, proof:{bytes,sig}, ts}` → ⑧ `GET /api/auth/keylog/head` → `buildKeyLogRecord(head, rootEpoch, {type:'set-relays', signer:'root'})` + `signKeyLogRecordWithRoot` → `POST /api/auth/keylog?hub=sync {bytes, sig}` → ⑨ 每 500 ms 轮询 `GET /api/mesh/relay/status`，≤30 s 等到 `mode==='relay'` 且该 url `online` |
| `tmex relay reauth <url> [--password <p>]` | 与 enroll 完全同一条 HTTP 链路（B3 的 `mergeRelayTargets` 按 url 去重，租户不变、令牌换新），只是提示语不同 |
| `tmex relay leave` | `POST /api/mesh/relay/leave/prepare` → 取 `payload` → 同样签 `set-relays` 提交 → 轮询直到 `mode !== 'relay'` |
| `tmex relay list [--json]` | `GET /api/mesh/relay/status`；非 json 时打印 mode/tenant/meta epoch/peers + `PRI URL STATE ATTACHED RTT NOTE` 表，`reauthRequired` 时提示跑 `relay reauth` |

口令处理：`--password` > `io.relayPassword` > health 报 `hasPassword === true` 时隐藏输入；health 不带 `hasPassword`（B2 当前实现就不带）时先不问，收到 401 再提示 `this relay requires a password` 并追问一次重试。

### `tmex hub join` 的 r3 分支

```bash
tmex hub join --token r3.<...>                 # 无需 url、无需 TMEX_HUB_URL
tmex hub join https://relay-b.example --token r3.<...>   # url 只用于把该中继提到 failover 队首
```

顺序（对 join 串里的地址逐个尝试，只有传输层失败才换下一个；中继明确拒绝（4xx/5xx）不重试）：

1. `decodeRelayJoinToken` → `{enrollSk, rootPublicKey, keyLogHeadHash, logKey, tenantId, token, relayUrls}`。
2. `GET /api/relay/tenants/:tenantId/enrollments/<b64url(enroll_pk)>`，头 `x-tmex-relay-token: <b64url(token)>` → `{authorization, authorization_sig, exp, used_at}`，`decodeAuthorization(...).uid` 得到租户 uid。**这条路由目前不存在，见 §四.2。**
3. `createNodeCertificate(enrollSk, {uid, edPk, x25519Pk, enrollPk, nodeId})` + `encodeRedeemPopMessage` 签 PoP。
4. `POST /api/relay/tenants/:tenantId/enrollments/redeem`，头 `x-tmex-relay-token`，体 `{certificate, cert_sig, pop}` → `{tenant_id, relays, rtc, key_log:[{seq, blob}]}`。
5. 用 `K_log` 逐块 `openEnvelope(logKey, 'keylog', blob)` → `{bytes, sig}`；要求 seq 从 1 连续，否则整页拒。
6. `verifyKeyLogChain(records, root_pk, head_hash)` → `assertChainUids` → 校验 genesis uid 与第 2 步的 uid 一致 → 若链里本节点证书已被吊销则报 `node_revoked`。
7. `ctx.userKeys.commitJoin({... identity: { hubUrl: null, ... }})`。
8. `MeshRelayStore.replaceRelays(join 串地址表, priority=下标)` + `putSecret('log', 0, K_log)` + `setUplinkKind('relay')` + `setLocalName(--name)`。**不写 `K_meta`**——要等承认本节点的 `meta-key` 记录到达。
9. app.env：`TMEX_ROLES=node`、`TMEX_HUB_URL=''`、`TMEX_HUB_PUBLIC_URL=''`，然后按 `--no-restart` 决定是否重启服务。
10. 打印 `joined relay <url> (tenant <id>)`；未被承认时追一行 pending 提示。

## 三、验证

| 项 | 结果 |
|---|---|
| `cd packages/app && bun test src` | **762 pass / 0 fail**（69 文件）。本任务新增 75 例。**开工时基线是 679 pass / 8 fail**（8 例全部是 B1 加 `UserKeyState` 三字段后 `apps/gateway/src/auth/user-key-service.ts:currentState()` 没补字段导致的 `cloneState` 崩溃），B3 在我干活期间修掉了，现在 0 fail。 |
| `bunx tsc --noEmit -p packages/app` | 只有基线那 1 个 `TS2688 Cannot find type definition file for 'node'`，未新增。 |
| `bunx biome check packages/app/src` | clean（165 文件）。全仓 `bunx biome check .` 里 `packages/app` 无任何条目。 |
| `bun scripts/complexity/gate.ts` | `packages/app` 侧只剩 `src/runtime/assemble-routes.ts: 646 > 600`——**那是 B2 的改动**（git status 显示 assemble.ts/assemble-routes.ts 是 B2 在改），不是我。其余违规全在 `apps/gateway/src/mesh|relay`（B2/B3 在飞）。我新增/修改的文件全部合规，**没有动 allowlist**。 |
| `bun run build:cli`（packages/app） | `Bundled 65 modules`，`cli-node.js 219.92 KB`。relay 命令走 Bun auth runtime 懒加载，未进 Node bootstrap。 |

## 四、需要指挥官处理

### 1.（必须裁决）中继密钥日志块的明文帧格式由我临时定义

plan §1.4 写的是 `blob = Envelope(K_log, recordBytes ‖ sig, AAD "tmex-relay/keylog/v1")`，但 **`sig` 在 passkey 签名下是变长 Borsh 断言，`recordBytes ‖ sig` 无法拆分**，B1 也没在 `@tmex/shared/relay` 里给编解码。我在 `packages/app/src/lib/relay-keylog.ts` 定了：

```
plaintext = utf8(JSON.stringify({ bytes: b64url(recordBytes), sig: b64url(sig) }))
kind = 'keylog'   // sealEnvelope(K_log, 'keylog', plaintext)
```

（与 hub `key.log.res` 的 `{bytes, sig}` 约定同形。）**B3 的 `relay-key-log-sync.ts` 必须用同一个帧**，否则 `hub join` r3 下载的日志和 uplink 同步的日志互相打不开。建议指挥官把 `encodeRelayKeyLogPlaintext` / `decodeRelayKeyLogPlaintext` / `RELAY_KEYLOG_ENVELOPE_KIND` 挪进 `packages/shared/src/relay/`，B3/B4 共用。我已核对过 B3 落地的 `relay-key-log-sync.ts` 存在但没读它的帧实现——**请务必对一遍**。

### 2.（必须补）中继缺一条 enrollment 查询路由，否则 r3 join 走不通

`applyAdmitNode`（`packages/shared/src/auth/key-log.ts:507`）硬性要求 `authorization.uid === certificate.uid === record.uid`，所以**加入方必须在造证书之前知道租户 uid**。hub 路径靠 `GET /api/auth/mode` 拿 uid；r3 串里没有 uid，B2 的 `handleRelayRedeem` 也不返回 authorization（且 enrollment 单次消费，拿不到第二次机会）。

最小补法（我已按这个形状实现 CLI 侧）：

```
GET /api/relay/tenants/:tenantId/enrollments/:enrollPkB64url
头   x-tmex-relay-token: <token>
200  { authorization, authorization_sig, exp, used_at }   // b64url
404  { error: { code: 'RELAY_NOT_FOUND' } }
```

中继本来就在 `relay_enrollments.authorization_bytes` 里存着这些字节，鉴权用同一个租户令牌，不多泄露任何东西。**没有这条路由时 CLI 会报**：`this relay does not expose GET /api/relay/tenants/:tenantId/enrollments/:enrollPk; upgrade the relay to 1.1.23 or newer`（`RELAY_ENROLLMENT_LOOKUP_MISSING`，测试已覆盖）。前端 F1 走同一条 r3 join 时也会撞上同一个洞。

### 3.（必须裁决）`POST /api/mesh/relay/enroll` 的 `proof` 形状：B3 与 F1 打架

- B3 `apps/gateway/src/mesh/relay-routes.ts:499 readProof()` 要求 `proof` 是对象 `{bytes, sig}`（都是 b64url，sig 64B）。
- F1 `packages/api-client/src/relay/tenant-api.ts:RelayEnrollRequest` 把 `proof` 声明成**一个 b64url 字符串（只有 sig）**。

**我按 B3（真服务端）发对象**。前端那条会被 400 `MALFORMED` 拒掉，需要指挥官统一（建议统一成对象，B2 的 `/api/relay/enroll` 也是读对象）。

### 4.（必须修）B2 与 B3 之间 `/api/relay/enroll` 的 `proof` 也不一致

B3 `callRelayEnroll`（`relay-routes.ts:205-213`）向中继发的是 `proof: b64url(sig)` + `proof_bytes: b64url(bytes)`；而 B2 `handleRelayEnroll`（`apps/gateway/src/relay/relay-routes.ts:61-64`）要求 `proof` 是 `{bytes, sig}` 对象。**当前节点→中继的 enroll 一定 400**。不在我范围内，请派给 B2 或 B3。

### 5. `proof-material` 的字段名 B3 与 F1 也不一致

B3 返回 `relayHost`（camelCase），F1 声明 `relay_host`。CLI 两个都认（`relayHost ?? relay_host`），但前端只认下划线那个，会拿不到 host。同样请统一。B3 的 enroll 响应用的是 `tenantId`（camelCase），F1 声明 `tenant_id`；CLI 也两个都认。

### 6. `packages/app/src/runtime/setup-service.ts:68` 的 `LocalStatus.role` 还是三值

B1 把 `TmexRoleName` 扩到 5 个后，`roleNameFromFlags(deps.roles)` 赋给 `role: 'standalone' | 'node' | 'hub,node'` 已经是类型错误（被 `packages/app` 那个基线 `TS2688` 挡住，官方 tsc 命令看不到；用 `types: []` 跑就会露出来）。同一处的下游还有 `packages/api-client/src/local/types.ts` 的 `LocalRole`（F2 已提过）。都不在我范围内。

### 7. 范围外但不可避免的两处改动

- `packages/app/src/types.ts`：`InitConfig` 加 `relayPublicUrl: string` 一行（`--role relay` 必须把公开地址带到 `buildAppEnvValues`）。
- `packages/app/src/lib/auth-spawn.ts`：`AUTH_COMMANDS` 加 11 个 `relay.*`（不加的话 `tmex relay ...` 不会被送进 Bun auth runtime）。

另：`packages/app/src/commands/hub.ts` 的 `assertChainUids` / `assertResponseCertsMatchProjections` 被搬到新文件 `hub-join-verify.ts`，纯搬运未改逻辑。这是为了给 r3 分支腾出行数——`hub.ts` 的 allowlist 上限是 1298 行，原文件已 1297 行，不搬就只能加 1 行。

### 8. 待确认的小假设

- `init --role relay` 时 `resolvePackageLayout` 仍要求包里存在 `resources/fe-dist`（`install-layout.ts`，不在我范围）。npm 包一定带，所以不阻塞；如果要做真正「relay 不装前端」，得改 `install-layout.ts` + `deployRuntimeFiles`（还要同步改 `upgrade-txn.ts`，否则升级会把前端补回去）。目前 relay 角色只是**不查 tmux、不追问 hub 地址**。
- `init` 会在 relay 角色下直接生成并写入 `TMEX_RELAY_ADMIN_TOKEN`（32 随机字节 b64url）。B2 的 `ensureRelayAdminToken` 在 env 已有令牌时只把 hash 落库，两者不冲突。
- CLI 访问本机 gateway 固定用 `http://127.0.0.1:<GATEWAY_PORT>`（`TMEX_BIND_HOST` 可能是 `0.0.0.0`/`::`，不能直接拼）。如果将来本机只监听 HTTPS，这条要改。
- `relay list` / `relay leave` 也要本机用户密码（要拿 node-session）。如果觉得读操作不该问密码，得让 B3 给 `/api/mesh/relay/status` 开一条本机免密门（round20 的 peer 打标那套），不在本轮范围。
