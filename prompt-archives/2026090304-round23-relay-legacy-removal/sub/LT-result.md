# LT 结果：真实多进程中继实测（4 实例 + 真 tmux + 前端截图）

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`），只读仓库，未改任何仓库代码。
基线 commit：`ec9f8180`（跑测时工作区还有未提交的文档改动，收尾时指挥官已提交到 `2392d865`）。

**结论：全部 7 组、24 条断言 PASS。**中继角色在真实多进程环境下端到端可用：口令接入 / r3 加入 / 承认 /
经中继的远程 HTTP 与真 tmux / 踢人与重新接入 / 吊销 全部符合设计。发现 **1 个测试脚手架级的真 bug（已定位，
不影响产品代码）**、**2 个 UI 布局问题**、**6 处文案问题**（含 1 个已知术语冲突）。

---

## 一、拓扑与安全边界

| 实例 | `TMEX_ROLES` | gateway | peer | 库 | 说明 |
|---|---|---|---|---|---|
| R | `relay` | 19993 | 19961 | `<live>/R/tmex.db` | 纯中继，无前端 |
| A | `node` | 19994 | 19962 | `<live>/A/tmex.db` | 租户主节点，带前端 |
| B | `node` | 19995 | 19963 | `<live>/B/tmex.db` | 经 r3 join 串加入 |
| R2 | `relay,node` | 19996 | 19964 | `<live>/R2/tmex.db` | 运营者 UI（自己接入自己的中继侧） |

`<live>` = `/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/f9d3700c-64d1-49ea-b5c9-799106d674d3/scratchpad/live`

全部实例统一：`NODE_ENV=test`、`TMEX_BIND_HOST=127.0.0.1`、`TMEX_TMUX_SOCKET=tmex-live`、
`TMEX_DIRECT_ENABLED=false`、`TMEX_STUN_SERVERS=`、`TMEX_MIGRATIONS_DIR=<repo>/apps/gateway/drizzle`、
`TMEX_FE_DIST_DIR=<repo>/apps/fe/dist`。进程 env 是**白名单构造**的（不 spread `process.env`），
避免继承本机安装版 app.env 的毒变量。

**生产安全复核（收尾实测）**：

- 默认 tmux socket：`tmex: 3 windows (created Wed Aug 26 00:26:54 2026) (attached)` —— 与开跑前逐字一致，未被触碰。
- `tmux -L tmex-live ls` → `no server running`（隔离 socket 已 kill-server）。
- 19993–19996 全部释放，`pgrep -f tmex-r23/packages/app/src/runtime/server.ts` 为空。
- 生产服务 `127.0.0.1:9883`（pid 94761）仍在监听，全程未发过一个请求，未 kill、未读写
  `~/Library/Application Support/tmex/`。
- `git status` clean。

---

## 二、逐步结果

驱动脚本 `<live>/live-relay.ts`，全部日志在 `<live>/run3.log`。计时是脚本内相对秒。

### 1. 中继 R（PASS ×4）

| 断言 | 证据 |
|---|---|
| 1.1 `GET /api/relay/health` 200 | `{"ok":true,"version":"1.1.23","tenants":0,"nodesOnline":0,"uptimeMs":536}` |
| 1.2 `GET /api/relay/status` 无 bearer → 401 | `{"error":{"code":"RELAY_UNAUTHORIZED","message":"RELAY_UNAUTHORIZED"}}` |
| 1.3 带 bearer → 200 | `{"hasPassword":false,"passwordEpoch":0,"minTokenEpoch":0,"defaultQuota":{"maxNodes":16,"maxStreams":64,"bandwidthBytesPerSec":null}}` |
| 1.4 `POST /api/relay/password {password, mode:'keep'}` | 200，`passwordEpoch 0 → 1` |

### 2. 节点 A 接入（PASS ×5，全程 2.2s → 3.1s）

用户用 `bootstrapUserWithSelfAdmit` 在**启库前**的独立进程里建好（与 `tmex relay enroll` 的
`createLocalUser` 同一条路径），之后一律 HTTP。

| 断言 | 证据 |
|---|---|
| 2.1 `/api/auth/challenge` + `/api/auth/login` 拿到 node-session | `uid=0675078f-… nodeId=e7b8fe1e…` |
| 2.2 **口令错** `POST /api/mesh/relay/enroll` | HTTP **401** `{"code":"RELAY_PASSWORD_INVALID"}`（节点原样透传中继错误码） |
| 2.3 口令对 | HTTP 200 `tenantId=a8d9c65a63e5754444e116e4ee684cc4 metaEpoch=1` |
| 2.4 签 `set-relays` → `POST /api/auth/keylog` → 轮询 | `mode=relay`，`relays[0] {online:true, attached:true, kicked:false}`（0.5 s 内） |
| 2.5 中继侧 | `{"tenants":1,"nodesOnline":1,...}` |

`proof-material → signRelayEnrollProof → enroll → set-relays` 这条链在**跨进程真 HTTP** 下与
`relay.integration.test.ts` 的进程内结果一致。

### 3. 节点 B 经 r3 join 加入并被承认（PASS ×7）

`helper-relay-join.ts` 直接调 `packages/app/src/commands/relay-join.ts` 的 `runRelayJoin()`，
塞显式 `LocalAuthContext`（`installDir`/`envPath` 为空 → 不读安装版 app.env、不重启服务）。

| 断言 | 证据 |
|---|---|
| 3.1 `POST /api/mesh/relay/enrollments` | 201 `{"ok":true,"id":"ff5b18dd-…","expiresAt":…,"relays":["http://127.0.0.1:19993"]}` |
| 3.2 `encodeRelayJoinToken` | `r3.` 串 271 字符 |
| 3.3 `runRelayJoin`（enrollment 查询 → 造证书 → PoP → redeem → 验链 → commitJoin → 落 `mesh_relays`/K_log） | `{"tenantId":"a8d9…","admitted":false,"stored":{"kind":"relay","name":"live-node-b","relays":[{"url":"http://127.0.0.1:19993",…}]}}` |
| 3.4 `admit-node` + `meta-key{op:'admit'}` | 200，`epoch=2`，nodeId `59ae2825…` |
| 3.5 中继侧 | `nodesOnline: 2`（承认后 0.5 s 内） |
| 3.6 **A 解出 B 的名字** | `/api/mesh/nodes` → `[{id:"e7b8fe1e",name:"self"},{id:"59ae2825",name:"live-node-b"}]` —— 名字来自 K_meta 封里的状态块，中继看不到 |
| 3.7 B 也看得见 A | `[{id:"59ae2825",name:"self"},{id:"e7b8fe1e",name:"tmex"}]` |

> 注：3.7 里 A 的名字显示为 `tmex` 而不是 `TMEX_SITE_NAME=lt-A`。节点自持名的来源是
> `mesh_relays` 的 `local_name`（r3 join 时由 `--name` 写入），A 是 enroll 上来的没走过那条路，
> 于是回落到默认值。不影响功能，但「主节点在别人眼里叫 tmex」这件事值得指挥官确认是否要在
> enroll 时也把本机名写进去。

### 4. 经中继流打到 B 的真 tmux（PASS ×2）

路径与前端一致：`POST /n/<B>/api/auth/challenge` → `/n/<B>/api/auth/login`（拿 `tmex_s_<B>` cookie）
→ 带 cookie 打 `/n/<B>/api/...`。`TMEX_DIRECT_ENABLED=false` 且无 hub，转发只可能走 `relay.open` 流。

| 断言 | 证据 |
|---|---|
| 4.1 `GET /n/<B>/api/devices` | 200，返回的是 **B 自己**的设备行 `{"id":"1129cd76-…","name":"KonatadeMacBook-Pro.local","type":"local","session":"tmex",…}` |
| 4.2 `POST /n/<B>/api/devices/<id>/test-connection` | 200 `{"success":true,"tmuxAvailable":true,"phase":"ready"}`；同刻 `tmux -L tmex-live ls` → `tmex: 1 windows (created Fri Sep 4 04:49:31 2026)` |

即：A 的浏览器会话 → forwarder → 中继流 → B 的 HTTP → B 真的起了 tmux control-mode 客户端，
并且**只落在隔离 socket `tmex-live` 上**（默认 socket 的生产 `tmex` session 全程未变）。

中继计量佐证：跑完后 R 的 `/api/relay/status` → `bytesIn: 6078, bytesOut: 6078`（见 §四.6 的口径问题）。

### 5. 改密语义（PASS ×4）

| 断言 | 证据 |
|---|---|
| 5.1 `mode:'kick'` | A 的 `/api/mesh/relay/status` **2 ms** 内变成 `{online:false, attached:false, kicked:true}`、`reauthRequired:true`（中继先发 `relay.kicked{password_rotated}` 再断链，不是等超时） |
| 5.2 用新口令 reauth（同一条 enroll 链路） | 200 |
| 5.3 重签 `set-relays` 后 | 1.1 s 内回到 `{online:true, attached:true, kicked:false}`、`reauthRequired:false`；租户号不变 |
| 5.4 `mode:'keep'` 轮换 | `passwordEpoch=3`、`minTokenEpoch=2`（未跟涨），A 3 s 后仍 `online:true`、未被踢 |

### 6. 吊销 B（PASS ×2）

`revoke-node` + `meta-key{op:'rotate', exclude:[B]}`，两条都走 `?hub=sync`。

| 断言 | 证据 |
|---|---|
| 6.1 中继侧 | `sqlite3 R/tmex.db "select status from relay_nodes where node_id=…"` → `revoked`；`totals.nodesOnline` 2 → 1（B 的链路被以 `revoked` 关掉） |
| 6.2 B 跟不上 A 了 | A `metaEpoch=3`，B `metaEpoch=2`，B `relays[0].online=false` —— 新一代 K_meta 没分发给 B，B 也连不回中继 |

### 7. 运营者实例 R2（PASS ×1 + 截图）

| 断言 | 证据 |
|---|---|
| 7.1 `relay,node` 下本机 node-session 直接可用管理面 | `GET /api/relay/status`（只带 cookie、不带管理令牌）→ 200，验证 B2 §六.13 的注入生效 |

为了让运营者 UI 有真实数据，另跑了 `<live>/extra-r2-tenant.ts`：让 R2 的节点侧接入 R2 自己的中继侧
（`relay,node` 同机自环），并用管理令牌给该租户打备注「上海 A 机」+ 单独配额 `8/32/512KB/s`。
全部 HTTP 均 200，租户表因此有一行真数据。

---

## 三、发现的问题

### 3.1 真 bug（测试脚手架级，不影响产品代码）—— 但值得写进文档

**`openLocalAuth()` 的 `databaseUrl` 会被静态 import 链悄悄旁路，所有写落到 `./tmex.db`。**

- 位置：`packages/app/src/lib/local-auth.ts:openLocalAuth()` 先 `process.env.DATABASE_URL = databaseUrl`
  再 `await import('../../../../apps/gateway/src/db/client')`；而
  `apps/gateway/src/config.ts:270` 是**模块加载时**的 env 快照（`getEnv('DATABASE_URL', './tmex.db')`），
  `apps/gateway/src/db/client.ts:18` 用 `new Database(config.databaseUrl)`。
- 复现：任何模块**静态** `import { runRelayJoin } from 'packages/app/src/commands/relay-join'`
  （它静态 import `apps/gateway/src/auth/node-identity-service` → … → `config`），再调
  `openLocalAuth({databaseUrl: '/somewhere/x.db'})` 并把 ctx 交给 `runRelayJoin`。
- 期望：写进 `/somewhere/x.db`。实际：`ensureNodeIdentity` / `commitJoin` / `MeshRelayStore`
  全部写进 `<cwd>/tmex.db`，而 `readRelayUplink(ctx)` 从同一个（错的）库读回来，**看起来一切正常**。
  我第一次跑就被这个坑掉：B 的库里只剩它自己启动时新建的身份，日志里是
  `[mesh] refusing to start uplink: userId unresolved`（`apps/gateway/src/mesh/mesh-runtime.ts:1422`）。
- **真实 CLI 不受影响**：`packages/app/src/cli-auth-entry.ts:50` 先 `await loadInstallEnv(parsed)`
  （它会 `applyCliEnv` 把 app.env 灌进 `process.env`），再 `await import('./commands/hub')`，顺序正确。
- 建议：`openLocalAuth` 的文档注释里写死「调用方必须在**任何** gateway 模块被 import 之前设好
  DATABASE_URL」，或者更硬一点——在 `openLocalAuth` 里比对
  `config.databaseUrl !== databaseUrl` 时直接抛错（现在是静默写错库，属于最难查的一类）。
  这条对未来写实测脚本 / 给 CLI 加新入口的 agent 都有价值。

### 3.2 UI 布局

1. **1280×800 + 侧栏展开时，两张表的「操作」列被裁掉且无滚动提示**。
   - `apps/fe/src/pages/settings/nodes/management/nodes-table.tsx:49-50`（`overflow-x-auto` + `min-w-[54rem]`）
     与 `apps/fe/src/pages/settings/relay/tenant-table.tsx:30-31`（`min-w-[62rem]`）。
   - 现象：`desktop-tenant-01-nodes-relay-strip.png` 里「移除」按钮只露出半个「移」；
     `desktop-operator-03-tenant-table.png` 里租户行的「编辑/踢出/删除」完全不可见（要横向滚才出来）。
   - 1280 是很常见的笔记本宽度，租户表 62rem 尤其吃紧。建议窄屏下把「操作」列做成 sticky-right，
     或把低价值列（公钥指纹 / 接入时间）在窄屏收起。

2. **移动端（390×844）打开 `?tab=relay` 时，标签条不会把选中的「中继」滚进视口**。
   `mobile-operator-01-header-cards.png` 里标签条停在最左（通用/终端/设备与文件/远…），
   选中态完全看不见，用户不知道自己在哪个标签。建议标签条挂一次 `scrollIntoView`。

### 3.3 文案（对照 `/Users/konata/code/tmex-copy-guidelines.md`）

1. **【必须裁决】术语冲突（F1 §五.1 已提，这次在真界面上确认了后果）**：规范里写
   「中继（Hub）」= hub，本轮「中继」= relay。同一屏上现在同时出现
   「中继 127.0.0.1:19993」（relay）、「只有本机作为 Hub 时才需要 HTTPS」（hub）、
   「离开后本机与各节点失去上级链路，须重新接入中继或 Hub。」（两个都用新义）。
   新义内部自洽，但与规范文件直接打架，**必须更新 `tmex-copy-guidelines.md` 那一行**，
   否则下一个 agent 会把 relay 又翻回去。

2. **reauth 对话框的说明文不对题**。
   `apps/fe/src/pages/settings/nodes/relay/relay-dialogs.tsx:100-104`：只有 `migrate` 有专属说明，
   `reauth` 回落到 `relay.tenant.dialog.urlHint` = 「填中继的公网 HTTPS 地址。」——
   可标题是「重新输入中继口令」、地址框已锁定并预填，用户要填的是口令不是地址。
   违反「一句话说清一件事」。建议给 `reauth` 单独一条，如「中继口令已变更，重新输入以恢复接入。」
   （见 `desktop-tenant-05-reauth-dialog.png`）

3. **epoch 一个概念三种说法**：链路条 `relay.tenant.strip.meta` = 「元数据密钥第 {{epoch}} 代」，
   运营者页 `relay.admin.password.epoch` = 「口令代次」、`…minTokenEpoch` = 「最低令牌代次」、
   `relay.admin.tenants.columns.tokenEpoch` = 「令牌代次」，而 B4/B2 的文档用「世代」。
   建议统一到「第 N 代」/「…代」，去掉「代次」（「代次」本身也不是常用词）。

4. **接入对话框的密码字段偏技术**：`relay.tenant.dialog.rootPassword` = 「当前密码」（没说是哪个密码），
   `…rootPasswordHint` = 「接入证明须用根密钥签名，通行密钥无法代签。」——「根密钥」「接入证明」
   都是内部实现词，规范明确要求「不要过于技术（堆术语/内部实现）」。
   建议：标签「当前密码（本机账号密码）」，说明「接入必须用密码签名，通行密钥无法代签。」

5. **口令对话框两个单选项的说明重复标签**（规范：严禁啰嗦）：
   `relay.admin.password.modeKeepHint` = 「保留现有租户，新口令只对新接入生效。」，
   `…modeKickHint` = 「作废旧令牌，所有租户需重新输入口令。」。说明里再念一遍标签是冗余，
   建议只写后果：「新口令只对新接入生效。」「所有租户须重新输入口令。」
   （顺带：同屏里「需重新输入」与「须重新接入」混用 需/须，规范偏好「须」。）

6. **运营者「总量」里的「发送 / 接收」永远相等，看起来像 bug**：
   `relay.admin.totals.outbound/inbound`，数据来自 `relay_tenants.bytes_in/bytes_out`；
   按 B2 §六.11 的口径，中继每读一帧同时计进 in 和 out。本次实测 R 的读数就是
   `bytesIn: 6078, bytesOut: 6078` —— 逐字节相等。运营者看到两个永远一样的数字会怀疑统计坏了。
   建议要么改成单个「中转流量 6.0 KB」，要么把口径写进 tooltip。

7. （非阻塞）`nodes.enrollment` / HTTPS 卡片里仍是「只有本机作为 Hub 时才需要 HTTPS；节点经 Hub 访问，
   无需配置。」——中继模式下没有 Hub，这句话对中继租户是错的。F1 §五.5 已列为「不敢动既有 key」，
   现在有真截图佐证（`desktop-tenant-01-nodes-relay-strip.png`），建议本轮内改成中性的「上级」。

### 3.4 值得确认的小口径

- **吊销后运营者看到的节点数会一直挂着**：`apps/gateway/src/relay/relay-admin-routes.ts:42`
  的 `nodes: deps.tenants.listNodes(tenant.id).length` **包含 revoked**，
  租户表渲染成 `在线/已知`。本次 R 的租户吊销 B 后是 `nodes: 2, nodesOnline: 1`，
  运营者会永远看到「1 / 2」。与 R4 §一.9「吊销节点不占清单也不占配额」的口径不一致，
  建议 `listNodes` 在这里也滤掉 revoked（或单列一个「已吊销 N」）。

---

## 四、截图

全部 24 张（desktop 1280×800 与 mobile 390×844 各 12 张，`deviceScaleFactor: 2`），目录：
`<live>/shots/`（约 5.1 MB，未拷进仓库；需要归档请告知）。

| 文件名（`desktop-` / `mobile-` 各一份） | 内容 |
|---|---|
| `tenant-01-nodes-relay-strip.png` | 设置→多节点互联，中继链路条在线态（`中继 ● 127.0.0.1:19993 · 元数据密钥第 3 代 · 经中继可见 0 个节点 · 配额 16 节点｜64 流`） |
| `tenant-02-strip-hover.png` | 链路条悬浮 |
| `tenant-03-relay-menu.png` | 「中继操作」菜单（`追加中继 / 重新输入口令 / 轮换元数据密钥 / 离开中继`） |
| `tenant-04-enroll-dialog.png` | 接入（追加中继）对话框 |
| `tenant-05-reauth-dialog.png` | 重新输入中继口令（地址锁定） |
| `tenant-06-rotate-confirm.png` | 轮换元数据密钥确认 |
| `tenant-07-leave-confirm.png` | 离开中继确认 |
| `operator-01-header-cards.png` | 运营者标签页头部三卡（运行状态 / 总量 / 接入口令） |
| `operator-02-default-quota.png` | 默认配额卡（含「不限速」开关） |
| `operator-03-tenant-table.png` | 租户表（真实一行：上海 A 机 / 1 / 1 / 8 节点 · 32 流 · 512 KB/s） |
| `operator-04-password-dialog.png` | 修改接入口令对话框（保留现有租户 / 作废旧令牌） |
| `operator-05-tenant-editor.png` | 租户编辑（备注 + 跟随默认 + 配额三项） |

**整体观感**：桌面与移动都没有溢出、没有硬截断的中文，移动端对话框自动变底部抽屉、按钮竖排全宽，
卡片自动堆叠，链路条在 390 宽下换行成两行且不挤。上面 §3.2 的两条是仅有的布局问题。

---

## 五、复跑方式

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/konata/code/tmex-r23

# 前置：apps/fe/dist 必须存在（没有就 cd apps/fe && bun run build）
L=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/f9d3700c-64d1-49ea-b5c9-799106d674d3/scratchpad/live

# 1) 主驱动：跑完 §二 的 1..7 后启 R2 并挂起等 UI 截图
rm -rf $L/R $L/A $L/B $L/R2 $L/proceed-cleanup
bun $L/live-relay.ts            # 加 --no-wait 则跑完立刻拆
#    非 0 退出即失败；SUMMARY 段落逐条 PASS/FAIL

# 2)（可选）给运营者页造一个真实租户
bun $L/extra-r2-tenant.ts

# 3) 截图（要在 apps/fe 下跑，才解析得到 playwright）
cd apps/fe && bun $L/shots.ts   # 产物在 $L/shots/

# 4) 拆
touch $L/proceed-cleanup        # 主驱动收到后 kill 全部 PID + tmux -L tmex-live kill-server
```

