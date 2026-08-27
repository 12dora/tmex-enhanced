# 设计检查 01：node 被攻破的横向影响 / 节点可见性

针对 `docs/hub/2026082700-hub-node-architecture.md`（详细设计 v1）。

## 1. 威胁模型：某台 node（非 hub）被取得 root，攻击者未登录 tmex

攻击者在该机上能拿到的东西（`TMEX_MASTER_KEY` 与被它加密的数据在同一台机器，等价于明文）：

| 资产 | 位置 | 能做什么 |
|---|---|---|
| node 私钥 | `node_identity.private_key` | 以该 node 身份连 uplink |
| hub 公钥、hub URL | `node_identity` | 验签用，无攻击价值 |
| **auth bundle**：`users[].password_hash`、`users[].totp_secret`、`revoked_sids`、STUN/TURN 凭证 | `auth_cache` | 见下 |
| 发给该 node 的 `rtc-ticket`、`x-tmex-uid` | 运行时 | 只对该 node 有效 |

### 设计已挡住的路径（无需改）

- hub 会话 cookie / Authorization 被 hub 过滤，不到 node；node 拿不到 `hub-session`。
- `node-session` 只有该 node 自己接受；`rtc-ticket` 绑 `aud=node:<id>`；hub 只认自己签的 `hub-session`。node 私钥无法伪造任何对 hub 或其他 node 有效的令牌。
- uplink 是"hub 开流 → node 处理"的单向模型，node 无法向 hub 请求打开到其他 node 的流；没有 node→node 的通道。
- 被攻破后 hub 侧 `revoke` 即断开且拒绝重连。

### 未挡住的路径（需改设计）

**H1（高）auth bundle 把 TOTP 密钥和密码哈希下发到每台 node，第二因素形同虚设。**
攻击链：取 `auth_cache` → `totp_secret` 直接明文可用 → 对 `password_hash` 离线爆破（argon2id 拖慢但不阻止弱口令）→ 用密码 + TOTP 登录公网 hub → 控制 hub 与全部 node（含 hub 机自身的 tmux）。设计 §5"安全边界"只提到"单用户可接受"，低估了 TOTP 失效这一点。
建议：
- **不下发 `totp_secret`**。node 本地离线登录只校验密码（本地 UI 默认绑定 127.0.0.1，可接受较低保证），文档明确标注。
- 或者更彻底：node 本地登录用独立的"本地口令"（`tmex-cli hub join` 时或 Nodes 页为该 node 设置，hub 只下发该口令的哈希），hub 主密码哈希不离开 hub。推荐后者——被攻破一台机器时，主账号不受影响。
- 无论选哪种：`hub user passwd` 时提示"若有 node 曾失陷需改密"；argon2id 参数取高成本（memory ≥ 64 MiB）。

