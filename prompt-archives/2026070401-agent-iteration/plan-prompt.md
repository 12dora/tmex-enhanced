# 用户原始 Prompt：Agent 迭代需求

用户提出 9 项对 agent（tmex 终端助手）的迭代需求：

1. **补全「获取终端信息」工具字段**：`get_pane_info` 应返回终端完整元信息（title/path/session/window/分屏等）。
2. **`read_screen` 返回尺寸+光标**：在返回中包含 cols/rows 与 cursorX/cursorY。
3. **提示词加入「一步一步执行 + 危险操作心智 + 流式等待」**：约束 agent 一次只做一步、危险操作前说明风险并等确认、连续 run_command 时先 read_screen 确认是否回到提示符。
4. **补全 tool call i18n**：为 `run_command`/`get_pane_info` 等工具补 i18n key。
5. **引导模型等待流式输出**：流式长跑命令（`tail -f`/`watch`/`build`）改用 send_input + read_screen，不用 run_command。
6. **pane 标题栏显示绑定 agent emoji**：区分「绑定中」与「输出中」两种状态。
7. **`send_input` 重构**：支持 modifier + 任意键/控制字符（带安全开关），做编码兼容性检查。
8. **提示词同步上述工具说明**：TerminalTools 段更新 send_input/get_pane_info/read_screen/run_command 的说明。
9. **前端 tool call 改单行简报 + 点击弹窗看详情**：默认单行简报，点击整行打开 modal 看完整 input/output。
10. **pane/runtime 失效主动停止**：ssh/tmux session 被外部杀掉等 pane 失效场景下，agent 必须主动停止而非不停尝试交互。

## 最终效果

agent 对终端的感知更完整、操作更稳健可观测、pane 失效时快速停止、前端更紧凑且能看清工具详情。

## 执行约束（来自 AGENTS.md）

- 必须在 worktree 里干活（`git worktree add`）。
- 先存档 prompt 再干活。
- 严禁触碰本机生产环境 tmex（监听 9883）与 `~/Library/Application Support/tmex/`。
- 严禁触碰名为 `tmex` 的 tmux session；测试用独立 socket（`tmux -L tmex-e2e`）。
- 三套环境（dev/test/prod）严格隔离。
- 生成文件不手改、不 lint。
- 简体中文交流，变量命名用英语。