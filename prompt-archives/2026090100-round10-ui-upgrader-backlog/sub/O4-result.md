# O4 结果：e2e baseline 五项失败的测试侧修复

范围：只改测试文件（含 `tests/helpers/mesh.ts`），未触碰任何产品代码；未运行 Playwright 真实用例。

## 逐项改动

### 1. `apps/fe/tests/sidebar-resize.spec.ts:42`

`getByRole('button', { name: 'Toggle Sidebar' })` → `getByTestId('mobile-sidebar-open')`。

按钮的可访问名由 `page-wrapper.tsx` 的显式 `aria-label`（`nav.openSidebar`，随语言变化）决定，`sr-only` 的 `Toggle Sidebar` 已被覆盖。与 `mobile-nav.spec.ts:13` 的既有写法一致。

### 2. `apps/fe/tests/mobile-mouse-reporting.spec.ts:206`

用例重命名为 `mobile: single-finger drag sends wheel events (not drag motion) when reporting is on`，session 名 `tmex-e2e-mdrag-*` → `tmex-e2e-mscroll-*`。

断言改为：
- `SGR_WHEEL_RE` 命中数 `> 0`（poll，10s）；
- `SGR_MOTION_RE` / `SGR_PRESS_RE` / `SGR_RELEASE_RE` 均为 `0`。

`SGR_WHEEL_RE`（`ESC[<6[45];\d+;\d+M`）文件里已存在（line 17，双指滚轮用例在用），无需新增；与其它 SGR 正则同风格。同时更新了文件头注释（原文写「单指拖=按住 motion」已与产品不符：单指移动走 `gesture-machine` 的 scroll 分支 → `reportGestureAsMouse` → 滚轮 64/65，TUI 的 press+motion+release 只保留给桌面原生鼠标）。

### 3. `apps/fe/tests/agent-session.spec.ts:404`（running session enqueues further messages）

提取 `const send = page.getByTestId('agent-chat-send')`；两处 `textarea.fill(...)` 之后各加一句 `await expect(send).toBeEnabled()` 再 `send.click()`。send 的禁用条件是 `disabled || text.trim().length === 0`，`disabled` 还受 `sending`/草稿物化影响，仅等 textarea 或 stop 按钮不足以证明 send 已 action-ready。未使用 `force` 点击，未放宽任何超时。

### 4. `apps/fe/tests/settings-llm.spec.ts`

- 新增 `MockSearchProvider` 接口（`id: string; label: string; isConfigured: boolean`），字段与 `packages/shared/src/contracts/llm.ts:9` 的 `SearchProviderInfoDto` 完全一致；
- 新增 `searchProviders` mock 数据：`tavily/Tavily`、`brave/Brave`，`isConfigured: false`；
- GET `**/api/llm/settings` 返回 `{ settings, searchProviders }`；
- PATCH 同样返回 `{ settings, searchProviders }`，并在返回前把 `isConfigured` 同步为 `settings.hasTavilyApiKey` / `hasBraveApiKey`（保存后 invalidate 重新 GET 不会退回不完整响应）。

`search-tab.tsx:103` 从 `settingsQuery.data.searchProviders` 构造选项，缺该字段时下拉只有 `none`，`Tavily` 永远不出现——这就是原失败原因。UI 目前不消费 `isConfigured`（全仓无引用），同步它只是让 mock 更贴近真实后端。

### 5. `apps/fe/tests/ws-borsh-theme-resize.spec.ts`

循环结束后、`waitForTimeout(2_000)` 之前插入 `await page.setViewportSize({ width: 1200, height: 800 })`，把 viewport 恢复到初始值再做 drift 比较；settle 沿用文件既有的 `waitForTimeout(2_000)` 风格。`colsDrift < 2` / `rowsDrift < 2` 容差保持不变——原失败是循环最后停在 1250×830 却与 1200×800 的 pane 尺寸比较，属比较对象不一致，不是容差问题。

### 6. `apps/fe/tests/helpers/mesh.ts:240`

```ts
const deviceLogin = page.getByTestId(`devices-node-login-${nodeId}`);
await expect(deviceLogin).toBeVisible({ timeout: 30_000 });
await deviceLogin.getByTestId(`node-login-${nodeId}`).click();
```

`node-login-<id>` 由公共 `NodeLoginButton` 生成，设备页与侧栏 Files 分节会同时渲染，Files tab 打开时全局 `getByTestId` 触发 strict mode 冲突。改为在设备页容器内定位，不动产品侧 testid。

## 验证

| 检查 | 改前 | 改后 |
|---|---|---|
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 error | 0 error（注意：`apps/fe/tsconfig.json` 的 `include` 只有 `src`，不覆盖 `tests/`） |
| 临时 tsconfig 覆盖 `apps/fe/tests/**/*.ts` 的 tsc | — | 本次 6 个文件 0 error（其它测试文件有 9 个既有 error，与本次改动无关） |
| `bunx biome check <6 个文件>` | 0 issue | 0 issue |
| `bunx playwright test --list`（5 个 spec） | — | 13 tests in 5 files，解析正常，未启动 web server |
| `TMEX_E2E_MESH=1 bunx playwright test --list --project=mesh` | — | 5 tests in 4 files，`helpers/mesh.ts` 编译通过 |

未运行任何真实 e2e 用例（其它 agent 正在并行改前端）。

## 遗留 / 待 live run 确认

- 第 3 项（agent enqueue）根因置信度 80%：若显式等待后 send 仍长期 disabled，需现场确认 `sending` / `materializingDraft` / session running 状态是否卡死（候选产品文件见 EX4-result.md 第 3 节）。
- 第 5 项：恢复 viewport 后若仍 drift ≥ 2，说明存在真实 resize oscillation，需查 `useWindowResizeReporter.ts` / `splitLayoutGeometry.ts`。
- 第 2 项：滚轮事件的实际数量与方向（64/65）建议 live run 复核一次。
