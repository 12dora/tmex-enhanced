# 第十五轮执行结果：UX 六项 + 通行密钥入口 + 真实主机多 hub 实测

## 交付对照

| 需求 | 结果 |
|---|---|
| 1.1 访问控制三选一 | 契约 `TunnelAccessMode`（none/login/cloudflare，null=未选）+ 表 `tunnel_config.access_mode`（迁移 0035）+ 动作 `set_access_mode`（选「无」且隧道暴露且无保护须确认，否则 409）。前端第六步三张选项卡；「账号密码」复用直接连接路径的登录保护块（`login-protection.tsx`）；「无」给警示并对任何残留 Access 应用提供移除入口。状态卡徽标改按**真实保护**：Access 生效 → 「Access 已生效」；登录生效 → 「登录保护已启用」；否则按所选方式给诊断（cloudflare 保留原六档；login → 「登录保护未生效」；none/未选 → 「访问保护未启用」）。旧数据推导：Access 生效 → cloudflare；登录生效 → login；残留失效 Access → cloudflare；否则未选。暴露确认改为逐动作归属（`EXPOSURE_ACK` id），发出即作废、保护/运行态一变即作废，且服务端 409 一定让被拒动作显示勾选框。步骤标题/说明改为通用措辞。 |
| 1.2 公网地址对齐 | `<code>` 加 `-ml-1.5`。 |
| 2 勾选框无勾 | `dark:data-checked:bg-primary`（暗色下原被 `dark:bg-input/30` 覆盖，勾号同色不可见）。截图验证浅/暗色勾号均可见。 |
| 3.1 Bell/Watch | zh：终端响铃 / 终端监控（推送终端响铃、终端响铃时播放提示音、响铃通知频控（秒）、终端监控触发…）；en：Terminal Bell 保留、Watch 事件改 Terminal Monitor；ja 同步。 |
| 3.2 webhook emoji | 三语 14 个 `notification.eventType.*` 去前导 emoji；顺带修掉 Telegram/企微通用消息里的双 emoji。 |
| 4 编辑目录弹窗 | 移除 `FileRootEnabledField`，行内开关为唯一入口；表单仍带 `enabled`（新建 true、编辑沿用）。 |
| 5 登录页通行密钥 | 链路本已存在，按钮原被 `passkeysForThisOrigin` 藏住。现：HTTPS/localhost 且浏览器支持即显示；未注册时点击内联提示「此地址尚未注册通行密钥，登录后可在「设置 → 账号安全」添加」；不安全上下文显示一行说明。整个流程（仪式 + 收尾）在同一 try/catch。 |
| 6 iOS PWA 落地 | `StandaloneLanding`：standalone + 移动端 + 启动路径 `/` 时一次性打开侧栏抽屉（panes）；深链启动后再导航到 `/` 不弹。 |
| 7 多 hub 实测 | 见下。 |
| 追加：切换收敛慢 | 用户问「为何节点切换要 80 s」：慢的是旧主 A 自身（先降 A 后升 B 时 A 挂到自己，靠 60 s hub 间轮询才发现 B 已是主，日志 55 s）。已做 G2：standby 挂自己/无已知主时 3 s 快速轮询（≤3 min 后回落 60 s）、角色过渡完成即轮询、学到不低于本机/当前 epoch 的 active 即触发 uplink 重评（2 s 去抖）、附着变化即刷新节奏；`/api/hub/status` 增 `peerPollFast`。 |

## 实测（任务 7，真实主机）

- 拓扑：A = 生产 hub `ai.jiefakj.com:18443`（1.1.13）；B = 122.51.254.148 `tmexhub-sh.jiefakj.com`（宝塔 LXD 容器 nginx 反代 → 宿主 tmex 0.0.0.0:9883，LE 证书由面板 acme 签发并纳入面板续签 cron，`TMEX_TRUST_PROXY=true`）；节点 konata-mac / docker-node / jiefa-app / jiefa-dns-1 均 1.1.13。
- 步骤与结果（`sub/live-r15.ts`）：install.sh 装 node → A `enroll`（`TMEX_PASSWORD`）→ B `hub join` → B `hub standby --public-url https://tmexhub-sh.jiefakj.com --priority 200` → **ADMIT**：A 上 root 签名 `admit-hub`（key-log seq 8，`hubAck:true`），A/B/M 均列 B 为 `signed` standby；B 库已复制 `mesh_hubs`/`user_hub_authorizations`/`nodes`/key-log。**FORWARD**：经 B 建加入码 201 `X-Tmex-Forwarded-By=B`，token 已复制到 B 库（响应 `replicatedTo` 仍为空——round14 遗留的 ACK 时序问题）。**ROLE** ×3（A→备 B→主 epoch 2；回滚 B→备 A→主 epoch 3；再 A→备 B→主 epoch 4）：过渡均 `complete`，普通节点秒级重挂；首轮 A 自身 55 s 后才切到 B（即 G2 要解决的问题），后两轮 13 s 内收敛。
- 终态：**B 主（epoch 4）、A 备**，六节点全部挂在 B；本机 M 对 B 的 RTT 约 62 ms，对 A 的 healthz 探测在本机网络下超时（RTT 为空）。海外测试机 2 未开通，基于延迟的优选待其就绪后再测。
- 浏览器入口不随主备切换自动跳转（设计如此）：用户仍用当前地址访问。

## 审查裁决

- RV1 后端 3 条全部采纳（runningEnabled 计入暴露、守卫分支测试、`emptyAccessStatus()` 工厂）；RV1 前端 5 条全部采纳（徽标按真实保护、旧数据推导、确认逐动作、登录页整流程 catch、启动路径判定）。
- RV2 前端 2 条采纳（409 强制显示勾选框、`tunnelExposed` 对齐网关）。
- RV3（G2）5 条：采纳 1–4（低 epoch active 不触发、轮询完成后再排下一次、附着变化刷新节奏、更早 deadline 替换去抖）；第 5 条（大规模 hub 的 O(N²) 状态请求）只加小抖动，写入已知限制。

## QA 截图

`scratchpad/qa/*.png`（临时 dev 实例）：登录页通行密钥按钮与未注册提示、节点勾选框浅/暗色、访问控制三选一、通知文案与无 emoji 的 webhook 事件、编辑目录弹窗无启用开关、PWA 冷启动侧栏展开/深链不弹。QA 顺带发现两个临时实例的坑（已记入记忆）：新库种子设备的 tmux session 名写死为 `tmex`；单独起 `apps/fe` dev 会回落到生产端口 9883。

## 门禁与发版

（终态数字与发版记录见文末追加。）