**H2（高）node 返回的响应在 hub origin 下渲染，可导致同源 XSS。**
`/n/:nodeId/api/files/*` 的媒体 `src` / 下载 `href` 由浏览器直接导航或加载，响应体与 `Content-Type` 完全由 node 决定。失陷 node 返回 `text/html` + 脚本，用户点开即在 **hub origin** 执行：cookie 虽 HttpOnly 读不到，但同源 `fetch` 自动带 cookie，可调用 `/api/hub/nodes/*/rtc-ticket`、`/n/<其他 node>/api/*`、`/n/<hub 本机 node>/ws`，即操作所有机器。这是"一台失陷 → 全部失陷"的最短路径。
建议（hub 侧转发响应时强制）：
- 对 `/n/:id/*` 所有响应加 `Content-Security-Policy: sandbox`、`X-Content-Type-Options: nosniff`；文件下载类路径强制 `Content-Disposition: attachment`。
- hub 覆盖/删除 node 响应里的 `Set-Cookie`、`Location`（或限制为相对路径）、`Content-Security-Policy`、`Access-Control-*`。
- 需要内联预览（图片/视频）的媒体路径单独白名单 `Content-Type`（image/*、video/*、audio/*、text/plain），其余一律 attachment。
- 长期方案：每 node 独立子域 origin（`<nodeId>.hub.example`），但与 Cloudflare Tunnel 单域名部署冲突，v1 不采用。

**M1（中）`rtc.signal`（node → 浏览器方向）未绑定 node。**
§3 `ctl` 定义 `rtc.signal {rtcSession, from:'node', sdp|candidate}`，hub 转发给浏览器；未规定 hub 校验 `rtcSession` 确属"该浏览器会话 ↔ 该 node"。失陷 node 可向正在与其他 node 建连的浏览器注入 SDP/candidate，把直连劫持到自己（拿到的只是 aud 绑定到目标 node 的 ticket，验不过，但可造成 DoS / 混淆）。
建议：hub 为每个 `rtcSession` 记录 `{uid, nodeId, browserConn}`，`from:'node'` 的信令只接受来自登记 nodeId 的 uplink。

**M2（中）`node.status` 上报内容被前端当可信数据展示。**
inventory 中的 device name、version 等由 node 决定，用于侧边栏、Nodes 页。React 默认转义，无脚本风险，但可仿冒其他机器名称诱导用户在错误机器上执行命令。
建议：设备行的 node 徽标显示 hub 侧登记的 `nodes.name`（用户在 Nodes 页命名，不可被 node 覆盖）；inventory 长度/字段做上限校验。

**L1（低）撤销无法回收已下发的 auth bundle。** 失陷 node 上的哈希/密钥永久泄露。H1 采用"本地口令"方案后影响降为仅该 node。

**L2（低）hub 兼 node（`hub,node`）时本机 node 失陷 = hub 失陷。** 同进程、同库，无隔离可言；设计已隐含，文档应明写：hub 机应视为最高信任等级，不建议在个人日常工作机上跑 hub 角色。

### 结论

按当前设计，失陷一台普通 node **不能直接**操作其他 node 或 hub（令牌信任矩阵与 header 过滤是对的），但存在两条间接路径：H1（离线爆破 + TOTP 密钥泄露 → 登录 hub）与 H2（node 响应在 hub origin 渲染 → 同源 XSS → 以用户身份调所有 API）。两条都需在实现前落到设计里；H2 属 hub 转发层的响应头策略（B2-1 范围），H1 属 auth bundle 与本地登录（B1-3 / B2-2 范围）。

## 2. 节点可见性：A/B/C/D + 服务器 F

设计是 **hub-and-spoke，纯手动注册，无自动发现**：

- F 跑 `hub,node`；A–D 各执行 `tmex-cli hub join <F 的 URL> --token <t>`（token 由 F 上 `hub enroll` 或 hub UI 的 Nodes 页生成，10 分钟单次）。
- **只有 hub 入口（F 的 URL）能看到全部机器**：侧边栏拍平展示 A–D 与 F 本机 node 的所有 device，离线 node 灰显。
- **A 的本地 UI（`http://127.0.0.1:port`）只看到 A 自己的 device**，看不到 B/C/D/F。本地 UI 的定位是"hub 不可达时的兜底"，不是第二个入口。
- 没有 mDNS/LAN 广播之类的自动发现；node 之间彼此不知道对方存在（这也是 §1 安全边界的前提——不存在 node→node 通道）。

对应 UI（§4）：
- `/nodes` Nodes 管理页：节点列表（在线/离线、版本、最近心跳、直连能力）、生成 enrollment token 并展示可复制的 `npx tmex-cli hub join …` 命令、重命名、吊销。
- 侧边栏聚合视图：设备行带 node 徽标。
- 设备页头部路径徽标（`lan / v6 / v4-p2p / turn / hub`）。

如果期望"在 A 的本地 UI 也能看到并操作 B/C/D"，设计需要增加"node 本地 UI 反向经 hub 访问其他 node"（A 浏览器 → A 本地 gateway → hub → B），这会引入 node→hub→node 通道，与上面 §1 的安全前提相抵，且 hub 离线时也不可用，收益有限；建议保持现状（所有多机操作统一走 hub URL），只把这一点在文档里明确写出。
