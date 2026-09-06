# Round 32 计划：中继运营限额 + 节点间文件传输 + 端口映射

## 背景

- 分支 `feat/round32-relay-quota-transfer-portmap`，worktree `/Users/konata/code/tmex-r32`，基线 main `cba94cc9`（1.1.36）。开工前已把 r18–r31 全部并入 main 并清理 worktree/分支，只剩 `main`/`legacy`。
- 探索报告：`sub/EX1-relay-quota.md`（中继配额/数据面）、`sub/EX2-file-transfer.md`（文件传输链路）、`sub/EX3-mesh-tunnel-portmap.md`（mesh 传输/隧道）。接手先读三份报告。
- 基线（`scratchpad/baseline/SUMMARY.md`）：八包 tsc 0；gateway 4913 pass / 10 fail（9 个 `mesh phase-2 integration` 环境性 + 1 个 DC 8 MiB flake），其余包全绿。
- 文案规范 `/Users/konata/code/tmex-copy-guidelines.md`；zh_CN 为源，en/ja 同步；改完 `bun run build:i18n`。
- 关键既有事实（EX1/EX3）：
  - 中继数据面唯一 choke point 是 `apps/gateway/src/relay/relay-stream-router.ts` 的 `pumpMetered`；已有租户级 `RelayTokenBucket`（延迟不丢、流间轮转、≤4 KiB 旁路道），三档配额 `maxNodes / maxStreams / bandwidthBytesPerSec` 随 `relay.quota` ctl 推给租户。
  - 中继流承载的是节点间整个 peer 会话（SecureChannel + LinkMux 嵌套），中继看不到 HTTP 头/文件大小；文件大小限制只能「中继发布、节点执行」。
  - 每个 mesh 传输（dc / ws-secure / relay）最终都是同一个 `LinkMux`，`PeerManager.getLink(nodeId).openStream(payload)` 即可开任意双向字节流；新增流类型只需改 `classifyOpenPayload` + `handleInboundStream`。
  - `relay-uplink-server.ts`（571）、`relay-metrics.ts`（586）、`packages/shared/src/relay/codec.ts`（563）逼近 600 行门禁，新逻辑一律新文件。
  - 新迁移必须同时追加到 `apps/gateway/src/db/managed-migrations.ts`。

## 第一部分：中继运营限额（R1）

### 存储
- 迁移 `0049_relay_limits.sql`：`relay_config` 新增 `max_tenants integer`（null 不限）、`total_bandwidth_bytes_per_sec integer`（null 不限）、`fair_share integer not null default 1`。
- `RelayQuota` 新增 `maxFileBytes: number | null`（可选字段，旧端忽略），随 `quota_json` / `default_quota_json` 与 `relay.quota` 推送。

### 后端
- 新文件 `relay-limits.ts`：`RelayLimits` 类型、`normalizeRelayLimits`（400 `RELAY_BAD_LIMITS`）、序列化。`relay-config-store.ts` 增 `setLimits`。
- 最大租户：`issueTenantToken` 的 `!existing` 分支、密码校验之后：`tenants.count() >= maxTenants` → 409 `RELAY_QUOTA_TENANTS`。重发 token 与 `join` 不受影响。
- 总带宽 + 公平分配：新文件 `relay-bandwidth.ts`，`RelayBandwidthLimiter` 持有一个中继级 `RelayTokenBucket(total)` 与「每租户一个父流」（fair share 开）或单一默认流（关，FCFS）。`pumpMetered` 中 `await tenantLimiter.take()` 之后 `await globalLimiter.take()`，再 `recordAdmitted`。`pumpRelayPair` 的 abort/finish 同步关闭。`setLimits` 后热更新 rate。
- 指标：`RelayMetricsTotals` 增 `bandwidthLimitBytesPerSec`、`maxTenants`、`fairShare`（计算放 `relay-bandwidth.ts`）。
- `GET /api/relay/status.config` 增 `limits`；`PATCH /api/relay/config` 接受 `{ limits }`；`health` 不暴露。
- 节点侧：`maxFileBytes` 透传 `GET /api/mesh/relay/status.quota`；新文件 `apps/gateway/src/files/transfer-limit.ts` 提供 `effectiveTransferMaxBytes()` = `min(config.transferMaxBytes, relayQuota.maxFileBytes ?? ∞)`（节点是中继租户时生效），在 `file-transfer-routes.ts` upload init 与 `device-storage.ts` 下载两处调用；超限返回既有 `too_large` 语义 + 错误码 `RELAY_QUOTA_FILE_SIZE`。第二部分的节点间传输引擎复用同一 helper。
- 修既有漂移：`RELAY_QUOTA_LIMITS.maxNodes` 4096 vs 服务端 256。

