# LT 结果：Hub → 中继 现网迁移的多进程演练

驱动：`<live>/live25.ts`（`<live>` = `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/2da64d3c-b5e4-4192-98f5-dbd74931b528/scratchpad/live/r25`）。
最终一轮日志：`<live>/run5.log`（前几轮 `run1`–`run4.log` 保留了修驱动的过程）。

**结论：72/72 断言全绿。** G2（TOTP 口令加入）、G3（leave→relay 删幽灵租户）、G4（enrollment 扇出）三项在跑的时候都已落地并被实测覆盖。迁移路径可以照下面的 runbook 在现网执行。

## 一、演练拓扑

| 实例 | 端口 | 角色变化 | 对应现网机器 |
|---|---|---|---|
| H1 | 19981 | `standalone` → `hub,node` → `standalone` → `relay` → `relay,node` → `relay` | B `tmexhub-sh`（写者 hub） |
| E | 19982 | `standalone` → `node`（token 加入），全程不重启，hub 模式直接切中继模式 | `konata-mac`（入口，浏览器持根钥） |
| N1 | 19983 | `standalone` → `node`（Hub 口令加入） → 中继 `node` | `jiefa-app` |
| N2 | 19984 | `standalone` → `node`（token 加入） → 中继 `node` | `docker-node` |
| N3 | 19985 | `standalone` → `node`（**带 TOTP 码**的 Hub 口令加入） → 中继 `node` | 新机 |
| N4 | 19986 | `standalone` → `node`（迁移后 `r3.` token 加入） | 新机 |
| A | 19987 | `standalone` → `node` → `hub,node`（standby, priority 200） → 中继 `node` | A `tmex`（ai.jiefakj.com standby） |

驱动扮演浏览器：从密码派生根钥，自己签 `admit-node` / `revoke-node` / `set-relays` / `meta-key` / `set-totp`，走真实 HTTP（`GET /api/auth/keylog/head` → 根钥签 → `POST /api/auth/keylog?hub=sync`）。

安全边界执行情况：`NODE_ENV=test`；每实例一个仓库 APFS 克隆（`setup` 路由写的 `test.env.local` 落在 scratch，仓库工作区没被写脏）；每实例独立 db；`TMEX_TMUX_SOCKET=tmex-live25`；**所有 CLI 调用带 `--service-name tmex-live25-<name>` + `--no-restart`**（`tmex hub leave` 在 darwin 上会走 `detectServiceManager()=launchd` 去 `stopService`，不指定 service-name 会默认落到 `tmex` 这个 label，正好是生产服务——这是必须避开的坑）。收尾确认：生产服务 pid 92193 仍监听 9883、`com.tmex.tmex` launchd 项在、默认 socket 的 `tmex` session 3 windows 未动、安装目录 mtime 未变、`tmex-live25` socket 已 kill、19971–19989 全部释放、无残留进程。

**一处对任务约束的偏离**：peer server 即使 `TMEX_DIRECT_ENABLED=false` 也照样 bind（`parsePeerPort` 不接受 0，没法要临时口），7 个实例要 7 个网关口 + 7 个对端口，19981–19989 装不下。网关口用 19981–19987（任务指定窗口内），**对端口另开 19971–19977**，同样只绑 127.0.0.1，预检确认过空闲，收尾确认已释放。

## 二、PASS/FAIL 表