脚本清单（全部在 `$L`）：

| 文件 | 作用 |
|---|---|
| `live-relay.ts` | 主驱动（起 4 实例、24 条断言、收尾） |
| `helper-bootstrap-user.ts` | 独立进程建首个本地用户（**动态 import，见 §3.1**） |
| `helper-relay-join.ts` | 独立进程跑 `runRelayJoin()` 的 r3 加入（同上） |
| `extra-r2-tenant.ts` | 给 R2 造真实租户 + 备注 + 配额 |
| `shots.ts` | Playwright 截图 + 文案 dump |
| `run3.log` / `shots.log` | 本次运行的完整日志 |

注意事项（下次跑之前必读）：

- 两个 helper 必须保持**动态 import**（`process.env.DATABASE_URL = …` 之后再 import），
  否则会静默写进 `<repo>/tmex.db`，见 §3.1。
- `test.env` 会 override 进程里的 `TMEX_MASTER_KEY`，所以 helper 与 gateway 必须用**同一把**
  （驱动从 `test.env` 读出来显式传给 helper）；不然节点身份私钥解不开。
- `test.env` 的 `TMEX_DEFAULT_LANGUAGE=en_US` 让界面默认英文，截图脚本会先进「设置→通用」
  切成简体中文再截。

---

## 七、F4 复核（commit `3e5f0406`，前端产物已按该提交重建）

