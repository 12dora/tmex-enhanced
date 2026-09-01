# Round 11 计划：PWA 性能 / 终端视口分离 / 文件侧栏 / 登录安全 / 跨节点静默登录

## 背景

- 基线：main `4e24515f`（v1.1.6）。worktree `../tmex-enhanced-wt-r11`，分支 `feat/round11-pwa-files-auth`。
- 多 agent 分工：codex gpt-5.6-luna(xhigh) 只读探索（EX1–EX6，报告在 `sub/EX*-result.md`）；grok-4.6(high，`grok --prompt-file … --permission-mode bypassPermissions`) 写后端（S*/B* 任务）；Claude Opus 写前端（A1/F1/T*/P* 任务）；codex gpt-5.6-sol(high) 审查（RV*）。agent 不 commit，指挥官分批 commit；同一 worktree 并行编辑，任务文件集互不重叠。
- 测试基线（本 worktree 起点）：gateway 3080 pass / tsc 21 条既有错误；fe 1098 pass / tsc 0；shared 392；stores 398；ws-client 283；terminal-ui 344；api-client 134。e2e 基线见 `docs/known-issues.md` KI-3（107 pass / 1 skip）。

## 探索结论（摘要）

- **EX5 跨节点登录**：mesh 用户身份是同一 uid/根公钥；浏览器持 sk_sess + 根钥签的 delegation（TTL 恒 18h，节点校验 `exp-issued_at === TTL`），远端节点 B 走 challenge → `signLogin` → B 自发 `tmex_s_<B>` cookie。会话钥**只在内存**，iOS PWA 每次冷启动都是新 document → 入口节点靠 cookie 仍在登录态，但 sk_sess 丢失 → 每台远端节点都要重新输密码。设备页对未登录节点直接渲染「登录此节点」按钮而不走静默门闸。**不采用**节点签名断言 / hub 签名断言（会把节点/hub 变成用户信任根）。
- **EX4 公网密码登录安全**：协议本身强（浏览器 argon2id 派生根钥、challenge 签名、密码不出浏览器；会话 256-bit 随机、DB 记录、18h 滑动/7d 硬上限、按节点绑定 `viaNodeId`；WS 用 cookie 不带 URL token）。实际风险是部署层：限流按 socket IP 分桶在隧道后全员共桶；首次 bootstrap 的 loopback 判定在隧道后可能被远端命中；裸 `@tmex/gateway` 入口无会话守卫（仅 dev）；HTTP 直连可被嗅探。**明确不做**：全局锁定/退避、密码复杂度规则、JWT/localStorage token、Origin 校验、HSTS、peer 口令层。
- **EX3 文件侧栏**：A) 文件可见性是浏览器本地偏好（`${runtimeNodeId}:${deviceId}`），缺省 `stored ?? hasRoots` → 远端节点凡配了目录的设备全部默认显示（终端侧栏远端默认隐藏），空分节仍渲染表头。B) 共享 `SortableVerticalList` 无 `modifiers`，`transform.x` 生效 + Base UI ScrollArea 视口 `overflow: scroll` + dnd-kit 默认双轴 auto-scroll → 横向滚动。
- **EX2 终端视口耦合**：一 pane 一个共享 PTY，任何客户端 `terminal-resize` 都 `resize-window`（后到者赢），`usePaneSizeSync`/`writeRestoredHistory` 再把本地模拟器强制拉到 tmux 几何。滚动在普通模式是本地（ghostty 自有 scrollback）；鼠标上报 / alt-screen 下手势变成 PTY 输入（TUI 自身滚动），这是共享 PTY 的固有属性。EX6 补充渲染层可行性后定 T* 方案。
- **EX1 PWA 加载/稳态传输**：待出。

## 任务清单与分派

| 编号 | 角色 | 内容 | 范围（文件集） |
| --- | --- | --- | --- |
| A1 | Opus | 会话钥持久化（WebCrypto 不可导出 Ed25519 + IndexedDB，仅 delegation TTL 内有效；不持久化 kTotp）、设备页静默登录门闸、失败退回手工登录、mesh e2e、架构文档 §2 更新 | `apps/fe/src/auth/**`、`pages/devices/node-device-group.tsx`、`packages/shared/src/auth` 新增 helper、`tests/mesh-login.spec.ts` |
| S1 | grok | 登录限流按 `TMEX_TRUST_PROXY` 解析真实客户端 IP；bootstrap loopback 判定代理感知（`CF-Connecting-IP` 恒视为非本地）；跨节点会话隔离回归测试；运维文档 | `apps/gateway/src/mesh/auth-routes.ts`、`mesh-deps.ts`、`api/local-auth-http.ts`、integration test |
| F1 | Opus | 文件侧栏缺省改为与终端侧栏一致（本机默认显示、远端默认隐藏，显式值优先）；已挂载且无可见根的分节不渲染；`SortableVerticalList` 加纵轴 modifier；ScrollArea 视口禁横向滚动；e2e | `packages/stores/sidebar-device-visibility.ts`、`packages/panels/src/files/**`、`device-tree-dnd.tsx`、`packages/ui/scroll-area.tsx`、`app-sidebar.tsx` |
| T1/T2 | grok + Opus | 终端视口分离（待 EX6 后定：网关按「最大可见客户端」定 PTY 尺寸；小客户端本地几何/平移；键盘输入照旧共享） | 待定 |
| P1… | 按 EX1 | PWA 传输精简 | 待定 |
| RV1–3 | codex sol | 按 backend / frontend / auth 三路审查 diff | — |

## 验收

- 各包单测不低于基线；tsc 错误数不高于基线；biome 对改动文件干净。
- e2e 全量与 KI-3 基线逐条比对；mesh 项目需 `TMEX_MESH_E2E_BUILD_FE=1`。
- 指挥官在仓库内起临时实例（不碰生产 9883）做场景实测：PWA 冷启动后远端节点静默登录；文件侧栏缺省与拖拽；双客户端终端尺寸。
- 分批 commit → 发版 → `tmex upgrade` 替换本机。

## 注意事项

- 生产 tmex（9883、`~/Library/Application Support/tmex/`）与 tmux session `tmex` 严禁触碰；测试用独立 socket。
- 改文案先读 `/Users/konata/code/tmex-copy-guidelines.md`，三语同步，`build:i18n` 由指挥官统一跑。
- e2e 运行期间不要改前端代码。
