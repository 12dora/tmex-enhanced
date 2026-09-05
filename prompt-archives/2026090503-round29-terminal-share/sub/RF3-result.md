# RF3 结果：前端评审修复（R1-frontend 1/4/5/6/7/8/9 + R1-backend 12/13）

分支 `feat/round29-terminal-share`，worktree `/Users/konata/code/tmex-r29`。基线 HEAD `2a09098b`。

## 一、后端必须对齐的握手约定（RF2 请按此实现）

分享页的 WS 在**初次连接与每一次重连**都会带一个固定查询参数：

```
wss://<host>/ws?cid=<nonce>&share=<shareId>          # self
wss://<host>/n/<nodeId>/ws?cid=<nonce>&share=<shareId>  # 经 Hub
```

- **参数名 `share`，值为 shareId 原文**（经 `encodeURIComponent`）。
- 追加逻辑在 `apps/fe/src/share/share-runtime.ts` 的 `withShareWsParam()`，常量 `SHARE_WS_QUERY_PARAM = 'share'`。
- `?cid=` 仍由 `createNodeWsUrlSource` 每条 socket 换一次，`share` 拼在它后面（没有查询串时自己起 `?`）。
- 契约期望：**带 `share=` 的握手一律按分享凭证鉴权**，不回退常规会话；凭证缺失 / 失效 / 绑定的是别的 shareId → 关闭码 **4401 `SHARE_LOGIN_REQUIRED`**。普通运行时（`NodeConnectionManager`）不带这个参数，行为不变。

## 二、发现 → 修复对照

| 编号 | 结论 | 修复 | 主要文件 |
|---|---|---|---|
| F1 major | 分享 WS 未绑定页面 shareId | 握手带 `share=<shareId>`（初连 + 重连）；运行时按 `nodeId+shareId` 记账，身份变了先 dispose 再重建，绝不复用别的分享的运行时；4401 仍回密码表单并释放运行时 | `apps/fe/src/share/share-runtime.ts`、`apps/fe/src/share/use-share-session.ts` |
| F4 major | 回放裁掉大尺寸录像的下 / 右画面 | 建完终端 `fit()` → `setViewportPan(true)`（内容表面按录制尺寸完整绘制，容器裁剪 + 双向滚动）；并把平移容器的 `touch-action` 交还浏览器（回放没有在线终端那套手势状态机，否则手机上拖不动） | `apps/fe/src/pages/settings/share/use-replay-terminal.ts` |
| F5 minor | 访客仍看到结构性操作 | 工具栏：`structureUi` 为 false 时不渲染「向右/向下分屏」；分屏区：pane 关闭按钮不渲染、标题栏不再可拖动（`cursor-grab`/`touch-none`/`onPointerDown` 一并去掉）。分享按钮此前已由 `shareUi` 关掉。**保留** splitter 拖拽（resize-pane）与尺寸仲裁 | `packages/panels/src/device-console/{use-device-console-actions.ts,device-console-toolbar.tsx,terminal-stage.tsx}`、`packages/terminal-ui/src/components/{SplitTerminalArea.tsx,split/SplitPaneView.tsx}` |
| F6 minor | 重开弹窗不再预选默认地址 | 填默认地址的 effect 加上 `open` 依赖（重置草稿的 effect 声明在前，同一次提交里先清后填） | `packages/panels/src/share/use-share-dialog.ts` |
| F7 minor | 已结束的分享仍显示「进行中」 | 抽出纯函数 `resolveActiveShare()`：创建结果只兜底到列表同步为止（`dataUpdatedAt > created.at`），之后一律以服务端为准 | `packages/panels/src/share/{share-dialog-model.ts,use-share-dialog.ts,use-share-status.ts}` |
| F8 minor | 分享错误在中文界面显示英文 | 四族端点改抛带 `code` 的 `ApiError`；新增 `shareErrorKey(error)` → `share.error.<CODE>`，未知 / 无码走 `share.error.generic`。弹窗 toast、设置页四处 Notice、回放加载失败统一走它 | `packages/api-client/src/{share.ts,share-errors.ts}`、`apps/fe/src/pages/settings/share/{share-api.ts,use-share-tab.ts,use-replay-log.ts,replay-viewer.tsx}`、`packages/panels/src/share/use-share-dialog.ts` |
| F9 minor / B12 | 设备查询失败覆盖成功快照 | 查询状态判定抽成纯函数 `deviceQueryFlags()`，新增 `succeeded = isSuccess && !isPlaceholderData`；快照回写只认 `succeeded`（成功返回的空列表照常保存，失败 / 占位不写） | `packages/panels/src/device-tree/use-sidebar-device-stats.ts`、`apps/fe/src/components/page-layouts/components/sidebar-device-list-runtime.tsx` |
| B13 | 无截止时间的熔断显示 `{{until}}` 原文 | `DIRECT_FAILURE_CODES` 加 `breaker_paused` + 三语文案；徽标在 `dcCode === 'breaker_cooling'` 且没有 `until` 时改用 `breaker_paused`（兼容不下发新码的旧网关） | `packages/api-client/src/auth/types.ts`、`apps/fe/src/node/device-node-badges.tsx` |
| 可选加固 | `useShareSession` 迟到响应 | 按 `nodeId\0shareId` 做代次检查：卸载或换分享后到达的 access / login / 关闭码一律不再 dispatch | `apps/fe/src/share/use-share-session.ts` |

