# 第二十三轮执行结果：公共中继（relay）角色 + round22 遗留

分支 `feat/round23-relay-legacy-removal`（worktree `/Users/konata/code/tmex-r23`，base main `fc7fdba3` / 1.1.22），
目标版本 **1.1.23**：新增盲中继角色 `relay` / `relay,node`（多租户、藏内容也藏元数据、保留根公钥），
同时清掉 round22 遗留的 legacy 终端状态流、`tailwind-merge` 依赖与三条只有测试引用的路由。

---

## 一、任务落地结论

### legacy 状态流下线（L1a–L1d）

| ID | 结论 |
|---|---|
| **L1a** | shared 侧 canonical v1.1：新增 `ResizePaneV11`（命令枚举 discriminator=5，带 `geometryReason` + `sizeEpoch: u64`）、能力 `canonical-state-v1.1`、`peerSupportsCanonicalV11(≥1.1.22)`、metadata 字段 `SOURCE_FIELD_TREE_ORDER = 15` 与三个树顺序助手。**刻意偏离 plan**：不升 `protocolVersion`、树顺序走 fields 扩展点而非 struct 追加字段（升 wire version 会让 v1 对端整条流解码失败），也没有加命令 fast-peek。 |
| **L1b** | gateway 停发 `STATE_SNAPSHOT(_DIFF)` / `TERM_HISTORY` / `TERM_OUTPUT` / `SWITCH_ACK` / `LIVE_RESUME`，停收 `TMUX_SUBSCRIBE_PANES` / `TMUX_FETCH_PANE_HISTORY` / `TERM_RESIZE` / `TERM_SYNC_SIZE`；删 switch-barrier、output-batcher、overlay-utils 等整文件；resize 走 `handleCanonicalResize` + 每 pane `sizeEpoch` 单调过滤；HELLO 与 entry↔node 双向版本门 fail-closed（`ERROR_UNSUPPORTED_PROTOCOL` + 前缀 `canonical-state-v1.1 required`）；树顺序写进 canonical metadata。 |
| **L1c** | ws-client/stores 删 `state-machine.ts`（781 行）、`pane-history-gate`、`canonical-metadata-overlay`、`pane-stream-gaps`、`select-transaction-observers`、`reselect-retry`；尺寸走 `ResizePaneV11` + 按连接自增的 `CanonicalSizeEpochs`；`StateFeedMode` 去掉 `'legacy'`、加 `'unsupported'`；`metadata-patch` 事件改为下发排好序的整棵快照。 |
| **L1d** | terminal-ui 删 legacy 首屏恢复（`writeRestoredHistory` / `onReset` / `onApplyHistory`）与 canonical kill switch；e2e helper 重建为 canonical（新增 `CanonicalCommandCollector`），改写 history / pane-route / switch-barrier / resize / theme-resize / mobile-keyboard 六组 spec；补 `websocket.serverTooOld` 三语提示；同步四篇文档。**顺手定位并修掉 KI-3**（见 §四）。 |

### round22 其余遗留（L2、L3、L3b）

| ID | 结论 |
|---|---|
| **L2** | `packages/ui/src/class-merge.ts` 取代 `tailwind-merge@3.4.0`：把默认配置的 `classGroups` / `conflictingClassGroups` 等价压缩成 350 组的前缀树 + 21 个校验器 + 48 条冲突规则。对照约 650 万次比对**零差异**；`packages/ui` 用例 110 → 370。体积只省 0.95 KB gzip（预期之外，取舍权已交回）。 |
| **L3** | 删 `GET /api/tmux/tree`、`GET\|POST /api/settings/theme`、`POST /api/hub/nodes/:id/revoke` 三条只有测试引用的路由。revoke 覆盖改走 `POST /api/auth/keylog?hub=sync`（必须由第三方链路发，否则 ack 帧被同轮关闭吞掉），主题 e2e 改走新 helper `tests/helpers/site-theme.ts`（WS `SITE_THEME_UPDATE`，与主题菜单同一条链路）。 |
| **L3b** | 收尾 L3 的外部遗留：`scripts/hub-e2e` 两个 run.sh 去掉 `tmux-tree` 取 pane（driver 从快照解析，`--pane-id` 改可选），删死代码 `apps/gateway/src/tmux/theme-broadcaster.ts` 与 `runtime.ts` 的注册/注销，`hub-runtime.ts` 的 allowlist 行数收紧到 1317。删掉两条无等价替换的断言（都是在测被删的路由本身，紧随其后的 marker 往返断言严格更强）。 |

