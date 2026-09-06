# Round 32 执行结果：中继运营限额 + 节点间文件传输 + 端口映射（1.1.37）

分支 `feat/round32-relay-quota-transfer-portmap`，worktree `/Users/konata/code/tmex-r32`，基线 main `cba94cc9`。
开工前把 r18–r31 全部并入 main，清理了 14 个 worktree 与本地/远端旧分支（只留 `main`、`legacy`）。

## 一、交付

### 1. 中继运营限额（R1 / R2）
- `relay_config` 新增 `max_tenants` / `total_bandwidth_bytes_per_sec` / `fair_share`（迁移 0049）；`RelayQuota.maxFileBytes` 可选字段随 `relay.quota` 下发（旧端忽略）。
- 满员 enroll → 409 `RELAY_QUOTA_TENANTS`（验密之后、创建之前重读上限）；重发 token 与 join 不受影响。
- `relay-bandwidth.ts`：中继级 `RelayTokenBucket`，公平分配开启时每租户一个父流按轮转均分，关闭为 FCFS；`pumpMetered` 先过租户桶再过全局桶。审查后：按句柄取消（中止不残留队列）、全局桶关闭 ≤4 KiB 旁路道并只发整块（否则 8 流 vs 1 流实测 8.18:1，修后 0.895）。
- 指标 totals 带 `bandwidthLimitBytesPerSec` / `maxTenants` / `fairShare`；「中继限额」弹窗、配额第四项「单文件上限（MB）」、租户侧第四行；CLI `tmex relay limits`、`relay quota --max-file-mb`；表单往返保留原始字节值；CLI 空值标志快速失败。
- 节点侧 `files/transfer-limit.ts` 的 `effectiveTransferMaxBytes()` 统一上传 init / 下载 / 节点间传输的单文件上限（中继发布、租户节点执行；带宽上限才是硬保护，文档已明示）。
- 修既有漂移：`RELAY_QUOTA_LIMITS.maxNodes` 4096 → 256。

### 2. 共享传输引擎 `@tmex/transfer`（T1 / T3）
- 新包：`ProgressTracker` / `throttleProgress`（唯一速率实现，替换 4 处重复）、`bytes` / `chunker` / `ranges`、`runPush`（offset 协商、N 个不相交区间并行、退避 `[1,2,4,8,15,15,15]s`、deadline 派生中止信号、取消优先）；Node 侧 `openRange`、`ResumableSink`（append 增量哈希 / ranged 预分配 + 位图 sidecar 原子发布 + 整文件校验；短 body 保留 `.part`；`commit(d, {onConflict})` 用 `link(2)` 原子无覆盖、rename 直接覆盖、按 `.part` 串行、排空活跃写者后封印）。
- 三个消费者改接：升级推包（194 个既有测试零改动通过）、浏览器上传（乱序区间 PUT、默认 4 流 / 中继 2 流、续传）与下载（HTTP Range 续传、会话到显式删除或 TTL）、RTC bulk 快路径（帧长统一 16 KiB）。本地设备下载不再 rsync 复制。
- `SystemInfo.transferCapabilities = ['transfer-v2','transfer-ranged-parallel']`。
- 引擎审查修复 11 项：短写入按实际字节循环、区间预留 / 已确认区间不可变、位图持久化失败上抛、`maxWriteBytes` 恒传、下载建连纳入重试、重试常量单一来源等。发现并修复 ranged sink `'w+'` 截断并发写入的真 bug。

### 3. 节点间文件传输（T1 / T4）
- 流程：浏览器 `POST /n/<B>/api/transfer/grants`（10 min 一次性，绑定 fromNodeId / destRootId / destPath）→ `POST /n/<A>/api/transfer/jobs` → A 经 peer 链路（dc / ws-secure / relay 自动选择）在 B 上开 mesh-internal 会话 → 并行区间 PUT → commit；进度 `GET .../jobs/:id/events`（NDJSON，snapshot → progress/item/state → end，有界订阅缓冲）。
- 审查修复 17 项：授权目录 realpath 边界 + symlink 安全遍历（本地 / SSH）、原子 skip（SSH 用 `rsync --ignore-existing`）、`rsync --list-only -r` 递归枚举替代 2000 条截断列表、同名相对路径 `dest_conflict`、准入上限（每用户 8 / 全局 32 任务；会话 5000 文件 / 64 GiB / 16 活跃写 / 每对端 4 会话）、取消贯穿本地通道 / 驱动 / sink / 远端 rsync、会话关闭态与按字节活跃保活、SSH 落地后才 committed、运行器终态兜底、forwarder 失败取消包裹体、跨会话稳定的 `.part` 身份 + 孤儿清扫、完成任务定时驱逐、空目录条目、统一错误归一化。
- 文档 `docs/files/2026090604-node-to-node-transfer.md`。

