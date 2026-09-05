# 第二十八轮结果：1.1.31

分支 `feat/round28-net-perf-smell`，worktree `/Users/konata/code/tmex-r28`。分工：Opus 子代理（探索 EX1–EX5、编码 T1–T5 / T7–T12、审查修复 RF1–RF3）、codex gpt-5.6-sol max（T6 网络调优，约 3 h）、codex gpt-6-astra high（三路审查）。

## 一、交付

| 任务 | 结果 |
|---|---|
| 1 隧道「无边缘连接」 | **真因**：Surge fake-IP——系统解析器把 `region1/2.v2.argotunnel.com` 解析成 198.18.x，Surge 转发器又报 `Unknown VIF` 丢包（用户规则已正确，是代理侧缓存/状态问题，09-04 23:41 网络切换后开始）。**tmex 侧免疫**（T1/RF1）：检测到 fake-IP 时 DoH 解析真实边缘并以 `--edge` 静态列表拉起 cloudflared；`status().edge` 诊断；0 连接 90 s 自动重解析并一次性重启（带代次取消、直用已解析地址）；前端三档提示（T2）。本机实测 `resolveEdge` 返回 8 条真实边缘地址。 |
| 2 升级 jiefa 服务器失败 | **真因**（EX1）：中继隧道流 RST → peer 链路连坐 → PUT 不可重试 + `.part` 被删。**修法**：续传协议（`offset` / `PACKAGE_INCOMPLETE` / 确定性 `.part` 24 h TTL / 能力位 `staged-package-resume`）、按偏移退避重试、`link_lost` 分类、持续推送进度、前端按阶段预算（T4/RF1/RF2）；链路侧「尽量别打断」见任务 4。 |
| 3 带宽显示 | `formatBytes/formatRate/formatBytesPair` 统一到 `@tmex/shared`（≤2 位小数），5 处硬编码收敛；无上限配额显示「1.2 KB/s（不限）」（T3）。全前端扫描无其它漏网点。 |
| 4 网络性能 | **rtc 真因**（EX3）：不是 glare，是陈旧 answer 重放到新 PC + `bindSignaling` 在 try 外导致 PC/监听器双泄漏自我放大。T6：按角色/epoch/单次 answer 过滤、inbox 30 s TTL、统一清理；ICE 启用 TCP/UDP mux/MTU 1200/`TMEX_RTC_PORT_RANGE`；拨号单一 15 s deadline；熔断跳过本地信令错误 + 10 min 探测；peer ping 5 s 且入站帧即活性；在途流先排空再退役/切换；中继心跳期间有流量不判死、令牌桶按流公平 + 小帧快速通道、RST 原因细化；分片 16 KiB（RF3：按 ≤17 片自适应）；failover 退避 15 s；候选对聚合日志。T7：浏览器 WS 重连抖动 / 无上限 / `online` 唤醒、网关 cork、粘贴流水线。 |
| 5 产品性能 | T5：页面模块缓存（重访零空白帧）、路由 chunk 悬停/空闲预热、文件树与会话 `content-visibility`、滚动测量 rAF 合帧、删恒空 Corner、`vendor-react` 分包（入口 281 KB → 161 + 121 KB gz）。不做：保活池跨路由（StrictMode/portal 风险）、lucide 深路径。 |
| 6/7 死代码与坏味道 | T8–T12：删 61 个无引用 i18n 键（−628 行）、23 个零引用导出、重复测试（B1–B6）；codec 拆四文件 + 读取族统一 + node id 大小写归一化（修 hub/mesh 不一致）；五份滑动窗口限流器 → `SlidingWindowCounter`、三份拨号分类器 → `classifyByKeywords`（CC 35/21/16 → 2/4/2）；`errorMessage`(108 处) / `sleepOrAbort` / `combineAbortSignals` / `withTimeout` 收敛；确认对话框上移 `@tmex/ui/confirm-dialog`；`account-security-panel`(830→184)、`useHubRoleSwitch`(1342→562)、`useNodeUpgrade`(453 行 hook → 45 行组合)、`TunnelStatusCard`(CC 31→<15)、`parseAction`(CC 30→<10)、`ChatThread` 拆分。门禁：0 违规 0 stale，未放宽 allowlist（只收紧/删除）。 |
| 8 SSH 预选 | `AddDevicePreset` 贯穿 `ssh-steps → openSelfAddDevice → AddDeviceTarget.open → DeviceManagementPanelHandle.openAddDevice → DeviceDialog.initialType`，全局事件路径同步（T2）。 |
| 9 顺手修复 | `add-device-menu` 把鼠标事件当 preset 传入；成功推包的 `forward aborted status=200` 假告警；`memoryHeapSub` 三语分隔符不一致；`cc.ts` 硬编码另一工作树路径。 |

## 二、审查（codex gpt-6-astra high，三路）

- 后端 5 条（自愈无取消 / 满长度 `.part` 误判完成 / DoH 预算耗尽 / 自愈地址未直用 / 重试复用已锁流）→ RF1 全修 + 追加持续推送进度。
- 前端 4 条（批量续跑抢在回读前 / 页面模块缓存竞态 / 推包 6 min 误超时 / JSON null 兜底）→ RF2 全修。
- mesh 2 条（missed-pong 排空无硬截止 / 16 KiB 分片让浏览器大帧超 17 片被拒）→ RF3 全修。
- 全部 11 条均为具体可复现场景，无过度防御项被拒。

## 三、测试终态

gateway 4530 / fe 2413 / app 897 / shared 730 / api-client 229 / panels 949 / ui 414 / stores 431 / ws-client 407 / ghostty-terminal 329 / terminal-ui 394，全部 0 fail；9 个包 tsc 0 错；biome 干净；复杂度门禁 ok（1573 files）。e2e 标准 108 pass / 3 fail / 1 skip（`terminal-mouse-recovery:411`、`terminal-render-regressions:478`、`terminal-selection-canvas:139` 为基线已知负载抖动，隔离定向复跑 16/16 通过）；mesh 12/12。

## 四、坑

- Opus 子代理并行 6–7 个时，共享文件（locale JSON、allowlist）只能定点编辑；函数搬家后 allowlist key stale，由指挥官改名。
- codex 会顺手改到相邻任务的文件（forwarder.ts），靠范围不重叠 + 提交前全量测试兜底。
- bun `mock.module` 会替换已有 namespace，「未激活时转发真实实现」必须在打桩前把真实函数抓成 const，否则自调死循环（RF2 踩过，表现为 `bun test src/` 100% CPU 挂死）。
- `--dns-resolver-addrs` 是 WARP 虚拟 DNS，不是边缘发现；`--edge` 才能绕过 SRV/DNS。
- codex 审查用 `-s read-only` 时无法写文件，靠 `-o` 收最终消息。

## 五、遗留

1. 下载阶段无持续进度（`downloadVerifiedRelease` 走 inflight 共享，无回调位）；慢网下载 >10 min 前端会先报未确认。
2. `node-datachannel@0.33.1` 无网卡过滤 API，docker0/utun 候选仍会进入 ICE。
3. TURN 仍需三 env 齐备；建议先按新的 `[mesh][rtc] summary` 数据决定是否内建。
4. `MAX_LINK_UNACKED` 提到 65 MiB 是不误关满窗口中继流的代价；排空 10 min 上限到期会 reset 剩余流。
5. D1 步骤 3（合并两个 ctl switch）、`uplink-server.ts` / `peer-manager.ts` 上帝类拆分建议独立立项。
6. 上线后需在现网实测：推包途中重启中继/顶号验证续传；直连 ICE-TCP 与端口范围无真实 NAT 集成测试。
