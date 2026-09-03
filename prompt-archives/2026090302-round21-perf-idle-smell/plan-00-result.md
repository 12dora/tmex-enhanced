# 第二十一轮执行结果

分支 `feat/round21-perf-idle-slim`（base main `e4ae3dd2` / 1.1.20），26 个 commit，291 文件 +24315 / −6259。

## 一、终端与界面流畅度（任务 1）

前六/七轮的终端性能工作全押在「应用写入 → 脏行最小化」，基准四个场景**全是 write 驱动，从未测过视口滚动**。
滚动是另一条轴：内核把整屏标脏，而实际内容是精确的整行平移。本轮补上这条轴。

实测（Apple Silicon，Bun 1.3.14 + Headless Chromium 145 / DPR 2，120×40）：

| 项 | 优化前 | 优化后 |
|---|---:|---:|
| 滚一行的 WASM 桥（`iterateRows`） | 0.97 ms | **0.042 ms**（24×） |
| 每帧脏行数 / 全量帧 | 40.0 / 200 帧全是 full | **1.0 / 0 帧 full** |
| Canvas 整屏绘制 | 5.03 ms | **1.56 ms**（3.2×） |
| 隔离的 `fillText`（3912 次） | 2.77 ms | **0.62 ms**（4.5×） |

落地手段：

- **滚动改 rAF 合并**。此前 `scrollLines()` 在 wheel/touchmove 处理器里同步跑完整渲染，两个监听器都是
  `passive:false`、事件率 60–120 Hz ⇒ 每秒 480–960 ms 主线程，且一帧内只有最后一次结果能上屏。
- **canvas run 批绘**：同前景色/同字体变体的连续窄 cell 合并成一次 `fillText`，同底色合并成一次 `fillRect`，
  font/fillStyle 状态去重。字形 advance 漂移用自调节 `maxRun = clamp(floor(0.4/|残差|), 1, cols)` 兜底。
- **位移感知行复用**：用相邻两次真实 `readScrollbar().offset` 之差（不是请求滚动量，避免贴边 clamp 造成假位移），
  在无输出、几何与配色未变时以 `settled[i+d]` 为比对基线；canvas 侧主/备画布 ping-pong 单次纵向 copy
  （实测两跳 scratch 4.16 ms 并不优于自拷贝 4.09 ms，故未采用），只补画新曝光行。
- **消除事件处理器内的强制同步布局**：滚动条 height 是布局属性却被无条件写，`trackHeight` 每帧读；
  pan 模式每个 wheel 读 4 个布局属性。全部改为写前比对 + 缓存 + `contain: layout paint style`。
- **输入延迟**：UI store 此前没有 storage 覆盖，敲一个字符就要把 17 个持久化键（含 50 条历史与全部草稿）
  `JSON.stringify` 并同步 `setItem`；改为按字段比对 + 草稿 ≤300 ms 合并写。
- **列表重渲染**：文件树/设备树的 `useLocation()` 在每个节点里调用，切一次 tmux pane 就重渲染整棵树；
  改为树根读一次、每行订阅自己的派生布尔量。侧栏拖宽从每个 pointermove 一次同步 `localStorage` 改为
  rAF 合并 + pointerup 落一次。

## 二、常驻与待机功耗（任务 2）

现场实测（生产节点，只读）：网关空闲 **5.65% 单核**（RSS 310 MB）；`tmex.log` **81 MB / 96k 行且无任何轮转**
（macOS launchd `StandardOutPath` 直写，跨版本升级仍追加）；近 50k 行里 `[ws-metrics]` ≈64k、`[mesh][rtc]` ≈20k。

服务端：

- `[ws-metrics]` 三条巨行每 30 s 一发且**全零也发**，且「读一次指标 = 全量清扫一遍所有 pane 并重排 timer」。
  改为全零不发、`snapshotStats()` 纯读。空闲日志约 −8640 行/天。
