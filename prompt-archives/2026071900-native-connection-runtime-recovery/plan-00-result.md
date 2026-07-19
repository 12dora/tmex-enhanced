# Native Connection Runtime Recovery（tmex 子实施结果）

## 完成项

- managed entry 在任何业务模块加载前处理 `--version`，只读取构建期
  `TMEX_MONOREPO_VERSION`，输出单行后结束；
- 新增无副作用子进程测试：production secret 缺失、数据库指向临时路径且端口配置非法
  时，`--version` 仍须在一秒内以 0 退出且不创建数据库；
- 配置新增 `TMEX_TMUX_BIN`，设置时必须为绝对路径；未设置时保留裸 `tmux` 兼容默认；
- local tmux 普通命令、版本 probe 与 control-mode client 均以 `config.tmuxBin` 为
  executable；SSH 远端 tmux 选择未改变；
- 新增覆盖绝对 binary、socket 参数、版本 probe 和 control client 的 argv 回归。

## 验证

- 定向 Bun 回归：69 tests pass，0 fail；
- host managed executable 构建成功，`--version` 输出 `tmex-gateway 0.17.0`；
- compiled `--version` 在无 master key、非法端口、临时数据库路径下成功退出，未创建
  数据库文件；
- `biome check` 对本次新增/独立文件通过，`git diff --check` 通过；
- Gateway 全量 TypeScript 检查仍有既有基线错误；本次引入的 managed entry module
  错误已修复，新增测试不再增加错误。

全程未启动真实 Gateway 服务，未执行真实 tmux 命令，也未访问默认 tmux socket 或生产
服务。

