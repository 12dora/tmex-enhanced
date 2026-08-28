# plan-00：hub/node 三机实测 + 遗留任务收尾

## 背景

`feat/hub-node` 已合入 `chore/merge-hub-tabs`（worktree `../tmex-enhanced-wt-merge`）。2026-08-28 前一轮 docker harness 单机 / 分体拓扑 A–G 已 PASS，但跨 NAT RTC 直连从未建立（D 停在 relay），遗留清单见 `../2026082801-hub-docker-e2e-multi-theme/leftovers.md`。本轮引入第三台机器：NAT 后的 tunnel 机（`home-tmex.konata.tv`，CF Access OTP，只有网页终端可用）。

## 测试机

| 机器 | 角色 | 访问 |
|---|---|---|
| 43.248.129.233（`ai.jiefakj.com`，x86 公网） | hub,node（docker `tmex-split` 项目，Caddy + LE 真证书 :18443，peer :39001） | ssh 10022（凭据在会话/scratchpad 包装脚本，不入库） |
| 本机 Docker（arm64 原生镜像） | node-a / node-b（各自 NAT 网桥）+ driver | 本机 |
| tunnel 机（Ubuntu x86，`~/.local/share/tmex`，systemd user） | node（`home`），入口经 CF Tunnel | Playwright 持久化 profile 登 CF Access；命令经 tmex 网页终端 `tmex-e2e` 窗口；用户物理机敲 `curl -sL ai.jiefakj.com/<x>\|bash` 兜底 |

tunnel 机做 hub 不可行：CF Access（OTP）挡住 node 的 WSS uplink，除非配 service token；本轮只验证其 node / 入口角色。

## 步骤

1. 远端准备：传 amd64 基础镜像 + bun zip + tarball，rsync harness，acme.sh webroot 签 LE 证书（隔离在 `/root/tmex-e2e/acme`），ufw 放行 18443/39900。
2. 并行分派遗留任务：TOTP 场景（grok，单机 harness）、healthz env（grok）、mesh Playwright e2e 入仓（opus）、RTC 根因探索（codex luna）。
3. 分体 harness 跑 A–G 基线；tunnel 机升级到本次构建并 `hub join`；从 tunnel 入口做浏览器场景（侧栏 / 远端终端 / passkey）。
4. RTC：按探索报告实现 offerer 唤醒 + transport 暴露 + ICE 诊断（grok）→ codex sol 审查 → 修复；harness D/H/I（transport=dc、UDP 中断不丢 SEQ、8 MiB 文件）。
5. 实测发现的问题即时分派修复：cpu-features Bun auto-install 首启卡 5 分钟；非 hub 入口 node 名退化为 id。
6. 重建 tarball / 镜像，重跑分体 harness 与 tunnel 机场景，直到 D/H/I 通过或明确边界（STUN/TURN）。
7. 清理：远端 docker 栈/镜像/证书/acme/nginx 根目录文件/ufw 规则/日志接收器，本机 compose 与镜像；tunnel 机 `~/tmex-e2e`、`hub leave` 与否由用户决定。
8. 分批 commit，最后 push；结果归档 `plan-00-result.md`。

## 验收

- 分体 harness A–I 全 PASS（D2 `transport=dc`、H2 SEQ 无缺口），或 FAIL 行附带 `[mesh][rtc]` 证据说明网络边界。
- tunnel 机：join 在线、入口登录、远端终端 marker、passkey 注册与登录、direct_capable 与路径记录。
- 单测/tsc 基线不退化；无凭据入库。
