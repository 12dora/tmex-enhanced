# Plan 00：code smell 清理（高圈复杂度 / 巨大文件与函数）

## 背景

v1.0.2 发版后对整仓做一次结构性清理。基线：`bun test` 各包全绿（gateway 有 1 个依赖 `$HOME` 的测试失败，属测试 bug）；fe 的 `bun test` 是 Playwright e2e，不在本次验证范围。

三份探索报告（codex gpt-5.6-luna, xhigh）见同目录 `research-*.md`。

## 分工

- 探索：codex gpt-5.6-luna（xhigh，read-only）
- 后端编码：grok-4.6（high），`grok --prompt-file ... --permission-mode bypassPermissions`
- 前端 / TS lib 编码：Claude Opus 5 subagent
- 审查：codex gpt-5.6-sol（high），以 `git diff` 为输入；codex 偏防御，是否修由指挥官判断
- 指挥：Claude Fable 5，负责拆批、验证、commit、push

所有 agent 在同一 worktree `../tmex-enhanced-wt-smell` 并行，按文件范围严格隔离；agent 不 commit，指挥官按批次 commit。

## 批次

| 批 | 范围 | 执行者 | 关键 bug |
|---|---|---|---|
| FE-1 | `stores/agent.ts` 拆分 | opus | sortSessionOrder 比较器不对称 |
| FE-2 | `stores/tmux.ts` 拆分 | opus | disconnectDevice 未取消 reselect 定时器 |
| FE-3 | `SettingsPage.tsx` 拆分 | opus | 保存时覆盖 SSH 重连配置 |
| FE-4 | `device-tree/sidebar-device-list.tsx` 拆分（菜单去重） | opus | — |
| BE-1 | `ws/index.ts` handler map + 拆分 | grok | 关闭期连接创建竞态；畸形 Borsh payload 未处理 rejection |
| BE-2 | `api/index.ts` 路由表 + `db/index.ts` 按域拆分 | grok | — |
| BE-3 | ssh/local external-connection 提取共享 core（72% 重复） | grok | 测试硬编码 `/Users/krhougs` |
| BE-4 | `pane-stream-parser.ts` 状态机拆分 | grok | — |
| BE-5 | `agent/run.ts` + `agent/tools/terminal.ts` 拆分 | grok | — |
| LIB-1 | ghostty `render-state` / `ghostty-wasm` / `canvas-renderer` | opus | 3 处 WASM 句柄泄漏；cursor style 被忽略；blinking=false 仍闪烁 |
| LIB-2 | ws-client `client.ts` / `transport.ts`；api-client `files.ts` | opus | 旧 socket 事件污染新连接；下载 prepare 阶段异常不清理远端 session |
| LIB-3 | ghostty `terminal.ts` bindDomEvents 拆分 | opus | — |
| LIB-4 | `shared/src/index.ts` 按域拆分；`convert.ts` codec 表 | opus | — |
| 第二轮 | `device-console.tsx`、`Terminal.tsx`、`SplitTerminalArea.tsx`、`files-tab.tsx`、`ui/sidebar.tsx`、`canonical-feed-session.ts`、`pane-retention.ts`、`watch/service.ts` | 视第一轮结果 | — |

## 验收标准

- 各包 `bun test` 无新增失败；`tsc --noEmit` 错误数不增；biome 对改动文件 clean。
- 对外导出、协议行为、e2e 依赖的 `data-testid` 保持不变。
- 每批独立 commit，最后 push 到 `origin/chore/code-smell-cleanup`。

## 注意事项

- 严禁触碰生产 tmex 服务、`tmex` tmux session、默认 tmux socket。
- 生成文件（i18n resources/types、fe-dist、dist）不做任何修改。
