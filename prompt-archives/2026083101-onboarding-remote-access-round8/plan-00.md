# 第八轮：接入指引 / 远程访问重排 / 发行源切到本仓库 / 设置页提速

## 背景

- 仓库为 `krhougs/tmex` 的 fork（`12dora/tmex-enhanced`），npm 包 `tmex-cli` 归上游，本 fork 无法发版；此前安装/升级/更新检查全部指向 npm registry（`apps/gateway/src/system/update-check.ts`、`upgrade.ts`，`packages/app/src/commands/upgrade.ts`）。
- 远程访问向导（`apps/fe/src/pages/settings/remote-access/`）把「直接连接」放在「安装 cloudflared → 选择方式」之后，结构上误导为必须先装 cloudflared。
- 右侧滑出面板基础设施（`apps/fe/src/components/side-panels/`，`?panel=<name>`）此前承载「多节点互联」（顶栏图标）与「账号安全」两块。
- 用户已手工润色 `zh_CN.json` 远程访问文案（见 `sub/zh_CN-user-edits.diff`）：偏好「本机」而非「这台机器」、去掉「你/你的」、句子短、专业不啰嗦。
- 追加需求：设置页各 tab 加载慢（部分数秒），需深度优化。
- 探索报告：`sub/E1-result.md`（远程访问）、`sub/E3-result.md`（CLI/发行）、`sub/E4-result.md`（mesh/PWA 真实流程与命令）。E2（侧栏/设备）报告因 codex 只读沙箱丢失，改由指挥官直接阅读代码完成。

## 目标与任务拆分

| 编号 | 内容 | 执行者 | 文件范围 |
|---|---|---|---|
| T5（已完成，指挥官） | 删顶栏多节点互联图标；`?panel=nodes` 面板改为 `connect`（接入更多设备）占位；`sidebar.nodes` 键删除；`nav.connectDevices` 三语 | 指挥官 | sidebar-title*、side-panel-url*、side-panel-host、locales |
| T1 | 远程访问：顶层二选一「Cloudflare Tunnel / 直接连接」，隧道分支才有安装/方式/登录…；直接分支只剩访问保护；未配隧道且选直接时隐藏隧道状态卡 | F1（Opus） | `pages/settings/remote-access/**`、`settings.remoteAccess.*` 三语 |
| T6 | 用户 zh_CN 润色同步到 en_US/ja_JP（同键组，由 F1 一并） | F1 | 同上 + `settings.deviceManagement.description` |
| T2 | 「接入更多设备」面板：两 tab（移动设备/服务器或电脑）、分步卡片、平台/模式子 tab、命令块+复制；侧栏底部「管理设备」左侧新增入口 | F2（Opus） | `side-panels/connect-devices/**`、`app-sidebar.tsx`、`nav-main.tsx`、`connectDevices.*`（zh/en 已由指挥官写好，F2 补 ja） |
| T4 | 设备页「+」菜单：顶部新增「添加远程节点」→ `/settings?tab=nodes`；原标签改「添加设备到已有节点」 | F3（Opus） | `pages/devices/add-device-menu*`、`DevicesPage*`、`device.addTo.*` 三语 |
| T3a | 网关更新检查/一键升级改指 GitHub Releases（`packages/shared/src/release/source.ts` 常量） | B1（cursor grok） | `apps/gateway/src/system/update-check*`、`upgrade*` |
| T3b | CLI：`upgrade` 从 Release 下载 tarball 后本地执行；`init/upgrade` 把 CLI 自身部署到 `<installDir>/cli/` 并写 `~/.local/bin/tmex` shim；join 命令改 `tmex hub join`；`install.sh`；`.github/workflows/release.yml`；README；版本 1.1.0 + CHANGELOG | B2（cursor grok） | `packages/app/**`、`install.sh`、`.github/**`、README*、`apps/fe/src/node/enrollment.ts` 的 join 命令字符串 |
| T7 | 设置页 tab 慢：先探索（E5，codex）定位阻塞点（服务端探测/spawn/网络、前端瀑布），再派后端+前端修复 | E5 → B3/F4 | 待定 |

## 设计要点

- 发行源：release tag `v<version>`，资产 `tmex-cli-<version>.tgz`（`npm pack`）。更新检查走 `releases/latest`（tag_name 去 `v` 比较，release body 作 changelog）；网关一键升级下载资产→解包→`bin/tmex.js upgrade --apply-current-package`；`bin/tmex.js`/`dist/cli-node.js` 为 bun 打包的自包含产物，无需 `npm install`（B2 需实测验证）。
- 安装脚本：`curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash`：检查 curl/tar，缺 bun 自动装（bun.sh），取 latest release tarball，解包后用 node（无则 bun）执行 `bin/tmex.js init "$@"`。
- 面板文案：指挥官已写 zh/en，`connectDevices.*`；命令示例键 `computer.join.run.example`；安装命令来自 `@tmex/shared` 的 `INSTALL_COMMAND`。
- 顶栏图标已删，多节点互联仅保留在设置页；设备页「添加远程节点」跳设置页。

## 验收

- 各包 `bun test` 不低于基线（fe 975、app 430+1 既有 fail、gateway 见 sub 记录）、tsc 错误数不高于基线、`bun run lint` 通过（含复杂度门禁，必要时 `--tighten`/抬锁）。
- 临时实例实测：接入面板两 tab 与复制按钮；远程访问顶层二选一；设备页菜单跳转；设置各 tab 首开耗时。
- 本机 tarball 1.1.0 `upgrade --apply-current-package` 上线；GitHub Release v1.1.0 含 tarball；`install.sh` 在临时目录 dry-run 到下载解包一步。

## 风险

- 上游可合并性：本轮明确放弃「不改发版文件」约束（用户要求发行指向本仓库）。
- `~/.local/bin` 可能不在 PATH：init/install.sh 输出提示，指引里给 `export PATH` 命令。