### 1. hub mesh 起来

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1.1 | H1 `POST /api/setup/hub` → `restarting:true` | PASS | `HTTP 200 {"ok":true,"fingerprint":"f8ef…","restarting":true}` |
| 1.2 | 重启后 `role=hub,node` | PASS | `nodeId=b815e86ccdbf02c897faf58d0870c1e1 uid=…` |
| 1.3/1.3b/1.3c/1.3d | mac / docker-node / hub-a 三台 token 加入：建 enrollment → `setup/join{method:'token'}` → 浏览器签 `admit-node` → online | PASS ×3 | `POST /api/hub/enrollments` 201；`admit-node` seq=3/4/5 `hubAck:true` |
| 1.5/1.5b | jiefa-app Hub 口令加入（1.1.24 起加入方自签 admit-node，无需人工补签） | PASS | 加入后直接 online，`nodeId=4db94e42…` |
| 1.7 | A `tmex hub standby --public-url … --priority 200` | PASS | `env={roles:hub,node, mode:standby, priority:200, peers:b815e86c…}`，命令自动把当前主 hub 写进 `TMEX_HUB_PEERS` |
| 1.8 | H1 `tmex hub allow <A nodeId>` | PASS | `peers=95e8dd4668cfb26200551774633d651a` |
| 1.9 | `/api/mesh/hubs` 出现 A（mode=standby） | PASS | hubs[] 两条：self active + A standby |
| 1.6 | E 的 `/api/mesh/nodes` 列出 5 台 online | PASS | `mac / tmex / docker-node / jiefa-app / hub-a` 全 online |

### 2. TOTP

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | 根钥签 `set-totp` 落账 | PASS | seq=7 `hubAck:true` |
| 2.2 | `GET /api/auth/totp-record` 200 | PASS | `{"record_seq":7,"root_epoch":1,"payload":"…"}` |
| 2.3 | 开 TOTP 后不带码登录被拒 | PASS | `HTTP 401 {"code":"TOTP_REQUIRED"}` |
| 2.4 | **[G2]** TOTP 账号不带码的 Hub 口令加入 → 稳定错误码 | PASS | `HTTP 400 {"error":{"code":"totp_required","message":"TOTP code is required"}}` |
| 2.5/2.5b | 带 `totpCode` 的 Hub 口令加入成功并 online | PASS | `nodeId=00205339d5f09b27fef60f824482a2d9` |

