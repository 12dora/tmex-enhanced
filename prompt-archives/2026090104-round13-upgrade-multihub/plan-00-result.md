# 第十三轮执行结果：节点升级修正 + 多 hub 主备（v1.1.11）

## 交付

| 目标 | 结果 |
|---|---|
| 1.1 docker-node「不支持程序内更新」 | 根因：1.0.2 没有 `/api/system/info|upgrade`（1.1.0 起才有）。FE 对 <1.1.0 的节点置灰并提示手动升级；`UPGRADE_NOT_ALLOWED`（无服务管理器/容器）文案改为明确原因。docker-node 已手动升到 1.1.10。 |
| 1.2 hub `tmex` 点升级「已更新到 1.1.10」实际未更新 | 根因：用户点击后 hub 确实开始升级，但 hub 所在 VPS 访问不了 GitHub，下载失败（`socket closed`），UI 只见「已开始升级」。修法：**远程升级改为入口下载 + 经 peer link 推送暂存包**（`PUT /api/system/upgrade/package`、`POST {source:'staged'}`、`upgradeCapabilities`），旧目标回落原路径。hub 已用文件上传 + 终端离线升级到 1.1.10（`sub/hub-upgrade.ts`）。 |
| 1.3 全部升级按钮 | 「添加」左侧，普通节点并发 3 → 远端 hub → 本机，行内/批量互斥，一条「成功 X，失败 Y」汇总。 |
| 1.4 最新版置灰 | `compareSemver(row.version, latest) >= 0` 置灰并 tooltip；latest 未知不猜。 |
| 2 多 hub | phase 1：主/备、单写者、有序 failover（3 次/20 s）、60 s±20 % 探测切回（make-before-break）、注册表由 node.list 复制、standby 拒写 `HUB_NOT_WRITER`、epoch 围栏且跨重启持久、hub 间 60 s 状态探测；**仅 `TMEX_HUB_PEERS` 授权节点可成为 hub**。CLI `hub standby|promote|demote|list|allow|disallow`；FE HubStrip/主备徽标/standby 只读提示。文档 `docs/hub/2026090104-multi-hub-standby.md`。 |

## 提交（分支 `feat/round13-upgrade-multihub`）

O1/O2 前端、G1 契约、G2/G2b/G2c/G2d 节点侧、G3/G3b/G3c/G3d hub 侧、G4/G4b/G4c 升级中转、G5/G5b CLI、G6/G6b 集成测试、link 背压两次修复；codex 审查 RV1–RV4 的 blocker 全部修复（详见 `sub/*-result.md`）。

## 验证

- 单测：gateway / fe / app / shared / api-client 全绿（见最终门禁数字于本文末）；tsc 基线不变（stores 1、api-client 5、app 1 为既有）。
- 集成：`multi-hub.integration.test.ts` 15 场景、`hub-peer-poll`、`large-push`（24 MiB relay/ws-secure）。
- 三实例实测 `sub/live-r13.ts`（production 模式、真实 GitHub 包、自签 TLS）：
  - Part A：POST 立即 `downloading` → 12 s 内 22 MB 经 relay 推送到目标 → 目标 applier 启动（止于实验室假安装的 pid 预检，属环境限制）。
  - Part B：C 看到 A(active)+B(standby)；standby 拒写带写者信息；停 A → **3 s** 切到 B、经 B 中继可达、B 已复制 A/B/C；A 回来 → **51 s** 切回；B `promote` → A 经 peer status 探测被围栏为 standby，重启后仍保持。
- 实测中发现并修复：Bun server WS 1 MiB `backpressureLimit` 掐断大包（两次修复：排队上限 + 无 drain 时轮询）、standby TLS 指纹晚广告、standby 未自动授权主 hub、promote 后无人告知旧写者、legacy node.list 丢自身行。

## 遗留 / 第二阶段

- hub 间 relay（跨 hub 的节点互访）、按 RTT 选 hub、自动选主、enrollment token 复制、用户签名的 `admit-hub` 授权记录。
- `TMEX_HUB_PEERS` 为各机 env，不随 mesh 复制；主 hub 需手动 `allow` 备用 hub。
- fail-back 依赖 60 s 探测周期；被围栏的 hub 广告靠模式变化立即重发。

## 远端节点

docker-node（本机容器）与 hub `tmex` 已按用户追加要求先升到 1.1.10，v1.1.11 发布后再次用同一方法升到 **1.1.11**（hub 已声明 `staged-package`，后续可直接在节点页推包升级）；本机生产已用 `tmex upgrade` 升到 1.1.11。jiefa-app / jiefa-dns-1 仍为 1.1.10，可用节点页「全部升级」处理（它们能访问 GitHub，走旧路径即可）。

## 最终门禁（2026-09-01）

gateway 3298 pass / fe 1205 / app 629 / shared 413 / api-client 140，0 fail；tsc：gateway 0、fe 0、shared 0、app 1（既有）、api-client 5（既有）、stores 1（既有）。
