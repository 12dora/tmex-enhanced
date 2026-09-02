# 第十五轮计划：UX 六项 + 通行密钥入口 + 真实主机多 hub 实测（主备互换）

## 背景

基于 v1.1.13（`main` @ `9aff9f2e`）。分支 `feat/round15-ux-passkey-hub-live`，worktree `/Users/konata/code/tmex-enhanced-r15`。分工：grok-4.6 后端、Opus 前端、codex luna 探索（EX1–3）、codex sol 审查（RV1）。指挥官亲自做真实主机实测。

## 代码任务与设计

| # | 需求 | 设计 |
|---|---|---|
| 1.1 | 远程访问第六步「访问控制」三选一：无 / 账号密码 / Access | 共享契约 `TunnelAccessMode = 'none' \| 'login' \| 'cloudflare'`，`config.accessMode`（null = 旧数据未选）；动作 `set_access_mode`（选「无」且隧道在跑且无保护须 `acknowledgeExposure`）；后端只记录选择，`exposureProtected` 仍按真实状态；前端 `effectiveAccessMode` 推导旧数据（Access 生效 → cloudflare；登录生效 → login；有失效 Access 应用 → cloudflare；否则未选）。状态卡徽标按**真实保护**显示（Access 生效 / 登录保护已启用 / 该模式对应的诊断 / 访问保护未启用），不再对未用 Access 的用户显示「Access 无法检测」。 |
| 1.2 | 公网地址 pill 与上下行文字对齐 | `<code>` 加 `-ml-1.5`。 |
| 2 | 节点管理勾选框只高亮无勾 | `packages/ui` Checkbox 缺 `dark:data-checked:bg-primary`，暗色下 `dark:bg-input/30` 盖掉底色、勾号同色不可见；补上。 |
| 3.1 | Bell/Watch 文案 | Bell → 「终端响铃」，Watch → 「终端监控」（zh/ja；en 保持 Terminal Bell，Watch → Terminal Monitor）。 |
| 3.2 | webhook 字段 emoji | 三语 `notification.eventType.*` 去前导 emoji；Telegram/企微的 `EVENT_EMOJI` 不动（顺带修掉双 emoji）。 |
| 4 | 编辑目录弹窗去掉启用开关 | 移除 `FileRootEnabledField`；表单仍保留 `enabled` 值（新建默认 true、编辑沿用）。 |
| 5 | 登录页通行密钥 | 登录链路本已存在，只是按钮被 `passkeysForThisOrigin` 藏住。改为 HTTPS/localhost 且浏览器支持即显示；未注册时点击提示去「设置 → 账号安全」添加；不安全上下文显示一行说明。 |
| 6 | iOS PWA 默认进设备页 | `StandaloneLanding`：standalone 显示模式 + 移动端 + 启动路径为 `/` 时，一次性打开侧栏抽屉（panes tab）。 |

## 实测（任务 7）

- B = 122.51.254.148（ssh 别名 `shanghai`，ubuntu/sudo），域名 `tmexhub-sh.jiefakj.com`（DNSPod A 记录）。80/443 被 LXD 容器 `web`（宝塔 aaPanel + nginx，proxy_protocol）占用，tmex 走宿主 `0.0.0.0:9883`，由宝塔站点反代（`http://10.108.57.1:9883`），Let's Encrypt 证书由面板 acme 签发并纳入面板续签 cron；`TMEX_TRUST_PROXY=true`。
- 步骤：install.sh 装 node → A `enroll` → B `hub join` → B `hub standby --public-url https://tmexhub-sh.jiefakj.com --priority 200` → A 上 root 签名 `admit-hub`（`sub/live-r15.ts ADMIT`）→ 校验 A/B 的 `mesh_hubs` / `user_hub_authorizations` / key-log → `ROLE`（A 降备、B 升主，epoch 服务端分配）→ 观察各节点 writer/attached/RTT → 最终态：B 主、A 备。
- 海外测试机 2 用户尚未开通；基于延迟的优选先用现有 A/B 两 hub 观察节点侧 RTT 挂载。

## 验收

- 各包 `bun test` 不低于基线（gateway 3507 / fe 1434 / shared 430 / panels 747 / ui 54 / api-client 140 / stores 419），tsc 0（gateway/fe/shared/panels/ui），`bun run lint` 通过。
- codex 审查项逐条裁决并修复。
- 发版 1.1.14 并替换本机生产；A/B 升级到 1.1.14。

## 注意事项

- 凭据只放 scratchpad 的 `creds.env` / `assh`，不进档案。
- 严禁触碰本机生产文件与 `tmex` tmux session；本机节点只做只读观察。
- A 是生产 hub，角色切换会让所有节点重连一次（实测约秒级）。