复核驱动 `<live>/live-f4.ts`（3 实例精简版）+ 截图脚本 `<live>/shots-f4.ts`，
产物 `<live>/shots-f4/`（16 张，desktop 1280×800 / mobile 390×844 各 8 张，@2x），
日志 `<live>/run-f4.log`、`<live>/shots-f4.log`。

**与 §二 的拓扑差别**：为了让运营者页出现「已吊销 N」，本次让 **R2（`relay,node`，19996）同时充当中继与
运营者 UI** —— A（`node`，19994）带口令接入 R2，B（`node`，19995）经 r3 加入后被吊销。
端口、`tmex-live` socket、白名单 env 与 §一 完全一致。

### 7.1 后端断言（9/9 PASS）

| 断言 | 证据 |
|---|---|
| F4.1 R2 设中继口令 | 200 |
| F4.2 A 带口令接入 R2 | 200，`tenantId=5fe71c4eb5aab607ce58398665b7b6c3` |
| F4.3 A 上线 | `{online:true, attached:true}` |
| F4.4/F4.5 enrollment + r3 join | 201 / `runRelayJoin` 返回 `kind:relay` |
| F4.6 承认 B | `nodesOnline: 2` |
| F4.7 经中继远程调用 | `GET /n/<B>/api/devices` 200（让「中转流量」有非零读数） |
| **F4.8 吊销后管理面口径** | `{"nodes":1,"nodesRevoked":1,"nodesOnline":1}` —— `nodes` 已不含 revoked，且新增 `nodesRevoked` 字段（`relay-admin-routes.ts` 的改动生效） |
| F4.9 备注 + 单独配额 | `label:"上海 A 机"`、`quota:{maxNodes:8,maxStreams:32,bandwidthBytesPerSec:524288}` |

