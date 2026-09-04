# 第二十五轮计划：中继遗留 / 终端提示节点名 / 节点管理误报 / 消息指令模板 / 中继实测迁移 / docker 节点

## 背景

- base：main `833ffd99`（1.1.24），分支 `feat/round25-relay-live-bots`，worktree `/Users/konata/code/tmex-r25`，版本 bump 到 **1.1.25**。
- 上一轮（`prompt-archives/2026090401-round24-relay-local-role/plan-00-result.md` §五）遗留：TOTP/passkey 账号不能走 Hub 密码加入；`leave → relay` 幽灵租户；Hub 清单无「未承认」态；enrollment 未扇出到全部中继；版本门仍读 `nodes` 表；远端节点仍旧版。
- 现网拓扑（生产库 `peer_cache`，只读）：B `tmexhub-sh`（hub,node 写者，1.1.23）、A `tmex`（ai.jiefakj.com:18443，standby，1.1.23）、`konata-mac`（本机入口，1.1.24）、`docker-node`（本机容器，手工部署 1.1.22，无 install-meta 故 UI 升级 403）、`jiefa-app` / `jiefa-dns-1`（内网 10.110.88.3/5，1.1.23）。
- 探索报告：`sub/EX1-report.md`（终端提示节点名）、`sub/EX2-report.md`（Hub 误报）、`sub/EX3-report.md`（bot 审计：两套 bot 只有通知 + `/start` 绑定，无指令、无 mesh 感知）、`sub/EX4-report.md`（遗留逐项 + 迁移路径审计）。

## 分工（激进并行，同一 worktree 文件互不重叠）

| 编号 | 执行者 | 内容 |
|---|---|---|
| EX1–EX4 | codex luna | 只读探索（已完成） |
| F1 | Opus | 节点管理首次探测期间不显示「无法连接到 Hub」，改为灰字「正在连接 Hub…」（已合入 `667c942a`） |
| F2 | Opus | `websocket.nodeTooOld` 用 mesh 节点名（`resolveNodeName` 注入 runtime）（`af5219a4`） |
| D1 | Opus | `scripts/docker-node/`：`init --no-service` 安装 + pid 看护，容器内可走正式升级器（`bec97b07`） |
| G1a | grok | 共享消息指令层 `packages/shared/src/messaging` + `apps/gateway/src/messaging`（注册表/解析/节点定位/分块/适配器），Telegram/Weixin 接入，`allow_commands` 列（0044），文档 |
| G1b | grok | relay 纯角色不起 bot；连接告警走统一通知门控（含微信）；agent 凭据告警双渠道；远端 agent 通知上下文；通知带节点名 |
| G2 | grok | Hub 密码加入支持 TOTP（`--totp`/`TMEX_TOTP`/`totpCode`）；passkey-only 退化为「待批准」；`GET /api/hub/nodes` 增 `admission_status` |
| G3 | grok | `leave → relay` 删除本机根钥对应租户；版本门在中继模式读 `peer_cache.version`，收窄空注册表豁免与 `rotate-root-keep` 旁路 |
| G4 | grok | enrollment 扇出：中继侧 `POST /api/relay/tenants/:id/enrollments`，节点侧并发扇出并返回逐台结果；pack 上传 `scope=all`；CLI redeem 跳过 404 |
| F3 | Opus | 节点表显示「待批准」行 + 「批准加入」；r3 加入串只含 accepted 中继 |
| F4 | Opus | Telegram/Weixin 设置表单「允许聊天指令」开关 |
| R1/R2 | codex sol | 后端 / 前端审查（指挥官裁决是否修） |
| LT | 指挥官 | 临时实例 + docker 演练迁移，再做现网迁移 |

## 现网迁移方案（任务 5，保留原根钥）

依据 EX4 §L6：
1. B：`tmex hub leave`（B 退回 standalone，A 保持 standby；不需要晋升 A——迁移期间不再需要写者）→ `POST /api/setup/relay {role:'relay', relayPublicUrl:'https://tmexhub-sh.jiefakj.com', relayPassword}`（纯中继，不建新用户）。
2. 本机（入口，浏览器持根钥）：设置 → 节点 → 接入中继（hub → 中继迁移）：`/api/mesh/relay/enroll` + 签 `set-relays?hub=sync` + 上传密封包。本机切到中继模式，历史密钥日志带 admit sidecar 上传，中继据此重建成员表。
3. 其他节点（A、jiefa-app、jiefa-dns-1、docker-node、B 自身）：`tmex hub leave` → `TMEX_PASSWORD=… tmex relay join https://tmexhub-sh.jiefakj.com --tenant <id> --name <原名>`（B 从纯 relay 变 relay,node；docker-node 用新镜像重建）。
4. 旧节点身份由本机浏览器吊销（revoke-node），避免中继注册表残留。
5. 全部节点升到 1.1.25（先发版；中继版本门 ≥1.1.23，密码加入需 1.1.24+）。

风险：每台节点 node id 变化；passkey 凭据随密钥日志回放保留（私钥在浏览器）；jiefa 两台只能经本机 tmex 终端或 ssh 密码访问，`leave` 后终端断开，需用 `nohup` 一次性脚本串行执行 leave+join。

## 验收

- 各包 `bun test` 0 fail（gateway/app/fe/shared/stores/ws-client/panels 与基线比较）、tsc 基线、`bun run lint` 绿；e2e 全量与 mesh 项目与基线一致。
- 临时实例演练：中继 + 三节点 + 扇出 + TOTP/passkey 待批准 + 幽灵租户 + 版本门。
- 现网终态：B `relay,node`，其余全部 `node` 挂 B 中继；本机网页能打开全部远端终端；docker 节点可从 UI 升级。
- 发版 1.1.25，本机 `tmex upgrade` 替换。
