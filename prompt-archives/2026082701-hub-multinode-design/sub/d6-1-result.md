# D6-1 结果 — hub/node 运维指南与部署文档改写

范围仅 `docs/**`。未改代码、未跑测试、未碰生产 tmex / 名为 `tmex` 的 tmux session、未 `bun install`、未执行改状态的 git 命令。

## 交付文件

| 路径 | 动作 |
|---|---|
| `docs/hub/2026082800-hub-node-operations.md` | **新**：运维指南 |
| `docs/2026021000-tmex-bootstrap/deployment.md` | **改写**：删 JWT / OIDC / 管理员密码 / Docker Compose 推荐路径；指向运维指南；保留并校正安装、服务、SSH、备份 |

## 运维指南章节 ↔ 主张来源

只写报告已落地的行为；设计文档仅作威胁模型与「已知限制」对照。

| 章节 | 主张摘要 | 报告 / 源 |
|---|---|---|
| 部署矩阵 | `standalone` / `node` / `hub,node`；无纯 hub；请求顺序；standalone 只挂 `GET /api/auth/mode`；mesh 关停 20 s、standalone 无信号处理器 | b2-3、b2-4、b2-2b-fix |
| env：`init` 写入键 | `TMEX_ROLES` / `HUB_URL` / `HUB_PUBLIC_URL` / `PEER_PORT` / `STUN_SERVERS`；upgrade 只 append；非交互 hub,node 必填 public URL | c5-1、c5-3、`hubEnvDefaults` |
| env：手写键 | `PEER_BIND_HOST` 未设 dual-stack；TURN 三者齐全才下发；`TRUST_PROXY` 默认 false 且只 via=self；`NATIVE_DIR` 由 `run.sh` 导出 | b2-4、b2-2b-fix、c5-2、c5-3、b3-1-fix（TURN URI） |
| 首次搭 hub | `init --role hub,node` → `hub user add`（自签 admit、拒重名）→ `enroll` / Nodes 页 → 各机 `hub join` | c5-1、c5-3、c5-4、设计 §5 迁移路径 |
| enroll CLI | `--ttl`；hub 轮询 token JSON 证书；非 hub 轮询 `/api/hub/nodes`；SIGINT 去 Nodes 页；TOTP `TMEX_TOTP` | c5-4；证书回写 b2-5 / 幂等 redeem b2-6 |
| enroll UI | pending 不含 `enroll_sk`；join 串只在内存；5 分钟复用窗口；passkey 可签授权 | f4-3、f4-fix、f4-4 |
| `hub join` | 仅 HTTPS + `redirect:error`；production 禁 `--insecure-local`；锚点链校验；原子 commit；写 `TMEX_ROLES=node`；防火墙提示 | c5-1、c5-3、c5-4 |
| `hub leave` | 清 hub_url，角色 standalone，重启 | c5-1 |
| Nodes 页 | `/nodes`；ENROLL_REDEEMED 定向推送 + 按 id 轮询；admit/revoke 走 `keylog?hub=sync` 且要 `hubAck`；hub 离线禁用管理；根钥才自动 admit | f4-3、f4-fix、f4-4、b2-5、b2-6 |
| 账号安全 | `/account/security`；passkey origin 绑定；TOTP 两段式且启用只能用密码；`rotate-root` 清 passkey/TOTP/会话 | f4-1、f4-fix、f4-4、c5-1（CLI passwd/totp） |
| 登录 fan-out | 先 self → `/api/mesh/nodes`；401 `NODE_LOGIN_REQUIRED` 不跳全局；cookie 无 sid | b2-2b-fix、f4-1、f4-fix |
| 直连 | `direct enable\|disable`；平台 darwin-arm64/x64、linux-*-gnu；musl/Windows 否；init 非致命；ICE 顺序；断开 toast + resume | c5-2、c5-3、b3-1、b3-1-fix、f3-1、f3-1-fix、b2-4 |
| Cloudflare Tunnel | `TMEX_TRUST_PROXY=true` 才用 forwarded origin / Secure / passkeyAvailable | b2-2b-fix |
| hub 离线 | 登录不经 hub；`peer_cache` 哨兵行；v1 只用缓存地址；管理按钮禁用 | 设计已确认取舍；b2-4 endpoints；b2-5 hub meta；f4-fix |
| 灾难恢复 | `mesh reset-root` standalone 拒绝、保 username 自签 admit；`hub user reset` stop→wipe nodes+tokens（留 certs）→start | c5-1、c5-4 |
| 排障 4401 | 升级后关；`/mesh/ws` 5 min 复验；前端停重连 | b2-2b-fix、b2-5、f4-fix |
| `NODE_LOGIN_REQUIRED` / `NODE_UNREACHABLE` | 401 增强；peer+relay 全失败 503 | b2-2b-fix forwarder |
| `KEY_LOG_FORK` / `HUB_TIMEOUT` | 409 本地不 persist；504 保留 pending | b2-6（相对 b2-5 的最终语义） |
| `DIRECT_UNAVAILABLE` | native 未装 / authorize 满 64 / 503 | b3-1-fix、f3-1 |
| 限速 | uid/ip 429；转发桶 `peer:<entry>` | auth-routes 实测；b2-2b-fix 协调者项 |
| 安全边界摘要 | **引用**设计 §5 表，不复制 | 设计 §5；失陷模拟用例见 b2-4 验收 4 |
| 已知限制 | 缓存地址；musl/Windows；IP 无 passkey；bulk 失败整次重传；IPv6 未实测；三键不进 init | 设计风险项；c5-2；f4-1；b2-4 leftover |

## deployment.md 改写要点

删除：`JWT_SECRET`、`JWT_EXPIRES_IN`、`TMEX_ADMIN_PASSWORD`、OIDC、Docker Compose 作为推荐安装、端口 3000、手写 nginx/systemd JWT unit。

保留并校正：`tmex-cli init` 安装布局、launchd/systemd 日志与 `KillMode=process`、SSH 四种认证、SQLite+`app.env` 备份、`/healthz`、`npx tmex-cli@version upgrade`、Cloudflare Tunnel（改为指向 `TMEX_TRUST_PROXY`）。

## 公开 API

文档任务，无新导出符号。运维读者入口：`docs/hub/2026082800-hub-node-operations.md`。

## 测试 / tsc

未跑。范围无源码。基线不变：`apps/gateway` 1777 pass / 23 tsc；`packages/shared` 277 / 0；`packages/app` 90 / 1。

## 未能做 / 协调者

1. **`docs/2026021000-tmex-bootstrap/architecture.md` 仍是 JWT 时代结构图**（Dockerfile、无 mesh）。不在本任务「改写 deployment 认证部分」范围内，未动。
2. **`init` / `upgrade` 仍不写 `TMEX_TRUST_PROXY` / `TMEX_TURN_*` / `TMEX_PEER_BIND_HOST`**（c5-1 `hubEnvDefaults`、b2-4 leftover）。文档已标「手写 `app.env`」。若希望少踩坑，需在 `packages/app` 把这几键并入 defaults（默认值保持 false / 空）。
3. 远程 entry 上 `ENROLL_REDEEMED` 的 sid 对不齐时仍靠 HTTP 轮询（b2-6 第 3 条）；文档已写轮询兜底，无需改 docs。
4. 未在其它模块文档加交叉链接（`docs/update` 等超出「deployment 认证部分」）。
