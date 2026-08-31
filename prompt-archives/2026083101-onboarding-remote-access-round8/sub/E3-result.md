无法完成文件写入：只读沙箱拒绝了 `apply_patch`，目标文件仍不存在：

`/Users/konata/code/tmex-enhanced-wt-r8/prompt-archives/2026083101-onboarding-remote-access-round8/sub/E3-result.md`

只读调查结果已完成，关键结论如下：

- `packages/app/package.json:2-20` 仍发布 npm 包 `tmex-cli`；没有 `repository` 字段，`release` 直接执行 `npm publish`。
- 根 `package.json:18-21` 的 `publish:tmex` 是完整构建后执行 npm 发布。
- `scripts/release.ts:169-201` 只生成双语 changelog 并 bump 版本，不负责真正发布。
- 当前 CLI 没有 `install` 命令；`packages/app/src/lib/args.ts:82-87` 只识别 `init`。因此 `npx tmex-cli install` 会失败，实际命令是 `npx tmex-cli init`。
- `npx tmex-cli upgrade` 在 `packages/app/src/commands/upgrade.ts:58-75` 中再次执行 `npx --yes tmex-cli@<version> ...`，仍从 npm 获取包。
- Gateway 自更新在 `apps/gateway/src/system/upgrade.ts:91-105` 执行 `bun add tmex-cli@<version>`，同样依赖 npm。
- 更新检查在 `apps/gateway/src/system/update-check.ts:5-7,20-46` 查询 npm registry 和 jsDelivr。
- UI 实际使用 `/api/system/update-check`，不是 `/api/version`：`packages/panels/src/settings/use-version-tab.ts:42-60`；“update available”显示于 `packages/panels/src/settings/version-tab-sections.tsx:66-80`。
- 版本主来源是 `packages/app/package.json.version`。`packages/app/scripts/build-runtime.ts:68-78` 注入 `TMEX_MONOREPO_VERSION`；Gateway 在 `apps/gateway/src/system/version.ts:31-58` 读取；Vite 在 `apps/fe/vite.config.ts:8-16,77-82` 注入 `__MONOREPO_VERSION__`。
- `.github` 目录不存在，没有现有 release/publish workflow。
- `install-meta.json` 位于安装目录，由 `packages/app/src/lib/install-layout.ts:29-42` 定义，字段见 `packages/app/src/types.ts:38-46`。
- launchd/systemd 安装逻辑位于 `packages/app/src/lib/service.ts:118-205`；升级保留现有备份、回滚、健康检查流程，见 `packages/app/src/commands/upgrade.ts:117-184`。
- `registry.npmjs.org` 在 `packages/app/src/lib/native-manifest.ts:12-31` 还用于下载 node-datachannel 原生 addon，这是独立于 CLI 发布的依赖。
- 现有更新测试不足：没有 `update-check.test.ts`；`packages/app/src/commands/upgrade.test.ts:4-38` 仅测试 direct addon 重启逻辑，单独运行结果为 `3 pass, 0 fail`。完整测试在沙箱中因 `EPERM` 临时目录和 `EADDRINUSE` 端口限制报告 `313 pass, 114 fail`。

推荐设计：

1. 保留包名 `tmex-cli` 和两个 bin，新增 repository 指向 `https://github.com/12dora/tmex-enhanced.git`，移除 npm publish 语义，让 `release` 生成 `tmex-cli-<version>.tgz`。
2. 在 `12dora/tmex-enhanced` 创建 `v<version>` GitHub Release，并附加同名 tarball及 checksum。
3. CLI 和 Gateway 使用 GitHub Releases API：

   `https://api.github.com/repos/12dora/tmex-enhanced/releases/latest`

   对显式版本直接下载：

   `https://github.com/12dora/tmex-enhanced/releases/download/v<version>/tmex-cli-<version>.tgz`

4. 将 `npx tmex-cli@<version>` 改为下载后的本地 tarball执行，例如：

   `npx --yes ./tmex-cli-<version>.tgz upgrade --apply-current-package`

   API 不可用时不得回退到上游 npm；应使用已缓存的 release 信息或返回明确的无更新/下载失败。
5. 添加根目录 `install.sh`，支持：

   `curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash`

   脚本检查 `curl`、Node/`npx`、Bun `>=1.3.0`，解析 GitHub latest release，下载 tarball，再执行本地包。由于当前没有 `install` 子命令，应使用 `init`，或先给 `init` 增加 `install` 别名。
6. 添加 `.github/workflows/release.yml`：tag push → Bun/Node 安装 → 完整构建 → 校验 tag 与 package version → `npm pack` → 生成 checksum → 创建 GitHub Release 并上传 tarball。
7. 更新 README、`docs/**` 以及 `apps/fe/src/node/enrollment.ts:700-705`、`packages/app/src/commands/enroll.ts:486` 中生成的 `npx tmex-cli` 命令。