`apiError.shareAuthRequired` **已由 RF1 加好**（三语齐全），按任务说明未重复添加。

## 三、i18n（只动了自己的两棵子树，三语同步）

- `nodes.badge.failure.breaker_paused`：zh「直连已暂停」/ en "Direct link paused" / ja「直接接続は停止中」
- `share.error.*` 新增 7 条：`generic` + `SHARE_NOT_FOUND` / `SHARE_WINDOW_NOT_FOUND` / `SHARE_PASSWORD_TOO_SHORT` / `SHARE_ORIGIN_INVALID` / `SHARE_ENDED` / `SHARE_AUTH_REQUIRED`
  （zh 例：「窗口已关闭，无法分享。」「须先启用登录保护才能分享。」「操作失败，请重试。」）

已跑一次 `bun run --filter @tmex/shared build:i18n`（common.md 允许），生成物未手改；指挥官收尾时会再跑一次。

## 四、结构性说明 / 与原任务描述的偏差

1. **`shareErrorKey` 放在 `packages/api-client/src/share-errors.ts`，刻意不从 `index.ts` 导出。**
   `share.*` 属 rest 语言包，而 `api-client/src/index.ts` 在前端入口的静态 import 图上，
   `apps/fe/src/i18n/core-coverage.test.tsx` 会因此要求这些 key 进 core（实测先放在 `share.ts` 里当场把守卫打红）。
   消费方（分享弹窗、设置页）都是懒加载 chunk，直接 `@tmex/api-client/share-errors` 引用。
2. **分屏结构开关没有从 `DeviceConsole` 透传**，而是在 `terminal-stage.tsx` 的 `StageContent` 里直接读
   `useRuntime().features.shareViewer`。原因：给 `DeviceConsole` 加参数会让它超出复杂度门禁记录的 128 行
   （allowlist 只降不升），而 `StageContent` 有余量。工具栏那侧仍走 model 的新字段 `structureUi`。
3. **跨范围最小改动（已尽量点状，请评审知悉）**：
   - `packages/terminal-ui/src/components/SplitTerminalArea.tsx`：新增可选 prop `structureActions`（缺省 true）并透传；
     为过门禁把「拖拽浮动标签」抽成 `PaneDragLabel` 组件（纯搬运）。
   - `packages/terminal-ui/src/components/split/SplitPaneView.tsx`：同名可选 prop；关闭按钮抽成 `PaneCloseButton`（纯搬运，为过门禁）。
   - `packages/api-client/src/auth/types.ts`：`DIRECT_FAILURE_CODES` 加一个码。
   - `packages/shared/src/i18n/locales/*.json`：只加 `nodes.badge.failure` 一条与 `share.error` 七条。
