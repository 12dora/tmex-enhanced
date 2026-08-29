# plan-00 执行结果（2026-08-29）

worktree `../tmex-enhanced-wt-merge`，分支 `chore/merge-hub-tabs`，base `a3d9613`。

## commit 序列

| commit | 内容 |
|---|---|
| `c0283ec` | theme/ui：动效基础（`motion.css` tokens/keyframes/reduced-motion、`<Reveal>`/`<Stagger>`/`useReducedMotion`），19 个基础组件时长/缓动统一 |
| `8de33cf` | 后端：`POST /api/local/leave`（一次性清理 users 及派生表、nodes、enrollment_tokens、peer_cache、hub_trust、node_identity，env 回 standalone，300ms 自退出），CLI `hub leave` 复用，join 清 `TMEX_HUB_PUBLIC_URL` |
| `29bdf29` | 设备页紧凑化、唯一全局「+」（多节点下拉选目标）、`sidebarDeviceVisibility` 浏览器偏好（self 默认显示、远程默认隐藏）+ 卡片开关 + 侧栏过滤；远程 runtime 不再改全局语言/主题（`controlsBrowserPrefs`） |
| `30d83b7` | 设置-节点：本机卡片角色 Select 与「更换 Hub」（退出 → sessionStorage 意图 → 重启后向导续接）、纯 node 角色 HTTPS 置灰、节点管理合并为单卡片（标题「节点管理」、刷新图标 + 「添加」）、`/nodes` 重定向到 `/settings?tab=nodes` |
| `940ecab` / `b15895e` | panels+terminal-ui / apps/fe 全面采用共享动效（页面/面板/侧栏入场、向导与结果卡片、设备卡首屏错落、终端提示淡入、复制反馈 live region 等；终端画布/tmux 高频更新一律不动） |
| `5c789df` `ac1d5c0` `0cebb6f` `0e88a36` `f473a89` | 三轮 codex 审查修复（见下） |

## 审查判定

- 后端（`sub/review-backend.md`）3 条全部采纳：leave 改为「暂存 env → 停机排空 → 清库 → 原子提升」；`UplinkServer.stop()` 异步化，拒绝新控制帧并排空在途处理（5s 上限）；CLI `hub leave` 检测到服务管理器时先停服务再重置后启动。
- 设备页/stores（`sub/review-fe-devices.md`）3 条全部采纳：主题预设/localStorage 同样受 `controlsBrowserPrefs` 守卫；拖拽重排合并隐藏设备保持完整顺序；离线 inventory 也保留当前路由设备。
- 设置-节点（`sub/review-fe-nodes.md`）9 条全部采纳：鉴权过渡期抑制 401 跳转与 mesh 轮询、并发守卫、重启基线在 leave 前采样、意图标记 TTL、超时为终态、HTTPS 等角色加载后再挂载、设置页 tab 由 URL 派生、角色化确认文案、编排抽成纯函数 + 15 个用例。
- 动效（`sub/review-motion.md`）4 条全部采纳：reduced-motion 清零延迟；连接指示器偏好切换直接落终态；登录/凭据错误与复制反馈改为常驻 sr-only live region。
- 指挥官实测额外发现并修复：自吊销的凭据弹层被同层 AlertDialog 遮挡（`f473a89`，新增 `confirming` 阶段先收起对话框）。

## 验证

| 包 | test | tsc（基线） |
|---|---|---|
| apps/fe | 577 / 0 | 0 |
| packages/app | 408 / 0 | 1（既有） |
| apps/gateway | 2455 / 0 | 21（既有） |
| packages/stores | 275 / 0 | 1（既有） |
| packages/panels | 388 / 0 | 0 |
| packages/terminal-ui | 315 / 0 | 0 |
| packages/ui / theme / shared / api-client | 23 / 52 / 344 / 130，全 0 fail | 0 / – / 0 / 5（既有） |

实测（`sub/live-leave.ts`、`sub/live-leave-result.md`）：临时 hub,node + node 双实例（自签 HTTPS + CA pin 加入）跑通 standalone→400、未登录→401、角色不符→409、node leave→10 张表清空 + env 复位 + 重新 enroll 得新身份、hub,node leave。Playwright 浏览器走完「更换 Hub」：凭据确认 → hub 侧该节点 `revoked` → leave → 重启 → 回到 standalone 设置页且加入表单自动展开（约 4.6s，无 pageerror）。截图确认：设备页单一全局加号 + 「显示在侧栏」开关、node 角色 HTTPS 置灰、节点管理单卡片、`/nodes` 跳转。

## 遗留 / 说明

- HTTPS 判定：standalone（为成为 hub 准备公网地址）与 hub,node 保留可用，仅纯 node 置灰。
- 旧 hub 不可达时自吊销失败只告警不阻塞，旧 hub 留离线记录需手动吊销（文案已说明）。
- 退出后节点身份重新生成；若旧 hub 未吊销，同名旧记录会与新记录并存（hub 表里两行同名）。
- 动效未做退场动画（需两阶段卸载模型）、节点表逐行入场（随轮询刷新会闪）。
- UI 默认语言由站点设置决定（测试实例为 en_US），截图为英文。
