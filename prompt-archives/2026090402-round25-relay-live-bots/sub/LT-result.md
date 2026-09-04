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
bun migrate-prod.ts enroll --url <中继> --yes    # runbook 阶段 2 全套，打印 TENANT ID；readmitRequired>0 时自动先跑 readmit
bun migrate-prod.ts readmit --yes               # [G7] 按当前 root epoch 重签全部 admit-node（修 member-epoch_mismatch）
bun migrate-prod.ts leave --yes                 # 中继 → hub 回滚（等价前端「离开中继」）
bun migrate-prod.ts revoke --ids <hex,…> --yes  # 逐条 revoke-node + meta-key rotate
bun migrate-prod.ts rotate --yes                # 只做 meta-key rotate
bun migrate-prod.ts verify --names a,b,c        # 每台 online 节点：/n/<id>/api/devices 反代 + canonical WS HELLO
bun migrate-prod.ts upgrade --names a,b --yes   # 远程升级（复刻网页「节点管理 → 升级」），逐台打印进度
```

`upgrade`：复刻 `apps/fe/src/pages/settings/nodes/management/use-node-upgrade.ts` 的真实调用链 ——
经入口给目标建会话（`/n/<id>/api/auth/challenge` + login；入口的 `readNodeSession` 要求 cookie 里有 `tmex_s_<id>`，缺了直接 401 `NODE_LOGIN_REQUIRED`）→ `GET /n/<id>/api/system/info` 看 `canSelfUpdate` / `upgradeCapabilities` → `POST /api/mesh/nodes/<id>/upgrade`（body 固定 `{}`）→ 每 2s 轮询 `GET /api/mesh/nodes/<id>/upgrade`，判定链与前端 `watchUpgrade`/`settleIdle` 逐条对齐（非 idle → 记住「见过活动」；5xx/网络异常 → 当「重启中」继续等；idle 带 error → 失败；idle 且见过活动 → 比对 `/api/mesh/nodes` 的 version；6 分钟预算耗尽只报「未确认」不猜结论）。POST 从不重发（目标可能已经开始，重发只会撞 `UPGRADE_IN_PROGRESS`）。

两条要点：

- **版本不可指定。** 入口的 `handleMeshNodeUpgradeStart` 固定调用 `requireLatestUpgradeRelease()`（GitHub latest），POST body 里的 `version` 会被忽略。`--version` 只作**期望值**：与 latest 不符就拒跑，跑完拿它核对。
- **推包路径是自动选的。** 目标 `/api/system/info` 的 `upgradeCapabilities` 含 `staged-package` 时，入口自己下载一次 release，经 `/api/system/upgrade/package` 推给目标 —— **访问不了 github.com 的机器（jiefa-dns-1）走这条**；不含时入口只转发 `POST /api/system/upgrade {version}`，由目标自行下载（jiefa-app 走这条）。脚本会把每台走哪条打印出来。`canSelfUpdate=false`（手工部署、无 install-meta）直接判失败，与网页一致。中途要停用 `DELETE /api/mesh/nodes/<id>/upgrade`（网页的「停止升级」；脚本不实现）。

`leave`：`POST /api/mesh/relay/leave/prepare` → 根钥签返回的空中继表 `set-relays` → `POST /api/auth/keylog?hub=sync` → 轮询到 `/api/mesh/relay/status` 的 `mode !== 'relay'` 且 `/api/mesh/hubs` 的 `attached` 非空，然后把两个响应都打印出来。超时会把最后一次读数打出来再退出。

`readmit`（G7 契约）：`GET /api/mesh/relay/readmit/prepare` → `{rootEpoch, entries:[{nodeId,name,admitSeq,admitRootEpoch,authorization_bytes,certificate_bytes,cert_sig}]}`；逐条 `authorization_sig = rootKey.sign(authorization_bytes)` → `encodeAdmitNodePayload(...)` → 以 `readmit-node` 类型在当前 head 上根签 → `?hub=sync` 顺序提交，逐条打印 PASS/FAIL，任一条失败即中止。G7 落地前 shared 的 `KeyLogType` 还没有 `readmit-node`，脚本有前置检查会给出人话提示并退出，**不会发出畸形记录**；G7 合入后无需改脚本。
每个子命令都支持 `--dry-run`（完全离线：不派生根钥、不开会话、不发任何请求，只打印将要发起的调用）。改状态的六个子命令（enroll / readmit / leave / revoke / rotate / upgrade）真实执行必须显式加 `--yes`；`revoke` 默认拒绝吊销仍在线的 id（要覆盖得加 `--allow-online`）。

环境变量：`MESH_PASSWORD`（账户密码，只在内存里派生根钥，绝不打印/落盘，用完清零）、`TMEX_TOTP`（账户开了 TOTP 时的 6 位码）、`RELAY_PASSWORD`（`enroll` 用的中继租户口令）。

必须在入口机本机直连 `127.0.0.1` 跑：只有这样才满足 `isTrustedLocalClient`，通行密钥二次验证才豁免；脚本刻意不设置 `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`（设了就会要求 passkey）。`status` 会把版本低于 `MIN_RELAY_RECORD_VERSION`（1.1.23）或版本未知的节点单独标出来——这些正是会让 `set-relays` / `meta-key` 撞 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES` 版本门的机器。

