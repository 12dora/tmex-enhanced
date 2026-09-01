# 第十三轮：节点升级修正 + 多 hub（主/备）

## 背景

- 生产 mesh 混合版本：本机 `konata-mac` 1.1.10（entry，`node` 角色），hub `tmex`（境内 VPS `ai.jiefakj.com:18443`，1.1.5，`hub,node`），`jiefa-app`/`jiefa-dns-1` 1.1.10，`docker-node` 1.0.2。
- 探索报告：`sub/EX1-result.md`（升级链路）、`sub/EX2-result.md`（节点页前端）、`sub/EX3-result.md`（多 hub 架构分析，57 KB）。
- 只读探针（`scratchpad/probe-hub-info.ts`，Playwright 登录本机生产 UI 后 GET）实测：
  - 转发到 hub 的 `/n/<hub>/api/system/info` 正确返回 `baseVersion 1.1.5, canSelfUpdate true`——后端节点解析没有错。
  - hub 的 `/api/system/upgrade` 状态为 `idle` + `error: "The socket connection was closed unexpectedly…"`，`startedAt 2026-09-01T10:16Z`：用户点了升级、hub 确实开始下载，但 **hub 所在 VPS 访问不了 GitHub Releases**，下载失败。UI 先弹「已开始升级到 1.1.10」，用户理解为「已更新」。
  - `docker-node` 1.0.2 没有 `/api/system/info|upgrade`（1.1.0 才有）→ 404 → `UPGRADE_UNSUPPORTED`「不支持程序内更新」。

## 目标

1. 节点管理：全部升级按钮（普通节点→远端 hub→本机）、最新版置灰、过旧/不可自更新节点给出明确原因（已完成，commit `0e5614a7`）。
2. 远程升级不再依赖目标机能访问 GitHub：**entry 下载 + SHA256SUMS 校验 → 经 peer link 推送 tarball 到目标 → 目标从本地暂存包升级**；目标能力由 `/api/system/info.upgradeCapabilities` 声明，旧目标回落原「目标自行下载」路径。
3. 多 hub 第一阶段（方案 A）：
   - 任一已加入的节点可用 CLI 变成 **standby hub**（`hub,node` + `TMEX_HUB_MODE=standby`），仍以 node 身份 uplink 到主 hub；
   - 主 hub 把 hub 集合（`hubs[]`：nodeId/publicUrl/mode/priority/writerEpoch/online）随 `node.list` 广播；所有节点落 `mesh_hubs` 表；
   - 节点 uplink 改为 **有序 failover**：active(最高 writerEpoch) → standby(按 priority)；主 hub 恢复后自动切回；
   - standby 复制签名状态（key log/证书由既有 catch-up 覆盖）+ 注册表（由 `node.list` 投影到 `nodes`），拒绝所有写操作（`HUB_NOT_WRITER`，附 writer 地址）；
   - 显式 `tmex hub promote|demote`（epoch 单调递增；active 见到更高 epoch 的 active 自动降级，防脑裂）；
   - FE 节点页显示 hub 集合、主/备、当前挂载 hub；
   - 不做：自动选主、多 primary、hub 间 relay、浏览器按 RTT 选 hub（第二阶段）。

## 任务清单与分工

| ID | 角色 | 内容 | 文件范围 |
|---|---|---|---|
| O1 | Opus | 全部升级 + 置灰（已完成） | `apps/fe/.../nodes/management/*`、locale `nodes.upgrade` |
| G1 | grok | 共享契约（`hubs[]`、node.status hub 广告、`HUB_NOT_WRITER`）、config（`TMEX_HUB_MODE/PRIORITY/WRITER_EPOCH`）、迁移 `mesh_hubs`、`MeshHubStore` | `packages/shared/src/uplink/codec.ts`、`apps/gateway/src/config.ts`、`db/schema.ts`、`drizzle/00xx`、`auth/mesh-hub-store.ts` |
| G4 | grok | 升级包中转：目标 `PUT /api/system/upgrade/package`、`POST {source:'staged'}`、`upgradeCapabilities`；entry 侧 `RemoteUpgradeJob`（下载缓存、推送、状态） | `apps/gateway/src/system/*`、`api/system.ts`、`mesh/forwarder.ts`、`packages/shared/src/contracts/system.ts` |
| G2 | grok | 节点侧 uplink 有序 failover（`UplinkPool`）、`mesh_hubs` 持久化、`/api/mesh/hubs`、`/api/mesh/nodes.isHub` 多 hub | `mesh/uplink-client.ts`、`mesh/mesh-runtime.ts`、`mesh/mesh-routes.ts`、`mesh/node-list-projection.ts`、`mesh/peer-manager.ts`（relay 诊断） |
| G3 | grok | hub 侧：mode/priority/epoch、standby 拒写、hub 广告收集与 `hubs[]` 广播、standby 注册表复制、epoch 围栏 | `apps/gateway/src/hub/*` |
| G5 | grok | CLI `hub standby|promote|demote|list`、runtime 装配接线、运维文档 | `packages/app/src/commands/hub.ts`、`runtime/assemble.ts`、`docs/hub/*` |
| O2 | Opus | FE hub 集合展示、`HUB_NOT_WRITER` 提示 | `apps/fe/src/node/*`、nodes 页 |
| G6 | grok | 进程内集成测试：主备复制/故障切换/切回/拒写/围栏 | `apps/gateway/src/mesh/integration/*` |
| RV* | codex sol | 分批审查 | — |

## 验收

- fe / gateway / app / shared 单测全绿，tsc 不高于基线（gateway 0、fe 0、stores 1、api-client 5、app 1、shared 0），biome 干净。
- 临时双实例（仓库内、独立端口/独立 tmux socket）实测：entry 推送包到目标完成升级（用本地 tarball 模拟 release）；主 hub 停机后节点切到 standby、`/api/mesh/hubs` 正确、恢复后切回。
- 发版 1.1.11 并替换本机；hub `tmex` 与 `docker-node` 需各手动升级一次（旧版无法接收推送）。

## 风险

- 混合版本：`node.list` 新字段必须被旧节点解码器容忍（G1 需核对 `v1.1.5` 的 codec），否则旧节点整帧丢弃。
- 脑裂：仅靠 epoch 围栏 + 显式 promote；文档明示「旧主恢复前先 demote」。
- 大包经 relay 推送（~20 MB）占用 hub 带宽；并发上限由 FE 批量并发 3 与 entry 侧单版本下载缓存共同限制。
