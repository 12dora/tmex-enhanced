# 第八轮执行结果

main `b7299c84` → `e61ef828`（分支 `feat/round8-onboarding` 已 push 并 ff 进 main）。GitHub Release **v1.1.0** 已创建（`tmex-cli-1.1.0.tgz` + `SHA256SUMS`），本机生产已用同一 tarball `upgrade --apply-current-package` 上线（healthz ok，`install-meta.cliVersion=1.1.0`，`~/.local/bin/tmex` shim + `~/.bun/bin/tmex` 软链就位）。

## 提交序列

| commit | 内容 |
|---|---|
| 2194208a | 接入更多设备面板 + 侧栏入口；顶栏多节点图标与 `?panel=nodes` 移除；shared release 常量；三语文案（含用户 zh 润色同步 en/ja） |
| b92446cc | 设备页「+」菜单：添加远程节点 / 添加设备到已有节点，恒定展开 |
| 22383af9 | 远程访问顶层「Cloudflare Tunnel / 直接连接」二选一 |
| c8dc5ca8 | 发行源切到 GitHub Releases：网关 update-check/一键升级、CLI upgrade/自部署/shim、install.sh、release workflow、1.1.0 |
| ca71b23d / fabac9b3 / f5d447e3 | R1 审查修复、英文标题式大写、行数锁重构 |
| 7c… (F2 跟进) | 面板 Tabs/TabsContent 无障碍 |
| ec63cce1 | 设置页前端提速（预取/staleTime/懒加载/骨架） |
| dde6bf8c | 设置页后端提速（SWR 检测、CF 超时、local/TLS/auth-mode 缓存） |
| ce118fb1 | R2 审查修复（shim 安全、node≥20、semver、tag 解析、tty、退出码、预检…） |
| 92205109 | R3 审查修复（确认豁免有界检测、纪元、异步 ps/fs、truncated、缓存失效接线） |
| ce423441 / e61ef828 | 文档、CHANGELOG |

## 分工与审查

- 探索：codex luna E1/E3/E4/E5（E2 因只读沙箱丢失，指挥官自行阅读代码补齐）。
- 前端：Opus F1（远程访问）、F2（面板+侧栏，含无障碍跟进）、F3（设备菜单）、F4（设置页前端提速）。
- 后端：cursor grok B1（网关更新）、B2（CLI/install.sh/workflow）、B3（隧道 SWR）、B4（local/TLS/auth-mode 缓存）、B5（R2 修复）、B6（R3 修复）。
- 审查：codex sol R1（前端）、R2（发行）、R3（提速）。R1 跳过「+」空目标兜底（仅挂载瞬间）；R2 跳过 tar 路径校验 / SHA256 校验 / ETag 缓存；R3 全部采纳（POST 幂等对账只做预算拆分）。

## 终态基线

fe 995 / panels 650 / gateway 2965 / app 475+1 既有 fail（build-runtime 需先全量构建）/ shared 392；tsc fe 0 / gateway 21 / app 1；`bun run lint`（biome + 复杂度门禁）通过，allowlist 仅抬 `runInit` 18→19。

## 实测

- 开发实例 Playwright 截图：面板两标签、命令块复制、设备菜单、远程访问二选一均正确；侧栏底部两入口标签经短标签 + `text-xs` 后不截断。
- tarball 烟测（19983）：`/api/tunnel/status` 冷 0.43s → 热 2ms；`/api/auth/mode` 4ms。
- `bash install.sh --print-latest` → `1.1.0`（走 releases/latest 重定向）。
- e2e 未跑（既有失败基线，且 devices.spec 已按新菜单补点选）。

## 遗留

- Actions release workflow 首跑结果见 `sub/`（若失败需修 workflow 后重跑 `workflow_dispatch`）。
- hub 元数据变更未接 auth-mode 缓存失效（5s TTL 兜底）；前端未消费 `external.probing`。
- 用户 zh_CN 润色里两处笔误（`temx`、「删除后恢复」）已改为 `tmex`、「删除后无法恢复」；「仅使」改「仅保证」。

