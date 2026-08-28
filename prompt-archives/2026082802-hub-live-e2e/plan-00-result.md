# plan-00 执行结果：hub/node 三机实测 + 遗留任务收尾

分支 `chore/merge-hub-tabs`，2026-08-28 20:00 → 2026-08-29 03:00。所有子任务 prompt/result/审查在 `sub/`；实测证据 `sub/evidence-*.txt`、`sub/report-run8-vm.md`。

## 一、遗留任务（`../2026082801-hub-docker-e2e-multi-theme/leftovers.md`）

| # | 项 | 结果 |
|---|---|---|
| 1 | 跨 NAT RTC 直连 | 根因：较大 id 一侧单方 `getLink()` 时没有 offerer 被唤起（`sub/explore-rtc.md`）。实现签名 `rtc.wake`、`waitForTransport`、`/api/mesh/nodes.transport`、`[mesh][rtc]` ICE 诊断；四轮 codex 审查修复。**在有入站 UDP 的机器上实测 node-a ↔ hub 经 TURN 建立 DataChannel（D2/D3 PASS）** |
| 2 | 直连中断不丢字 | 新增 liveness ping（10s 判死）、流 failover（HELLO→DEVICE_CONNECT→等快照→重放订阅→补历史）、丢链后 5/15/30/60/120s 重试升级。WAN（TURN）与 LAN 两个变体 H1–H3/L4–L6 PASS |
| 3 | TOTP 场景 | 单机 harness 场景 9（启用/缺码/错码/正确码/rotate-root 清空） |
| 4 | 文件 bulk 直连 | I/L7 经 DC 读 8 MiB：LAN PASS；WAN 暴露慢链路窗口/liveness 停滞（已修，见二-11，本地 netem 复测见三） |
| 5 | mesh Playwright e2e | `apps/fe/tests/mesh-login.spec.ts`、`mesh-passkey.spec.ts` + 进程内 hub/node 引导，5/5 通过 |
| 6 | harness 重跑前提 | 文档化；harness 参数化（主机/IP/用户/目录/私有 CA/TURN/netem/UDP 预检） |
| 7 | healthz env | `bun build` 内联了构建期 `NODE_ENV`，改运行时读取 |

## 二、实测发现并修复的产品缺陷（按发现顺序）

| # | 缺陷 | 提交 |
|---|---|---|
| 1 | 生产 runtime `--external cpu-features` 触发 Bun auto-install，首启卡 5.5 分钟（远端）/ 拖慢 tunnel 机升级 | c0b5e23 |
| 2 | 非 hub 入口的节点名退化为 id（hub 自身无 name、peer_cache 名被覆盖） | 241d2cf |
| 3 | RTC 直连从不发起（offerer 唤醒缺失）+ 无诊断日志 | e2facea → 93a09db、78ee7a0、02a9ef8、ede9eb8 |
| 4 | `hub join` 遇同名旧用户 `UNIQUE constraint failed`（hub 重建/reset-root 后无法重新加入） | 33f7484 |
| 5 | hub redeem 对同一节点二次 join 返回 409 `node_exists`；随后加入 PoP 防止 token 持有者绑定他人 nodeId | 4346e55、16d05be |
| 6 | 已 admit 节点重新 join 会二次 admit 被 key log 拒绝（`node_id_reused`），enroll 误报 `node admitted`，uplink 永远 `auth_rejected`，hub 无任何日志 | 123362c |
| 7 | uplink 连接失败被 `catch {}` 吞掉、无连接超时（tunnel 机 join 新 hub 后 10 分钟无任何日志） | 50088c6 |
| 8 | DC 死链要 ~35s 才被 ICE 发现 | 3d8b1f3 |
| 9 | 绑定在 DC 上的入口转发流断链后直接死亡，终端输出停在 SEQ_162 | c5a845b → 073d049、2938e83 |
| 10 | 直连丢失后不再重试升级；`getLink` 会把新流绑到未握手完成的 DC 上 | 02a9ef8、d625231 |
| 11 | DC 上大文件转发在 2,113,536 字节静默截断 200（重组上限少 10 字节帧头 + 32 条计数上限）；慢链路上 1 MiB 后停滞（三轮：控制帧独立队列/收包回调内不发送/原生 send 返回 false 但已入队时不重发） | 6518a97、92dc21e、9bfecf0、7fc5e92、32530af |
| 12 | DC 握手 ↔ Link 交接吞帧（三轮审查逐步收敛：晚到 hello 触发 fragment-protocol、>4 KiB 首帧被拒、sess 首帧丢失、溢出静默丢弃） | 93a09db … ede9eb8 |