### 中继后端（B1–B5）

| ID | 结论 |
|---|---|
| **B1** | `packages/shared/src/relay/*`：`relay/v1` ctl codec（18 类消息、64 KiB 上限）、租户密钥信封与按节点 X25519 封装、join 串 r3、`relay.status` / `relay.rtc` 明文块、`tmex/relay-enroll/v1` proof；`auth` 侧新增 `set-relays` / `meta-key` 两类记录（签名者 root+passkey，`minVersion 1.1.23`、`allowForce:false`）；`TmexRoles` 加 `relay` 字段与 `validateRoles()`。 |
| **B2** | `apps/gateway/src/relay/`（23 个文件，全部 ≤600 行）：多租户 `RelayRuntime`、`relay/v1` uplink 服务、租户注册表 / 密钥日志 / 配额计量 / 口令与管理鉴权、`/api/relay/*` 全族路由、迁移 `0039_relay.sql`；config 解析 relay 角色与 `TMEX_RELAY_*`；assemble 在 hub 之前挂载 relay，`relay` 单跑不建 mesh/auth surface、前端一律 404。 |
| **B3** | 节点侧：`RelayUplinkClient`（把 hub ctl 翻译成 `relay/v1`，`createKeyLogPublisher` / `MeshRtcSignalRouter` 零改动可用）、密钥日志双向同步、`RelaySecrets` 落库、`UplinkPool` 双种类候选、`set-relays` / `meta-key` 应用、`/api/mesh/relay/*` 八条路由、迁移 `0040_mesh_relay.sql`（含放开 `user_key_log` 的 type CHECK）。**偏差**：`rename-node` 记录类型根本不存在，节点名改由 `node_identity.name` 自持；`meta-key` 的 admit 也必须换世代（记录要求严格递增）。 |
| **B4** | CLI：运营者七条（`status/tenants/passwd/kick/remove/quota/label`）+ 租户四条（`enroll/reauth/leave/list`），`hub join` 识别 `r3.` 串（无需 url、无需 `TMEX_HUB_URL`），`init --role relay\|relay,node` + `--relay-public-url`。`args.ts` 与 `cli-auth-entry.ts` 因复杂度门禁改写成查表/分派表。同时点出三处跨 agent 契约打架（proof 形状 ×2、`proof-material` 字段名）与「中继缺 enrollment 查询路由」这个会卡死 r3 加入的洞。 |
| **B5** | 进程内集成测试（1 中继 × 2 租户 × 2 节点真实栈，11 例九场景）；密钥日志明文帧上提 `@tmex/shared/relay/keylog-frame`；集成过程中修掉三个阻断级缺陷：`enroll.redeemed` 不落库（r3 加入的节点永远无法被承认）、换钥后不重发状态块、版本门禁把中继记录全部堵死；另修 `MeshRuntime.stop()` 不停自建 `HubRuntime` 导致的跨文件「closed database」——**任务书列的 4 个已知负载 flake 因此全部消失**。`packages/app` 的 tsconfig 从无效的 `types:["node"]` 改成 `["bun"]`，放出的 121 个真实类型错误已全部修完。 |

### 中继前端（F1–F3）

