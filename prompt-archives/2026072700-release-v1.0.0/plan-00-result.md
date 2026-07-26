# v1.0.0 提交、合并与发版执行结果

## 完成情况

- 已将 Settings 文件根目录 query cache 隔离修复和 Playwright 回归用例提交为 `4f540f3`。
- 已将 `vibex/main` 快进合并到本地 `main`。
- 已将 `tmex-cli` 版本从 `0.17.0` 更新为 `1.0.0`，并提交发布元数据。
- 已将 CHANGELOG 改写为英文、中文双语的面向用户说明，并移除草稿标记。
- 已完成依赖同步、完整生产构建和 `npm pack --dry-run` 检查。
- 已将 `tmex-cli@1.0.0` 发布到 npm `latest` 标签。
- 已确认 npm `latest` 指向 `1.0.0`，并从临时目录通过 npx 执行 CLI 帮助成功。

## 验证记录

- `bun install --frozen-lockfile`：通过。
- `bun run build`：通过，运行时注入版本为 `1.0.0`。
- `npm pack --dry-run --workspace tmex-cli`：通过，包含运行时、前端资源、迁移文件和 CHANGELOG。
- `npm whoami`：账号为 `krhougs`。
- `npm view tmex-cli dist-tags`：`latest` 为 `1.0.0`。
- `npx --yes tmex-cli@1.0.0 --lang en help`：通过。
- 按用户要求跳过剩余全量测试。

## 安全边界

- 未读取、修改、删除或重启本机生产 tmex 服务及其安装目录。
- 未读取或复制生产数据库。
- 未操作名为 `tmex` 的 tmux session。

## 注意事项

- 本地 `main` 已领先 `origin/main`，本次仅完成本地合并和 npm 发布，未自动推送 Git 远端。
- 生产实例仍需由用户按正式流程自行执行 `npx tmex-cli@1.0.0 upgrade`，本次未执行该命令。