### 3. 迁移

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 3a.1 | H1 `tmex hub leave`（**不需要密码**）→ app.env `TMEX_ROLES=standalone` | PASS | exit=0；env 里 `TMEX_HUB_URL=""`、`TMEX_HUB_PUBLIC_URL=""` |
| 3a.2 | leave 清空 users，节点身份重建（新 node id、无 user_id） | PASS | `users=0 node_identity.user_id=(none) old=b815e86ccdbf new=cbd9b5133825` |
| 3a.3 | E 仍在线，H1 上级不可达 | PASS | E `/api/mesh/nodes` 200；`/api/mesh/hubs` 里 H1 `online:false` |
| 3b.1 | H1 `POST /api/setup/relay {role:'relay'}` → `restarting:true`（**不建新用户**） | PASS | `{"ok":true,"role":"relay","hasPassword":true,"restarting":true}` |
| 3b.2 | `GET /api/relay/health` 200、`GET /` 404、库里仍无用户 | PASS | `health={"ok":true,"version":"1.1.25","tenants":0}` `root=404 users=0` |
| 3c.1 | E（**hub 模式**）`POST /api/mesh/relay/enroll` → 200 + tenantId | PASS | `tenantId=91a071d75218b55f4ff1a51de9aafa6d` |
| 3c.2 | 根钥签 `set-relays` + `?hub=sync` | PASS | `seq=9 hubAck:true localApply:true`（本地优先落账，不回灌旧 hub） |
| 3c.3 | E 切到中继模式并 attached（**无需重启**） | PASS | `mode=relay relays=[{online:true,attached:true}]` |
| 3c.4 | `POST /api/mesh/relay/pack` 上传密封包 | PASS | `{"ok":true,"results":[{"ok":true,"status":200}]}` |
| 3c.5 | 中继注册表按历史 admit 记录重建出全部 6 台旧节点 | PASS | `relay_nodes` 六行全 `admitted`（H1/E/N1/N2/N3/A） |
| 3d.1 ×5 | jiefa-app / docker-node / n3-totp / hub-a `tmex hub leave` → standalone | PASS | exit=0 |
| 3d.2 ×5 | `TMEX_PASSWORD=… tmex relay join <url> --tenant <id> --name <原名>` | PASS | `joined relay http://127.0.0.1:19981 (tenant 91a071…)`，app.env `TMEX_ROLES=node` |
| 3d.3 ×5 | E 经中继看到各节点 online 且 **node id 换新、名字保持原样** | PASS | 如 `jiefa-app old=4db94e42c3de new=7b3c70d6ab2b` |
| 3d.4 ×5 | 经入口 E 的 `/n/<id>/` HTTP 反代（remote challenge+login → `GET /api/devices`） | PASS | HTTP 200，返回目标机自己的设备表 |
| 3d.5 ×5 | canonical 流经中继打通（`WS /n/<id>/ws` HELLO → HELLO_S2C） | PASS | `serverVersion=1.1.25_dev capabilities=["canonical-state-v1","canonical-state-v1.1"]` |
| 3e.1 | H1 `tmex relay join <自己的 url>` → `relay,node`（中继保持运行） | PASS | app.env `TMEX_ROLES=relay,node` |
| 3e.2 | E 看到 `tmexhub-sh` online | PASS | `id=cbd9b5133825782fdee8a1545d48b7e4` |
| 3g.1 | E 为 5 个旧 node id 签 `revoke-node` | PASS | 五条全 HTTP 200 |
| 3g.2 | `POST /api/mesh/relay/meta-key/prepare {op:'rotate'}` → 签 `meta-key` | PASS | `epoch=7`，append seq=25 |
| 3g.3 | 中继注册表旧身份全部 `revoked`，在网节点不受影响 | PASS | 5 revoked / 6 admitted；`live` 六台仍 online |
| 3h.1/3h.2 | **[G4]** `POST /api/mesh/relay/enrollments` 返回 `relays:[{url,tenantId,token,accepted}]` | PASS | `[{"url":"…","tenantId":"91a071…","token":"…","accepted":true}]` |
| 3h.3 | `tmex hub join <relay url> --token r3.…` 成功 | PASS | exit=0，提示 `this node is pending; confirm it from the Nodes page` |
| 3h.4 | 入口补签 `admit-node` + `meta-key {op:'admit'}` 后 N4 经中继 online | PASS | admit 200、prepare 200、append 200、online=true |
| 3d.6 | [记录] 备用 hub 迁移后的遗留 env 键 | PASS（记录项） | `TMEX_ROLES=node` 但 `TMEX_HUB_MODE=standby`、`TMEX_HUB_PRIORITY=200`、`TMEX_HUB_PEERS=b815e86c…` 都留着 |

### 4. 负例 / 遗留

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 4.1 | H1（relay,node）`POST /api/local/leave {targetRole:'relay'}` → 200 | PASS | `{"ok":true,"fromRole":"relay,node","targetRole":"relay","restarting":true}` |
| 4.2 | **[G3]** 删掉本机根钥对应的租户 | PASS | `relay_tenants before=1 after=0`，本租户行数 0 |
| 4.3 | E 与中继断开 | PASS | `relays=[{online:false,attached:false}]` |
| 4.4 | 用旧 tenant id 直接 `relay join` **无法**恢复 | PASS | `exit=1 relay tenant kdf failed: HTTP 404 RELAY_TENANT_NOT_FOUND` |
| 4.5 | 恢复路径：入口重新 `enroll` 拿到新 tenant id 并重新 attach | PASS | `newTenant=e6405ae7… (old=91a071d7…)`，set-relays 200，attached |
| 4.6 | 旧租户被删后**其余节点全部掉线** | PASS | 仅入口自己在线 |

版本门（旧 peer）按任务要求跳过。

## 三、runbook：现网可以照抄的命令 / API（按序）