## 三、三台机器实测结论

| 机器 | 结论 |
|---|---|
| 43.248.129.233（aaPanel VPS） | 单机/分体 A–G 全 PASS；**上游过滤入站 UDP**（网卡 tcpdump 看不到），且 node-datachannel（libjuice）不支持 TURN over TCP → 该机永远拿不到 DataChannel，只能 relay。LAN 变体（本机 node-a↔node-b）在其作 hub 时可复测 L1–L8 |
| 本机 Docker | 出口为**对称 NAT**（不同目标映射不同端口），打洞必须 TURN；TUN 代理会吞 UDP，需主机路由绕过（run.sh `preflight_udp` 提示/尝试） |
| 118.195.194.170（临时腾讯云，已销毁） | 入站 UDP 通：node-a↔hub 经 TURN `transport=dc`、D/H 全 PASS、L1–L7 PASS；I1/I2（慢链路 8 MiB）失败 → 缺陷 11；F 在私有 CA + `--insecure-tls` 路径 `ERR_EMPTY_RESPONSE`（真证书路径 PASS，未再深究） |
| tunnel 机（home-tmex.konata.tv） | 0.17.0 → 本次构建；作 node 入口：侧栏/远端终端/passkey 注册与登录 PASS；`direct enable` 成功；每轮 harness 重建 hub 后需重新 join，暴露缺陷 4/5/6/7。cloudflared 断线根因：其 unit `Requires=tmex.service`，CLI 升级 `stop` 时被连带停止且不随 start 回来（用户已改 unit）。该机做 hub 不可行（CF Access OTP 挡 uplink） |

run 8（新 VM，含除慢链路修复外的全部修复）报告：`sub/report-run8-vm.md`（42 PASS / 4 FAIL：I1、I2、L8、F）。run 9b/10/11（43.248 hub + LAN netem 80ms/16mbit）：`sub/report-run9b-43248-netem.md`、`sub/report-run10-43248-netem.md`、`sub/report-run11-43248-netem.md`——run 11（最终构建）L1–L8 全 PASS，D2/D3 因该机 UDP 边界 FAIL（预期），E2 一次偶发（见遗留）。

## 四、验收对照

| 包 | 结果 |
|---|---|
| apps/gateway | 2441 pass / 0 fail |
| packages/shared / app / api-client | 335 / 250 / 96 pass，0 fail |
| tsc | gateway 21、app 1、api-client 5（基线） |

## 五、遗留

- WAN DataChannel 的复测需要一台入站 UDP 通的公网机（本轮临时 VM 已销毁）；43.248 只能验证 relay。
- F（Playwright）在私有 CA + `--insecure-tls` 模式下 `ERR_EMPTY_RESPONSE`，真证书模式正常；未定位。
- 浏览器 `sess` DataChannel 仍依赖 ICE 判死（前端未实现 ping）。
- 审查 nit：`rtc-wake` 集成测试的吊销用例已改为在线后吊销的第三节点。
- run 11 出现一次 E2 偶发失败：node-a 重启后首个 uplink 连接挂到 20s 超时（`reason=timeout`），8s 的终端 hello 落在该窗口内；run 8–10 均通过。harness 可在 E2 前等待 `[uplink] online`；uplink 日志里 `reason=unknown` 的分类可再细化。
- 本机为绕过 TUN 加的主机路由 `sudo route -n delete -host 43.248.129.233` 可删。

## 六、清理

远端 43.248：`tmex-split` compose 栈、镜像、`/root/tmex-e2e`（acme/证书/接收器）、nginx 根目录 `tmex-e2e/`、`u*`、`d*`、`stun.ts`、`nat.ts`、ufw 18443/3478/39900/49160-49200。本机：`tmex-split-local` compose、`tmex-e2e:split` 镜像保留。tunnel 机：`~/tmex-e2e`（tarball/package/ca/日志）与 `tmex-e2e` tmux 窗口由用户决定是否保留；其 tmex 已升级为本次构建并已 `hub leave`（standalone）。