| ID | 结论 |
|---|---|
| **F1** | 租户侧节点页：`HubStrip` 泛化成上级链路区块 + 中继链路条，接入 / 迁移 / 追加 / 重输口令 / 离开 / 轮换六个流程，admit 后自动补 `meta-key{op:'admit'}`、吊销后自动补 `{op:'rotate'}`；`RelayEnrollmentApi` 顶替 `HubApi` 让加入码引擎零改动可用；`packages/api-client/src/relay/tenant-api.ts` + i18n `relay.tenant.*`。 |
| **F2** | 运营者侧设置页「中继」标签（13 个文件 + 101 个 `relay.admin.*` key）：健康/总量/口令三卡、默认配额、租户表（备注就地编辑、踢出、逐字确认删除）。FE 拿不到角色信息，标签门禁走 `GET /api/relay/status` 探针（404 = 角色缺席）；该 tab 不进 `chunkPreloadOrder`，非中继机不预热这块 chunk。 |
| **F3** | 改密 / 根轮换后自动补 `meta-key`（`rotate-root` 因当场 `revokeAllSessions` 必然 401，已签好的记录存 sessionStorage 待重新登录后重发）；新增 `POST /api/mesh/relay/remove/prepare` 与「移除某条中继」UI；评审整改 A–H：模式判定改问网关、换代欠账持久化 + 自动重试、侧滑面板适配中继、`prepare` 收进写锁、reauth 打对中继、上游错误码透传、配额表单上限对齐服务端。 |

### 三轮审查与整改（R1a/R1b、R2/R3、R4）

| ID | 结论 |
|---|---|
| **R1a** | 网关侧 6 条 finding 全部属实并修复：`TMUX_SELECT` 绕过实时几何去重、failover 重协商对缺失/畸形 HELLO fail-open、拒绝旧节点时泄漏上游流与远端会话、切换后视口 claim / 最新几何不恢复（新增 `ViewportReplayCache`）、`paneSizeEpochs` 无界增长、`stream-failover` 集成用例根本没走被测数据面（整体重写）。追加批次再修 `failover-exhausted` / `failover-error` 的同型泄漏，以及 hub uplink 定时器越过测试文件边界（新增 `UplinkTimerSet`，回调异常只 warn 不外抛）——这是「closed database」流弹的另一半真因。 |
| **R1b** | 客户端/shared 侧 4 条：树顺序被 `Unset` 后退不回 tmux 顺序（改为保留未排序底稿 `baseSnapshot`）、老对端被拒没有变成 `server-too-old`（新增共享匹配器 + `protocolFatal` 停重连）、shared 仍导出 10 个已删 kind 的 schema/编解码（整体删除并把号段标为永久作废）、pane 移除时 `sizeEpoch` 不回收。另把 `scripts/hub-e2e/driver/terminal.ts` 整条改成 canonical（否则版本门下它直接跑不通），并把 `client.ts` 拆到 804 行清掉门禁。 |
| **R2** | 中继 CLI 10 条 finding 全部属实：**BLOCKER** r3 加入无法回放含 passkey 签名的密钥日志（新增 `makeReplayPasskeyVerifier`，随后按指挥官要求同样接进 hub join）；r3 的 CA 指纹解出即丢（新增 pin 流程，指纹不符不 failover）；把 join 串里的 head 当链尾用；**一个 tenantId/token 走遍所有中继**（改 r3 字节布局为每条地址自带凭据）；`relay,node` 被写成 `node`；`init --role relay` 接受空/非 https 地址；head→签→append 无并发处理（有界乐观重试 + 重取 payload）；HTTP 无超时、响应体无上限；配额 flag 校验对齐服务端。 |
| **R3** | **BLOCKER** `POST /api/auth/keylog?hub=sync` 在中继模式下必然死锁（三处独立堵点）——改为 `planKeyLogAppend()` 本地优先落账、不等上级 ACK、`set-relays`/`meta-key` 不回灌旧 hub，**前端一行未改**；**MAJOR** `relay,node` 退不出 mesh 且退出不清中继密钥——`/api/local/leave` 接受 `relay,node`（退出后落 `standalone`）、`clearAll()` 增删 `mesh_relays`/`mesh_secrets`，纯 `relay` 明确 400 `not_member`。 |
| **R4** | 中继后端安全审查 14 项，**无一误报，全部已修**：3 条 BLOCKER（重放的 member sidecar 能把已吊销节点抬回 admitted；`direct_capable` 走明文；中继没有根轮换路径）+ 8 条 MAJOR（codec 强制 64 字节签名导致 passkey 记录上不去、`enroll.create` 的 exp 未与 authorization 对齐、重签令牌不断旧链路、追加日志非原子 + 垃圾信封堵死同步、并发流配额重复计数且有竞态、`relay.list` 先截断后过滤且 `maxNodes` 上限与清单容量不符、中继路径被 Access/域名守卫挡住且限速用 socket IP、enrollment 无上限）+ 2 条 MINOR + 1 条 B5 遗留（standalone 机器 `/api/mesh/relay/*` 恒 401）。 |

