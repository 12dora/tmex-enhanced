# 第二十四轮计划：本机中继角色 + 接入方式双标签 + 密码加入 + 中继遗留

## 背景

- 分支 `feat/round24-relay-local-role`，worktree `/Users/konata/code/tmex-r24`，base main `2d1428a2`（1.1.23）。目标版本 **1.1.24**。
- 上一轮（`prompt-archives/2026090304-round23-relay-legacy-removal/`）落地了公共中继角色，遗留清单在其 `plan-00-result.md` §五。
- 生产事故（2026-09-04 上午）：本机升到 1.1.23 后打开远端 1.1.22 节点终端持续弹「Gateway 版本过低，请升级到 1.1.22」。真因：1.1.23 前端要求对端宣告 `canonical-state-v1.1` 能力（仅 1.1.23 才有），门槛常量却写 1.1.22，文案也不说是哪个节点。
- 用户本轮三项原始要求 + 讨论中追加：（1）中继遗留；（2）本机角色选择器加 `relay` / `relay,node`；（3）Hub / 中继接入方式挪到本机卡片做两个标签页；（4）**「租户编号 + 密码」加入中继、「Hub 地址 + 密码」加入 Hub**（密封包方案，见 plan-prompt.md 第三条记录）；（5）接入设备侧滑面板引导同步更新；（6）口令输入框右侧加「生成」按钮，中继接入口令默认预生成。
- 分工：codex luna 探索（EX1 后端、EX2 前端、EX3 密码加入）；Opus 子代理前端；cursor grok 4.6 后端；codex sol 审查；指挥官分批 commit、实测、发版、替换本机。

## 任务清单

| ID | 执行者 | 内容 | 依赖 |
|---|---|---|---|
| EX1/EX2/EX3 | codex luna | 只读探索报告 | — |
| V1 | Opus | 门槛常量 → 1.1.23；`server-too-old` 事件带 side/version/nodeId；toast 分节点/网关/网页三种文案；文档与 changelog | — |
| F1 | Opus | 本机卡片「接入 Hub / 接入中继」双标签；relay 动作改可见按钮；`useLocalUplinkController` 统一 owner；节点管理只留节点表 + enrollment（≤500 行） | EX2 |
| G1 | grok | `POST /api/setup/relay`（relay / relay,node，写 env、口令哈希、relay,node 引导用户）；`/api/local/leave` 加 `targetRole`；`clearAll` 拆分；`/api/local/status.relay`；api-client | EX1 |
| G2 | grok | peer_cache.version（迁移 0041）；`GET /api/mesh/relay/status` 本机免密 + CLI list 免密；RTT + currentNodes；自拨回环 `resolveRelayDialUrl`；join-material 兼容字段删除 | EX1 |
| G3 | grok | `rename-node` 密钥日志记录（shared + gateway + 迁移 0042） | EX1 |
| P1 | grok | 中继侧密封包：`relay_tenants` 加 kdf_params/sealed_pack；`GET /api/relay/tenants/:id/kdf`、`POST …/pack`、`POST /api/relay/enroll` `mode:'join'` 不换令牌；节点侧 `POST /api/mesh/relay/join-by-password` 全流程（取盐→派生根钥→证明→解包→拉日志重放→自签证书→admit-node→meta-key→set-relays）；写入方在 append 后刷新密封包；根轮换后重密封 | EX3 |
| P2 | grok | Hub 侧 `POST /api/hub/enrollments/by-password`（根签名证明换加入码）+ 限速；节点侧 `/api/setup/join` 接受 `{hubUrl, password}`；CLI `tmex hub join --password`、`tmex relay join <url> --tenant <id>` | EX3 |
| F2 | Opus | 角色选择器五角色；`classifyRoleChange` 五×五矩阵；`BecomeRelayForm`（公网地址、接入口令默认生成、兼节点开关、账号）；`PasswordFieldWithGenerate`；leave 对话框文案；`SetupIntent` 新路径；relay,node 重启后引导接入本机中继 | F1、G1 |
| F3 | Opus | 密码加入表单：standalone 的 Hub 标签「用密码加入 Hub」、中继标签「用租户编号 + 密码加入」；已接入机器显示可复制租户编号；接入设备侧滑面板引导改为密码加入；relay 模式改名走 `rename-node` | F1/F2、P1/P2、G3 |
| F4 | Opus | 遗留清理：meta-key 重试提到宿主级；ws/index 两个转发壳；spec 改名；两处过时注释；`hubNotConfirmed`/`missingHubUrl` 中继文案 | F1 |
| R* | codex sol | 后端 / 前端 / shared 三路审查，指挥官裁定修复 | 各批 |
| LT | 指挥官 | 四进程实测（relay / relay,node / node×2）+ 密码加入实测 + e2e | 全部 |
| REL | 指挥官 | 1.1.24 发版、GitHub Release、本机 `tmex upgrade` | LT |

## 注意事项

- B2「enrollment 扇出到所有中继」：需要新 join 串格式（逐条 CA 指纹）且与密码加入重叠，本轮列为后备（G4），优先级最低。
- 纯 `relay` 角色没有网页；前端切到纯 relay 前必须明确警告「网页将不可用，只能用 `tmex relay` 命令管理」。
- 迁移编号：G2 用 0041，G3 用 0042，P1 用 0043；注册表 `managed-migrations.ts` 由各自追加，指挥官合并时核对顺序。
- `apps/gateway/src/mesh/relay-routes.ts` 唯一 owner 为 G2；P1 的节点侧路由写在新文件里，注册行由指挥官接线。
- 复杂度门禁 600 行：`setup-service.ts` 746、`assemble-routes.ts` 598、`relay-uplink-client.ts` 597、`nodes-management.tsx` 594 都在门口，任务书已要求先拆再加。

## 验收标准

- 各包单测不低于基线且全绿；`bun run lint` 全绿无 allowlist 新增；tsc 不高于基线。
- e2e 全量与 mesh 项目对照 `e2e-baseline-failures` 无新增失败。
- 实测：本机网页在本机卡片切换为 `relay,node` → 重启 → 接入本机中继；第二台临时实例用「租户编号 + 密码」加入并看到对方终端；Hub 模式用「Hub 地址 + 密码」加入。
- 发版后本机升级到 1.1.24，远端 1.1.22 节点的提示改为「节点 X 版本 1.1.22 过低，请升级到 1.1.23」。
