# 第二十五轮执行结果

版本 1.1.25（主体）+ 1.1.26（readmit-node 热修）+ 1.1.27（中继模式节点名 / 未挂载错误原因）。分支 `feat/round25-relay-live-bots`，全部以 merge commit 并入 main；本机与全部远端节点已升级；现网已迁移为「tmexhub-sh = 中继 + 节点，其余全部为节点」。

## 一、任务与落地

| 任务 | 落地 |
|---|---|
| 1 中继遗留 | L1 Hub 密码加入支持 TOTP（`--totp`/`TMEX_TOTP`/`totpCode`），passkey 账号退化为「待批准」并可在节点管理一键批准（`admission_status`）；L2 `leave → relay` 删除本机根钥对应租户；L3 待批准态；L4 enrollment 扇出到全部中继（中继侧 `POST /api/relay/tenants/:id/enrollments`，节点侧并发扇出、r3 只含接受方，密封包全表）；L5 版本门在纯节点/中继模式读 `peer_cache.version`，本机自身证书永不阻塞 |
| 2 终端提示节点名 | `resolveNodeName` 注入 stores runtime，`websocket.nodeTooOld` 显示 mesh 节点名 |
| 3 节点管理误报 | 首次探测（含静默登录）期间不再显示「无法连接到 Hub」，改为「正在连接 Hub…」 |
| 4 bot 指令模板 | `@tmex/shared/messaging` + `apps/gateway/src/messaging`：注册表 / 解析 / 节点定位 / 分块 / 适配器 / 运行时钩子；Telegram 与微信共用；`allow_commands` 开关（0044）+ 设置页开关；relay 纯角色不起 bot；连接告警走统一门控；文档 `docs/messaging/2026090402-messaging-command-template.md` |
| 5 中继实测与迁移 | 临时实例演练 72/72 + 根轮换演练 39/39（`sub/LT-result.md`）；现网迁移完成（见三） |
| 6 docker 节点 | `scripts/docker-node/`：`init --no-service` + pid 看护，可从网页升级；容器已重建为 1.1.26 并加入中继 |

审查：R1（后端 10 条：修 7，不修 #3 租户令牌伪造 passkey enrollment（§13 边界）、#4 中继模式未缓存 cert 跳过、#2 由指挥官改 run.sh 回环发布）、R2（前端 7 条全修）、R3（readmit-node 3 条全修）。

## 二、1.1.26 的来由：根轮换后接入中继失败

现网账号根 epoch 为 4（三次 `rotate-root-keep`），所有 `admit-node` 都是 epoch 1 旧根签的。入口以当前根 enroll 后，中继对 `relay.auth` 回 `member-epoch_mismatch`，整网无法接入（演练时根从未轮换，未暴露）。修复：新记录 `readmit-node`（载荷同 admit-node，用当前根重编码授权，证书字节必须一致，minVersion 1.1.26），`GET /api/mesh/relay/readmit/prepare`，接入流程先补签再远端 enroll（令牌换发不可逆）再 `set-relays`；`/api/mesh/relay/status.readmitPending` + 状态卡片「重新确认成员」。

## 三、现网迁移实录（2026-09-04）

1. 全部节点升 1.1.25 → 发现 epoch 问题 → 入口 `leave` 退回 hub A → 发 1.1.26 → 全部节点升 1.1.26（A、jiefa-dns-1 走 scp + `--apply-current-package`；jiefa-dns-1 到 github.com 不通）。
2. B：`tmex hub leave` → 手删 `TMEX_HUB_MODE/PEERS/PRIORITY/WRITER_EPOCH` → `POST /api/setup/relay {role:'relay'}`；A：`tmex hub promote --yes` 临时接管写者（以便吊销旧 docker/旧 B 身份，`set-relays` 的版本门要求全员 ≥1.1.23）。
3. 入口：`migrate-prod.ts readmit`（4 条）→ `enroll`（同租户 `65078cc9…` 重签令牌，`set-relays` seq 21，attached，密封包上传）。
4. **意外但更好的结果**：`set-relays` 在入口脱离 hub A 前被 A 的 key-log catch-up 拉走并广播，A、jiefa-app、jiefa-dns-1 都原地切到中继模式（node id 不变，readmit 后中继直接承认）。因此只有 docker-node（重建）与 B（`hub leave` 后 `relay join`）换了 node id。
5. A：改 `TMEX_ROLES=node`、删 hub 键、重启；B：`tmex relay join … --name tmexhub-sh` → `relay,node`；`meta-key rotate`。
6. 终态：中继 6 节点全在线；入口 `verify` 5/5（`/n/<id>/api/devices` + canonical HELLO）。

## 四、测试计数（1.1.26 终态）

gateway 4312/0、app 908/0、shared 689/0、stores 418/0、ws-client 398/0、panels 907/15（main 同样 15，环境性）、api-client 209/0、ui 370/0、fe 2137/0；tsc 除基线（gateway 1 条既有 TS5097、stores 1、api-client 5）全 0；lint 绿；e2e 107/4/1（2 条 viewport-policy 既有 + 2 条 terminal-render-regressions 负载抖动，隔离复跑 5/5）+ mesh 12/12。

## 五、遗留

1. 中继模式下入口节点名显示 `self`（`selfName()` 只在 hub 角色回落站点名）；未挂载中继行无错误原因 —— G9 / 1.1.27。
2. jiefa 两台的 sshd 在多次连接后拒绝握手（疑 fail2ban），本轮最终未用 ssh 迁移它们。
3. R1-#3/#4 未修（见上）；`packages/panels` 15 个环境性失败仍在；CI 工作流（非 Release）在 main 上一直失败，未查。
4. 指令层只在托管 bot 的本机执行，远端节点需在各自节点配置 bot；`registerMessagingRuntime` 未做真实 Telegram/微信打通实测。
