# fe 分包重构计划（2026-07-06）

## 背景

`apps/fe`（~150 文件 / ~30300 行）的可复用逻辑与应用外壳强耦合：`Terminal.tsx` 反向依赖 stores / ws 层 / fonts / react-router / sonner；stores 直调 toast、bell-sound、导航；WS 客户端与 pane-sink 为模块级单例且 `WS_URL` 顶层求值；REST 调用为散落各处的裸 fetch。这使终端组件与数据层无法在其他宿主中复用，纯逻辑无法用 bun test 隔离覆盖，多连接/测试并行受单例限制。

本计划把可复用部分拆为独立 workspace packages，`apps/fe` 变薄为外壳。沿用仓库既有包范式：`exports` 直指 `./src/index.ts` 源码直引、无独立构建；含 React 的包将 react/zustand/react-i18next/@tanstack/react-query 声明为 peerDependencies。

## 目标包结构（9 包，新增 7 个）

```
@tmex/shared ─┬─→ ws-client ─────┐
              ├─→ api-client ────┤
              ├─→ notifications ─┼─→ stores ─┬─→ terminal-ui ─┐
              └─→ theme ─────────┘           │                ├─→ panels → apps/fe
ghostty-terminal ────────────────────────────┴─(terminal-ui)  │
@tmex/ui（无内部依赖）───────────────────────→ terminal-ui/panels/fe
```

| 包 | 内容 | 关键改造 |
|---|---|---|
| @tmex/ui | components/ui/ 30 文件、lib/utils.ts(cn)、hooks/use-mobile | 子路径导出；peerDeps 模板在此定死 |
| @tmex/ws-client | src/ws-borsh/ 全部 | WS_URL 惰性化+构造注入、updateUrl；PaneSinkRegistry 类化（模块级函数保留为默认实例代理）；createGatewayConnection 工厂 |
| @tmex/api-client | files/watch/settings 各 api + stores 内联 fetch 收敛 | ApiClient 类（baseUrl+统一错误解析）；端点函数 `fn(client = defaultApiClient)`；capabilities 常量上移 shared，新增 fetchCapabilities + FeatureSet helper |
| @tmex/notifications | tmux-notification-format、bell-sound、bell store、watch 格式化纯函数 | NotificationSink/BellPlayer/BrowserNotifier 接口 + no-op 默认；fe 提供 sonner 适配器；不依赖 stores（开关状态调用方传入） |
| @tmex/stores | stores/ 其余、usePaneAgentState、导航/url utils、flow-bridges 抽象 | createAppRuntime(options) 工厂 + dispose；默认单例兼容层原名导出（fe 零行为变化）；/react 子入口 RuntimeProvider（context 默认值=默认 runtime）；HostServices；getTmuxWindowStyle 改指 @tmex/shared |
| @tmex/theme | lib/fonts/、themes.css、index.css token 段 | loadTerminalFonts 加 assetBaseUrl；preset 注册表 + 激活接线（ui store 增 themePreset，dormant preset 变可用功能）；--terminal-shortcut-* TS 真源 + 生成 tokens.generated.css |
| @tmex/terminal-ui | components/terminal/ 17 文件 + 终端相关 utils/hooks | 依赖反转：store 走 context hooks、pane-sink 走 runtime.connection、文件链接走 host.navigate + onOpenFile 回调、toast → notifications、fonts → theme；去 react-router/sonner 依赖 |
| @tmex/panels | agent-panel、files-panel、markdown、code-viewer、watch React 部分、connection-indicator、device-status-badge、settings 全部 | 子路径导出（/agent /files /settings…）；watch-events-init 接 notifications |
| apps/fe（留下） | main.tsx、pages/、Sidebar、page-layouts、global-device-provider、flow-bridges 组件、i18n 初始化、index.css（@theme inline 桥+业务 class+@source）、sonner 适配器 | 变薄为外壳 |

## 分阶段（每阶段独立可验证；P2/P3/P4 可并行；关键路径 P1→P5→P7→P8）

P1 @tmex/ui（S）→ P2 ws-client（M）/ P3 api-client（M）/ P4 notifications（S–M）→ P5 stores（L）→ P6 theme（M）→ P7 terminal-ui（L）→ P8 panels（L）→ P9 收尾（fe 清残留、HELLO_S2C capabilities 落地、/api/capabilities 消费、文档）（M）。

每阶段验证基线：`bun run lint`、`bun run --filter @tmex/fe build`、`bun test`（受影响包）、fe Playwright e2e 全绿（独立 tmux socket、非生产端口）；P1/P5/P7/P8/P9 额外全链 `bun run build` 与 `build:artifacts`。

## 风险与对策

1. Tailwind v4 扫不到包内 class → P1 建立 fe index.css `@source` 范式，每阶段明暗双模式人工核对；
2. React 双实例 → 含 React 包一律 peerDependencies，P1 定死模板；
3. 单例惰性化改时序 → 兼容导出保持「首次 import 即建默认实例」等价时序，重连/刷新 e2e 重点回归；
4. notifications↔stores 隐环 → 开关状态由调用方传参，notifications 无状态；
5. persist key 不改（tmex-ui 等），前缀只走工厂 option；
6. 搬迁 commit 用 git mv 保 blame，「先搬迁后解耦」分 commit；
7. 产物链（fe/dist → bundle-resources.sh → resources/fe-dist）不变，chunk/资产变化在 build:analyze 与临时实例冒烟确认。

## 注意事项

- 不碰生产环境（launchd 服务 / 9883 / `~/Library/Application Support/tmex/`）与名为 `tmex` 的 tmux session；e2e 用独立 socket 与非生产端口。
- 生成文件（i18n resources、wasm、未来的 tokens.generated.css）不 lint/format。
- 浏览器侧包禁止导出 Node-only 模块。