4. `use-replay-terminal.ts` 里 `handle.fit` 仍然导出但无人调用（既有情况，未动）。
5. **回放的纵向平移**：滚轮向下先喂 scrollback，到底后才由原生 `overflow:auto` 平移到录像底部；
   这与在线跟随者终端行为一致。横向靠 `deltaX` / Shift+滚轮（Ghostty 已有的 `consumeGestureAsPanX`）与原生滚动条。
   **未做浏览器实测**（需要真实录像），请指挥官在实测阶段用 200×60 的录像核对能否拖到右下角。

## 五、测试与门禁

| 命令 | 结果 |
|---|---|
| `cd apps/fe && bun test src/` | **2598 pass / 0 fail**（155 文件） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 错 |
| `cd packages/panels && bun test` | **1004 pass / 0 fail**（92 文件） |
| `cd packages/panels && bunx tsc --noEmit -p .` | 0 错 |
| `cd packages/api-client && bun test` | **245 pass / 0 fail** |
| `cd packages/api-client && bunx tsc --noEmit -p .` | 0 错 |
| `cd packages/stores && bun test` / `tsc` | 432 pass / 0 fail；0 错（本轮未改该包，仅回归） |
| `cd packages/terminal-ui && bun test` / `tsc` | 394 pass / 0 fail；0 错 |
| `cd packages/shared && bun test` | 789 pass / 0 fail（含语言包一致性与生成物同步） |
| `bunx biome check <本任务全部文件>` | clean |
| `bun scripts/complexity/gate.ts` | 本任务文件 0 违规。仓库当前 3 条违规全在 `apps/gateway/src/mesh/{peer-dial-race,peer-manager,mesh-runtime}.ts`（RF2 在途） |

`packages/ws-client` 未触碰（`wsUrlFactory` 已覆盖初连 + 重连，无需改动）。

新增测试文件：
- `packages/api-client/src/share-errors.test.ts`（2）：契约码 → key、未知/无码/非 ApiError 走兜底
- `packages/panels/src/device-tree/use-sidebar-device-stats.test.ts`（4）：pending / 占位 / 成功空列表 / 失败四态
- `apps/fe/src/pages/settings/share/use-replay-terminal.test.ts`（3）：fit → 开平移的顺序、touch-action 交还、无容器不抛错

改动的既有测试：
- `packages/api-client/src/share.test.ts`：+1（错误确实是带 code 的 `ApiError`，可直接映射 i18n key）
- `packages/panels/src/share/share-dialog-model.test.ts`：+5（`resolveActiveShare` 五种组合）
- `packages/panels/src/share/share-i18n.test.ts`：清单补 7 个新 key
- `packages/panels/src/device-console/device-console-actions.test.ts`：+1（`structureUi:false` 去掉分屏按钮），model 夹具补字段
- `packages/panels/src/device-console/toolbar-tooltips.test.tsx`：model 夹具补字段
- `packages/panels/src/device-console/terminal-stage.test.tsx`：+1（share viewer 的分屏视图无关闭按钮、无 `cursor-grab`），runtime 夹具支持 `shareViewer`
- `apps/fe/src/share/share-runtime-codes.test.ts`：+4（`withShareWsParam` 拼接 / 转义 / 参数名）
- `apps/fe/src/node/device-node-badges.test.tsx`：+2（无 until 换 `breaker_paused`、网关直接下发新码）

## 六、遗留 / 需要别的 agent 配合

1. **RF2**：WS 握手必须识别 `?share=<shareId>` 并强制匹配分享凭证，不匹配 4401（见第一节）。
   若最终参数名有变，改 `apps/fe/src/share/share-runtime.ts:SHARE_WS_QUERY_PARAM` 一处即可。
2. **RF2**：`breaker_paused` 需在网关侧 `direct-failure-codes.ts` 于无 `coolingUntil` 时下发；
   前端已同时兼容旧网关（`breaker_cooling` + 无 `until` 也按 `breaker_paused` 显示）。
3. 未做浏览器 / e2e 实测：回放平移、分享页结构按钮消失、错误码 toast 三项建议在实测阶段一并核对（含文案换行与截断）。