### 4. 端口映射（T2 / P2 / P3）
- 新流类型 `tcp`（`classifyOpenPayload` + `handleInboundStream` 分派），A 机监听、B 机 `port_map_exports` 放行表（`mapId` + `fromNodeId === peer` + enabled）+ 拨号；`port_maps` / `port_map_exports` 表（迁移 0050），开机恢复；占用 / 保留端口探测；`/api/portmap*` 路由；A 删除时经 peer 清理 B 放行并回报 `exportRemoved`。
- 中继无需改动：隧道走既有 peer 中继流，自动受租户配额计量，不额外占 `maxStreams`。每对端 48 流共享预算（防 `MAX_LINK_UNACKED` 65 MiB 拖垮整条链路），每映射 64 连接。
- 半关闭：Bun 1.3.14 的 `socket.end()` / `shutdown(true)` 都做不到写半关闭，用 `bun:ffi` 调 libc `shutdown(fd, SHUT_WR)`（不可用回退 `end()`）。
- **实测发现的 Bun 背压问题（P3 重做 socket 层）**：`Bun.listen` / `Bun.connect` 的 `pause()` 只在首次 `resume()` 之前可靠，之后在持续灌入下基本失效（pending 实测 32–43 MiB），大流量映射被 `portmap-buffer-overflow` RST。`node:net` 的 `pause()` 是真背压（远端阻塞、0 字节漏进），但 Bun 的 shim 忽略 `createServer({allowHalfOpen})`，须在每个 socket 实例上置 `allowHalfOpen = true` 才不会一收到 FIN 就销毁；配合对 `_handle` 做 FFI `shutdown(SHUT_WR)`，两侧「FIN 后延迟回复」均可收到。socket 层据此改为 node:net + 实例 allowHalfOpen + FFI 半关闭。
- 文档 `docs/mesh/2026090604-port-mapping.md`。

### 5. 前端（F1 / F2）
- 设备页右上角三点菜单：文件传输 / 端口映射 / 恢复默认布局（保留确认框与 test id）。
- 双栏文件传输弹窗（节点 + 根目录选择、面包屑、复选多选 + Shift 区间（按路径锚点）、键盘、发送到左 / 右、传输列表：大小 / 速度 / ETA / 进度 / 状态 / 路径徽标 / 取消 / 清除已完成）；传输任务 store（模块级 Map + `useSyncExternalStore`，NDJSON 订阅 + 重连 + 404 收敛）统一浏览器上传 / 下载与节点间任务，toast 改为渲染器。
- 端口映射弹窗（聚合列表 2 s 轮询、探测门控的创建表单、暂停 / 继续 / 删除、放行记录待清理与重试、创建失败先核对再回滚）。
- i18n 三语；`formatEta`。

### 6. 其它
- 打包迁移清单漏加 0049 已修，并加守卫测试（清单 = drizzle journal = 目录）。
- 实测 harness `apps/fe/tests/helpers/relay-boot.ts`（relay,node + 两个租户节点，从源码拉起）+ `docs/testing/2026090604-relay-live-harness.md`。

## 二、审查
codex gpt-6-astra high 五路（端口映射 / 中继 / 前端 / 引擎 / 节点间传输），报告在 `sub/R1-*-review.md`；除「diff 拆分产物」一条外全部采纳修复（P2 / R2 / F2 / T3 / T4）。

## 三、验证
- 八包 tsc 0；`bun run lint`（biome + 复杂度门禁）通过，无 allowlist 新增。
- 单测：gateway 5050 pass / 10 fail（全部为既有基线：9 个 `mesh phase-2 integration` 环境性 + 1 个 DC 8 MiB flake），fe 2801、panels 1070、api-client 282、shared 799、app 949、transfer 60、ws-client 413、ui 414、stores 435、notifications 23，均 0 fail。
- 实测（中继拓扑 R 19851 / A 19852 / B 19853，B 经 A 为 relay；hub 拓扑 19771/19772）：
  - 文件传输 A→B（两种拓扑）：60 MB + 3 MB + 目录（含空目录）全部 sha256 一致、空目录创建、`skip` 生效、`../` 越界 `outside_roots`、grant 一次性（第二个任务 `grant_invalid`）。
  - 中继限额：`PATCH /api/relay/config {limits}` / 400 / 指标 totals / CLI `relay limits` 均正确；总带宽 2 MiB/s 下 20 MB 传输 10 s、中继计量 2.10 MB/s；`maxFileBytes` 10 MiB → 节点间条目 `quota_file_size`、上传 init 413 `too_large`（带 maxBytes）、5 MB 放行。
  - 端口映射（P3 重做后，中继拓扑）：探测（空闲 / 保留 / 占用 409）、创建、100 B / 5 / 20 / 50 MiB 全双工往返（50 MiB 195 MB/s）、半双工「发完 FIN 再读响应」、8 并发 × 2 MiB、暂停拒连 / 继续、删除后 B 放行记录同步清理、端口释放全部正确；P3 自测 200 MiB 往返与慢消费者下 pending 峰值 1.5 MiB。中继总带宽 2 MiB/s 下 10 MiB echo 往返（中继转发 20 MiB）9 s，中继计量 2.3 MB/s，配额对隧道流量生效。
  - UI 截图核对：菜单、双栏弹窗（列表正确聚合 API 创建的任务）、端口映射弹窗。
- Playwright：非 mesh 受影响用例（devices / files-context-menu / settings-files / sidebar-device-disclosure）8/8；mesh 项目（login / notify / passkey / share）17/17。

## 四、遗留 / 注意
- `maxFileBytes` 不适用于端口映射（无声明大小），带宽配额是唯一控制；已写入文档。
- 最大租户数的「N+1 enroll → 409」只有单测 / 集成覆盖，未做四进程实测。
- SSH 目标目录在远端 realpath 检查与 rsync 之间仍有 TOCTOU 窗口（本地无）。
- `relay-uplink-server.ts`（597）、`relay-metrics.ts`（594）逼近 600 行门禁，后续中继改动一律新文件。
- 直连 / WebRTC 在本机回环无法升级（endpoint backoff），实测传输路径均为 relay；DC 路径靠 `rtc-loopback` 与集成测试覆盖。
