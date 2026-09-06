# T5 后端结果（Opus 子代理）：发行包缓存清扫

- `release-download.ts`：`sweepReleaseCache(cacheDir,{keepVersions,now,partTtlMs})`（非保留版本、孤儿 sidecar、过期且不在途的 .part、杂物全删；在途受 inflight 保护）、`isReleaseDownloadInFlight`、校验结果按 size+mtime 记忆免重复哈希。
- `upgrade.ts`：取消本地升级不再误删在途 .part；`pruneOrphanReleaseCache` 删除，`repairStagingArtifacts` 改用 sweeper 只保留目标版本。
- `upgrade-service.ts`：每次升级开始、下载前清扫只保留 latest（30 s 记忆，批量只扫一次）。
- `update-check.ts`：latest release 查询缓存 60 s（并发合并，失败不缓存），FE 轮询同样受益。
- `runtime.ts`：启动时全量清空 release-cache（`keepVersions:[]`, `partTtlMs:0`）。
- 测试 +14；文档 `docs/update/2026061406-self-update.md` 新增「发行包缓存与清扫」。网关全量 4808/10（mesh phase-2 环境性）。
