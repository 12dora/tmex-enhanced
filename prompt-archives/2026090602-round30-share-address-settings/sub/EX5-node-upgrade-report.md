# EX5 — 节点升级链路探索报告（Opus 子代理，要点）

## 链路
FE `nodes-table.tsx:387`/`bulk-actions-menu.tsx:269` → `POST /api/mesh/nodes/:id/upgrade`（`mesh/mesh-routes.ts:276-333` → `system/upgrade-service.ts:82-121`）→ 入口侧 `system/remote-upgrade-job.ts`（download → push（断点续传）→ start）→ 节点侧 `system/upgrade.ts stagePackage`。产物 `tmex-cli-<v>.tgz` 平台无关，按版本缓存即可。

## 关于「每个节点都下载一遍」
- `release-download.ts:159-232 downloadVerifiedRelease` 已有 `<installDir>/staging/release-cache/<v>.tgz + .sha256` 校验缓存与进程内 `inflight` 单飞；测试 `remote-upgrade-job.test.ts:135` 覆盖「两节点共享一次下载」。生产机 release-cache 每版本仅一份 → 网络层并未重复下载。
- 真问题：A1 缓存从不清理（已积 1.1.12…1.1.34 共 10 版 ≈220 MB；`pruneOrphanReleaseCache` 只删无 sidecar 的文件，且无启动扫描）；A2 `cleanupCancelledUpgrade`/`pruneOrphanReleaseCache` 无条件删 `*.part`，会打断远程任务共享的在途下载；A3 每个任务都整包重新 sha256（`readVerifiedCache`）且 FE 每节点都先显示「下载中」；A4 `installDir` 为空时退到 OS tmp；另 `requireLatestUpgradeRelease()` 每次 start 都打 GitHub API 无缓存。

## 并发
批量按 [其它节点]→[远端 hub]→[本机] 分组顺序执行，组内并发 3（`upgrade-batch.ts:19`）；任务表为内存 Map，进度靠 2 s 轮询。

## 浏览器弹窗（全应用仅 nodes 管理页 6 处）
升级：`use-node-upgrade-controller.ts:48`、`use-upgrade-batch.ts:235`（confirm 端口已注入，纯逻辑层可测）；撤销：`use-node-row-actions.ts:237/239/369-373`（confirm + prompt 原因）。可用组件 `packages/ui/src/components/confirm-dialog.tsx`、`alert-dialog.tsx`；同页先例 `uninstall-dialog.tsx`、`hub-role-dialog.tsx`。无 e2e 依赖 dialog。

## 建议
后端：`sweepReleaseCache(cacheDir,{keepVersions})` 启动时清空、每次升级开始前只保留 latest；在途 `.part` 受 inflight 保护；校验缓存按 size+mtime 记忆免重复哈希；latest release 查询缓存 60 s。前端：`ConfirmDialog` 替换升级 confirm（异步 confirm 端口），撤销改为带原因输入的对话框。
