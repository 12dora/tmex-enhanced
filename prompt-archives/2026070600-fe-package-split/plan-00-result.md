# 执行结果（P1：@tmex/ui，2026-07-06）

## 落地形态

- 新包 `packages/ui`（@tmex/ui，private）：`components/`（21 个 shadcn 组件，git mv 保 blame）+ `utils.ts`（cn）+ `hooks/use-mobile.ts`；`exports` 主入口 + `./*` 子路径直指 src；react/react-dom 为 peerDependencies——后续分包的 package 范式模板。
- fe：47 文件 import 改写（`@/components/ui/*` → `@tmex/ui/*`、cn/useIsMobile 走主入口）；`index.css` 加 `@source "../../../packages/ui/src"`；components.json aliases 与 tsconfig paths 指向包内源码（shadcn CLI 生成落位 packages/ui）。
- Dockerfile 补齐 workspace 包 COPY（@tmex/ui + 存量缺失的 ghostty-terminal）。
- 新增 cn 单测 4 例。

## 验证证据

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit`（fe） | 0 错误 |
| `bun run --filter @tmex/fe build` | 通过（vite 产物正常） |
| `bun run lint` | 343 错误 < 改动前基线 353（未新增；organizeImports 顺带修复存量排序） |
| bun test | shared 91 / ghostty 108 / ui 4 / app 72 / gateway 826 全 pass（gateway 曾偶现 1 例 switch-barrier 时序 flaky，复跑全绿） |
| Playwright e2e | 87 passed / 3 skipped / 1 failed（`ws-borsh-theme-resize.spec.ts`，**stash 基线复现同样失败**——本环境存量不稳定用例，与本次改动无关） |
| `build:artifacts --outdir … --smoke` | 组装 176 entries，临时实例 `GET /healthz → 200` |
| 明暗双模式截图核对 | devices/settings 页 light+dark 样式完好，`@source` 生效无丢 class |

## 复验（严格「零 break」验收，2026-07-06 晚）

1. **内容等价**：21 个组件 + utils + use-mobile 新旧版本剔除 import 行后逐字节等价；CSS/裸副作用 import 零重排；main.tsx 仅 2 行 import 路径改写；persist/localStorage 零触碰。
2. **全量 e2e 前后对照**（同命令同环境，JSON 报告逐用例 diff，103 用例集完全一致）：回归候选 3 例经重复采样全部排除——mobile-mouse-reporting×2 单跑全过（全量时负载抖动）；theme-propagation rapid-toggle 单 spec 采样基线 4/6 过 vs 改动后 3/4 过（通过率一致，存量抖动用例）；改动后反向修复基线 2 例失败（抖动对称）。**无真回归**。
3. **Dockerfile 隔离演练抓到并修复第二处缺失**：按 COPY 清单在隔离目录完整跑 bun install + build，发现根 tsconfig.json 未入构建上下文（packages/* 的 tsconfig extends 解析失败），补 COPY 后演练通过（f34bb60）。
4. **npm pack --dry-run**：包结构 bin/dist/resources（181 文件）无源码包泄漏；build:artifacts --smoke 复跑探活 200。
5. **组件交互真实走查 8/8**：dialog 开/关、sidebar 折叠展开、tabs 切换、input、select 下拉、switch、settings 五 tab 轮巡（产物形态临时实例）。

## 偏差与遗留

- 本环境全量 e2e 存在约 11-13 例随负载漂移的不稳定用例（两侧基线均复现，集中在 mobile 触控、terminal-mouse-recovery、theme×resize 压力类）；单跑/小组合大多通过。建议后续在低负载 CI 环境建立稳定基线，不阻塞分包推进。
- lint 全仓基线本就有 ~350 个存量错误（多为 shadcn 生成风格与 biome 规则冲突），本次未处理，维持「不新增」原则。
- P2（ws-client）/P3（api-client）/P4（notifications）可并行，见 plan-00.md。

## P2–P6 实施记录（2026-07-07/08）

按 plan-00.md 串行完成，每阶段「先搬迁（git mv 保 blame）后解耦」分 commit，
推送前全部通过：tsc + vite build、全包 bun test、全量 e2e 前后对照（零 pass→fail，
失败候选一律单跑/基点采样排除，证据方法见 docs/testing/2026070800-e2e-known-issues.md）、
lint 不新增（343→319）、Dockerfile 隔离演练、npm pack 核对、build:artifacts --smoke、
明暗双模式截图核对。

- **P2 @tmex/ws-client**（d3b0742、973c5c0）：WS 端点构造注入 + updateUrl；PaneSinkRegistry
  类化（模块级函数保留为默认实例代理）；createGatewayConnection 连接工厂；biome 固化生成
  产物 ignore。
- **P3 @tmex/api-client**（9a6eca6、ca6eeef）：ApiClient(baseUrl) + 端点函数尾参双形态；
  agent/site store 内联 fetch 收敛（404/409 等分支语义逐处保持）；capabilities 常量上移
  @tmex/shared（REST/WS 同源）；fetchCapabilities + FeatureSet helper。
- **P4 @tmex/notifications**（0bc0d3f、a107559）：通知文案组装 t 注入；bell store/声音入包；
  NotificationSink/BellPlayer/BrowserNotifier 语义接口 + no-op 默认；watch 文案纯函数；
  应用侧 sonner 适配器。
- **P5 @tmex/stores**（e6d7f7d、b709040）：五 store 工厂化 + createAppRuntime（连接面/REST/
  通知/宿主服务/storagePrefix 全可注入，默认 client 惰性求值保时序等价）；模块级可变状态
  收进工厂闭包 + dispose 注销；默认 runtime 原名导出兼容层；/react RuntimeProvider；
  字体清单先行入 @tmex/theme（依赖方向 theme→stores）。
- **P6 @tmex/theme**（d405e87、f6ddac8）：themes.css 与应用 token 段入包（CSS 变量名清单即
  换肤契约）；preset 注册表 + dataset 激活机制（ui store 增 themePreset，默认 null 视觉不变）；
  --terminal-shortcut-* 单源化（TS 真源生成 tokens.generated.css）；顺带修复 preset 样式源
  顺序缺陷（dormant 时代变量恒被默认值覆盖，从未真正可激活）。

- **P7 @tmex/terminal-ui**（e0811f9、f2537de）：components/terminal 13 文件 + 5 utils +
  use-keyboard-avoidance 入包；store 访问经 `@tmex/stores/react` context 便捷 hook（缺省即
  默认 runtime）；Terminal 六路依赖反转（navigate→host.navigate + onOpenFile 回调、
  toast→notifications、fetchFile→apiClient、registerPaneSink→runtime.paneSinks、
  fonts→theme）；runtime 补 PaneSinkRouting.registerPaneSink（sink 消费侧反转，register/
  dispatch 归同一注册表）；去 react-router/sonner 依赖。
- **P8 @tmex/panels**（c8e7b89、afb2b43）：agent/files/markdown/code-viewer/watch/settings
  面板 + connection-indicator + device-status-badge 共 46 文件入包，按功能域划子路径出口；
  内联跨面板引用改相对；i18n 由应用侧包装改 i18next 全局单例；watch-events-init 通知出口
  改走默认 runtime sink（浏览器通知保留本地降级）；富渲染第三方依赖（react-markdown/mermaid/
  katex/dnd-kit/qrcode/rehype-*/remark-*）随组件迁移声明，singleton 类库（sonner/react-router/
  i18next/react-query）置 peerDependencies。settings 桶出口可摇树（设备页仅取两组件不裹入
  重模态）。

- **P9 收尾**（capabilities wiring + docs）：fe 已外壳化（components 仅剩 page-layouts +
  Sidebar/flow-bridges/global-device-provider）；`client.serverCapabilities` 落 HELLO_S2C
  能力集（按连接）；site store 增 `capabilities: FeatureSet` + `loadCapabilities()`（消费
  `GET /api/capabilities`），fe 启动即拉取；包结构/嵌入用法文档见 `docs/frontend/packages.md`。

**九包拆分完成**（shared/ui/ws-client/api-client/notifications/theme/stores/terminal-ui/
panels + apps/fe 外壳）。**已知限制**：bell store 为全局单例（多连接宿主 paneId 理论冲突）；
getSiteNameFallback/usePaneAgentState 绑定默认 runtime（多实例宿主应经 runtime 取用）；
panels 保留 sonner/react-router peerDep（最外层 UI 面局部 toast/路由，非跨切面通知）；
preset 设置页 UI 未做（机制层完备，可编程激活）。
