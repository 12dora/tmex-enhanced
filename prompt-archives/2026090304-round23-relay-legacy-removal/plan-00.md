# 第二十三轮计划：公共中继角色（relay）+ round22 遗留

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`，base main `fc7fdba3` / 1.1.22）。目标版本 **1.1.23**。

## 背景

- hub/mesh 现状见 `sub/EX1-hub-map.md`（codex 探索）：hub 明文读取并持久化 `node.status` 的 inventory/endpoints/version、生成明文 `node.list`、解码并应用整条密钥日志、读取 `rtc.signal` 的 SDP；「密文中转」只覆盖 `SecureChannelLink` 建立后的数据面。hub 单租户（`users[0]` 回退、`node_identity` 单例、`peer_cache` 无 user_id）。
- round22 遗留任务的代码地图见 `sub/EX2-leftovers-map.md`。
- 用户拍板（`plan-prompt.md`）：中继藏内容 + 元数据、保留根公钥；与 hub 二选一；全站口令 + 租户令牌（改密可踢可留）；租户侧 + 运营者侧都做网页 + CLI + API；计量 + 全局默认配额 + 每租户覆盖；`relay` 可单跑，`relay,node` 才有网页，不与 hub 同机；本地成员表权威、中继注册表可重建、多中继有序 failover、同时连留下轮；吊销即换租户密钥（X25519 按节点封装）。

## 注意事项

- 严禁触碰生产 tmex（9883、`~/Library/Application Support/tmex`）与 tmux session `tmex`；临时实例必须设 `TMEX_TMUX_SOCKET`。
- 多 agent 同一 worktree 并行：文件集互不重叠；agent 不 commit；共享 barrel / package.json 由指挥官改。
- 生成文件（i18n resources/types、fe-dist）不手改；locale JSON 改后 `bun run build:i18n`。
- 复杂度门禁：文件 ≤600 行，不加 allowlist。

---

## 一、中继（relay）设计

### 1.1 角色与运行时

- `TMEX_ROLES` 新增 `relay`、`relay,node`；`relay` 与 `hub` 同机 → 配置错误。`packages/shared/src/roles.ts` 的 `TmexRoles` 加 `relay: boolean`。
- `RelayRuntime`（`apps/gateway/src/relay/`）挂载顺序：TLS/local → setup → **relay** → hub → mesh → gateway → 静态。只处理 `/api/relay/*` 与 `/relay/uplink`。
- `relay` 单跑：无前端、无用户；管理 API 用 `TMEX_RELAY_ADMIN_TOKEN`（首启缺失则生成并写 app.env，CLI 读 app.env）。`relay,node`：管理 API 同时接受本机 `node-session`（复用 mesh `withAuth`）。
- 中继不需要链路身份密钥（uplink 签名绑定 `nonce ‖ host`，沿用 hub 的 `hubHostFromUrl(TMEX_RELAY_PUBLIC_URL)`）。
- STUN/TURN 复用 `TMEX_STUN_SERVERS` / `TMEX_TURN_*`，随 `relay.list` 下发。

### 1.2 中继能看到什么（硬边界）

| 可见 | 不可见（加密块） |
|---|---|
| 租户编号、根公钥、根 epoch | 节点名、设备清单、endpoints、版本细节以外的一切状态 |
| 节点编号 → 链路公钥（Ed25519）、X25519 公钥、admitted/pending/revoked | 密钥日志 payload（passkey、TOTP、中继列表、租户密钥） |
| 在线状态、流量字节、并发流数、协议版本、client 版本号（门禁用） | SDP / ICE candidate |
| 「承认加入」「吊销」两类根签名记录的明文（用于建注册表） | `relay` 流内层（SecureChannel，现状） |

### 1.3 租户密钥

- `K_log`（32 B，不轮换）：加密存放在中继的密钥日志记录。随 join 串 v3 与 `set-relays` 记录分发。
- `K_meta`（32 B，带 `epoch: u32`，吊销/根轮换即换）：加密 `relay.status` 状态块、`relay.rtc` 信令、`relay.list` 中的对端状态块。只经 `meta-key` / `set-relays` 记录按节点 X25519 封装分发（节点证书已含 `x25519_pk`）。
- 封装：`wrap = X25519(eph_sk, node_x25519_pk) → HKDF-SHA256(ss, salt = "tmex-relay-wrap/v1", info = node_id) → AES-256-GCM(key, nonce 12B 随机, plaintext = K)`；记录里每项 `{node_id, eph_pk, nonce, ct}`。
- 信封：`AES-256-GCM(K, nonce 12B 随机, plaintext, AAD = "tmex-relay/<kind>/v1")`；wire 形态 `{v:1, epoch?, n: b64url, ct: b64url}`。实现放 `packages/shared/src/relay/tenant-cipher.ts`（WebCrypto AES-GCM + `@noble/curves` x25519，浏览器与 Bun 共用）。
- 节点侧落库 `mesh_secrets {kind: 'log'|'meta', epoch, key_enc（主密钥加密）, created_at}`；hub 模式无此表数据。

### 1.4 密钥日志新增记录类型（`packages/shared/src/auth/`）

签名矩阵与现有一致（root / passkey）。两者 `KEYLOG_RECORD_COMPAT.minVersion = '1.1.23'`，`allowForce: false`。

- `set-relays`：`{ mode: 'ordered', relays: [{ url, tenant_id(16B), token(32B), priority: u8 }], log_key: [WrapEntry...], meta_key: { epoch: u32, entries: [WrapEntry...] } }`。空 `relays` = 离开中继（回到 env 里的 hub 配置或无上级）。节点应用：写 `mesh_relays`、解出自己的 `K_log`/`K_meta` 入 `mesh_secrets`、切换 uplink 池目标。
- `meta-key`：`{ epoch: u32, entries: [WrapEntry...] }`。应用：解出自己的条目存 `mesh_secrets`（找不到自己 = 被排除，保留旧 epoch 只读）。`epoch` 必须严格递增。
- 既有 `revoke-node` / `rotate-root(-keep)` 不改格式；发起方（浏览器/CLI）在其后紧接一条 `meta-key`（新 epoch，封装给剩余节点）。`admit-node` 后紧接 `meta-key`（当前 epoch，只封装给新节点）。
- 中继存储的日志记录：`{ seq, blob = Envelope(K_log, recordBytes ‖ sig, AAD "tmex-relay/keylog/v1") }`；中继按租户强制 `seq = head + 1`。

### 1.5 join 串 v3

`"r3." + base64url( enroll_sk 32 ‖ root_pk 32 ‖ head_hash 32 ‖ K_log 32 ‖ tenant_id 16 ‖ token 32 ‖ n(u8) ‖ [len(u16 LE) ‖ url utf8]×n )`，可保留 `.<64hex>` CA 指纹后缀。旧 96 B 串继续为 hub 模式。实现 `packages/shared/src/relay/join-token.ts`（encode/decode/isRelayJoinToken）。

### 1.6 中继侧持久化（`apps/gateway/src/db/schema/relay.ts`，迁移 `0039_relay.sql`）

```
relay_config      id=1, password_hash(argon2id, nullable=无口令), password_epoch(u32), min_token_epoch(u32),
                  default_quota_json, updated_at
relay_tenants     id(16B hex), root_public_key, root_epoch, token_hash(sha256), token_epoch, quota_json(nullable=用默认),
                  created_at, last_seen_at, bytes_in, bytes_out, key_log_head_seq, label(nullable, 运营者备注)
relay_nodes       tenant_id, node_id(主键 (tenant_id,node_id)), ed_pk, x25519_pk, status(pending|admitted|revoked),
                  admit_seq, last_seen_at, proto_version, client_version
relay_enrollments id, tenant_id, enroll_pk(unique), authorization_bytes, authorization_sig, expires_at, used_at, node_id
relay_key_log     tenant_id, seq, blob, created_at   主键 (tenant_id, seq)
```

`relay_tenants.id` 由中继在 enroll 时随机生成（与 uid 无关）。中继不使用 `users`/`node_certs`/`nodes` 表。

### 1.7 中继 HTTP API（`apps/gateway/src/relay/relay-routes.ts`）

无鉴权：
- `GET /api/relay/health` → `{ ok, version, tenants, nodesOnline, uptimeMs }`
- `POST /api/relay/enroll`（按源 IP 限速，复用 `auth-login-limiter` 模式）body `{ password?, root_public_key, root_epoch, proof }`；`proof` = 根钥对 `{domain:'tmex/relay-enroll/v1', relay_host, root_public_key, ts}` 的 Ed25519 签名（Borsh），防止拿别人根公钥占坑。同一根公钥重复 enroll = 重新签发令牌（被踢后重输口令的路径），tenant_id 不变。→ `{ tenant_id, token, password_epoch }`；口令错 401 `RELAY_PASSWORD_INVALID`；无口令时 `password` 忽略。
- `POST /api/relay/tenants/:tenantId/enrollments/redeem` header `x-tmex-relay-token`，body 同 hub redeem（`certificate, cert_sig, pop, name?` — name 不上传）→ 校验 token、enroll_pk 存在未过期未用、cert_sig、PoP、节点数配额 → `relay_nodes` pending → 推 `enroll.redeemed` 给该租户在线节点 → `{ key_log: [{seq, blob}], relays: [url...], rtc, tenant_id }`。

管理（admin token 或本机 node-session）：
- `GET /api/relay/status` → `{ config: {hasPassword, passwordEpoch, minTokenEpoch, defaultQuota}, tenants: [{ id, label, createdAt, lastSeenAt, nodes, nodesOnline, streams, bytesIn, bytesOut, quota, tokenEpoch, kicked }], totals }`
- `POST /api/relay/password` `{ password: string | null, mode: 'kick' | 'keep' }` → `password_epoch += 1`；`kick` 时 `min_token_epoch = password_epoch`（并断开所有 token_epoch 过旧的 uplink）。
- `PATCH /api/relay/config` `{ defaultQuota: { maxNodes, maxStreams, bandwidthBytesPerSec | null } }`
- `PATCH /api/relay/tenants/:id` `{ quota?: {...} | null, label?: string | null }`
- `POST /api/relay/tenants/:id/kick`（作废该租户令牌 + 断开）/ `DELETE /api/relay/tenants/:id`（删注册表与日志）

### 1.8 中继 uplink 协议 `relay/v1`（`packages/shared/src/relay/codec.ts`，`WS /relay/uplink`）

沿用 `packages/shared/src/link` 帧/多路复用与 64 KiB ctl 上限。ctl JSON `{t, ...}`：

| t | 方向 | 载荷 | 中继行为 |
|---|---|---|---|
| `auth.challenge` | R→N | `{nonce}` | 同 hub |
| `relay.auth` | N→R | `{tenant_id, token, node_id, sig, proto: 1, client_version, member?: {bytes, sig}}` | 校验 token(hash, epoch ≥ min)、client_version ≥ 1.1.23；节点未知或 pending 时要求 `member`（明文 admit-node 记录）：`signer=root` 用根公钥验签后 admitted；`signer=passkey` 中继无法验签，仅在该租户已有 admitted 节点且 token 有效时接受（见 1.12 边界）；`sig` = Ed25519(nonce ‖ relay_host)；revoked → 拒 |
| `auth.ok` | R→N | `{tenant_id, key_log_head_seq, rtc}` | |
| `ping/pong` | 双向 | | |
| `relay.status` | N→R | `{blob: Envelope(K_meta), epoch, direct_capable}` | 只存内存（最新块）+ 广播 |
| `relay.list` | R→N | `{version, nodes: [{id, online, status, epoch?, blob?, direct_capable}], rtc, key_log_head_seq}` | 全量；`blob` 为对端最近的 `relay.status` 块 |
| `relay.keylog.append` | N→R | `{id, seq, blob, member?: {op:'admit'|'revoke', bytes, sig}}` | `seq = head+1` 否则 `ack {ok:false, error:'SEQ_MISMATCH', head}`；`member.op='revoke'` 仅 root 签名有效（passkey 签名 → ack ok 但 `member_ignored: true`）；成功后向租户其他在线节点推 `relay.keylog.push` |
| `relay.keylog.ack` | R→N | `{id, ok, seq?, error?, head?, member_ignored?}` | |
| `relay.keylog.req` | N→R | `{from_seq, limit?}` | 分页返回 |
| `relay.keylog.res` / `relay.keylog.push` | R→N | `{records: [{seq, blob}], has_more?}` | |
| `relay.rtc` | 双向 | `{rtcSession, from:'browser'|'node', to, enc: Envelope(K_meta, {sdp?, candidate?})}` | 校验 `to` 同租户 admitted 在线 → 转发 |
| `relay.enroll.create` | N→R | `{id, enroll_pk, authorization, authorization_sig, exp}` | 用根公钥验 authorization → `relay_enrollments`；ack `relay.enroll.ack {id, ok, error?}` |
| `enroll.redeemed` | R→N | `{certificate, cert_sig, enroll_pk, node_id}` | 推给租户全部在线节点 |
| `relay.quota` | R→N | `{maxNodes, maxStreams, bandwidthBytesPerSec}` | 认证后与变更时 |
| `relay.kicked` | R→N | `{reason:'password_rotated'|'kicked'|'revoked'}` | 随后关闭 |

流：OPEN 首帧 `{to}` 同 hub；中继校验 source/target 同租户且均 admitted；并发流超配额 → RST；带宽用令牌桶延迟 pump（不丢帧）。计量每租户 bytes_in/out（内存累计，30 s 落库）。

### 1.9 节点侧（`apps/gateway/src/mesh/relay-*.ts` + 既有文件小改）

- `mesh_relays {url, tenant_id, token_enc, priority}`（迁移同 0039）；`node_identity` 加 `uplink_kind ('hub'|'relay')` 与 `name`。
- `RelayUplinkClient`（实现 `UplinkPool` 依赖的同一接口）：auth → 发 `relay.status`（状态块 = `{name, version, tmux, inventory, endpoints}`）→ 收 `relay.list` 解密对端块写 `peer_cache`（解不开的 epoch 旧块跳过）→ keylog 双向同步（本地 head > 中继 head → 上传缺失；反之下载、解密、逐条验签应用）→ `relay.rtc` 加解密后接入现有 RTC 路由 → relay 流同 hub。
- `UplinkPool`：候选来源 = `mesh_relays`（按 priority）当 `uplink_kind = relay`；failover 逻辑不变（无 writer/epoch 概念）。
- 记录应用（`user-key-persistence.ts` 扩展）：`set-relays`、`meta-key` 见 1.4；`revoke-node` 到达后若本节点是中继模式且日志里紧随的 `meta-key` 尚未到 → 等待（不主动轮换）。
- 节点侧 HTTP（`apps/gateway/src/mesh/relay-routes.ts`，需本机 node-session）：
  - `GET /api/mesh/relay/status` → `{ mode: 'relay'|'hub'|'none', tenantId?, relays: [{url, priority, online, attached, rttMs?, lastError?, kicked?}], metaEpoch, nodesViaRelay: number, reauthRequired: boolean }`
  - `POST /api/mesh/relay/enroll/prepare` `{ url, password? }` → 节点用（浏览器传来的）根签名 proof 调中继 `/api/relay/enroll`… **简化**：浏览器先 `POST /api/mesh/relay/enroll/proof-material {url}` 拿 `{relay_host, ts}`，本地用根钥签 proof，再 `POST /api/mesh/relay/enroll {url, password?, proof, ts}` → 节点转调中继 → 返回 `{ tenant_id, token }` 与待签的 `set-relays` payload（含现有列表 + 新中继、`log_key`/`meta_key` 封装给全部未吊销节点；首次接入时节点生成 `K_log`/`K_meta`，`meta_key.epoch = 当前 epoch 或 1`）。浏览器签名后走既有 `POST /api/auth/keylog?hub=sync` 提交。节点在记录应用时才真正切换。
  - `POST /api/mesh/relay/leave/prepare` → 待签 `set-relays { relays: [] }`。
  - `POST /api/mesh/relay/meta-key/prepare` `{ op: 'admit', node_id } | { op: 'rotate', exclude?: [node_id] }` → 待签 `meta-key` payload（`rotate` 生成新 K，暂存 pending 直到记录应用）。
  - `GET /api/mesh/relay/join-material` → `{ K_log, tenant_id, token, relays }`（供前端拼 join 串 v3；仅中继模式）。
  - `POST /api/mesh/relay/enrollments` body 同 hub 的 `/api/hub/enrollments` → 经 uplink `relay.enroll.create`；`GET /api/mesh/relay/enrollments/:id` 查本地 pending。
- 名称：节点自持 `node_identity.name`（join `--name` 写入；`rename-node` 记录到达且目标是自己时更新）；状态块携带。

### 1.10 CLI（`packages/app/src/commands/relay.ts` + `relay-admin.ts`）

- 运营者（中继机本地，读 app.env 管理令牌，调本机 `/api/relay/*`）：`tmex relay status [--json]`、`tmex relay passwd [--clear] [--kick|--keep]`（交互输入，默认 keep）、`tmex relay tenants [--json]`、`tmex relay kick <tenantId>`、`tmex relay remove <tenantId>`、`tmex relay quota <tenantId|default> --max-nodes N --max-streams N --bandwidth KBps|unlimited`、`tmex relay label <tenantId> <text>`。
- 租户（任意节点本地）：`tmex relay enroll <url> [--password ...]`（交互输入中继口令与本机用户密码；无本地用户则先创建，等价 `hub user add`）、`tmex relay reauth <url>`、`tmex relay leave`、`tmex relay list`。走本机 gateway 的 `/api/mesh/relay/*`，根签名在 CLI 本地完成（复用 `enroll.ts` 的根钥派生）。
- `tmex hub join` 识别 `r3.` join 串 → 走中继 redeem（`init --role node` 后 `TMEX_HUB_URL` 不再必需）。
- `init --role relay|relay,node`；`relay` 单跑不装前端不查 tmux。

### 1.11 前端

- 租户侧（节点页）：`HubStrip` 泛化为上级状态条；中继模式显示每个中继 url/在线/attached/RTT/lastError、`reauthRequired` 提示 + 重输口令对话框、`meta epoch`；操作：接入中继（url + 口令 + 根密码/passkey 签 `set-relays`）、追加/移除中继、离开中继、hub → 中继迁移入口（同接入）。隐藏 hub 专属：主备切换、admit/retire hub、写转发状态、`HubStrip` 多 hub 视图。加节点向导：中继模式生成 `r3.` join 串；admit 后自动签 `meta-key`(admit)；吊销后自动签 `meta-key`(rotate)。
- 运营者侧（设置页新标签「中继」，仅 `relay,node`）：健康/总量、租户表（编号/备注/节点数/在线/流量/配额/令牌 epoch）、改口令对话框（踢/留二选一、清除口令）、默认配额表单、每租户配额与备注编辑、踢出/删除确认框。
- api-client：`packages/api-client/src/relay/`（tenant-api、admin-api）。i18n `relay.*` 命名空间（zh_CN/en_US/ja_JP）。

### 1.12 已知边界（写入文档）

- 中继无法验 passkey 签名（验签需 clientDataJSON，含 origin）；因此中继层 `admit` 可由持令牌节点提交，`revoke` 只认根签名。中继注册表只是链路准入缓存，真正的成员判定与 `K_meta` 轮换在节点侧完成；被 passkey 吊销的节点仍可连中继但解不出新元数据、与任何节点握手都被拒。运营者可手动踢。
- 中继看得到租户根公钥、节点数、在线时段与流量模式。
- 多中继本轮为有序 failover：不同节点落在不同中继时互不可见（无跨中继转发）。

---

## 二、round22 遗留

1. **legacy 状态流删除**（EX2 §A）：L1a shared（canonical v1.1 `ResizePaneV11` + `canonical-state-v1.1` capability + `peerSupportsCanonicalV11(≥1.1.22)` + metadata 记录补 tree order/custom names）→ L1b gateway（`apps/gateway/src/ws/*`、`mesh/stream-replay-state*`、forwarder 测试；resize reason/epoch 接 viewport-policy；删 switch-barrier、legacy broadcaster 段、legacy kinds 编解码；对端 <1.1.22 拒绝 canonical、不回退）→ L1c ws-client/stores（删 state-machine、pane-history-gate、legacy overlay、legacy 解码；resize 走 v1.1；select-pane 走 canonical）→ L1d terminal-ui + e2e helper/spec 改写 → 文档。
2. **tailwind-merge 替换**（L2，Opus）：`packages/ui/src/class-merge.ts` 自研 merge，与 `twMerge` 在语料 + 随机对照；指挥官逐页目测。
3. **删三条路由**（L3）：`/api/tmux/tree`、`/api/settings/theme`（e2e 改走 UI 同路径 helper）、`POST /api/hub/nodes/:id/revoke`（测试改走 `/api/auth/keylog?hub=sync`）。
4. **bench**：已删 6 个旧文件（render-bridge 例外保留），`files-tree-render.bench.tsx` 保留。

## 三、任务与分工

| ID | 角色 | 范围 | 依赖 |
|---|---|---|---|
| L1a | grok | shared ws-borsh v1.1 / capability / metadata | — |
| L1b | grok | gateway ws + mesh replay legacy 删除 | L1a |
| L1c | grok | ws-client + stores legacy 删除 | L1a |
| L1d | Opus | terminal-ui + fe e2e helper/spec | L1a |
| L2 | Opus | class-merge | — |
| L3 | grok | 三路由删除 | — |
| B1 | grok | `packages/shared/src/relay/*`、auth 新记录、roles | — |
| B2 | grok | `apps/gateway/src/relay/*`、schema/migration、config、assemble 挂载 | B1 |
| B3 | grok | 节点侧 relay uplink / pool / 记录应用 / mesh relay routes | B1 |
| B4 | grok | CLI relay 命令、join r3、init role | B1 |
| F1 | Opus | 租户侧节点页 + api-client tenant + i18n | B1（join-token） |
| F2 | Opus | 运营者侧设置标签 + api-client admin + i18n | — |
| B5 | 指挥官/grok | 进程内集成测试（1 中继 × 2 租户 × 2 节点）、docker-node 实测 | B2 B3 B4 |
| RV | codex sol | backend / frontend / libs 三路审查 | 全部 |

## 四、验收

- 各包 `bun test` 不低于基线（shared 534 / ws-client 408 / stores 440 / panels 911 / ui 110 / api-client 175 / app 690+1 / terminal-ui 400 / theme 52 / fe 1783 / gateway 4046+4 flake）；tsc 不新增错误；`bun run lint` 全绿；首屏 gzip 预算 ≤300 KB。
- 集成：中继 2 租户互不可见（跨租户 relay OPEN 拒绝、list 不含对方）；改密 kick 后旧令牌拒连、reauth 恢复；keep 模式旧令牌继续；换中继（set-relays）全节点自动切换；吊销 → `meta-key` 轮换后被吊销节点解不出新块；hub → relay 迁移；配额（节点数/流数）生效。
- e2e 与 main 基线逐条对照；mesh e2e 通过。
- 本机 `tmex upgrade` 到 1.1.23；docker-node 升级并以临时中继实例实测 enroll/join/relay 流。