约定：`<HUB>` = `https://tmexhub-sh.jiefakj.com`（迁移后同时是中继地址），`<PW>` = mesh 账户密码，`<RELAYPW>` = 中继租户口令（≥8 位，新设），`<TENANT>` = 第 3 步拿到的 32 位 hex 租户编号。真机是 systemd-user，**不要**加 `--no-restart`（演练里加是因为临时实例没有服务）。演练用的 `--insecure-local` 现网也不要加（现网是 https）。

### 阶段 0：准备
1. 先发版 1.1.25，把**所有**节点升到 1.1.25（中继版本门 ≥1.1.23，密码加入需 1.1.24+）。`docker-node` 用新镜像重建。
2. 记下每台机器现在的 **node id 与名字**（迁移后 node id 全部会变，名字靠 `--name` 保留）。入口浏览器保持登录（后面每一步签名都要根钥）。
3. 如果账号开了 TOTP：`tmex hub join --password` / `tmex relay join` 之外的浏览器登录都要验证码；口令加入必须带 `--totp`（否则 `totp_required`）。

### 阶段 1：B 退 hub，改纯中继
```bash
# 在 B（tmexhub-sh）上
tmex hub leave                 # 不需要密码；服务会自己停→改 env→起
```
`hub leave` 之后 B 的库里 users / node_certs / key log / mesh_relays 全清、节点身份重建（node id 变），`app.env` 变成 `TMEX_ROLES=standalone`、`TMEX_HUB_URL=""`、`TMEX_HUB_PUBLIC_URL=""`。

然后浏览器打开 B 的 setup 页（或直接打 API）把它变成纯中继：
```http
POST https://tmexhub-sh.jiefakj.com/api/setup/relay
{"role":"relay","relayPublicUrl":"https://tmexhub-sh.jiefakj.com","relayPassword":"<RELAYPW>"}
```
校验：`GET /api/relay/health` → 200；`GET /` → 404（纯中继不带前端）；库里 `users=0`。

### 阶段 2：入口（本机 mac）挂中继，把历史成员表推上去
浏览器在**设置 → 节点 → 接入中继（hub → 中继迁移）**里一路点完即可；等价 API：
```http
POST /api/mesh/relay/enroll/proof-material   {"url":"<HUB>"}      # 拿 relayHost + ts
# 用根钥 signRelayEnrollProof({relayHost, ts})
POST /api/mesh/relay/enroll  {"url":"<HUB>","password":"<RELAYPW>","proof":{bytes,sig}}
#   → { tenantId: <TENANT>, token, metaEpoch, payload }      ← 记下 <TENANT>
# 用根钥把 payload 签成 set-relays 记录：
GET  /api/auth/keylog/head  → POST /api/auth/keylog?hub=sync
# 再刷密封包（别的机器用密码加入的唯一凭据）：
GET  /api/mesh/relay/join-material?scope=all → sealRelayPack(每中继一份)
POST /api/mesh/relay/pack   {"packs":[…],"kdf_params":…,"root_epoch":…,"head_seq":…}
```
校验：`GET /api/mesh/relay/status` → `mode=relay`、`relays[0].attached=true`；中继侧 `relay_nodes` 会把**全部历史节点**重建成 `admitted`（演练里 6/6）。入口**不需要重启**。

### 阶段 3：逐台节点迁移（每台都是这两条）
```bash
tmex hub leave
TMEX_PASSWORD='<PW>' tmex relay join <HUB> --tenant <TENANT> --name <原来的名字>
```
- `--name` 必须给，否则默认叫 `node`；名字给对了，入口的节点列表看起来就和迁移前一样（只有 node id 变）。
- 顺序建议：`jiefa-app` → `jiefa-dns-1` → `docker-node` → `A（tmex）` → 最后 **B 自己**：
  ```bash
  # 在 B 上（中继保持运行，relay join 不会停服务）
  TMEX_PASSWORD='<PW>' tmex relay join <HUB> --tenant <TENANT> --name tmexhub-sh
  ```
  B 的角色会从 `relay` 变成 `relay,node`。
