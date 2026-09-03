# 第二十二轮计划：流畅度 / TUI 变绿 / 待机功耗 / 坏味道 / 精简

## 背景

- 基线 main `c462f3bd`（1.1.21），分支 `feat/round22-perf-tui-color-smell`，worktree `/Users/konata/code/tmex-r22`。
- 第二十一轮（`prompt-archives/2026090302-round21-perf-idle-smell/`）已做：终端滚动 rAF 合并 + canvas run 批绘 + 位移感知行复用；待机 CPU 未能证明改善；门禁清零；精简约 1600 行。
- 用户新增诉求：Claude Code TUI 输入框「有时变浅绿」。

## 分工

- 指挥官（Claude）：计划、拆任务、分批 commit、验证、发版。
- 探索：Opus 子代理 ×5（EX1 流畅度 / EX2 变绿 bug / EX3 待机 / EX4 坏味道 / EX5 精简）。
- 后端编码：cursor-agent grok-4.6 high（G* 任务）；复杂性能：codex gpt-5.6-sol max（C1–C4）；前端：Opus（O* 任务）。
- 审查：codex sol high，按价值取舍。
- 并行原则：同一 worktree，文件集互不重叠，agent 不做 git 操作。

## 任务清单（按 EX 报告拆分）

| 批次 | 任务 | 角色 |
|---|---|---|
| bug | EX2 根因：`forceFullRepaint` 清掉位移复用的「有输出」门 → 拆 `cursorPendingOutput` / `rowsPendingOutput` | 指挥官 |
| smell 1 | GA B1+B14、GB B4、GC B7+B12、GD B6+B8、GE B9、GF B10+B13 | grok |
| smell 1 | OA F2+F4、OB F3+F6+F7、OC F8+F5+G2、OD F9 | Opus |
| perf | GG T2、GH T6+T9、C1 T3+T5、C2 T4、C3 T1+U4 | grok / codex |
| perf | OE U1+U6+U9、OF U3+U8+U10+U11+U12、OG G1+T8+faint+T14、OH U7+T7+T12 | Opus |
| slim | GI 死路由/死导出/死文件、GJ semver/校验/PID 合一 | grok |
| slim | OI U2+hljs 按需、OJ base-ui 懒加载+sonner+主题幽灵、OK i18n 拆分+死 key+README+规范、OL U5、OM direct 懒加载 | Opus |
| standby | C4 R2+R3+R5+R6、GL R9+R10+R13+R7、GK T11 | codex / grok |
| smell 2 | GM B3+B2+*Row、GN B5+B11+R12、GO B15、GP T1、ON F1+R14 | grok / Opus |

## 验收

- 各包 `bun test` 不少于基线；`bunx tsc --noEmit` 不高于基线；`bun run lint`（biome + complexity gate）全绿。
- fe e2e 与 main 基线逐条对照（既有失败见记忆 `e2e-baseline-failures`）。
- 首屏 entry gzip 从 `dist/index.html` 读入口文件名量。
- 发版：CHANGELOG + 版本号 → tag → GitHub Release → `tmex upgrade` 替换本机。

## 注意事项

- 起临时实例必须 `TMEX_TMUX_SOCKET=tmex-e2e`：push supervisor 启动即对所有设备 `attach-session`。
- `grep -c` 返回 0 会打断 `&&` 链（本轮又踩一次，GH 那批漏提交后补上）。
- 关 canonical 对照要改 `node-runtimes.ts` 的显式 option，不是 ws-client 默认值。
