# 第二十四轮执行结果：本机中继角色 + 接入方式双标签 + 密码加入 + 中继遗留

分支 `feat/round24-relay-local-role`（worktree `/Users/konata/code/tmex-r24`），base main `2d1428a2`（1.1.23），版本 **1.1.24**。

## 一、任务落地

| ID | 执行者 | 结论 |
|---|---|---|
| EX1/EX2/EX3 | codex luna | 三份只读实现地图（后端角色切换与遗留、前端上级链路 UI、密码加入协议），全部存档在 `sub/` |
| V1 | Opus | **生产事故真因**：1.1.23 前端要求对端宣告 `canonical-state-v1.1`（仅 1.1.23 有），门槛常量却写 1.1.22。门槛改 1.1.23；拒绝消息统一由 shared 格式化/解析（`client <ver>` / `node <nodeId> version <ver>`）；`server-too-old` 事件带 side/version/nodeId；toast 分节点/网关/网页三种文案，按 `side:nodeId:version` 去重 |
| F1 | Opus | 本机卡片「接入 Hub / 接入中继」双标签；`useLocalUplinkController` 唯一持有 hub/relay 轮询与中继动作；中继动作改可见按钮；`nodes-management.tsx` 594→275 行 |
| F2 | Opus | 角色选择器五角色（纯中继须确认）；`classifyRoleChange` 5×5 矩阵；`SetupIntent` 加 `become-relay` / `enroll-self-relay`；`BecomeRelayForm`；`PasswordFieldWithGenerate`（接入口令默认预生成） |
| G1 | grok | `POST /api/setup/relay`（relay / relay,node）；`/api/local/leave targetRole`；`clearMeshMembership` / `clearRelayOperatorState` 拆分；`/api/local/status.relay` |
| G2 | grok | `peer_cache.version`（迁移 0041）；`GET /api/mesh/relay/status` 可信本机免密 + `tmex relay list` 免密；心跳 RTT；`relay.quota.currentNodes` / `totals.nodes`；`resolveRelayDialUrl` 自拨回环；join-material 删兼容字段 |
| G3 | grok | `rename-node` 密钥日志记录（root/passkey，minVersion 1.1.24，迁移 0042）；落账 nodes/peer_cache/node_identity + NODE_EVENT；指挥官补空注册表豁免 |
| P1 | grok | 中继密码加入：`packages/shared/src/relay/relay-pack.ts` 密封包（KEK=HKDF(root_seed, tmex-relay-pack/v1, tenant_id)，AAD 绑租户/根公钥/根 epoch）；中继侧 `GET tenants/:id/kdf`、`enroll mode:'join'`、`POST tenants/:id/pack`（迁移 0043）；节点侧 `performRelayPasswordJoin`（取盐→派生→证明→解包→拉日志校验 head→自签证书→admit-node + meta-key→上传→重密封）；`POST /api/mesh/relay/pack` 转发；CLI `tmex relay join` |
| P2 | grok | Hub 密码加入：`tmex/hub-enroll/v1` 证明；`POST /api/hub/enrollments/by-password` + 限流；`/api/setup/join method=password`；`/api/setup/relay-join`；CLI `hub join --password` / `relay join` 参数与分派 |
| F3a | Opus | 加入 Hub 表单默认密码；「加入已有中继」表单与向导路径卡；租户编号可复制；接入设备引导按上级形态给密码加入步骤（加入码收进「高级」）；中继模式改名走 `rename-node` |
| F3b | Opus | 浏览器持有根种子时重密封并上传（每中继一份）：接入/重输口令/改密/根签名追加后；rotate-root 记欠账 |
| F4 | Opus | meta-key 欠账重试提到宿主级；接入区块中继文案；删 ws 死壳；spec 改名；健康探测自拨；运营者总量卡节点占用 |
| G5 | grok | P1 代码过复杂度门禁（join 流程四阶段拆分、公共路由表、pack 转发拆分）；seal 后清零明文 |
| R1 | codex sol | 后端审查 11 条：修 9（G6），不修 passkey admit sidecar（§13 已知边界）、代理 CIDR 校验（round20 既定策略） |
| G6 | grok | kick/令牌代次 TOCTOU；密码加入先远端后本地并拒绝未授权中继；每中继密封包；standby 转发 by-password；relay-join 写 env；KDF 预算；限流分桶；失败路径清零；口令最短 8 位 |
| R2 | codex sol | 前端审查 14 条：1 条已由 `join-material?scope=all` 修掉，13 条全修（F5） |
| F5 | Opus | 密封包逐台校验与 URL 级欠账；K_log 清零；admit 后刷新；setup 过渡态锁定；意图角色重挂；relay,node→relay 警告；standalone 不请求中继状态；重试武装键；口令对话框清理；校验对齐；错误码与文案；toast 去重集合 |
| LT | Opus | 多进程实测 38 条：37 过，1 个发版阻断（Hub 密码加入无人签 admit-node）+ 错误码退化 500 → G7 修复；复测见 `sub/LT-result.md` |
| G7 | grok | Hub 密码加入由加入方根钥自签 admit-node 并在重启前推到 Hub；中继密码加入错误映射稳定码 |

