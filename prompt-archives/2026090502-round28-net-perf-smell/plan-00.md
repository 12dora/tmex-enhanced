# 第二十八轮计划：隧道 fake-IP 绕行 / 中继升级推送 / 带宽显示 / 网络与前端性能 / 死代码与坏味道

## 背景

- 基线：main `24b9c6e7`（1.1.30，round27 已并入）。分支 `feat/round28-net-perf-smell`，worktree `/Users/konata/code/tmex-r28`。
- 分工（用户 2026-09-05 指定）：Opus 5（Agent 工具子代理，不经 cursor）承担前后端编码与探索；codex gpt-5.6-sol（max）承担复杂网络/性能调优编码；codex gpt-5.6-sol（high）审查（偏过度防御，由指挥官判定是否修）；指挥官分批 commit，最后发版替换本机。
- 参考：`prompt-archives/2026090501-round27-relay-mgmt-onboarding/plan-00-result.md`（遗留清单）。

## 任务 1：隧道「无边缘连接」真因（本机只读排查结论）

- cloudflared `/ready` = `readyConnections:0`；云端 `tunnel info` 无连接。
- cloudflared 预检：`region1/2.v2.argotunnel.com` 经系统解析器（Surge 198.18.0.2）得到 **fake-IP 198.18.91.209 / 198.18.92.12**；QUIC/TCP 7844 均失败；直连真实边缘 `198.41.192.7:7844` 通。
- Surge 日志自 2026-09-04 23:51（23:41 网络切换后）持续报 `[SGUDPForwarder] Unknown VIF virtual IP: 198.18.91.209:7844, client: cloudflared`——Surge 自己发出的 fake-IP 在其转发器里查不到映射，直接丢包。
- 用户的 Surge 配置**已经**含 `always-real-ip = …, *.argotunnel.com, argotunnel.com, *.cfargotunnel.com` 与 `DOMAIN-SUFFIX,argotunnel.com,DIRECT`、`PROCESS-NAME,cloudflared,DIRECT`（profile 2026-09-01 修改、09-03 载入），但 Surge DNS 仍返回 fake-IP：属 Surge 侧缓存/状态不一致，不是 tmex 代码 bug，也不是规则缺失。
- tmex 侧修法（使隧道对这种劫持免疫）：网关启动 cloudflared 前用 DoH 解析 SRV `_v2-origintunneld._tcp.argotunnel.com` → A 记录；若系统解析器给出 198.18.0.0/15 则改传 `--edge <ip>:7844` 静态边缘列表（cloudflared `StaticEdge` 跳过 DNS 发现）；状态面新增 `edge` 诊断字段；降级 ≥90 s 时一次性自动重解析并重启；前端提示「已绕行」或「绕行失败 + 代理侧修法」。（T1 后端 / T2 前端）

## 任务 2：节点管理升级 jiefa 服务器失败

- 生产日志 01:04:37：经中继推送 13.5 MB / 10.9 MB 升级包时收到 `rst recv reason=relay-rst`，`raw-body push aborted err=stream-aborted`；同时段 `reason=replaced`。EX1 探索定位根因后派 T4。

## 任务 3：带宽显示

- EX2 结论：本机卡片走 `formatRate`（B 档原值直出无小数收敛），中继指标走 `formatBytesPerSec`（2 位）；`quotaValue = "{{used}} / {{total}}"` 与 `/s` 撞出双斜杠。修法：`packages/shared/src/format-bytes.ts` 统一 `formatBytes/formatRate/formatBytesPair`，api-client 薄壳 re-export，新 key `quotaUnlimitedValue = "{{used}}（不限）"`，5 处硬编码 `a / b` 收敛。（T3）

## 任务 4/5：网络与前端性能

- EX3（网络）：ws/中继/rtc 三路传输、glare、datachannel open timeout、熔断、弱网重连；实施交 codex（max）。
- EX4（前端）：终端输入/输出路径、路由切换、列表虚拟化、订阅粒度；实施交 Opus。

## 任务 6/7：死代码、腐化测试、坏味道

- EX5 探索；实施按包切片分给 Opus 子代理，遵守既有保留清单（memory `code-smell-retained-hotspots`）。

## 任务 8：SSH 路径预选类型

- `openAddDevice(preset)` 贯穿 `packages/panels` → `add-device-targets` → `open-add-device` → `ssh-steps`。（T2）

## 测试基线（改动前）

gateway 4416 / app 907 / shared 692 / api-client 222 / panels 930 / ui 414 / stores 431（0 fail）。

## 验收

- 各包 `bun test` 0 fail、`tsc` 0 新错、biome 干净、复杂度门禁通过；e2e 标准与 mesh 不低于基线。
- 发版：版本号 + CHANGELOG + tag + GitHub Release，本机 `tmex upgrade` 替换（用户授权）。

## 注意事项

- 生产 tmex / tmux `tmex` 会话红线；临时实例必须 `TMEX_TMUX_SOCKET=tmex-e2e` + 独立端口；`test.env.local` 用完即删。
- 生成文件（i18n resources/types、fe-dist）不 lint。

## 分派表（2026-09-05 执行中）

| 编号 | 内容 | 执行者 | 状态 |
|---|---|---|---|
| EX1–EX5 | 中继推送 / 带宽格式 / 网络 / 前端性能 / 死代码 探索 | Opus | 完成，见 sub/EX*.md |
| T1 | 隧道 fake-IP 绕行（DoH + `--edge`、edge 诊断、自愈重启） | Opus | 已提交 `2969eb95` |
| T2 | SSH 预选 + 远程访问 edge 三档提示 | Opus | 已提交 `fcb6642b` |
| T3 | 字节/带宽格式统一到 shared、「已用（不限）」 | Opus | 已提交 `a42c0774` |
| T4 | 升级推包可续传 + 重试 + `link_lost` 分类 + FE 预算/进度 | Opus | 进行中 |
| T5 | 页面模块缓存 / 路由预热 / content-visibility / Corner 删除 / vendor 分包 | Opus | 进行中 |
| T6 | rtc 信令重放修复 + epoch、RtcConfig、熔断/超时预算、ping 5 s、在途流保护、中继心跳/令牌桶公平、分片 16 KiB、观测 | codex gpt-5.6-sol max | 进行中 |
| T7 | ws-client 重连抖动/无上限/online 监听、FakeSocket 合并、ws cork、粘贴流水线 | Opus | 进行中 |
| T8 | codec 拆分与读取族统一（NODE_ID_HEX 修正）、parseAction、tunnel 门禁、测试去重、死导出、readCodedError、async helpers | Opus | 进行中 |
| T9 | global-device-provider 测试去重、account-security 拆文件、useHubRoleSwitch 拆分、死导出、relay tiles 去 export、hub-api readError、确认对话框上移 @tmex/ui | Opus | 进行中 |
| T10（待派） | 全部 agent 结束后：删 61 个 i18n 键、errorMessage/sleep/abort/withTimeout 收敛、滑动窗口限流器、dial 分类器、TunnelStatusCard、useNodeUpgrade 拆分、device-delete-dialog | Opus | 待 T4/T6 完成 |
| R | codex 审查（backend / frontend / libs 三路） | codex gpt-5.6-sol high | 待所有编码完成 |