- 日志分级（`TMEX_LOG_LEVEL`，缺省 info）+ macOS 按行边界 rename 轮转（16 MiB × 3 代，不 truncate launchd 持有的 fd）。
  RTC 拨号 chatter 降 debug，`breaker trip`/`dial failed`/状态迁移保持 info。
- `os.networkInterfaces()` 每 15 s 被调 1+N_peer 次 → TTL 缓存后约 1 次；key-log head 每 peer 每 15 s 一次
  `users` SELECT → 进程内缓存 + 变更失效；`node_sessions` 每会话每 5 min 一次写事务 → 剩余寿命过半才写。
- 事件循环 lag 采样空闲降到 10 s 一拍；并把 wall/mono 漂移记为 `suspend` 而非 `lag`
  （此前观测到的 `max_lag_ms=56675` 其实是整机睡眠，这个指标一直在误导）。
- tmux control-mode 心跳：区间内有终端输出即视为存活并跳过这一拍。

PWA：

- 光标闪烁从 `setInterval` 改 CSS 动画（后台标签页浏览器自动暂停），保活池不可见实例关闭动画。
  实测基线一个终端页约 192 次 JS 唤醒/分钟，其中 **180 次来自光标闪烁**。
- 手机键盘 follow 循环的进入条件不是「键盘弹起」而是「终端聚焦且光标可见」，
  ⇒ 只要终端聚焦就 60 Hz 常驻、每帧强制同步布局。改为写前去重 + 收敛后退出 + 廉价探针。
- WebRTC `getStats()` 2 s 轮询此前无可见性判断且把实时浮点 RTT 计入相等性判据，几乎每拍唤醒诊断订阅者。
  改为隐藏即停 + RTT 5 ms 分桶；后续审查又指出改动把「等上一次完成」丢了，已改回。
- `useHubNodes` 的裸 `setInterval` 补上与既有 `startPolling` 一致的可见性门控。

**没有做的**：O13（RTC liveness 3 s → 15 s）与 O14（零客户端时挂起 mesh 快节奏）都会改故障检测阈值，
风险与收益不成比例，明确不做。

## 三、code smell（任务 3）

`bun run lint` 从**失败 24 条**变成**全绿**（`complexity gate ok`）。

- 重构消解：`peer-manager.ts` 2540→1930（拆 DC 升级协调器与 RTC wake 门）、`auth-routes.ts` 1091→766、
  `mesh-runtime.ts` 1658→1559、`ws/index.ts` 941→829、`direct-carrier-controller.ts` 1200→1113、
  `assembleTmex` CC 21→10、`resolveAcmeDnsPatch` CC 33→10、`dialWsSecureCandidate` CC 22→10、
  `handleUplinkNodeList` CC 21→1、前端设置页三处超限函数。
- 去重：拨号熔断器（网关/浏览器两份同构状态机）合到 `packages/shared/src/net/dial-breaker.ts`；
  `readBodyCapped` 这类**安全边界**不再两份实现。
- allowlist 从 151 条 `--tighten` 到 141 条，剩余 8 条逐条补写理由（纯条件 JSX / 装配根 /
  拨号失败分类扁平分派 / 测试夹具参考实现）。三个失败分类器**有意不合并**：入参、返回语义、下游消费方都不同。

## 四、代码库精简（任务 4）

- 死代码约 1600 行：6 个无人 import 的 barrel、约 20 个零引用导出、`contracts` 僵尸类型、10 个 spike 脚本。
  每条都重新 grep 复核；canonical 全部符号、rtc `@deprecated` 别名、weixin 逆向协议常量表等**保留并写明理由**。
- 依赖 8 个：`shadcn`（runtime 依赖但 0 import）、`tw-animate-css`、`@fontsource-variable/geist`、
  `autoprefixer`/`postcss`（全仓无 postcss config）、`uuid`+`@types/uuid`（5 处改 `crypto.randomUUID`，
  同一代码库已用 83 次）、panels 的 `ghostty-terminal`；以及从未生效的 `apps/fe/tailwind.config.ts`。
