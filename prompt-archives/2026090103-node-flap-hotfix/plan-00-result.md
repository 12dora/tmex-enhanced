# 热修执行结果（1.1.9 / 1.1.10）

## 时间线（2026-09-01）

1. v1.1.8 上线约 1 小时后用户反馈远端节点设备卡片每秒闪断（消失 → 「登录该节点」 → 终端断开 → 恢复），局域网延迟 1000+ ms。
2. 取证：生产日志无 uplink 抖动、gateway 侧 RTC 拨号/failover 频率与升级前相当；「登录此节点」只能由 `loggedIn:false` 触发，1.1.8 唯一亚秒级路径是 M1 审查修复新增的 `onAuthRequired → markLoggedOut`。
3. 止血：`tmex upgrade --version 1.1.7` 回滚本机；随后发 **1.1.9**（`1cb386e8`：节点级 401 只按拍回源、不翻 loggedIn，控制台打 `[mesh] node 401`），本机升级，用户确认闪断消失。
4. 用户报告 `Unknown kind: 776`（每切一次远端 pane +1）与 `POST /n/<jiefa-app>/api/rtc/authorize 401`，响应体 `nodeId` = hub。定位：远端节点均为旧版（hub 1.1.5 / jiefa-app 1.1.6 / jiefa-dns-1 1.1.5 / docker-node 1.0.2），旧 gateway 不认识 1.1.7 的 `TERM_VIEWPORT`；authorize 401 来自旧版 hub 中转层用 hub 身份做会话校验。
5. **1.1.10**（`b4ec0a75` V1 视口帧版本门控 + `463ca3ca` V2 拦截器以路径 node 为准），本机升级至 1.1.10。

## 验证

- 1.1.9：fe 1140 pass / tsc 0；tmex-cli 598；用户确认闪断与延迟恢复。
- 1.1.10：ws-client 295 → 306、shared 398 → 403、api-client 134 → 137、fe 1140、tmex-cli 598；复杂度门禁 ok；GitHub Release run 成功；`/healthz` 1.1.10。

## 遗留

- 旧版 hub 中转返回带 hub `nodeId` 的 401（本机不可修，升级 hub/jiefa 节点后再观察）。
- `forwarder.applyAuthPolicy` 把上游任何 401 改写为 `NODE_LOGIN_REQUIRED`（含 auth-skip 的登录失败），1.1.9 后无害，待后续收敛。
- 教训：把「单次错误响应」映射为状态翻转并卸载子树的逻辑必须先在多节点真实环境验证；审查 should-fix 也可能引入比原问题更重的事故。