### 7.2 §3.2 布局问题：**两条全部修复**

1. **「操作」列可达** ✅。两张宽表现在都是 `position: sticky; right: 0`，脚本量到的实测数据：

   | 表 | 视口 | 滚动容器 clientWidth / scrollWidth | `scrollLeft` | 末列 rect | 末列内容 |
   |---|---|---|---|---|---|
   | `nodes-table` | 1280 | 846 / 876 | 0 | 1013–1219（视口内） | `升级 更多 移除` |
   | `relay-tenants-table` | 1280 | 846 / 1055 | 0 | 1013–1219（视口内） | `编辑 踢出 删除` |
   | `nodes-table` | 390 | 316 / 876 | 0 | 147–353（视口内） | `升级 更多 移除` |
   | `relay-tenants-table` | 390 | 316 / 1055 | 0 | 147–353（视口内） | `编辑 踢出 删除` |

   即**未滚动时操作按钮已完整可见**（`desktop-tenant-01-nodes.png` 里 `升级/更多/移除` 三个按钮完整、
   被裁的改成了低价值的「公钥指纹」列 `d6920d3291205…`）。滚动容器还加了细滚动条样式
   （`[&::-webkit-scrollbar]:h-1.5` + `scrollbar-width:thin`），有了可见的滚动提示。