**审查统计**：三轮共 36 条 finding（R1a 6+2、R1b 4、R2 10、R3 2、R4 14），
其中 BLOCKER 5、MAJOR 约 20、其余 MINOR / 测试质量问题；**全部核实为真且全部修复**，无一误报、无一挂起。

### 明确「不做」的项

| 项 | 理由 |
|---|---|
| member sidecar 再加一个「绑定信封明文」的哈希 | 密文与 sidecar 由**同一个上传者**产生，他可以两边都改，对恶意上传者零收益。真正起作用的是 seq 绑定 + epoch 绑定 + `revoked` 终态，三条都已实现 |
| 「根 epoch 变了就重做 enroll 流程」（R2 findings 原文） | 根 epoch 只会因换根而变，CLI 手里那把由密码派生的根钥换过之后签什么都无效，重做只会以更难懂的错误失败。改成检测到即中止并抛 `RELAY_ROOT_ROTATED` |
| 「退出租户但保留中继服务」 | `relay,node` 退出后落 `standalone`。前端本机卡片的可选角色只有 `standalone\|node\|hub,node`，保留纯 `relay` 会让网页直接消失；要做需要先给本机卡片加 relay 角色并给 `/api/local/leave` 加目标角色字段 |
| `viewport-policy.spec.ts:77/128` 改绿 | 真因是网关 `resolveWinner` 按「可见客户端中**列数最小**者持整窗」，与 spec 期望的「最大者持窗、小的平移」是两套语义。相关文件相对 main 零改动，属产品取舍，本轮不动（见 §四） |
| 升 canonical wire version / struct 追加 metadata 字段 | 都会让 v1 对端整条流解码失败，混版本 mesh 会整体断流。改用「命令枚举尾部追加变体 + fields 新字段号」，对 v1 无声兼容 |
| 多中继同时连接、跨中继转发 | 本轮定为有序 failover，同一时刻只连一台（plan 已拍板，边界已写进文档 §13） |
| `rename-node` 记录类型 | hub 的改名只写 `nodes` 表 + 广播，本就没有这条记录；中继模式下改**别的**节点的名字需要新增记录类型，属下一轮 |

---

## 二、测试计数终态

数字取自各任务结果文件里最后一次运行（R4 是 HEAD 提交，其数字最新）。**指挥官将跑一次全量复核并在此追加。**

| 包 | 基线（main / 1.1.22） | 本轮终态 | 备注 |
|---|---|---|---|
| `apps/gateway` | 4046 + 4 条满载 flake | **4141 / 0 fail** | 4 条已知 flake 因 B5 修掉 `MeshRuntime.stop()` 与 R1a 修掉 hub 定时器泄漏而消失 |
| `packages/shared` | 534 | **621 / 0 fail** | 中继 +87、canonical v1.1 +28，R1b 删 legacy wire 用例 −16 |
| `packages/app` | 690 + 1 已知失败 | **798 / 1 fail** | 唯一失败是 `scripts/build-runtime.test.ts`（读 `dist/runtime/server.js`，需先跑 `bun run build:runtime`），环境性，与改动无关 |
| `packages/api-client` | 175 | **201 / 0 fail** | |
| `apps/fe`（`src/`） | 1783 | **1883 / 0 fail** | F1 +24、F2 +59、F3 +19，L1d 净 −2 |
| `packages/ws-client` | 408 | **392 / 0 fail** | 删 state-machine 全套后净减，R1b 又补回门槛/尺寸/树顺序用例 |
| `packages/stores` | 440 | **411 / 0 fail** | 删 warm / gap / reselect 全套 |
| `packages/terminal-ui` | 400 | **394 / 0 fail** | 删 `writeRestoredHistory` 等 6 例 |
| `packages/panels` | 911 | **911 / 0 fail** | 源码一行未动 |
| `packages/ui` | 110 | **370 / 0 fail** | L2 的 251 条 tailwind-merge 对拍用例 |
| `packages/theme` | 52 | 52 | 未触碰 |

