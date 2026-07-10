# tmex 设备树与侧边栏迭代 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use test-driven-development task-by-task. This plan is intentionally based on the current vibex gitlink, not an arbitrary newer tmex main.

**Goal:** 移除 tmex 前端可见的设备连接／断开分支，改为可持久化的设备树展开状态，并按规定重排和联动侧边栏一级分区。

**Architecture:** 底层 tmux WebSocket 订阅仍是运行时机制，不能删除；`GlobalDeviceProvider` 不再保存用户的连接意图，而是在设备路由或设备树展开时无感确保订阅。Zustand UI store 成为所有展开规则和本地持久化的唯一来源，侧边栏仅以 URL 选择三元组高亮。

**Tech Stack:** Bun、React 19、React Router、Zustand persist、TanStack Query、Base UI Collapsible、Playwright。

---

## 背景与边界

- 实施基线为 `ebbdf7c34024b94f6ac392c4f8b2521e72315d65`（父仓当前 tmex gitlink / `origin/vibex/main`），tmex 开发分支为 `vibex/tmex-sidebar-device-management`。
- 本阶段只改 tmex；Vibe X Webapp 的完整 tmex 风格迁移、除 Agent 外的功能同步与多 instance 聚合，待用户验收 tmex 后另开计划。
- 不删除 `packages/stores/src/tmux.ts` 的 `connectedDevices`、`deviceConnected`、`connectDevice` 或 `disconnectDevice`。它们服务于协议、重连、终端和 Files→Agent 流程，不再用于决定 UI 是否可见。
- 按最佳实践先行：设备路由或手动展开设备时后台订阅，折叠只控制显示；不一次性订阅所有设备，避免 SSH runtime 连接风暴。删除设备时全局层清理残留订阅。
- 生产 tmex（9883、`~/Library/Application Support/tmex/`、默认 tmux `tmex` session）不触碰。数据库仅按用户授权从 `/Users/krhougs/LocalCodes/tmex` 的开发库复制 WAL 三件套到本 worktree 的 `vendor/tmex/` 根。

## 可验收行为

1. 侧边栏没有连接／断开按钮、绿灰连接点、点击整张卡连接的行为；所有设备显示一致，设备树可独立展开／收起且刷新后保持。
2. 设备管理页没有 Connect 入口。
3. Panes、Files 默认展开；Agent 位于第一项且默认收起。打开 Agent 会收起 Panes 和 Files；打开 Panes 或 Files 会收起 Agent；Panes、Files 可以同时展开。状态刷新后保持。
4. 设备、窗口、pane 的高亮仅由浏览器当前 URL 三元组决定，绝不以 tmux `active` 字段给其他项目高亮。
5. UI 保持当前 tmex 信息架构和视觉语言，只调整一级分区头的密度、图文层级与顶部留白。

### Task 1: 先为侧边栏状态转换建立失败测试

**Files:**

- Create: `packages/stores/src/ui.test.ts`
- Modify: `packages/stores/src/ui.ts`

**Step 1: Write the failing test**

为纯状态转换写 Bun 测试，要求：默认 `{ panes: true, agent: false, files: true }`；打开 Agent 后只有 Agent 打开；从 Agent 打开 Panes 或 Files 会关闭 Agent 且保留另一非 Agent 项；关闭项不影响其他项；旧的 `{ panes: true, agent: true, files: true }` 持久化值被归一为 Agent 独占；设备展开状态可按 device ID 写入状态。

**Step 2: Run test to verify it fails**

Run: `bun test packages/stores/src/ui.test.ts`

Expected: FAIL，因为默认值、状态转换 helper、设备展开状态和 persist 行为均尚不存在。

**Step 3: Implement the minimal state model**

在 `ui.ts` 中：

- 导出可单测的 section 归一化／转换 helper；
- 增加 `sidebarDeviceExpanded: Record<string, boolean>` 与 setter；
- 把 `sidebarSections` 纳入 persist `partialize`，`merge` 时归一旧值；
- 让 `setSidebarSectionOpen` 和 `expandSidebarSection` 复用同一转换逻辑；
- 保持既有 `${storagePrefix}tmex-ui` key，确保多实例隔离。

**Step 4: Run test to verify it passes**

Run: `bun test packages/stores/src/ui.test.ts`

Expected: PASS，且只覆盖状态层。

### Task 2: 先写会失败的侧边栏／设备管理 E2E 回归

**Files:**

- Create: `apps/fe/tests/sidebar-device-disclosure.spec.ts`
- Modify: `apps/fe/tests/devices.spec.ts`
- Modify: `apps/fe/tests/mobile-agent-watch.spec.ts`

**Step 1: Write failing E2E tests**

使用 `tests/helpers/tmux.ts` 的独立 `tmex-e2e` socket 建一个 local device 和会话。测试应断言：

