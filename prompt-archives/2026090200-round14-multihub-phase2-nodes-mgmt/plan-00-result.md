# 第十四轮执行结果：多 hub 二阶段 + 节点管理重做 + tunnel 连接器健康（v1.1.13）

## 交付对照

| 需求 | 结果 |
|---|---|
| 1.1 hub 间 relay / 按 RTT 选 hub / 自动选主 | 附着路由表 + `hub.attachments`（分页、保活）/`hub.forward`/`hub-relay` 流（hop≤2、资源边界）；节点按 RTT 挂最近 hub（EWMA+30%/15ms 滞回+10min 驻留，hub 角色与旧版 hub 除外，浏览器仍走当前入口）；自动选主 opt-in（`TMEX_HUB_AUTO_PROMOTE`，(writer,epoch) 计票、本地时钟新鲜度、2-hub 免 quorum 长超时） |
| 1.2 hub 授权走用户签名 | `admit-hub`/`retire-hub` key-log 记录 + `user_hub_authorizations` 投影；合并规则 signed>env、retired 压过 seed/env 并即时围栏；兼容门禁 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`（<1.1.13 在网时拒绝，force 头端到端）；UI 授权来源徽标（signed/env/self/none） |
| 1.3 standby 复制 enrollment token | `hub.tokens` 帧 best-effort 复制（writer-only 发送、按用户、剥 entry_sid、≤48KiB 分页、幂等 revision）；redeem 仍 writer-only，promote 后可兑换旧 token（live 实测 PASS）；另有 standby 写转发：writer 可达时 enroll/redeem/rename/revoke/keylog 经认证 uplink `hub.write-forward` 转发（剥凭据、writer/epoch 围栏、分片 ACK、幂等缓存） |
| 1.4 fail-back 主动通知 | writer 恢复→standby 重连即广播 node.list→节点 `dispatchNodeList` 检测 hub 状态变化立即探测（5s 去抖），60s 定时器仅兜底；实测切回 ~4s |
| 1.5 TLS CA 轮换事件 | listener 成功 apply 后单次回调→立即更新自指纹并重广告；启动期 listener 未就绪不广告；10min 轮询仅兜底 |
| 1.6 批量升级刷新续接 | localStorage 计划（组序/done/summaryEmitted，TTL 2h，tab owner+storage 事件），刷新续接未开始组、hub→本机顺序保持、汇总只弹一次；「升级」菜单项自动含本机 |
| 1.7 candidates.lastError 进 UI | HubStrip chip 警示图标 + title（最近尝试/最近错误/RTT 序列化） |
| 2 tab 互换 | 「设备与文件」↔「远程访问」已互换 |
| 3.1 多选 | 首列 Checkbox（本机禁用）、表头单按钮全选/全不选、`@tmex/ui/checkbox` 新组件 |
| 3.2 「更多」菜单 | 「添加」右侧下拉：升级（含本机）/移除节点/卸载 tmex；「全部升级」按钮已移除 |
| 3.3 远程卸载 | 目标 `POST /api/system/uninstall`（拷 CLI 到临时目录 detached `--yes --purge --delay-ms`，容器/手动部署 409、会话鉴权+审计）+ 入口中继与 `gateway_kv` 长事务 + FE 批量卸载→签名 revoke |
| 3.4 主备切换 | HubTag 旁切换按钮：必要时签 admit-hub（旧节点 409 可强制）→ 降原主 → 升目标（epoch 服务端分配）→ 跨重启轮询过渡；失败/未确认强制恢复框（重试/回滚） |
| 3.5 刷新 preserve | 升级（GET 回读+批量计划）、卸载（operation 随节点列表）、切换（sessionStorage 四档续跑+服务端过渡表）均刷新可恢复 |
| 追加：tunnel 误报 | 连接器 `/ready` 探测（多端口归属校验）、`degraded` 态、外部 `--logfile` 尾读（强脱敏）、检查连通性三档（Access 拦截≠通过）；对本机真实外部 cloudflared 实测通过 |

## 审查

RV1（10 条）/RV2（10 条）/RV3（13 条）三轮 codex sol：采纳 27 条并全部修复（G0b/O1b/G4b/O3b/G7/O3c）；驳回 6 条已写入文档 known limitations（节点会话=目标机完全控制、admit 即授围栏权、localStorage TOCTOU、2-hub 自动选主脑裂等）。

## 实测

`sub/live-r14.ts`（production 模式 A/B/C/D/E 临时实例、纯 HTTP、约 90s）六部分：ADMIT（签名授权、无 env）/ ROLE（API 降升、epoch 服务端分配 2→3、C 2s 切换、A 重启保持围栏）/ RELAY（C@A↔D@B 双向 `/n/<id>/api` 200、attachedHubId 投影）/ TOKENS（token 复制→杀 A→promote B→E 凭旧码加入）/ FORWARD（经 standby 建码 201 + `X-Tmex-Forwarded-By`）/ UNINSTALL（无服务管理器 409 守卫、无残留 operation）——全 PASS（首跑 ROLE 因 G8 并行满载超时，隔离与静载复跑均过）。tunnel 连接器另以临时实例对生产外部 cloudflared 只读实测通过。

## 门禁（终态见下方数字）

复杂度门禁从 main 遗留 42 → 本轮峰值 73 → **exit 0**（4 处拆分 + allowlist 151 条 tighten）。

最终数字（2026-09-02）：gateway **3508** / fe **1434** / shared **430** / app **644**(src) / api-client **140** / ui **54**，全 0 fail；tsc：gateway/fe/shared/ui 0、app 1（既有 `@types/node`）、api-client 5（既有）；`bun run lint`（biome + 复杂度门禁）通过。

## 发版

- `bun scripts/release.ts 1.1.13` → 双语 CHANGELOG 人话改写 → `bun run build` → `npm pack` 烟测（临时实例 healthz/首页 200）→ `chore(release): 1.1.13`（`10496e69`）→ 合并 main（`eebc3afb`）→ tag `v1.1.13` push，Release CI 成功（资产 `tmex-cli-1.1.13.tgz` 22.4 MB + SHA256SUMS）。
- 本机生产 `tmex upgrade` 1.1.12 → **1.1.13**（committed，healthz/install-meta/日志验证）；docker-node 容器手动 `docker cp` + 覆盖 + 重启 → **1.1.13**。
- hub `tmex`、jiefa-app、jiefa-dns-1 待用户在节点页「全选 → 更多 → 升级」推包（需登录会话，指挥官无凭据）。
- 注意：`gh` 默认仓库指向上游 `krhougs/tmex`，查 fork 的 run/release 必须 `-R 12dora/tmex-enhanced`（本轮等待器曾因此空转）。