门禁：`bun run lint`（biome + 复杂度）在 R4 收口时全绿、**未新增任何 allowlist 条目**；
`tsc --noEmit` 在 gateway / shared / app / fe / ws-client / terminal-ui / panels 全部 0 error
（`packages/api-client` 与 `packages/stores` 各有既有基线错误，均在未改动的测试文件里）。

---

## 三、发版

> **待补（指挥官填）**：版本号 / 发版日期 / `npx tmex-cli@<version> upgrade` 替换本机结果 / 六节点升级情况。

---

## 四、e2e 基线变化

对照记忆里的 `e2e-baseline-failures`（main 上既有的 9 个失败）：

- **KI-3 `mobile-terminal-interactions` ×4 —— 真因已定位并修复。** 这四例监听的是 `TERM_INPUT` kind，
  而输入早在 canonical 上线时（`50e2f718^`）就改走 canonical `TerminalInput` 了，`sentInputs` 恒为空。
  L1d 建起 canonical 命令解码器后顺手改写（`sentInputs()` 映射 `collector.inputs`；
  `isComposing === false` 的断言直接去掉——canonical 链路在客户端就拦掉了组合中的输入，该条件恒成立）。
  断言语义与原来一致，可以从基线里划掉。
- **主题 5 个 spec（11 例）—— 已修，11/11 通过。** 真因是 L3 新建的 helper `tests/helpers/site-theme.ts`
  裸 WS HELLO 报 `clientVersion: '0.0.0'`，被 L1b 的 fail-closed 版本门直接拒掉，`setSiteTheme()` 永远等不到广播。
  改成上报 `CANONICAL_V11_MIN_PEER_VERSION`。
- **`viewport-policy.spec.ts:77 / :128` —— 仍失败，非本轮回归，属产品取舍。** 抓两端 POLICY 帧确认：
  小客户端 B 拿到 owner，整窗被缩到 B 的几何，与 spec 断言（小客户端不缩窗、自己本地平移）正好相反。
  `resolveWinner` / `viewport-policy.ts` / `terminal-stage.tsx` 相对 main **零改动**，round21 也记录过同样失败。
  二选一：改网关仲裁为「列数最大者持窗」（要回归窄屏溢出、移动端拼接布局），或按现行语义重写这两例。
- **`terminal-mouse-recovery.spec.ts:411` —— 负载敏感 flake，非回归。** 定向单跑 5 次里 1 失败、整文件单跑 7/7 通过；
  断言依赖 opencode TUI 在 5 s 内重绘完。维持 round21 的既有归类。
- R1b 的定向跑：`ws-borsh-resize` 6/6、`ws-borsh-switch-barrier + ws-borsh-resize` 8/8、
  `terminal-mouse-recovery` 整文件 7/7、八 spec 合跑 25 passed / 1 failed（唯一失败就是上面那条 flake）。

---

## 五、遗留 / 下一轮

**中继功能面**

1. **`peer_cache` 缺 `version` 列**：`nodes` 注册表只有 hub 侧会写，中继租户上它恒为空，
   所以 `KEYLOG_RECORD_COMPAT` 那道版本门禁在中继模式下是「不判定」而非「判定通过」（现有两处豁免是最窄口子）。
   状态块里已经带 `version`，加一列并在 `relayListToNodeList` 里写入即可（要新迁移）。
2. **多中继同时连接**：本轮只有有序 failover，落在不同中继上的节点互不可见。
3. **enrollment 未扇出到所有中继**：`relay.enroll.create` 只落在当前 attach 的那一台，
   所以 join 串只能带这一台；扇出之后 r3 布局不用再改（每条已自带凭据），但 CA 指纹要做成每条一个。
