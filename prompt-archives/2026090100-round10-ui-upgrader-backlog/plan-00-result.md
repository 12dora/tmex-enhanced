# Round 10 执行结果

日期：2026-09-01。分支 `feat/round10-ui-node-upgrade`（已并入 `feat/crash-safe-upgrade`），版本 1.1.6。

## 交付清单

### A. UI（实测截图核对通过）

1. 侧栏底部「接入/管理设备」按钮组：Footer/Group 垂直 padding 清零 + size sm，desktop 下缘 892px 与外框/SidebarInset 底完全对齐；按钮组上方留 6px。终端列表多出约 39px。
2. 顶部 tab 切换器：header gap-5→gap-4 + `-mt-px`，可见药丸 top=72px 与终端面板上缘对齐。
3. 设备卡片拖拽避让：`device-grid-collision.ts` 半径限制 closestCenter（`max(96, 半对角线)`），拖远时 over=active 兄弟归位；键盘 DnD 透传；11 个单测。
4. SelectionToolbar 吞点击：终端容器 capture pointerdown（左键、非触摸、非工具条内）先 `clearSelection()`，同一手势即可在原死区开始新选择（Playwright 实测确认新选区高亮）。

### B. 节点远程升级（新功能）

- 后端：`GET /api/mesh/upgrade/latest`、`POST/GET /api/mesh/nodes/:id/upgrade`；本机直调 UpgradeController，远端经 peer-link HTTP stream 转发目标 `/api/system/upgrade`（POST 不重试）。错误码 NODE_LOGIN_REQUIRED/NODE_UNREACHABLE/UPGRADE_NOT_ALLOWED/UPGRADE_IN_PROGRESS/UPGRADE_ALREADY_LATEST/UPGRADE_UNSUPPORTED/RELEASE_UNAVAILABLE/NOT_FOUND。审查后加固：403/409 优先于 latest 解析、semver prerelease 逐段比较、409 白名单防伪造 code/nodeId、远端 body 64KB 有界读取 + info 失败关闭。
- 前端：节点管理 Actions 列「升级」按钮 + 每节点状态机（pending→downloading→executing→restarting→done/failed/cancelled）；重启期不可达不判失败；成功以节点列表版本回读确认；POST 丢响应走「未确认」轮询；卸载 AbortController 真取消；轮询错误分级（网络/5xx 重试，401/403/404/UPGRADE_UNSUPPORTED 立即收尾）。不绑 hubOnline。
- **限制**：本机 dev 环境无 mesh 身份（`/api/mesh/nodes` 404），未做双实例 live 实测；靠 33+ 单测与两轮审查兜底。发版后首次在真实 mesh 上使用时先拿一台非关键节点验证。

### C. 崩溃安全升级器（feat/crash-safe-upgrade → 已并入）

- review-J 7 个 blocker 全修：activeTxnId 贯穿 repair/GC、legacy 顶层目录仅 committed 后删、preflight RuntimeMode（零副作用探针测试）、1.0.2 status-only 健康兼容、PID 归属（token 匹配 + identity + kill 前 TOCTOU 复验）、SHA256SUMS fail-closed（三入口一致，≥1.1.4 强制；--allow-unverified 仅放行真 404；install.sh 自算摘要防路径穿越）、stopping 阶段消除 double-start。
- should-fix：VACUUM INTO argv、native 离线复用、upgrade.log FD、legacy shim、TLS readiness（healthz `tls:{mode,listenerRunning}` + commit 门槛）、repair 清 shim `*.tmp`、flag 单一来源 `upgrade-flags.ts`、Web controller early-exit（G5b 已有）。
- **演练实测新发现并修复**：`started` 阶段 repair 在服务仍运行时二次 start()，双启进程覆盖 tmex.pid 后端口冲突退出留死记录（428f53e7）。
- 三环境演练全绿（`sub/rehearsal-result.md`）：scratch no-service 升级/回滚/4 点位 kill 矩阵；launchd（隔离 label）升级 + KeepAlive 崩溃循环回滚；systemd（docker，`systemctl --user`）升级 + 回滚。
- 已知限制已写入设计文档：preflight import-time 副作用（transfer-session GC timer、tunnelManager 构造）；prerelease 门槛 CLI/install.sh vs Web 语义差（不发预发布 + Web fail-closed，无实际影响）。

### D. backlog P2 清零

1. SelectionToolbar（见 A4）。2. `node-login-<id>` strict-mode：helper 按 `devices-node-login-` 容器收窄。3. hub-e2e driver select 带真实 windowId。4. e2e 5 例：`sidebar-resize:40`（改 testid）、`mobile-mouse-reporting:205`（断言改滚轮语义）、`settings-llm:42`（mock 补 searchProviders）、`agent-session:404`（**产品 bug**：composer 左组溢出遮 Send，去包装层+可换行截断修复）、`ws-borsh-theme-resize:39`（根因是基线取样过早非产品漂移，spec 改稳定基线+窗口总量断言）。known-issues KI-3 已同步；backlog 文件删除。

## 验证终态

- 单测：gateway 3073 pass/0 fail；packages/app 597 pass（唯一 fail 为既有 build-runtime 产物依赖）；panels 697、terminal-ui 344、fe 1098 均 0 fail。tsc：app 1 条既有、gateway 21 条既有、fe/panels/terminal-ui 0。复杂度门禁 ok。
- 全量 e2e（合并树）：**107 pass / 1 skip / 0 fail**（历史基线 10 失败的用例本次全过；KI-3 保留其中负载敏感项不摘）。mesh 项目另行补跑。
- 审查：codex sol 三路（RV1/RV2/RV3）→ 全部 blocker/should-fix 修复或有据豁免（见 C3/C4/O7-result 与本文件）。

## 过程档案

EX1-EX4 探索、C1a/C1b/C2/C3/C4（cursor）、O1-O7（Opus）prompt+result、RV1-RV3 审查、rehearsal-result 均在 `sub/`。
