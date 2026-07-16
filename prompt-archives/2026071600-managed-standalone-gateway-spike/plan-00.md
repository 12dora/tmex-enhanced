# Managed Standalone Gateway Spike Plan

**目标：** 以最小但真实的 Spike 固化 companion-managed Gateway 的编译、运行和发行边界，不提前实现下游 updater 或产品协议。

## 任务

1. 新增明确的 managed standalone entry/build target；默认 Gateway build/runtime 行为保持不变。
2. build-time 排除 self-update、CLI install layout 和 frontend dist 依赖；runtime 受控注入 `management_mode` 与 `update_owner`，用户环境不能覆盖。
3. 固定 darwin/linux × x64/arm64 target matrix；当前 Mac 架构真实 `bun build --compile`，以仓库临时 DB/端口启动并验证 health、SQLite migration、WebSocket/API 基础能力。
4. 扫描 executable/artifact，拒绝 Bun runtime 相邻文件、JS/TS source、`node_modules`、tmex CLI、fe-dist 与 self-update/npm/CDN 特征。
5. 单元测试默认/managed 路由和配置隔离；提供可重复命令与诚实平台矩阵。非当前架构未真实执行时不得标 PASS。

## Gate

- 当前 Mac executable 可在无 Bun PATH、无 frontend dist、无 production env 的临时目录启动并通过健康检查。
- managed executable 的 update-check/upgrade 路由不存在或稳定返回 `managed_externally`，且不会联网/写升级目录。
- 产物 scanner 全绿；默认开源 Gateway tests/build 无回归。
- 代码和文档不含下游商业命名、凭据、本机绝对路径或固定局域网 IP。
