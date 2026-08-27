## 审计结果

| path | verdict | one-line reason |
|---|---|---|
| `docs/2026021000-tmex-bootstrap/architecture.md` | DELETE-ROTTEN | 仍描述 `pipe-pane`/FIFO、xterm.js、`.env.example`、`TMEX_PORT`，当前已改为 Control Mode、Ghostty 与 `GATEWAY_PORT`。 |
| `docs/agent/2026061300-terminal-agent-overview.md` | FIX | 前端路径 `apps/fe/src/components/agent-panel/`、`apps/fe/src/stores/agent.ts` 已迁移至 `packages/panels`/`packages/stores`，运行中消息现入队而非统一返回 409。 |
| `docs/agent/2026061302-system-prompt-and-credential-handling.md` | FIX | `apps/gateway/src/agent/prompts.ts` 已不存在，当前实现位于 `agent/prompts/{jsx,components,system-prompt.tsx}`；验收数量也是历史快照。 |
| `docs/agent/2026061303-run-command-headless-ghostty.md` | FIX | 实现路径基本准确，但 `gateway 495 / shared 49` 是旧验收计数，应更新为当前测试统计。 |
| `docs/appearance/2026070501-tui-theme-notify-2031.md` | KEEP | `TMEX_THEME_NOTIFY_2031`、主题订阅代码、真实 tmux 集成测试和 e2e 路径均存在且语义一致。 |
| `docs/device-tree/2026061400-reorder.md` | FIX | `apps/fe/src/ws-borsh/message-builder.ts`、`apps/fe/src/stores/tmux.ts` 已迁移至 `packages/ws-client`、`packages/stores`。 |
| `docs/env/2026061301-three-tier-env.md` | KEEP | `development.env`、`test.env`、`load-env.ts`、`GATEWAY_PORT`/`FE_PORT` 及测试 preload 均与当前实现一致。 |
| `docs/files/2026061409-context-menu-and-transfer.md` | DELETE-ROTTEN | `POST /api/files/upload`、`uploadFiles` 和旧前端 ContextMenu 路径已不存在，已被 init/PUT/commit 分块传输取代。 |
| `docs/files/2026061500-transfer-progress-chunked.md` | FIX | `files-panel/api.ts` 已不存在，当前上传/下载 API 位于 `packages/api-client/src/{upload-transfer,download-transfer}.ts`。 |
| `docs/fonts/2026061501-font-pipeline.md` | FIX | 产物和 manifest 路径仍写为 `apps/fe/src/lib/fonts`/`apps/fe/public/fonts`，当前位于 `packages/theme/resources/fonts` 与 `packages/theme/src/fonts`。 |
| `docs/frontend/packages.md` | FIX | 未列出实际 workspace 包 `ghostty-terminal`，且遗漏 `@tmex/panels` 的 `device-tree`、`device-console`、`device-management` 出口。 |
| `docs/known-issues.md` | KEEP | KI-2 仍开放：存在分层单测和 `local-external-connection.integration.test.ts`，但没有真实 tmux→Control Mode→parser→emulator→`run_command` 全链路测试。 |
| `docs/notify/2026062000-weixin-clawbot-channel.md` | FIX | `0012_naive_lizard.sql` 已删除 `enable_weixin_*` 字段，且路由实现位于 `api/messaging-routes.ts`，不是文档所称的 `api/index.ts`。 |
| `docs/operations/2026021200-db-key-mismatch-journald.md` | KEEP | `systemctl`/`journalctl`、`TMEX_MASTER_KEY` 和 systemd journald 配置均仍对应当前服务模板。 |
| `docs/operations/2026061100-known-issue-dual-gateway-pipe-pane-conflict.md` | DELETE-ROTTEN | 文档围绕已移除的 `pipe-pane`、`installHook`、`startPipeForPaneNow` 展开，当前实现使用共享 Control Mode。 |
| `docs/product/2026062400-mindmap.md` | KEEP | 产品能力与当前设备、Agent、Watch、通知、文件和升级功能基本一致。 |
| `docs/product/2026062400-prd.md` | FIX | 版本仍写 `v0.13.0`，当前 `tmex-cli` 为 `1.0.2`；Agent 工具名 `send_keys` 已改为 `send_input`。 |
| `docs/release/2026041300-cli-release-process.md` | KEEP | `release:tmex`、根构建链、`tmex-cli` 资源打包和版本注入路径均存在。 |
| `docs/release/2026061406-release-changelog-flow.md` | KEEP | `scripts/release.ts`、双语 changelog、版本注入和 CDN 获取流程均与当前脚本和运行时代码一致。 |
| `docs/service/2026061400-process-survival.md` | KEEP | `KillMode=process`、`AbandonProcessGroup=true`、linger 边界和安装/升级生效方式均与当前服务代码一致。 |
| `docs/terminal/2026021400-terminal-react-xtermjs-refactor.md` | DELETE-PROCESS | 未执行的 `react-xtermjs` 计划文档，当前已由 `packages/terminal-ui` + Ghostty 实现替代。 |
| `docs/terminal/2026021404-terminal-switch-barrier-design.md` | FIX | 文档仍标记“未实现/迁移中”，但 `packages/ws-client/src/state-machine.ts` 和 gateway `switch-barrier.ts` 已实现并有测试。 |
| `docs/terminal/2026041400-tmux-external-cli-architecture.md` | DELETE-ROTTEN | 描述 `pipe-pane`/FIFO 外部 CLI 流程，当前 `Local/SshExternalTmuxConnection` 已使用 tmux Control Mode。 |
| `docs/terminal/2026041600-ghostty-wasm-runtime.md` | FIX | `apps/fe/src/components/terminal/Terminal.tsx` 和 `useTerminalResize.ts` 已迁移至 `packages/terminal-ui/src/components`。 |
| `docs/terminal/2026061101-claude-code-osc-notification.md` | FIX | 表格把 `auto` 标为“不会发通知”，但同文及当前 `TMEX_TMUX_TERM_PROGRAM=ghostty` 流程明确支持该渠道。 |
| `docs/terminal/2026061501-mobile-keyboard-behavior.md` | FIX | 多个 hook/utils/settings 路径已迁移至 `packages/terminal-ui`/`packages/panels`，且当前 follow 模式允许 `inset + shortcut bar` 上限。 |
| `docs/testing/2026061302-live-integration-tests.md` | KEEP | `test.env.local`、`apps/gateway/test-preload.ts`、`test:live:*` 脚本和 live 环境变量均存在。 |
| `docs/testing/2026070800-e2e-known-issues.md` | DELETE-PROCESS | 这是分包期间的历史基线审计/多轮采样报告，依赖旧 commit 和 prompt archive，不应作为当前规范保留。 |
| `docs/update/2026061406-self-update.md` | FIX | `apps/fe/src/components/settings/version-tab.tsx` 已迁移至 `packages/panels/src/settings`，且当前 `canSelfUpdate` 还受外部托管模式限制。 |
| `docs/update/2026061502-bun-path-resolution.md` | KEEP | Bun 路径优先级、`TMEX_BUN_PATH`、`sanitizeBunPath`、超时和 `BUN_INSTALL_CACHE_DIR` 均有对应当前实现。 |
| `docs/watch/2026061300-watch-monitor-overview.md` | FIX | 前端路径 `apps/fe/src/components/watch/` 已迁移至 `packages/panels/src/watch`，其余 Watch API/调度/规则语义仍有效。 |
| `docs/ws-protocol/2026021402-ws-borsh-v1-spec.md` | FIX | 仍标记未实现，且 capability 列表遗漏 `tmex-split-v1`/`canonical-state-v1`，并引用不存在的 `TERM_CHUNK`。 |
| `docs/ws-protocol/2026021403-ws-state-machines.md` | FIX | 顶部“未实现/迁移中”已过时，当前已有 `packages/ws-client` 状态机、gateway barrier 和 canonical feed 实现。 |
| `docs/ws-protocol/2026070402-site-theme-update.md` | FIX | 前端不再使用 `apps/fe/src/stores/tmux.ts`/`useUIStore.setTheme()`，当前由 `packages/stores` 的 `setThemeFromS2C()` 接收事件。 |
| `README.md` | FIX | FAQ 仍称 SSH 每个 pane 开一个远程 reader channel；当前 SSH 设备使用共享 tmux Control Mode channel。 |
| `README.zh-CN.md` | FIX | 同英文 README，`每个 pane 独立远程读取通道` 已不符合当前共享 Control Mode 实现。 |
| `packages/app/README.md` | KEEP | CLI 名称、`npx tmex-cli` 命令和 Node.js-compatible 定位与 `package.json`/构建脚本一致。 |
| `AGENTS.md` | FIX | 开头笼统称项目代码“不兼容 Node.js”，但 `packages/app` 明确提供 Node.js-compatible CLI，且 `build:cli` 使用 `--target node`；应限定为应用运行时。 |

## 结构建议

- 将 `docs/ws-protocol/2026021403-ws-state-machines.md` 与终端切换屏障文档合并为当前协议实现说明。
- 删除旧的 bootstrap、pipe-pane、react-xtermjs 文档；不要继续以日期目录保存已失效架构。
- 将 `docs/files/2026061409-context-menu-and-transfer.md` 的安全设计要点并入分块传输文档。
- 将仍开放的 e2e 失败项移入 `docs/known-issues.md` 或外部 issue tracker，再删除历史审计报告。
- 为当前文档增加稳定入口索引，避免依赖日期文件名寻找唯一真源。

## `docs/known-issues.md`

KI-2 仍未解决。现有代码分别覆盖真实 Control Mode、parser、`PaneEmulator` 和 `run_command` fake emulator，但未发现串联全部组件的真实 tmux 集成测试。