2. **移动端深链标签滚入视口** ✅。`?tab=relay` 打开后实测
   `settings-tab-relay` 的 rect = `{left:290, right:369, viewportWidth:390, fullyVisible:true}`
   （桌面同样 `fullyVisible:true`）。`mobile-operator-01-header-cards.png` 里「中继」高亮标签就在右侧可见。

### 7.3 §3.3 文案问题：5 条修复，1 条仍开

| LT 编号 | 状态 | 复核证据 |
|---|---|---|
| §3.3-1 术语冲突（中继=relay vs 规范里中继(Hub)=hub） | ❌ **仍开** | `/Users/konata/code/tmex-copy-guidelines.md` 第 22 行仍是「中继（Hub）\| 中心节点 / 服务器」，mtime 还是 8-31。**需要指挥官改这份规范文件**（它在仓库外，我未动） |
| §3.3-2 reauth 说明文不对题 | ✅ 修复 | 新增 `relay.tenant.dialog.reauthNotice`，界面为「中继口令已变更，重新输入以恢复接入。」（`desktop-tenant-03-reauth-dialog.png`） |
| §3.3-3 代/代次/世代 不统一 | ✅ 修复 | 新增 `relay.admin.epochValue`「第 {{epoch}} 代」；运营者页改为「口令 第 1 代」「令牌下限 第 0 代」，租户表列头由「令牌代次」→「令牌」值「第 1 代」，与链路条「元数据密钥第 3 代」一致 |
| §3.3-4 接入密码字段过于技术 | ✅ 修复 | 「当前密码（本机账号密码）」+「接入必须用密码签名，通行密钥无法代签。」（「根密钥」「接入证明」已去掉） |
| §3.3-5 口令模式说明重复标签 | ✅ 修复 | 「保留现有租户 / 新口令只对新接入生效。」「作废旧令牌 / 所有租户须重新输入口令。」（并把「需」改成「须」） |
| §3.3-6 发送/接收永远相等 | ✅ 修复 | 「总量」卡合成单项「中转流量 5.19 KB」（`relay.admin.totals.traffic`） |
| §3.3-7 HTTPS 卡片写死 Hub | ✅ 修复 | 「只有本机作为上级时才需要 HTTPS；节点经上级访问，无需配置。」 |

