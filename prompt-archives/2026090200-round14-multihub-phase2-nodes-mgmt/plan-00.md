# 第十四轮计划：多 hub 第二阶段 + 节点管理重做 + tunnel 健康加固

## 背景

- 分支 `feat/round14-multihub-phase2-nodes-mgmt`，worktree `../tmex-enhanced-wt-r14`，基于 main `59160db9`（v1.1.12）。上一轮档案 `prompt-archives/2026090104-round13-upgrade-multihub/`（多 hub phase 1、批量升级、推包升级、取消）。
- 用户原始需求见 `plan-prompt.md`；分工：grok-4.6 后端 / Opus 前端 / codex luna 探索（`sub/EX1–3-result.md`）/ codex sol 审查；指挥官只做契约、集成、实测与 commit。
- 追加需求（2026-09-02 进行中）：本机 Cloudflare Tunnel 断了但设置页「运行中」「检查通过」「日志为空」——根因与生产布局见记忆 `tunnel-health-diagnosis`。

## 目标与拆分

| 编号 | 内容 | 执行者 | 依赖 |
|---|---|---|---|
| T0 | 设置页「设备与文件」↔「远程访问」标签互换 | 指挥官（已提交 `981939fb`） | — |
| G0 | tunnel 后端：cloudflared `/ready` 连接器探测（`--metrics` / argv / 日志 / 20241–20245 扫描）、`degraded` 判定、外部 `--logfile` 尾读、`jobCheck` 改为 Access 拦截 ≠ 通过、30 s 轮询 | grok | 契约 `982551a9` |
| O0 | tunnel 前端：连接器行、degraded 警示、检查结论四档、外部空日志文案、host-status degraded | Opus（已提交 `51fe3e27`） | 同上 |
| G1 | 远程卸载：目标 `POST/GET /api/system/uninstall`（拷 CLI 到临时目录后 detached `tmex uninstall --yes --purge --delay-ms`）、入口 `POST /api/mesh/nodes/:id/uninstall` + `gateway_kv` 长事务记录（`operation` 随 `/api/mesh/nodes` 下发，TTL 30 min）、能力 `uninstall` | grok | 契约 `e2f8c58e` |
| O1 | 节点表多选（`@tmex/ui/checkbox` 新组件；当前节点不可选；表头单按钮全选/全不选）、「添加」右侧「更多」下拉（升级/移除节点/卸载 tmex，作用于选中行）、移除「全部升级」按钮、卸载对话框 + 卸载中/失败行态、`candidates[].lastError` 进 HubStrip tooltip、「当前节点」→「当前」 | Opus | 契约 `e2f8c58e` |
| O2 | 批量升级编排持久化：`localStorage` 计划（groups/done/summaryEmitted，TTL 2 h，版本失效，tab owner），刷新后续接未开始组、hub→本机顺序、汇总 toast 只发一次 | Opus | — |
| G2 | hub 授权改用户签名 key-log 记录 `admit-hub`/`retire-hub`（enum 末尾追加）、`user_hub_authorizations` 投影、`isAuthorizedHub` 合并规则（signed > env）、**兼容门禁**：有 <1.1.13 节点时 writer 拒绝追加（409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`，HTTP 可 force）、`HubEndpointInfo.authorization` | grok | EX2 |
| G3 | hub 远程主备切换 `POST /api/hub/role`（env + `mesh_hubs` + 过渡表 + 既有 scheduleRestart）、`GET /api/hub/role/status`、入口 404/405 → `HUB_ROLE_UNSUPPORTED` | grok | 契约 `5c8282e8`，G2 完成后（同文件） |
| O3 | 主/备徽标右侧切换按钮、「设为主 Hub」序列（未授权先签 admit-hub → 旧写者 demote → 目标 promote epoch=max+1 → 轮询过渡 → 刷新恢复）、role-switch 行态 | Opus | G2、G3 |
| G4 | enrollment token 复制到已授权 standby（hub 专用 `hub.tokens` 帧，best-effort；redeem 仍 writer-only，promote 后可兑换旧 token） | grok | G2/G3 后 |
| G5+ | EX1 项：hub 间 relay、按 RTT 选 hub、自动选主、fail-back 主动通知、TLS CA 变更事件 | grok | EX1 报告 |
| RV | codex sol 审查（backend / frontend / shared 三路） | codex | 每批之后 |

## 设计要点

- **tunnel**：`TunnelStatusResponse.connector`（`reachable` null = 找不到 metrics 端点）、`process.state='degraded'`、检查 job 结束步 `ok | access_protected | access_protected_unverified`，Access 拦截且连接器 0 连接 → `connector_down`。
- **卸载**：入口不能卸载自己；docker/手动部署返回 `UNINSTALL_NOT_ALLOWED`；卸载器必须从临时目录运行；FE 在 202 后走既有签名 revoke 清除 hub 记录；`operation` 记录在节点消失时懒清理。
- **签名授权兼容**：旧节点无法解码新记录（zorsh 序号枚举）会永久卡链，因此首条 `admit-hub` 前须全员升级；UI 提示「请先升级所有节点」。
- **主备切换**：epoch 只增不减；A 不可达时不得声称 demote 成功，靠更高 epoch 围栏；过渡状态在目标机持久化以便刷新回读。
- **并行约束**：hub/mesh 后端文件（`uplink-server.ts`、`hub-runtime.ts`、`mesh-runtime.ts`）只允许一个 grok 同时改（G2 → G3 → G4/G5 串行）；tunnel（G0）、system/uninstall（G1）与之无交集；FE 按文件划分 O1/O2，O3 等后端契约落地后启动。

## 验收

- 单测/tsc：gateway、fe、shared、app、api-client 不低于基线（gateway ≈3346、fe 1275+、shared 413、app 629、api-client 140；tsc gateway/fe/shared 0、app 1、api-client 5 既有）。
- 三实例实测（沿用 `2026090104/sub/live-r13.ts` 思路）：卸载真实临时实例并验证目录清空；主备切换 A→X 后节点在阈值内切到 X、A 被围栏；批量升级刷新后续接并只弹一条汇总。
- tunnel：本机外部 cloudflared 场景下 `connector.readyConnections` 与 `curl 127.0.0.1:20241/ready` 一致；模拟 0 连接（测试用 fake）时检查为 `connector_down`。
- 发版 1.1.13 → `tmex upgrade` 替换本机 → 节点页推包升级其余节点。

## 注意事项

- 生产 tmex（9883、`~/Library/Application Support/tmex/`）与 tmux session `tmex` 严禁触碰；tunnel 排查只读。
- 生成文件（i18n `resources.ts`/`types.ts`）只由 `bun run build:i18n` 重建。
- 结果存档：每个子任务 `sub/<id>-{prompt,result}.md`；完成后写 `plan-00-result.md`。