- 首屏 gzip **376,321 → 345,670 B**（−8%）：watch 对话框与 `@dnd-kit` 移出入口、`highlight.js` 跨构建格式去重。
- **内置字体不动**（用户决定）：16 MB 只影响安装包体积，浏览器按需只取一种。

## 五、canonical 状态流迁移（用户本轮拍板）

服务端 canonical feed（约 2544 行）自建好起从未跑过——浏览器有解码器却没有命令编码器，谁也发不出 0x0901。
本轮补齐五种命令、capability 门控与 legacy 回退、订阅 ACK/epoch/gap 语义、metadata/screen/history 事务组装，
并让 `stream-replay-state.ts` 里原先不可达的 canonical failover 分支真正生效（按 cursor 精确补流，
不再走 `buildLegacyHistoryRequests()` 的整段历史重放）。kill switch：`localStorage['tmex.disable-canonical-state']`。

## 六、审查发现与修复

三个并行 reviewer（backend / libs / frontend）对全量 diff 复审，提出 22 项，判定后修了其中 16 项，包括：

- **同步输出期间滚动会吞掉真实脏行**（HIGH）：DECSET 2026 激活时不排帧 ⇒ `outputSinceRender` 为 false ⇒
  位移复用消费掉 dirty 位却丢弃新内容，下一帧读到 clean，**错误画面永不自愈**。改为把「有写入」与「立即排帧」拆成两个状态。
- canonical `epoch_changed` 无退避重发风暴；retry 定时器在降级 legacy 后吞掉请求；
  metadata assembly 无字节预算（约 1 GiB 上限）；cursor miss 的 gap 在背压时静默丢失。
- 会话续期在 hard TTL 前最后 9 小时**每个请求**写一次库；日志轮转漏切 fd 2；WS 关闭原因未净化就入日志。
- 懒加载边界缺失败恢复（chunk 404 会替换整条路由且 `React.lazy` 缓存拒绝状态）。

**未修并说明理由**：日志逐行同步写盘（改动前 `console.log` 同样是同步写同一个 fd，非本轮引入）。

## 七、独立发现并修复的真实回归

多 hub 主备切换后新写者无法 redeem（409 `HUB_NOT_WRITER`，写者仍指向已崩的 A）。
二分定位到 auth-routes 拆分那个 commit，但真因是既有的 dual-role 自连 TOCTOU：
B 提升后，作为 node 连到自己时仍持有提升前的 `node.list` 快照，经 `replaceAll` 把刚写入的本机行盖掉。
hub 侧的 `applyReplicatedNodeList` 本来就 overlay 本机行，node 侧这条路径没有。已加不变量测试。

## 八、验收数据

| 项 | 结果 |
|---|---|
| gateway | 3831 tests，隔离复跑全绿（全量并行下 4–5 条既有 flake） |
| fe / panels / stores / ws-client / ghostty / terminal-ui / ui / shared / api-client / app | 全绿（app 仅已知 cpu-features 一条） |
| `bun run lint` | biome + complexity gate 全绿 |
| 首屏 entry gzip | 376,321 → 345,670 B |
| 滚动 bench | dirtyRows 40→1、full 200/200→0/200、mean 1.12→0.042 ms |

## 九、遗留

- `@base-ui/react` 的 trigger-gated select/menu/dialog/tooltip（约 154 K rendered）仍在首屏，`packages/ui` 本轮未动。
- 文件树无虚拟化（`DISPLAY_CAP=500` + 显示全部）；`content-visibility: auto` 是更便宜的中间步骤。
- 拖拽实现落地必然重挂子树（空样板 0 hook vs `useSortable` 一串 hook），要彻底消除需把若干行组件改成 render-prop 桥接。
- O13/O14 两项待机优化按风险判定不做。