**指挥官亲手改动**：copy-guidelines 术语（中继=relay、Hub 不再叫中继）；`hub-authorization.ts` 空注册表豁免扩到 rename-node；`POST /api/mesh/relay/pack` 接线、域名访问放行 kdf/by-password、redeem 后 `notifyQuota`、0043 迁移用例；`join-material?scope=all`；密封包欠账提示挂载；版本号与更新日志。

## 二、测试计数终态

| 包 | 基线（1.1.23） | 本轮 |
|---|---|---|
| apps/gateway | 4141 | 4213 / 0 fail（2 条 `relay-hardening` harness 关流 `relay-rst` 未捕获拒绝，非用例失败） |
| packages/app | 798 (+1 env) | 877 / 0 fail / 1 skip |
| apps/fe (src/) | 1883 | 2058 / 0 fail |
| packages/shared | 621 | 649 |
| packages/ws-client | 392 | 398 |
| packages/stores | 411 | 415 |
| packages/api-client | 201 | 209 |
| packages/panels | 911 | 896 / 15 fail（**main 同样 896/15**，环境性既有失败，非回归） |
| ui / terminal-ui / theme | 370 / 394 / 52 | 不变 |

tsc：除既有基线（stores 1、api-client 5）全 0；`bun run lint`（biome + 复杂度门禁）全绿，未新增 allowlist。

e2e：全量 109 pass / 2 fail / 1 skip（7.5 分钟），mesh 项目 12/12。

## 三、发版

分支以 merge commit 并入 main，tag `v1.1.24` 推送 origin 触发 `release.yml` 构建 GitHub Release；本机 2026-09-04 12:33 用 `node ~/Library/Application\ Support/tmex/current/cli/bin/tmex.js upgrade --yes --lang zh-CN` 从 GitHub Release 升到 **1.1.24**：healthz 1.1.24、`current → versions/1.1.24`、迁移 44 条（0041–0043 已应用，`relay_tenants.kdf_params_json/sealed_pack`、`peer_cache.version` 在库）、tmux `tmex` 会话未动。升级后日志立即出现新格式拒绝 `canonical-state-v1.1 required: node 8a810928… version 1.1.22 < 1.1.23`（docker-node 仍是 1.1.22），需用户升级远端节点。

## 四、e2e 基线对照

对照 `e2e-baseline-failures`（round23：106/5/1）：本轮 **109/2/1**。2 个失败仍是 `viewport-policy.spec.ts:77/128`（网关 `resolveWinner` 按列数最小者持窗 vs spec 期望最大者持窗，产品取舍未决，main 同样失败）；round23 记为负载抖动的 `terminal-mouse-recovery` / `terminal-render-regressions` 本次全过。mesh 12/12（含 `TMEX_MESH_E2E_BUILD_FE=1` 重建前端）。

## 五、遗留 / 下一轮

1. **TOTP / passkey 二因子账号无法走密码加入**（自承认需要根钥登录 Hub，口令加入接口没有二因子通道）：会 `join_failed` 并回滚；要支持需给 by-password enroll 加二因子。
2. **`leave targetRole=relay` 后本机旧租户成幽灵租户**留在自己中继的注册表里（运营者可手动删除）。
3. **Hub 节点清单只有 enrolled/revoked**，看不出「未承认」状态。
4. round23 B2「enrollment 扇出到所有中继」仍未做（密码加入已成为主路径，r3 串退为高级）；多中继密封包已按每台各自封装。
5. R1-#4 passkey admit sidecar 可伪造（持租户令牌即可）仍是文档 §13 边界；R1-#7 代理 CIDR 校验维持 round20 策略。
6. `packages/panels` 在 main 上就有 15 个环境性失败，待另查（疑与依赖/bun 版本漂移有关）。
7. `packages/app/src/commands/hub.ts` 1287 行（allowlist 内）、`setup-service.ts` 589/600、`encoding.ts` 564/600 逼近门槛。
8. 远端节点（hub B、docker-node、LAN 节点）仍是 1.1.22，需用户升级到 1.1.24 才能从本机网页打开它们的终端。