自检：`tsc` 零错误（`<live>/tsconfig.check.json`）；八个子命令的 `--dry-run` 与七条「缺 `--yes`」/「缺 `--names`」/「缺 `MESH_PASSWORD`」守卫路径，对着一个计数监听器跑下来 `TOTAL_HITS=0`（确认一个请求都没发）。本次会话没有对生产实例执行过任何非 `--dry-run` 的调用。

## 七、根轮换后迁移（`--rotated`，复现现网故障 + 验证 G7）

现网踩到的缺口：账户根已经轮换过（`rotate-root-keep`，epoch 到了 4），但全部 `admit-node` 记录还停在 epoch 1；中继的 `verifyRelayMemberProof` 硬性要求 `record.root_epoch === 租户当前 epoch`，于是 `relay.auth` 一律 `member-epoch_mismatch`，入口切到中继模式后**永远挂不上**。G7（后端 `readmit-node` 记录 + `GET /api/mesh/relay/readmit/prepare` + enroll 的 `readmitRequired` + status 的 `readmitPending`）与 F6（前端）落地后，用 `bun live25.ts --rotated` 完整复现并验证了修法。

跑法：`bun <live>/live25.ts --rotated`（四台：H1 写者 / E 入口 / N1 口令加入 / N2 token 加入；跳过 A、N3、N4）。日志 `<live>/run8-rotated.log`，**39/39 全绿**。

> 注意 `--skip-clone` 会复用旧的仓库克隆。第一次跑（`run6`）就因为克隆是 G7 落地前的快照，`readmitRequired` 缺失、`/api/mesh/relay/readmit/prepare` 回 405。**验证新落地的后端一定要重新克隆。**

### PASS/FAIL

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| R1.1 | E 用**旧**根签 `rotate-root-keep{root_public_key:新根, kdf_params:新盐, totp:null}` → `?hub=sync` | PASS | `HTTP 200 {"ok":true,"seq":6,"hubAck":true}` |
| R1.2 | `/api/auth/mode` 的 `rootEpoch` +1 | PASS | `1 → 2` |
| R1.3 | E 能用**新**密码登录（驱动切到新根钥） | PASS | `uid=9c8ccd65… nodeId=653ef72f…` |
| R1.4 | 改密后其余节点照常在线（不动会话与证书） | PASS | mac / tmex / docker-node / jiefa-app 四台全 online |
| R1.5 | 全部未吊销证书的 `admit-node` 仍停在旧 epoch（病灶本身） | PASS | 未吊销证书=4，全部由 epoch 1 的 `admit-node` 承认；新 rootEpoch=2 |
| 3a / 3b | H1 `tmex hub leave` → `POST /api/setup/relay {role:'relay'}` | PASS | 与第二节同；relay health 200、`GET /` 404、`users=0` |
| R2.1 | E（新根）`POST /api/mesh/relay/enroll` → 200 + tenantId | PASS | `tenantId=460585d3…` |
| R2.2 | **[G7]** enroll 响应带 `readmitRequired` = 未吊销证书数 | PASS | `readmitRequired=4`，未吊销证书=4 |
| R2.3 | **[G7]** `GET /api/mesh/relay/readmit/prepare` 列出全部陈旧成员 | PASS | `rootEpoch=2`，4 条：`tmex@epoch1, mac@epoch1, docker-node@epoch1, jiefa-app@epoch1` |
| R2.4 | **[G7]** `/api/mesh/relay/status` 的 `readmitPending` 与之一致 | PASS | `readmitPending=4` |
| R3.1 | **对照**：不 readmit，直接签 `set-relays` | PASS（记录成功落账） | `seq=7 hubAck:true localApply:true` |
| R3.2 | **【复现现网故障】** 跳过 readmit 时中继拒绝 `relay.auth` | PASS | `mode=relay attached=false`；E 的 uplink 日志 `err=member-epoch_mismatch`；`relay_nodes(本租户)=0`（一个成员都没登记上） |
| R4.1 | **[G7]** 逐条 `readmit-node` 落账（root signer，用新根重签 `authorization_bytes`，证书原样） | PASS | 4/4，`admitSeq=2/3/4/5`，`epoch 1→2`，全 HTTP 200 |
| R4.2 | readmit 之后 E **立刻**挂上中继 | PASS | `mode=relay attached=true online=true` |
| R4.3 | `readmitPending` 归零 | PASS | `readmitPending=0` |
| R4.4 | 按新 `root_epoch` 重封的密封包上传成功 | PASS | `root_epoch=2 {"ok":true,"results":[{"ok":true,"status":200}]}` |
| R4.5 | 中继注册表把成员标为 `admitted` | PASS | 4/4 `admitted`（H1/E/N1/N2 的旧身份） |
| 3d.1–3d.5 | N1 `hub leave` → `relay join` → E 经中继看到它（新 node id）→ `/n/<id>/api/devices` 反代 200 → canonical `WS /n/<id>/ws` HELLO→HELLO_S2C | PASS | `old=dd06d70767ae new=874250353e3f`；`serverVersion=1.1.26_dev capabilities=["canonical-state-v1","canonical-state-v1.1"]` |