- `device-expand-{id}` 存在；展开后窗口树出现，收起后隐藏，reload 后仍保持收起；
- 不存在 `device-connect-*`、`device-disconnect-*` 及 `device-card-connect-*`；
- section trigger 的 `aria-expanded` 与 Agent/Panes/Files 联动规则一致，并在 reload 后保持；
- 当前 URL 对应的窗口／pane 带 `data-active=true`，非当前项没有该属性；
- 移动端 Agent 测试更新为 Agent 打开时 Panes/Files 收起，而不是旧的三分区同时可见。

**Step 2: Run tests to verify they fail**

Run: `cd apps/fe && bun run test:e2e tests/sidebar-device-disclosure.spec.ts tests/devices.spec.ts tests/mobile-agent-watch.spec.ts`

Expected: FAIL，现有界面仍有 Connect/Disconnect、所有一级分区同时打开且无设备 disclosure／`data-active` 标记。

### Task 3: 实施无感订阅与设备树 disclosure

**Files:**

- Modify: `apps/fe/src/components/global-device-provider.tsx`
- Modify: `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`
- Modify: `apps/fe/src/pages/DevicePage.tsx`

**Step 1: Replace persisted connection intent**

把 `tmex:connectedDevices` 及 `connect/disconnect/toggle` 用户操作 API 替换为 `ensureDeviceSubscribed(deviceId)`：设备路由进入或 tree 展开时调用；通过 `['devices']` 查询在已加载设备集合中清理被删除设备的底层订阅。不得因 collapse 断连，也不得展示连接开关。

**Step 2: Replace visual connection branches**

在 `sidebar-device-list.tsx` 中删除 `isConnected` prop、连接点、Power 图标／按钮、卡片 click-to-connect 和仅已连接渲染的条件。用本地持久化的 device expansion 状态控制窗口树；展开时调用 `ensureDeviceSubscribed`，无 snapshot 时展示中性 loading 文案。保留 `DeviceStatusBadge` 用于错误／重连诊断，不把它作为二元连接状态。

将 window/pane 的 active class fallback 删除；逐级传递完整的 URL 选择身份，给当前窗口和 pane 加 `data-active` 以提供稳定验收钩子。

在 `DevicePage.tsx` 删除“Disconnected / Connect to start”的可见分支，统一为后台准备中的 loading 或已有错误反馈，避免设备页面重新暴露连接态。

**Step 3: Verify targeted E2E turns green**

Run: `cd apps/fe && bun run test:e2e tests/sidebar-device-disclosure.spec.ts tests/devices.spec.ts tests/mobile-agent-watch.spec.ts`

Expected: PASS。

### Task 4: 实施一级分区顺序和轻量视觉校准

**Files:**

- Modify: `apps/fe/src/components/page-layouts/components/app-sidebar.tsx`

**Step 1: Wire the state model**

将 Agent block 移到 Panes 之前，不改变三块 Collapsible 的结构、lazy loading 或 footer 导航。维持 Panes/Files 可同时分配空间。

**Step 2: Apply constrained styling**

仅为首个分区增加平衡顶部间距，微调一级 trigger 的图标大小、文字字重／tracking、间距、圆角 hover/focus 状态；沿用现有 tmex token 和颜色，禁止引入新的视觉体系或重构布局。

**Step 3: Run the targeted E2E suite**

Run: `cd apps/fe && bun run test:e2e tests/sidebar-device-disclosure.spec.ts tests/devices.spec.ts tests/mobile-agent-watch.spec.ts tests/sidebar-close-confirm.spec.ts tests/sidebar-click-no-pty-injection.spec.ts`

Expected: PASS，且所有 tmux 操作仍使用 `tmex-e2e` socket。

### Task 5: 回归、构建、视觉验收与归档

**Files:**

- Modify: `prompt-archives/2026071003-tmex-sidebar-device-management/plan-00-result.md`
- Modify: `docs/architecture/2026-07-10-tmex-sidebar-device-management.md`

**Step 1: Run focused and package verification**

Run:

```bash
bun test packages/stores/src/ui.test.ts
cd apps/fe && bun run test:e2e tests/sidebar-device-disclosure.spec.ts tests/devices.spec.ts tests/mobile-agent-watch.spec.ts tests/sidebar-close-confirm.spec.ts tests/sidebar-click-no-pty-injection.spec.ts
cd ../.. && bun run build:fe
```

Expected: all commands exit 0.

**Step 2: Run the temporary development server**

在复制开发数据库三件套并确认源库没有开发进程占用后，在 `vendor/tmex` 根执行 `bun run dev`。保留临时实例，使用 `http://localhost:19883` 供用户验收；不得触碰 9883 生产服务。

**Step 3: Browser verification**

使用 Playwright / 浏览器确认桌面与移动侧边栏：Agent 置顶、互斥规则、Panes+Files 并开、device disclosure、本地刷新保持、设备管理页无 Connect、当前路由的唯一高亮。记录截图或可复现证据。

**Step 4: Review and commit**

先做需求符合性 review，再做代码质量 review，修复所有重要问题后重新验证。tmex 内使用中性开源的 commit message；推送前须经用户授权，且永不推上游 main/master。