- jiefa 两台只能经本机 tmex 终端 / ssh 密码访问，`hub leave` 会断终端 → 用一次性脚本串起来：
  ```bash
  nohup bash -c 'tmex hub leave && TMEX_PASSWORD="<PW>" tmex relay join <HUB> --tenant <TENANT> --name jiefa-app' >/tmp/mig.log 2>&1 &
  ```
- 每台迁完在入口验证：节点出现在列表且 online；点开终端（canonical 流）能用。演练里用 `WS /n/<id>/ws` HELLO 与 `GET /n/<id>/api/devices` 两条都验过。
- **A（standby hub）额外注意**：`hub leave` 只清 `TMEX_ROLES` / `TMEX_HUB_URL` / `TMEX_HUB_PUBLIC_URL`，**`TMEX_HUB_MODE=standby`、`TMEX_HUB_PRIORITY`、`TMEX_HUB_PEERS` 会留在 `app.env` 里**。角色变成 `node` 后它们是死键，但建议手工删掉，免得以后 `tmex hub standby` 之类的命令读到脏值。

### 阶段 4：清理旧身份
在入口浏览器上，对**每一个旧 node id**（含 B 的旧 hub 身份、A 的旧 standby 身份）签一条 `revoke-node`，再轮换一次元数据密钥：
```http
# 每台：根钥签 revoke-node {node_id, reason} → POST /api/auth/keylog?hub=sync
POST /api/mesh/relay/meta-key/prepare {"op":"rotate"} → 根钥签 meta-key → POST /api/auth/keylog?hub=sync
```
校验：中继 `relay_nodes` 里旧 id 变 `revoked`，在网节点不掉线。

### 阶段 5：加新节点（迁移之后）
```http
POST /api/mesh/relay/enrollments {enroll_pk, authorization, authorization_sig, exp}
#   → { id, expiresAt, relays:[{url,tenantId,token,accepted}] }   ← 只有 accepted:true 的进 r3 串
```
```bash
tmex hub join <HUB> --token r3.…  --name <名字>
```
加完在入口签 `admit-node`，再补 `meta-key {op:'admit', node_id}`（网页向导会自动做这两步）。

## 四、必须知道的坑 / 结论

1. **`/api/local/leave {targetRole:'relay'}` 会把整个租户删掉。** 那条被删的 `relay_tenants` 的 `root_public_key` 就是 mesh 账户根公钥，级联清掉该租户的 nodes / enrollments / key_log。演练里执行后：入口立刻 detach，其余 5 台全部掉线，**用旧 tenant id 再 `relay join` 只会 404 `RELAY_TENANT_NOT_FOUND`**。唯一恢复路径是入口重新 `POST /api/mesh/relay/enroll` 拿一个**新** tenant id + 重签 `set-relays` + 重传密封包，然后所有节点按新 tenant id 重新 `relay join`。**现网 B 变成 `relay,node` 之后，绝对不要在它上面点「离开中继（保留中继角色）」。**
2. **`tmex hub leave` 在 macOS 上会去动 launchd 服务，默认 service name 是 `tmex`。** 任何在本机做的演练/调试都必须带 `--service-name <非 tmex>`，否则会 bootout 生产服务。现网机器是 Linux systemd-user，正常带自己的 service name，无此风险。
3. **`hub leave` 不需要密码**，但会停服务→改 env→起服务；`relay join` **不**停服务（所以 B 可以在自己中继还跑着的时候 join 自己）。
4. **node id 必换**（`hub leave` 清 `node_identity`），名字靠 `relay join --name` 保留。旧 id 要显式 `revoke-node`，否则中继注册表会留着 admitted 的幽灵行。
5. **入口不需要重启**：`set-relays` 一落账 uplink 就从 hub 切到 relay（`set-relays` / `meta-key` 走本地优先落账，不推给旧 hub，正是为迁移设计的）。
6. **密封包必须在 `set-relays` 之后立刻传**（`POST /api/mesh/relay/pack`），否则其它机器的 `relay join --password` 会 404。之后每次根签追加、改密、根轮换也要重刷。
7. **TOTP 账号**：登录、口令加入都要码。`POST /api/setup/join {method:'password'}` 不带 `totpCode` 稳定回 `400 {"error":{"code":"totp_required"}}`；CLI 侧对应 `--totp` / `TMEX_TOTP`。
8. `GET /api/mesh/hubs` 在写者 leave 之后**不会立刻**把它标 offline（要等探测退避），别拿它当 leave 是否成功的判据；看 `/api/mesh/relay/status` 和目标机自己的 `app.env` 更准。
9. hub 自己那台的 mesh 显示名来自 `TMEX_SITE_NAME`（演练里是 `tmex`），迁移后由 `relay join --name tmexhub-sh` 定名——这也是现网名字能保持的原因。
10. `/api/local/status` 不经 `/n/<id>/` 反代（反代只转 gateway 的 `/api/*` 路由），排查远端节点时用 `/n/<id>/api/devices` 一类真实 gateway 路由。