## 上线后修复（1.1.1）

- 面板错乱根因：`@tmex/ui` Tabs 根的 `data-horizontal:flex-col` 在 Tailwind v4 里匹配布尔属性 `[data-horizontal]`，Base UI 输出的是 `data-orientation="horizontal"`，根一直是 flex-row；此前所有 Tabs 只放标签列表，接入面板首次把内容放进根才暴露。改为 `data-[orientation=horizontal]:flex-col`（`12f88189` 前一提交）。开发实例截图未复现是因为截图早于 F2 的 Tabs/TabsContent 跟进——教训：agent 跟进改动后必须重新截图。
- 底部两入口 `justify-center`。
- v1.1.1 Release（tag 首次误建在旧 main 上，删除重建到 `12f88189`），本机已升级到 1.1.1。

## 1.1.2（上线后第二批反馈）

- 移动设备第 1 步地址：新增 `GET /api/system/addresses`（监听地址 + 非回环 IPv4，私网段优先），前端按「公网（命名/临时隧道、Hub 公开地址）→ 局域网 → 非回环当前地址」拼候选（`access-addresses.ts` 纯函数 + `use-access-addresses.ts`），只剩回环时提示监听限制。
- 加入已有中继第 4 步就地生成加入码（F5）：`use-create-enrollment.ts` 从节点管理页抽出共用；面板四态；第 5 步真实 `joinCommand` 联动，未生成前用真实函数 + 占位哨兵生成预览。第 6 步确认加入未搬入（需要 `useEnrollmentWatch`/`useAdmitAction` 编排，双 admit 引擎有 seq_gap 风险）。
- 整包测试下其他用例桩污染共享查询键，地址推导加形状守卫。
- v1.1.2 Release（tag `aa7c9da3`），本机已升级。

## 1.1.3（第三批反馈）

- 加入码标签「加入码（有效期 N 分钟）」按 TTL 推导，去独立提示行；第 3 步中英文案压到一行。
- enrollment 引擎单例化（F6）→ R4 安全审查 9 条（F7）→ R5 复审 5 FIXED/4 PARTIAL + 1 新 BLOCKER（F9）：全局 key-log 写互斥（含吊销）、签前重校验、已签记录先入未确认存储、事务表 + busyIds + 取消延后、操作上下文快照与代际、签名者租约仅覆盖记录构建、面板会话绑定与回收、复合 reset。引擎第三轮后按价值判定收束。
- 「本机作为中继」第 3–5 步按隧道状态与 auth mode 推导（F8，`host-status.ts`）。
- v1.1.3 Release（tag `e1de4588`），本机已升级。远端应用服务器 10.110.88.3 安装待用户确认登录凭据与加入码。

## 远端应用服务器接入（10.110.88.3，jiefa-app）

- Ubuntu 26.04 / tmux 3.6 / 无 node、bun；`loginctl enable-linger ubuntu`；`apt install unzip`（bun 安装器依赖）；`curl -fsSL …/install.sh | bash -s -- --no-interactive --install-dir ~/.local/share/tmex --host 127.0.0.1 --port 9883 --db-path … --autostart true --lang zh-CN` 一次成功（Bun 1.4.0、tmex 1.1.3、systemd user 服务 active、`~/.local/bin/tmex`）。
- 用户在本机面板生成加入码（Hub `https://ai.jiefakj.com:18443`），远端 `tmex hub join … --name jiefa-app` → `TMEX_ROLES=node`，首连 `auth_rejected`（待准入），约 50s 后 Hub 侧 admit 落 key-log（seq 5），`[uplink] online`。
- install.sh 发现并修复：无 TTY 时 `exec 3</dev/tty` 的 bash 报错未被抑制（`788065dc`）。