4. **最小 admission ticket**：中继验不了 passkey 签名，当前靠「该租户已有 admitted 节点」容忍 passkey 签的 admit。
   要收紧需要设计一份中继能独立验证的最小准入凭据（根签名背书、与具体 node id 绑定）。
5. **`tmex relay list` / `relay leave` 也要本机用户密码**（都要 node-session）。读操作免密需要给
   `/api/mesh/relay/status` 开一条本机免密门（round20 的 peer 打标那套）。
6. `GET /api/mesh/relay/status` 的 `rttMs` 恒为 null；`/api/relay/status` 不带「当前节点数」，
   加节点表单没法提前拦 `maxNodes` 配额，只能等中继在 redeem 时拒。
7. `meta-key` 欠账的自动重试只在节点管理页挂载时跑；要更强得把重试回路提到宿主级（和 `enrollment-engine` 同档）。
8. 中继模式下**改别的节点的名字做不到**（无 `rename-node` 记录类型）。
9. `join-material` 的顶层 `tenantId` / `token` 兼容字段只为集成 harness 保留，harness 改用 `relays[0]` 后可删。

**实测**

10. **Linux / docker-node 实测未做**：本轮只跑了进程内集成测试与本机临时实例。
    需要在真实第二节点上走一遍 enroll / r3 join / relay 流 / failover。
11. hub docker e2e 的 driver 已按 canonical 重写并打包通过，但**本机跑不了 docker harness**，
    下次跑 hub e2e 时要留意 `--capture-seq` 的 history/output 归因；
    `split/run.sh` 的 pane 兜底完全依赖快照（`run.sh` 还有 tmux 直查兜底），偶发时应给 driver 加 `pane-id` 子命令而不是恢复被删的路由。

**清理**

12. `apps/gateway/src/ws/index.ts` 上两个已无生产调用方的转发壳
    （`WebSocketServer.scheduleTmuxThemeApply` / `broadcastSiteThemeUpdateS2C`），由 ws owner 决定是否清。
13. `apps/fe/tests/ws-borsh-switch-barrier.spec.ts` 文件名名不副实（屏障已删），建议改 `ws-borsh-pane-switch.spec.ts`。
14. 两处过时注释：`packages/ghostty-terminal/src/terminal.ts:400`（提到已删的 `onApplyHistory`）、
    `packages/panels/src/device-console/use-pane-size-sync.ts:48`（提到已删的 `TERM_RESIZE`）。
15. 文案术语：`/Users/konata/code/tmex-copy-guidelines.md` 里「中继（Hub）」指的是 hub，
    而本轮的 relay 也叫「中继」。本轮所有新文案按「中继 = relay、Hub = hub」写，**规范文件需同步更新**，
    否则后续 agent 会再翻一次。另外 `nodes.enrollment.hubNotConfirmed` / `missingHubUrl` 仍写着 Hub，
    中继模式下会显示「Hub 未确认」。
16. 复杂度余量告急：`apps/fe/src/pages/settings/nodes/management/nodes-management.tsx` 595/600，下一个动它的人得先拆。

---

## 六、本轮产出的文档

- `docs/relay/2026090304-relay-role.md` —— relay 角色的实现参考（协议、存储、接口、CLI、网页、配额、运维、已知边界、实测方法）。
- 同步更新：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`（1.1.23 作废号段 + 冻结正文的过期标注）、
  `docs/ws-protocol/2026021403-ws-state-machines.md`、`docs/terminal/2026021404-terminal-switch-barrier-design.md`（整篇改为「已下线」）、
  `docs/terminal/2026090101-viewport-policy.md`、`docs/terminal/2026041600-ghostty-wasm-runtime.md`、
  `docs/hub/2026082700-hub-node-architecture.md`（角色矩阵 + 挂载顺序 + 载体切换）、
  `docs/hub/2026082800-hub-node-operations.md`（部署矩阵 + `app.env` 键）、
  `docs/hub/2026090104-multi-hub-standby.md`、`docs/ws-protocol/2026070402-site-theme-update.md`、
  `docs/env/2026061301-three-tier-env.md`（两个新中继环境键）。
