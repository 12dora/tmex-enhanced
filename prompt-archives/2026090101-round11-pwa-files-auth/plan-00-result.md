# Round 11 执行结果

分支 `feat/round11-pwa-files-auth`（worktree `../tmex-enhanced-wt-r11`，基于 main `4e24515f`），版本 **1.1.7**。

## 分派与产出

| 任务 | 角色 | 结果 | 提交 |
| --- | --- | --- | --- |
| EX1–EX6 | codex luna | 探索报告 `sub/EX*-result.md` | af23c593 |
| A1 | Opus | 会话钥持久化（WebCrypto 不可导出 Ed25519 + IndexedDB）、设备页静默登录、mesh e2e、架构文档 §2 | af23c593 |
| F1 | Opus | 文件侧栏缺省对齐终端侧栏、空分节不渲染、纵轴 modifier、ScrollArea `axis` | 260fb186 |
| S1 | grok | 代理感知客户端 IP（限流 / bootstrap loopback）、mesh 隔离回归测试、运维文档 | fb16849d |
| — | 指挥官 | 公网登录安全评估文档 | 8c543ca0 |
| P2 | grok | 静态资源缓存策略（immutable / ETag / 304） | 59f2a229 |
| T1 + T2a + T2b | grok + Opus×2 | 视口策略协议、网关仲裁、store/panels 跟随模式、ghostty 平移视口与触摸嵌套滚动 | 8e783319 |
| P1 | Opus | 远端运行时按需创建（展开/路由）、单一 mesh 轮询、设备查询等门闸、展开状态持久化 | 58db945c |
| RV1–RV4 | codex sol | 审查（`sub/RV*-result.md`），修复见下 | — |
| 审查修复 | 指挥官 / Opus / grok | CF 头恒非本机、base64url 哈希；IndexedDB 事务 complete 语义 + 登出等待删除；热区 bypass；网关 select 仲裁 / 实时几何 / 同窗切 pane 策略 / 跨窗清理（V1）；冷 select 保持 selectPaneWithSize 顺序 + 快照安装时重绑声明（V4）；策略按会话去重重发 + 跟随者回灌不受 pending 阻塞（负载下竞争，指挥官修） | 967bb533、1351933e、8ca4333d、3ee44979、deefb5dd、1a2250fd、f24180e6 |
| C1 / C2 / LoginForm | grok / Opus / 指挥官 | 复杂度门禁恢复（无 allowlist 变更） | 62b1b0e5、87de9650、61beb01d |

## 决策记录

- 跨节点登录：不引入节点签名 / hub 签名断言（会把节点或 hub 变成用户信任根）；只把既有 delegation 流程的会话钥跨文档持久化，私钥永不出 WebCrypto，TTL 仍受 18 h delegation 约束，TOTP 会话与 `@noble` 回退不持久化。
- 终端视口：一 pane 一个共享 PTY 是硬约束，不做每客户端 PTY。策略为「最大可见客户端持有整窗尺寸」，跟随者保留权威几何本地平移；TUI（鼠标上报 / alt-screen）内部滚动仍是应用状态、天然共享，属固有限制。
- 安全：只修部署层的两处（代理感知 IP、bootstrap loopback），明确拒绝锁定 / 复杂度规则 / JWT / Origin 校验 / HSTS 等过度防御项，见 `docs/operations/2026090101-public-login-security-review.md`。
- 文件侧栏缺省：推翻 round9「配了目录即显示」，改为与终端侧栏一致（远端默认隐藏）。
- 未做（EX1「需设计」项）：保活 pane 停止订阅、网关按 pane 订阅 control-mode 输出、mesh DTO 瘦身、agent 会话列表延迟加载。

## 验证

- 单测：gateway 3134 pass / tsc 21（既有）；fe 1130 pass / tsc 0；shared 398；ws-client 286；stores 415；panels 724；terminal-ui 358；ghostty-terminal 228；ui 49；app 601（1 例既有：需 dist 产物）。
- lint：`biome check .` 干净；复杂度门禁 ok。
- e2e：默认项目 107 pass / 3 fail / 1 skip——3 例 `terminal-mouse-recovery`（opencode）在 main 同环境同样失败（opencode 1.15.12 启动 >20 s），已登记 KI-3；新增 3 例（files-sidebar-drag、viewport-policy×2）通过；终态全量复跑同样 107/3/1；`viewport-policy` 在 gateway 全量单测并行制造的高负载下 4/4 通过（修复前 1/3 失败）。mesh 项目 6/6（含新增 reload 后静默登录）。
- 打包烟测：`tmex-cli-1.1.7.tgz` 临时实例 `/healthz` 1.1.7；哈希资源 `immutable`，`index.html` `no-cache` + ETag + 304。

## 上线

- release commit `41c05a60`，merge `3648f495`，tag `v1.1.7`；GitHub Actions Release 成功（`tmex-cli-1.1.7.tgz` + `SHA256SUMS`）。
- 本机生产：`node "$HOME/Library/Application Support/tmex/current/cli/bin/tmex.js" upgrade --yes --lang zh-CN` → `upgrade committed 1.1.6 -> 1.1.7`，`/healthz` 版本 1.1.7；升级前生产库三件套只读备份在 scratchpad `prod-backup-1.1.6/`。
- 其余节点（Hub、jiefa-app、jiefa-dns-1）未升级，可在设置-节点管理用「升级」按钮逐台升级。