§3.4（运营者节点数含已吊销）也已修复：租户表「节点」列现在是 `1 / 1` + `已吊销 1` 徽标，
后端 `nodes` 不再计入 revoked（见 7.1 的 F4.8）。

### 7.4 新发现：sticky 操作列在移动端把表格挤到几乎不可用

固定操作列在桌面是净收益，但在 390 宽下它占掉滚动窗口的三分之二：

- `nodes-table`：滚动容器 316 px，sticky 操作列约 206 px → 只剩 **约 110 px** 显示其余 8 列，
  实际只看得到「名称 self 当前」，状态 / 版本 / 最近在线 / 支持直连 / 登录状态 / 公钥指纹全部要横向拖
  （`mobile-tenant-01-nodes.png`）。
- `relay-tenants-table`：同样只剩「编号 5fe71c4eb5aa…」和三个按钮，备注 / 接入时间 / 节点 / 流量 / 配额
  全部看不到（`mobile-operator-02-tenant-table.png`），而这张表 `scrollWidth` 有 1055 px。

建议：`sm` 以下不要 sticky（整行一起横滚），或者窄屏把行改成卡片式、操作收进「⋯」菜单。
不阻塞发版，但移动端这两张表现在的可读性比 F4 之前更差。

### 7.5 截图清单（`<live>/shots-f4/`，desktop-/mobile- 各一份）

