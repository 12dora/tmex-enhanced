# 第十九轮执行结果

分支 `feat/round19-settings-mesh-ux`（worktree `/Users/konata/code/tmex-r19`），基于 1.1.18，发版 1.1.19。

## 交付

| 任务 | 结果 |
|---|---|
| 1 设置-通用联动 | `GET /api/settings/site` 增 `effectiveSiteUrl/siteUrlEditable/siteNameLinkedToNode/nodeId`；mesh 下 `siteUrl` 即有效地址（hub 自身根地址；备 hub 与纯节点为 `<hub>/n/<self>`），PATCH 改 `siteUrl/siteName` 分别 400 `site_url_managed/site_name_managed`；改名走 hub rename，hub `handleRename` 命中自身与节点收到 `node.list` 时同步本地站点名。前端名称字段标注联动、访问地址只读、仅提交变更项。 |
| 2 接入设备 Application Error | 真因：`SidePanelHost` 裸 `React.lazy` + 无 `errorElement`，chunk 加载失败/渲染异常落到 React Router 默认页。新增 `AppErrorBoundary`（页面/面板两形态、重试用 revalidate、重新加载、返回首页、复制详情）、路由 `errorElement`、面板走 `lazyChunk` 重试。 |
| 3.1 三处地址 | 本机盒子改为「本机地址」（hub 角色的公开地址）与「当前 Hub」（实际挂靠 + 更换 Hub 按钮；未挂靠显示未连接；加入地址仅在不同时作为次行）。 |
| 3.2 直连 pill | 单状态 pill（不支持/未安装/已安装 vX），「启用」开关移到同一行。 |
| 3.3 HTTPS 设置 | 标题「HTTPS 设置」，状态三行（对外访问/配置模式/内置监听器），文案统一；ACME dns-01 提供商抽象（Cloudflare/DNSPod，`tls_config.acme_dns_provider/acme_dns_secret_enc`，迁移 0037，旧 cf token 读回退）。 |
| 3.4 允许域名访问 | `node_access_policy`（迁移 0038，默认允许），守卫在 `assemble.ts createHttpDispatch`；关闭后 `via=self`、非服务路径、**客户端源地址非内网/本机/CGNAT** 的请求 403（Host 不参与判定，防伪造），服务白名单 `/hub/uplink`、`/healthz`、ACME、enroll redeem/status、`/api/hub/status`；`GET/PATCH /api/system/domain-access`（peer 入站可达，hub 端经 `/n/<id>` 读写远端）；`/api/local/status.domainAccess`。本机盒子「通用设置」行 + 关闭确认（viaDomain 强警告）。 |
| 3.5 hub pill | 去掉「写入」，写入信息进 tooltip。 |
| 3.6 节点管理 | 行按钮 升级/更多/移除；节点详情弹窗（名称、允许域名访问、只读信息），dirty 比较，仅提交变化项，部分成功推进 baseline。 |
| 3.7 二维码 | 移动 tab：选择地址（健康隧道 → hub → 局域网 → 当前）→ 扫码（`QRCodeSVG`）→ 添加主屏 → 启动。 |
| 3.8 延迟 | 徽标 = 浏览器↔入口节点 WS 心跳 RTT，tooltip 说明；心跳 nonce 关联、单在途探测、`performance.now`、5 样本中位数（raw 保留）；网关 PONG 走优先发送（DataChannel 有界优先队列），`[ws-metrics] ping` 聚合。 |
| 追加 1 known-issues | KI-2 集成测试落地；改密无反馈真因是登录仪式的 401（PASSKEY_REQUIRED）触发全局登出跳转 + 替换窗口内会话为 null，已修（拦截器豁免仪式路径、替换窗口对外仍已登录、跳转延后判定）；KI-3 三组 e2e 修竞态并复跑通过。 |
| 追加 2 直连探测 | `PeerEndpointBackoff`（1min→6h、仅传输失败、广播集/本机网络变化清零）、LAN 候选 4s 预算、全局并发 4、广播端过滤容器网卡/ULA/CGNAT、同 canonical 地址去重。 |
| 追加 3 WebRTC 熔断 | 3 次触发、30s→30min 指数冷却、健康 60s 才重置、通道打开后异常关闭/liveness 超时也计数、冷却期只探测一次；浏览器侧同策略 + `retryDirect()`；`MeshNode.dcBreaker`（REST）。 |

## 审查

codex sol 三路：R1 前端 10 条（修 8：远端改名旧名覆盖、writer hub、部分成功重提、当前 Hub 行、二维码默认地址、路由重试、无域名禁关、forwarder 信封；2 条已由后续提交解决/待 e2e 验证）；R2 后端 3 条全修（Host 伪造绕过 → 按源地址判定；存量域名入集合；备 hub 有效 URL）；R3 mesh/ws 3 条全修（PONG 在 DataChannel 背压下丢弃、浏览器重试预算不复位、重复候选放大退避）。

## 验证

- 单测：gateway 3744（2 个负载敏感 flake 隔离通过）、fe 1721、app 687/1（cpu-features 已知）、shared 442、api-client 155、stores 420、panels 747、ws-client 319；tsc 仅既有 3 处。
- e2e：mesh 项目 `mesh-passkey.spec.ts` 7/7（含此前 fixme 的改密用例）；KI-3 三组 spec 定向复跑全部通过。
- `bun run build`、`test:tmex` 684 通过。

## 上线

- tag `v1.1.19`（发版提交 `581c334b`），GitHub Actions Release 成功（`tmex-cli-1.1.19.tgz` + `SHA256SUMS`）；main 已 fast-forward 并 push。
- 本机生产 `tmex upgrade --version 1.1.19` 成功，`/healthz` 版本 1.1.19。
- 其余节点待批量升级；**hub B 切内置 LE（DNSPod dns-01 + 9443）与拆面板站点**待用户提供 DNSPod ID/Token 并确认后执行（方案见 plan-00）。

## 遗留

- 域名访问关闭后已建立的 WS 不会被踢（新握手被拒）。
- `forceProbe`/`forceDcProbe` 仅 gateway 内部方法，无 HTTP/UI；`dcBreaker` 状态未进 NODE_EVENT，也未在节点徽标展示。
- 反向代理部署必须开启信任代理头，否则域名访问策略按代理自身 IP 判定。
- 有效访问 URL 的解析顺序与 `auth-routes.ts` 私有 `resolveHub` 略有不同（前者多一步 attached 回退），未统一。