## 五、驱动使用说明

```bash
cd /Users/konata/code/tmex-r25
bun <live>/live25.ts              # 全量（含 6 次仓库克隆，约 50s）
bun <live>/live25.ts --skip-clone # 复用已有克隆，全程约 3 分钟
```
退出码 0 = 全绿；1 = 中途 abort；2 = 有 FAIL。收尾会 kill 全部实例、`tmux -L tmex-live25 kill-server`、并打印默认 socket 的 session 列表供人工确认没误伤。

## 六、现网入口驱动 `migrate-prod.ts`

`<live>/migrate-prod.ts`：把上面演练验证过的「浏览器」动作搬到真实入口机上执行。**只操作本机入口（默认 `http://127.0.0.1:9883`），不碰任何远端机器**；远端的 `tmex hub leave` / `tmex relay join` 仍按第三节 runbook 手工执行。

```
bun migrate-prod.ts status                      # /api/auth/mode + /api/mesh/nodes(id/name/online/version) + /api/mesh/hubs + /api/mesh/relay/status
bun migrate-prod.ts enroll --url <中继> --yes    # runbook 阶段 2 全套，打印 TENANT ID
bun migrate-prod.ts revoke --ids <hex,…> --yes  # 逐条 revoke-node + meta-key rotate
bun migrate-prod.ts rotate --yes                # 只做 meta-key rotate
bun migrate-prod.ts verify --names a,b,c        # 每台 online 节点：/n/<id>/api/devices 反代 + canonical WS HELLO
```
每个子命令都支持 `--dry-run`（完全离线：不派生根钥、不开会话、不发任何请求，只打印将要发起的调用）。改状态的三个子命令真实执行必须显式加 `--yes`；`revoke` 默认拒绝吊销仍在线的 id（要覆盖得加 `--allow-online`）。

环境变量：`MESH_PASSWORD`（账户密码，只在内存里派生根钥，绝不打印/落盘，用完清零）、`TMEX_TOTP`（账户开了 TOTP 时的 6 位码）、`RELAY_PASSWORD`（`enroll` 用的中继租户口令）。

必须在入口机本机直连 `127.0.0.1` 跑：只有这样才满足 `isTrustedLocalClient`，通行密钥二次验证才豁免；脚本刻意不设置 `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`（设了就会要求 passkey）。`status` 会把版本低于 `MIN_RELAY_RECORD_VERSION`（1.1.23）或版本未知的节点单独标出来——这些正是会让 `set-relays` / `meta-key` 撞 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` 版本门的机器。

自检：`tsc` 零错误（`<live>/tsconfig.check.json`）；五个子命令的 `--dry-run` 与三个「缺 `--yes`」「缺 `MESH_PASSWORD`」的守卫路径，对着一个计数监听器跑下来 `TOTAL_HITS=0`（确认一个请求都没发）。本次会话没有对生产实例执行过任何非 `--dry-run` 的调用。
