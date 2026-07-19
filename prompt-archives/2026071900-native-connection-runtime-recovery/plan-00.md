# Native Connection Runtime Recovery（tmex 子计划）

## 背景

外部 host 会执行 managed Gateway 的 `--version` 探测，并为本机终端选择一个明确的
tmux binary。当前 managed entry 未分流 `--version`，会启动完整 Gateway；本机 tmux
调用也仍使用裸 `tmux`，可能被登录 shell 的 PATH 改写。

## 实施

1. 先增加 managed entry 子进程测试：production 环境缺少运行时密钥且端口已占用时，
   `--version` 仍应在一秒内成功退出，不创建数据库。
2. 先增加配置与 local connection 测试：拒绝相对 `TMEX_TMUX_BIN`，并断言普通命令、
   `-V` probe、control client 都以配置的绝对路径为 argv 首项。
3. 在 managed entry 的任何业务 import 前处理 `--version`，版本仅来自构建期常量。
4. 在配置层读取并校验 `TMEX_TMUX_BIN`，local connection 统一使用该值；SSH 远端路径
   保持不变。
5. 运行定向 Bun 测试、格式与类型相关检查，并记录结果。

## 验收标准

- `--version` 一秒内以 0 退出，输出单行版本，不创建 DB、不依赖空闲端口或 production
  secret；
- `TMEX_TMUX_BIN` 设置时必须为绝对路径；
- local command/probe/control-mode argv 的 executable 均为该路径；
- 登录 shell PATH 中存在其他 `tmux` 也不能改变 executable；
- 不执行任何真实 tmux 命令，不接触生产服务或默认 tmux socket。
