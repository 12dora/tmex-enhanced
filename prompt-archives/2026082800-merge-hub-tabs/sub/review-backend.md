审查完成，确认 2 条 `major` 合并语义丢失；未发现 `blocker`、`minor` 或存疑项。

但当前工作区被配置为只读，写入 `review-backend.md` 时被沙箱拒绝，目标文件尚未生成。需要恢复写权限后才能落盘。

1. `major` — hub-first 升级永久缺失 tabs 的 agent 查询索引

- **文件:行**：[_journal.json:131](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/drizzle/meta/_journal.json:131)
- **丢失行为**：tabs commit `9f8d720` 新增 queued messages 和 pending confirmations 两个复合索引。
- **失效原因**：索引迁移时间戳 `1787808955472` 早于 hub auth 的 `1787844349224`。Drizzle 只执行时间戳大于数据库最后迁移的项目，因此已运行 hub 父分支迁移的数据库会永久跳过索引迁移；文件编号改成 `0018/0019` 不影响判断。
- **复现断言**：模拟数据库最后迁移时间为 hub auth，再执行 HEAD migrations，查询 `sqlite_master` 得到两个索引均不存在。
- **严重度**：`major`，查询结果正确，但退化为扫描和额外排序。

2. `major` — 路由拆分后 transfer UID 清理丢失

- **文件:行**：[file-transfer-routes.ts:91](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/file-transfer-routes.ts:91)、[files.ts:14](/Users/konata/code/tmex-enhanced-wt-merge/apps/gateway/src/api/files.ts:14)
- **丢失行为**：hub commit `3fa0b4d` 的 `cleanupUpload` / `cleanupDownload` 会同时删除 transfer session 和 UID 映射。
- **失效原因**：tabs commit `fda189e` 拆出的路由仍在第 91、95、101、146、155 行直接调用 `remove*Session()`。合并只补回 `rememberTransferUid()`，没有迁移五条清理路径，导致模块级 `transferUids` 无界增长。
- **复现断言**：完成或取消 transfer 后，断言 UID bookkeeping 数量回到基线；HEAD 失败。也可复用固定 transfer ID，删除后重新创建裸 session，HEAD 会读到旧 UID。
- **严重度**：`major`，长驻 Gateway 只能通过重启释放残留映射。

其余重点均未发现语义丢失：connect generation、legacy observer 生命周期、SourceGap、notification prune、OSC 52、严格 offset/JSON 校验、两端 UID 绑定，以及 HTTP/mesh bulk 共用 transfer session。