# 第二十七轮计划：中继管理 / 本机卡片 / 接入向导重写（2026-09-05）

## 背景
接手 1.1.29（round26）。分支 `feat/round27-relay-mgmt-onboarding`，worktree `/Users/konata/code/tmex-r27`。用户提出 5 组反馈（见 plan-prompt.md）。分工：grok 4.6 后端、Opus 子代理前端、codex luna 探索（EX1–EX5，见 sub/）、codex sol 审查。

## 关键结论（探索 + 只读排查）
1. **隧道「无边缘连接」是真实状态，不是 UI 误报**：cloudflared `/ready` 503 `readyConnections:0`，云端 `tunnel info` 无活动连接；`nc *.argotunnel.com:7844` 失败但直连边缘 IP 成功，域名解析到 198.18.x（Surge fake-IP）→ Surge 把 argotunnel 走了代理策略，7844 不通。**需用户在 Surge 加 `DOMAIN-SUFFIX,argotunnel.com,DIRECT` / `cftunnel.com,DIRECT`**。代码侧只把提示做得可操作（T4）。
2. 「最近错误 connect-failed」：节点侧 `RelayUplinkClient.lastConnectError` / `UplinkPool` diag 成功后从不清零；UI 直接插值原始字符串（T1B + T2）。
3. 配额：只有 `maxNodes` 有 `currentNodes`；并发流 / 带宽只有上限；中继侧有实时计数但未下发（T1B 扩展 `relay.quota` 控制消息 + `/api/relay/metrics` 有效配额与用量）。
4. 多中继切换：内部 `UplinkPool.switchTo` 存在，无 HTTP 路由（T1B 新增 `POST /api/mesh/relay/switch` + 首选持久化）。
5. 中继 tab：无表格库；成员表固定排序；`name` 恒 null（盲中继不知道节点名，按 `name ?? nodeId` 排）。
6. 接入面板：目前只有「加入 / 设为 Hub」两支，无中继自建、无 SSH 直连。

## 任务拆分
| 任务 | 执行者 | 范围 |
|---|---|---|
| T1B 后端：错误清零 + `lastErrorCode` 分类、`relay.quota` usage 推送、metrics 有效配额+用量+带宽消耗、`/switch` 路由 | grok | apps/gateway mesh+relay、shared codec、api-client 类型 |
| T2 本机卡片：错误仅离线显示且 i18n、删元数据密钥/密钥日志/轮换、三配额实时、文案、行重构 + 切换中继确认 | Opus | apps/fe settings/nodes（除 management/setup/https） |
| T3 中继管理 tab：改名移位、速率 2 位小数、三点菜单（接入密码 / 默认配额弹窗）、租户表在前可选中、接入节点表搜索/排序/筛选 | Opus | apps/fe settings/relay、SettingsPage |
| T4 远程访问：无边缘连接的可操作提示 | Opus | remote-access |
| T5 接入面板：经中继（加入/自建）/ 经 Hub（加入/自建）/ SSH 直连 三路 + 简明解释 | Opus | side-panels/connect-devices |
| 指挥官 | Claude | api-client 类型桩（已加）、i18n 生成、分批 commit、审查裁决、实测、发版替换本机 |

## 验收
- 各包 `bun test` 0 fail、tsc 0、根 lint + 复杂度门禁通过；e2e 标准套件与 mesh 套件不退化。
- 临时打包实例实测：本机卡片行/切换弹窗、连接详情三配额、中继管理表格交互、接入面板三路。
- 发版 1.1.30，`tmex upgrade` 替换本机。

## 注意事项
- 生产 tmex / tmux `tmex` 会话红线；临时实例必须 `TMEX_TMUX_SOCKET`、`TMEX_PEER_PORT`、独立端口；setup 会写 `test.env.local`，测完删。
- 前端并行编辑同一 locale JSON，按子对象隔离，指挥官统一 `bun run build:i18n`。