### 现网 runbook 的增补

第三节阶段 2（入口挂中继）在**改过密的账号**上要插一步，顺序不能反：

```
POST /api/mesh/relay/enroll …                      → { tenantId, payload, readmitRequired: N }
若 N > 0：
  GET  /api/mesh/relay/readmit/prepare             → { rootEpoch, entries:[…] }
  每条 entry（顺序、逐条取 head）：
    authorization_sig = 当前根.sign(authorization_bytes)      # 证书与授权字节原样不动
    payload = encodeAdmitNodePayload({authorization_bytes, authorization_sig, certificate_bytes, cert_sig})
    根签 'readmit-node' → POST /api/auth/keylog?hub=sync
然后才签 set-relays → POST /api/auth/keylog?hub=sync
```
`migrate-prod.ts enroll --yes` 已经内置这一条件分支（`readmitRequired > 0` 时自动先跑 readmit 再写 `set-relays`）；也可以单独 `migrate-prod.ts readmit --yes`。G7 落地后 `migrate-prod.ts readmit --dry-run` 已确认打印「shared 的 KeyLogType **已**包含 'readmit-node'（G7 已落地）」。

### 补充发现

1. **顺序颠倒是可恢复的，但要等重连。** 先写 `set-relays` 再补 readmit 也能救回来：`readmit-node` 在中继模式下走本地优先落账（不需要先挂上中继），下一次 `relay.auth` 会带上新 epoch 的成员证明，节点随即挂上（R4.2 就是从 R3.2 的卡死状态恢复过来的）。所以**现网 mac 现在的状态可以直接用 `readmit` 修，不必先 `leave` 回 hub 模式**——`leave` 只是想在修复上线前退回已知良好状态时才需要。
2. **可观测性缺口（建议修）**：挂不上的时候 `/api/mesh/relay/status` 的 `relays[].lastError` 恒为 `null`——它只在 `attached?.publicUrl === row.url` 时才填，而挂不上正是 `attached` 为空的时候。真正的原因（`member-epoch_mismatch`）只出现在**节点自己**的 uplink 日志里（`[uplink] candidate failed hub=… err=member-epoch_mismatch`），中继侧一行都不打。运维在网页上只能看到「离线」，看不到为什么。建议把最近一次连接失败的 reason 也带进 `relays[].lastError`（或单开一个 `lastConnectError` 字段）。
3. **改密之后节点侧的密码加入要用新密码**：`tmex relay join --tenant … --password` 用旧密码派生的根钥对不上租户当前根公钥，中继回 `401 RELAY_BAD_PROOF`（演练里踩到过一次）。现网迁移时若中途改过密，务必把新密码发给各机器。
4. `readmit/prepare` 的 `name` 对入口自己那台会退化成 node id（`nodeDisplayName` 在 `nodes` / `peer_cache` 里都找不到 self 的名字），不影响功能，只影响可读性。