| 文件 | 内容 |
|---|---|
| `tenant-01-nodes.png` | 节点页：中继链路条 + 节点表（sticky 操作列） |
| `tenant-02-enroll-dialog.png` | 追加中继对话框（新密码标签/说明） |
| `tenant-03-reauth-dialog.png` | 重新输入中继口令（新说明、地址锁定） |
| `operator-01-header-cards.png` | 运营者头部三卡（单一「中转流量」、「第 N 代」）+ 租户表首行 |
| `operator-02-tenant-table.png` | 租户表（`1 / 1` + `已吊销 1`、sticky 操作列） |
| `operator-03-password-dialog.png` | 修改接入口令（新单选说明） |
| `operator-04-tenant-editor.png` | 租户编辑对话框 |

### 7.6 收尾复核

`proceed-cleanup` 后：19994/19995/19996 全部释放、`pgrep -f tmex-r23/…/server.ts` 为空、
`tmux -L tmex-live ls` → `no server running`、默认 socket 仍是
`tmex: 3 windows (created Wed Aug 26 00:26:54 2026) (attached)`（逐字未变）、
生产 runtime（`~/Library/Application Support/tmex/current/runtime/server.js`，监听 9883）全程未触碰、
仓库无 `tmex.db` 残留。

### 7.7 复跑

```bash
export PATH="$HOME/.bun/bin:$PATH"
L=/private/tmp/claude-501/-Users-konata-code-tmex-enhanced/f9d3700c-64d1-49ea-b5c9-799106d674d3/scratchpad/live
cd /Users/konata/code/tmex-r23
rm -rf $L/R2 $L/A $L/B $L/proceed-cleanup && bun $L/live-f4.ts   # 起 3 实例并挂起
cd apps/fe && bun $L/shots-f4.ts                                  # 截图 + 表格/标签位置量测
touch $L/proceed-cleanup                                          # 拆
```
