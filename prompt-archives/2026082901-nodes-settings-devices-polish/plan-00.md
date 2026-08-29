# plan-00：设置-节点整理、设备管理精简、i18n 稳定、全局动画（2026-08-29）

## 背景
- worktree `../tmex-enhanced-wt-merge`，分支 `chore/merge-hub-tabs`，base `a3d9613`。承接 `prompt-archives/2026082900-hub-ui-tls/`（设置页「节点」标签、向导、HTTPS）。
- 探索报告：`sub/explore-local-role.md`（角色/hub 地址模型与本地状态清单）、`sub/explore-frontend.md`（设置页/节点页/设备页/侧栏/i18n）、`sub/explore-motion.md`（动画现状与分桶）。
- 三节点测试环境（远程 hub `ai.jiefakj.com:18443`、本机生产 `konata-mac`、容器 `tmex-node-docker` 29883）保留；本轮结束后重建容器镜像上线（tarball 进容器 `/opt/tmex` 并重启进程，保留 `/var/lib/tmex` 数据）。

## 已拍板的设计
1. **角色切换与更换 hub**（任务 1）
   - 支持的角色仍为 `standalone | node | hub,node`。新增后端 `POST /api/local/leave`（mesh 角色需 self 会话）：一次性清理本机所有 mesh 成员状态（users 及派生表、nodes、enrollment_tokens、peer_cache、hub_trust、node_sessions；`node_identity` 整行清除，重启时重新生成新身份），写 env `TMEX_ROLES=standalone`、`TMEX_HUB_URL=`、`TMEX_HUB_PUBLIC_URL=`，走 setup 事务锁与 300ms 自退出重启。CLI `hub leave` 复用同一函数；`joinHub()` 顺带清空 `TMEX_HUB_PUBLIC_URL`。
   - 前端本机卡片：角色改为可切换（Select）。目标为 standalone → 确认后 leave；目标为其它 mesh 角色 → leave 后自动进入向导对应路径（`sessionStorage` 记录意图，重启后设置页 `tab=nodes` 自动展开）。「更换 hub」= 同一链路（leave → join 表单）。节点侧在 leave 前**尽力**对旧 hub 做自吊销（复用 nodes-table 的签名吊销流程，允许 self），失败不阻塞。
   - 因 hub 侧无跨 hub 协议，旧 hub 会留下离线记录，用户可在旧 hub 节点表吊销；文案明示。
2. **移除 `/nodes` 独立页**（任务 2）：路由改为重定向到 `/settings?tab=nodes`；SettingsPage 读 `tab` 查询参数；侧栏 Network 图标与本机卡片链接改指向设置页。
3. **节点管理大盒子**（任务 3）：`NodesManagement` 改为单个 `Card`，标题「节点管理」，header 右侧刷新图标按钮 + 「添加」按钮；删掉加入码说明段落；加入码生成表单/待处理列表与节点表都在同一 Card 内。
4. **HTTPS 置灰**（任务 4）：HTTPS 对 standalone（为成为 hub 做准备）与 `hub,node` 有意义；纯 `node` 角色置灰并提示"仅 hub 需要"。
5. **管理设备**（任务 5）：缩小节点分组头与卡片留白，卡片网格三列（xl）；删除各节点分组的加号，仅保留右上全局加号（多节点时下拉选择目标节点）；新增浏览器本地偏好 `sidebarDeviceVisibility`（键 `${runtimeNodeId}:${deviceId}`，self 默认显示、远程默认隐藏），设备卡片上提供「显示在侧栏」开关，侧栏按此过滤。
6. **i18n 稳定**（任务 6）：只有 host/self 运行时的 site store 允许 `i18next.changeLanguage`；远程节点 runtime 的 site store 不再改全局语言。
7. **动画**（任务 7）：先落 `packages/theme/src/motion.css` + `packages/ui/src/components/motion.tsx`（tokens、`.tmex-reveal`、`<Reveal>`/`<Stagger>`、reduced-motion），再在功能代码合并后对页面/面板/终端 UI 做一轮采用。

## 分工与批次
| 批次 | agent | 范围 |
|---|---|---|
| 1 | Opus f-motion-foundation | packages/theme、packages/ui、index.css 一行 import |
| 1 | cursor/grok b1 | leave API、hub leave 复用、join 清 PUBLIC_URL、api-client 类型 |
| 1 | Opus f1 | 任务 2+3（路由、SettingsPage tab 参数、侧栏链接、NodesManagement 盒子） |
| 1 | Opus f2 | 任务 1 前端 + 任务 4（本机卡片角色/hub 切换、向导意图、HTTPS 置灰） |
| 1 | Opus f3 | 任务 5（设备页布局、全局加号、卡片侧栏开关） |
| 1 | Opus f4 | 任务 5.3 store + 侧栏过滤、任务 6 |
| 2 | Opus f5/f6 | 任务 7 功能侧采用（apps/fe 页面 / panels+terminal-ui 两桶） |
| 2 | codex sol ×3 | 审查 backend / frontend / stores+panels |
| 3 | 指挥官 | 临时实例实测、i18n 生成、commit、push、docker 上线 |

## 验收
- 本机卡片可从任一角色切到任一角色；node 更换 hub 后旧 hub 无残留本地状态、新 hub 正常 enroll；`/nodes` 跳转设置页；节点管理为单盒子；纯 node 角色 HTTPS 置灰；设备页无分组加号、远程设备默认不在侧栏、可勾选显示；远程设备「连接」不再改语言；各包 test/tsc 不低于基线；docker 容器更新到本轮构建。
