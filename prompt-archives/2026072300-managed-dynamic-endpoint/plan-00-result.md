# Managed Gateway Dynamic Endpoint 实施结果

## 结果

Task 3 已在 `vibex/canonical-managed-endpoint` 完成。普通 Gateway 继续默认监听 9663；
Companion-managed 入口改为强制绑定 OS 分配的 loopback 临时端口，并在 listener 成功建立后
原子发布一次性 readiness 文件。Gateway runtime restart 不再重绑 listener。

## 协议

- env：`TMEX_MANAGED_ENDPOINT_PATH`、`TMEX_MANAGED_ENDPOINT_NONCE`；
- path 必须是绝对文件路径；nonce 必须包含 1..256 UTF-8 bytes，空值和纯空白拒绝；
- readiness JSON 上限 1024 bytes，拒绝未知字段；
- schema 固定为 `schemaVersion=1`、精确 nonce、精确 `process.pid`、`transport=tcp`、
  `host=127.0.0.1|::1`、`port=1..65535`；
- 发布使用目标同目录的 0600 独占临时普通文件，再 rename 到最终路径；
- 两个一次性 env 在校验后立即从 `process.env` 删除，nonce 和 owner token 均不进入日志。

## runtime 生命周期

- managed entry 正常启动必须提供上述两个 env、`GATEWAY_PORT=0` 和数值 loopback host；
- `--version` 仍在加载生产配置、数据库和 listener 前早退，不要求 readiness env；
- Bun listener 只创建一次，实际端口只读取 `server.port`；
- fetch 与 WebSocket handler 委托给当前 runtime；replacement 窗口 HTTP 返回 503；
- 旧 WebSocket 先执行旧 runtime 清理，再以 1012 / `Gateway runtime restarting` 关闭；
- replacement 成功后复用原 PID 和 endpoint，失败则停止 listener 并使进程非零退出；
- 既有 managed smoke runner 已改为消费动态 readiness，不再自行猜测随机固定端口。

## 验证证据

- `bun test apps/gateway/src/system/managed-endpoint.test.ts apps/gateway/src/config.test.ts`：
  23 pass / 0 fail；
- `bun test apps/gateway/src/managed-entry.version.test.ts`：1 pass / 0 fail；
- `bun run --filter @tmex/gateway test`：1044 pass / 0 fail；
- 相关文件 `bun x biome check`：通过；
- `bun run --filter @tmex/gateway build:managed`：darwin-arm64 编译通过；
- `TMEX_MANAGED_SMOKE_CLEAN=1 bun run --filter @tmex/gateway smoke:managed`：artifact
  scan、readiness、health、managed update gate 和 WebSocket probe 全部通过；
- 额外真实 restart Gate：观察到 replacement 窗口 503，旧 WebSocket 收到 1012；约
  577ms 后 health 恢复，readiness PID 和端口均未改变；
- `bun x tsc --noEmit -p apps/gateway/tsconfig.json` 仍因既有 agent/telegram/SSH/ws
  类型基线退出非零，诊断未命中本次修改文件，与历史 managed spike 记录一致。

所有临时 binary、数据库、readiness、独立 tmux socket 和测试进程均已清理；未访问或重启
已安装 tmex，也未操作默认 tmux socket。

## 剩余风险

- 原子 rename 和 compiled smoke 已在 macOS 实测；Windows 的 rename 替换语义未在本机执行。
  Companion 每次启动仍应先清理精确 stale readiness 文件，并按计划独立执行普通文件、
  非 symlink、size、PID、nonce、loopback 和 owner-proof 校验。
- `::1` 由协议单测覆盖，本轮 compiled smoke 使用 `127.0.0.1`。
