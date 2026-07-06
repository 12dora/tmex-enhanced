# 任务 prompt（2026-07-06）

对 `apps/fe` 做分包重构：把可复用的前端逻辑从应用中拆分为独立 workspace packages，使 fe 变薄为外壳层。动机：

1. **可嵌入复用**：终端组件、数据层、通知逻辑目前与应用外壳强耦合（模块级单例、组件反向依赖 stores/路由/toast），无法被其他宿主（嵌入式场景、备用外壳、E2E 驱动）复用。
2. **测试隔离**：纯逻辑（协议客户端、状态管理、格式化）与 React/DOM 解耦后可用 bun test 独立覆盖，不必全部依赖 Playwright e2e。
3. **消除模块级单例副作用**：`WS_URL` 顶层求值、全局 client/pane-sink 单例使多连接、SSR 安全、测试并行都受限；改为工厂 + 默认实例兼容层。

约束：
- 行为不变的重构——fe 现有 Playwright e2e 全程保持绿；persist key、时序、产物链（fe/dist → bundle-resources.sh → resources/fe-dist）不变。
- 分阶段推进（每阶段独立可验证），搬迁 commit 用 `git mv` 保 blame，「先搬迁后解耦」分 commit。
- 浏览器侧包禁止导出 Node-only 模块；生成文件不 lint；react 等运行时依赖在含 React 的包中声明为 peerDependencies。

分阶段计划见 plan-00.md。本次会话执行 P1（@tmex/ui）。

## 后续对话 prompt

（追加于此）