### 前端 / CLI / 文案
- `quota-fields.tsx` 第四项「单文件上限（MB）」（默认配额弹窗与租户编辑共用）；`relay-menus.tsx` 页头菜单新增「中继限额」弹窗（最大租户数、总带宽上限、租户带宽公平分配开关）；指标磁贴带宽显示 `已用 / 上限`；租户侧连接详情第四行「单文件上限」。
- CLI：`tmex relay limits --max-tenants --total-bandwidth-kb --fair-share on|off`，`relay quota` 增 `--max-file-mb`；help 中英双块。
- i18n：`relay.admin.limits.*`、`relay.admin.quota.maxFile*`、`relay.tenant.errors.RELAY_QUOTA_TENANTS / RELAY_QUOTA_FILE_SIZE`、`nodes.machine.details.quotaMaxFile`。
- 文档：更新 `docs/relay/2026090304-relay-role.md` §6/§7/§8/§11、`docs/relay/2026090403-relay-metrics.md`，新增 `docs/relay/2026090604-relay-limits.md`。

### 测试
- `relay-units.test.ts`：两租户共享总带宽约 50/50；单租户空闲中继不被限；toggle 关闭后 FCFS；`maxFileBytes` 规范化/往返。
- `relay-admin.test.ts`：limits PATCH/校验；`relay-routes.test.ts`：满员 409、重发 token 放行；`relay-membership.integration`：按 admitted 字节断言。
- 契约测试：codec back-compat、api-client、fe relay-forms/relay-ui、app relay-shared/args。

## 第二部分：设备页三点菜单 + 节点间文件传输 + 端口映射

详见 `plan-01-transfer-portmap.md`（EX2 到齐后补充）。要点：
- 共享传输引擎（切片 / 并行流 / 断点续传 / 哈希）作为唯一上游，浏览器上传、节点间传输、升级推包共用。
- 端口映射：新增 `tcp` 流类型，A 机 `Bun.listen`、B 机 `Bun.connect`，复用 LinkMux 信用流控；B 侧白名单；持久化 `port_maps` 表并开机恢复；占用端口检测；中继模式下节点侧本地令牌桶。
- 设备页右上角三点菜单：恢复布局 / 文件传输 / 端口映射。

## 分工与并行
- R1（Opus，中继运营）：上述第一部分，范围 `apps/gateway/src/relay/**`、`packages/shared/src/relay/**`、`packages/api-client/src/relay/**`、`apps/fe/src/pages/settings/relay/**`、`apps/fe/src/pages/settings/nodes/relay/**`、`packages/app/src/commands/relay-*`、`apps/gateway/src/files/transfer-limit.ts`（新）、`file-transfer-routes.ts:47` 与 `device-storage.ts` 两处定点调用、locale `relay.*` 子树。
- T1（Opus，传输引擎 + 节点间传输后端）、T2（Opus，端口映射后端）、F1（Opus，前端菜单/两个弹窗）：见 plan-01。
- 指挥官：契约拍板、build:i18n、分批 commit、codex 审查、临时多实例实测、发版 1.1.37、`tmex upgrade` 替换本机。

## 验收
- 中继：设最大租户 N 后第 N+1 个 enroll 409；两租户并发灌流量时 admitted 速率各占总上限约一半；单文件上限生效于租户节点上传/下载 init。
- 八包 tsc 0、`bun run lint` 通过、单测不低于基线。
