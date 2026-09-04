# 第二十七轮结果：1.1.30

## 一、交付

| 任务 | 结果 |
|---|---|
| 1 隧道「无边缘连接」 | **真实状态，非 UI 误报**：cloudflared `/ready` 503 / 0 连接，云端 `tunnel info` 无活动连接；`*.argotunnel.com:7844` 经 Surge fake-IP 走代理不通，直连边缘 IP 通。代码侧（T4）：只有 `readyConnections` 为有限 0 才判无边缘连接，降级提示补排查指引（7844 / argotunnel / cftunnel）+ 错误明细。**用户需在 Surge 加 `DOMAIN-SUFFIX,argotunnel.com,DIRECT`、`DOMAIN-SUFFIX,cftunnel.com,DIRECT`**。 |
| 2 在线仍显示 connect-failed | 真因：`RelayUplinkClient` / `UplinkClient` / `UplinkPool` diag 成功后从不清零。T1B：成功即清，路由 `online` 时三字段强制 null，新增闭集 `lastErrorCode`（分类器 `relay-link-error.ts`）；T2：只在离线时按 `relay.tenant.linkErrors.*` 显示。R4/R5 后：live 链路终止原因写回真正下线的 URL，分类器覆盖中继实际关闭原因与 WS 拨号失败原文。 |
| 3 本机卡片 | 删元数据密钥代数 / 密钥日志 / 轮换元数据密钥；三档配额实时用量（`relay.quota` 控制消息带 `usage`，5 s 变化推送；带宽按令牌桶放行计）；「经中继可见节点」→「可访问节点」；「本机编号」紧随租户编号；中继行 = 地址 pill + 单状态徽标；≥2 中继可点击切换（确认框 → `POST /api/mesh/relay/switch`，首选写 `gateway_kv`）。 |
| 4 中继管理 | 改名并移到多节点互联右侧；速率 ≤2 位小数；页头三点菜单（修改接入密码）+ 租户卡三点菜单（默认配额弹窗）；租户表在前、可选中过滤接入节点；接入节点表检索 / 七列排序（默认节点名）/ 状态筛选；「接入口令」→「接入密码」，删「令牌下限」。未引入表格库（无 antd / tanstack）。 |
| 5 接入向导 | 三路：经中继（加入 / 自建：设为中继 → 接入密码 → 接入本机中继 → 让新机器加入）、经 Hub（加入 / 自建）、SSH 直连（跳设备页并打开新建设备对话框）；一句话解释 + IconTooltip；默认路径按本机现状推导。 |
| 附带修复 | 追加中继被中继拒绝的 401（`RELAY_*`）不再把整页踢去登录页（`session-interceptor`）。 |

审查：R1（6 条，修 3，拒 1 a11y 过度、其余属后端在做）、R2（3 条全修）、R3（7 条 + 文案全修）、R4（6 条全修 + 拆文件）、R5（4 条全修）。

## 二、测试终态

gateway 4416 / app 908 / shared 692 / api-client 222 / panels 930 / ui 414 / stores 431 / fe 2400，全部 0 fail；tsc 全 0；根 lint + 复杂度门禁 ok；e2e 标准 110/1（bug2 负载抖动，基线既有）、mesh 12/12。

## 三、实测（临时打包实例，`NODE_ENV=test`）

- a（relay,node，19863）经向导设为中继并接入自身；b（纯 relay，19864）用 admin token 设密码。a 追加 b → 两行中继；点击 b 行 → 确认框 → `/switch` 200、attached 变更；重启后首选生效（先挂 b）；`RELAY_ALREADY_ATTACHED` 409 / `RELAY_UNKNOWN` 404；b 下线后 a 自动 failover 到自身，b 行显示离线 + 错误码。
- 中继管理：菜单 → 密码弹窗 / 默认配额弹窗；租户行选中过滤；检索无匹配空态；排序 `aria-sort`。
- 接入面板：三路截图正常；SSH「添加设备」跳 `/devices` 并打开对话框（类型仍需手选 SSH：`openAddDevice()` 不带参数，见 T5 报告）。
- 优雅退出：挂在外部中继时 SIGTERM 5 s 退出；中继下线态 15 s（等拨号超时）。

## 四、坑

- `loadEnv` 对 `test.env.local` 是 override：多实例并行时 b 的 `TMEX_RELAY_PUBLIC_URL` 被文件覆盖成 a 的地址 → `relayHost` 绑错 → `RELAY_BAD_PROOF`。从文件删掉 `TMEX_ROLES` / `TMEX_RELAY_PUBLIC_URL` 后正常。测完必须删文件。
- `lsof -ti :<port>` 会匹配到持有该端口客户端连接的进程，用它 kill 会误杀对端；杀监听进程用 `-sTCP:LISTEN`。
- 临时实例启用直连插件会把 `node_datachannel.node` 装进 worktree `packages/app/native/`（未跟踪），提交前删。

## 五、遗留

1. 盲中继不知道节点名，接入节点表按 `name ?? nodeId` 排序。
2. `openAddDevice()` 不能预选 SSH 类型（需改 `packages/panels` 事件签名）。
3. `uplink-pool.ts` 内部 failover wrap 的 `anyAbort()` 仍无 cleanup（R5 只要求切换路径）。
4. 现网远端节点仍是旧版本；中继实时用量与切换需两端都升到 1.1.30。
