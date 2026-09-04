# T2a 执行结果 — 登录页不预填用户名 / PWA 冷启动焦点

## Bug A — 用户名框预填 UUID

`apps/fe/src/pages/LoginPage.tsx`

1. `useState(mode.username ?? '')` → `useState('')`：永远不预填。`autoComplete="username"` 保留，浏览器自己的自动填充不受影响。
2. `resolveLoginUid()` 提为导出的纯函数，签名放宽成 `Pick<AuthModeResponse, 'uid' | 'username'>`：
   - `mode.uid` 缺失 → 用输入的用户名（老行为）；
   - 输入为空 / `mode.username` 为 null 或空 / `mode.username === mode.uid` → 一律用 `mode.uid`（后端并发改成「存的名字就是 uid 时返回 `username: null`」，两种形态都覆盖）；
   - 输入等于 `mode.username` → `mode.uid`；否则按输入的用户名走（留给多用户）。
3. 新增导出的纯函数 `missingRequiredCredentials(mode, username, password)`：密码永远必填；用户名只在 `mode.uid` 也缺失时才算「身份缺失」，此时仍走原来的 `auth.login.credentialsRequired`。`onSubmit` 的必填校验换成它。「没有主用户 / 密码错」那条中性文案（`mode.kdfParams` 为空）的分支未动。

`apps/fe/src/pages/LoginPage.test.tsx`

- 删掉 `value="alice"` 断言；新增「用户名框永远不预填」——对 `username: 'alice'` / `username: uid` / `username: null` 三种 mode 都断言渲染出的 `<input data-testid="login-username">` 是 `value=""` 且带 `autoComplete="username"`。
- 新增 `describe('resolveLoginUid')` 5 个用例（留空 → uid、`username` 为 null/空/等于 uid → uid、输入真实用户名 → uid、输入别的名字 → 该名字、`uid` 为 null → 输入值）。
- 新增 `describe('missingRequiredCredentials')` 2 个用例（uid 已知时空用户名放行、密码仍必填；uid 与用户名都没有时拦下）。

说明：`apps/fe` 没有 DOM 测试环境（无 happy-dom/jsdom，`bunfig.toml` 只 preload env；全部组件测试走 `react-dom/server` 静态渲染），所以「提交时用了哪个 uid」只能落到 `resolveLoginUid` / `missingRequiredCredentials` 的纯函数用例上，无法真的触发一次 submit。

## Bug B — PWA 冷启动焦点落在「关闭侧边栏」

采用的是任务里的第二条路线（自动弹出后收回焦点），**没有**走 `initialFocus={false}`。理由：

- `initialFocus` 这个 prop 确实存在（`@base-ui/react@1.2.0`，`DialogPopup.d.ts`，`false` = 不移动焦点），且 `SheetContent` 的 props 类型已经是 `SheetPrimitive.Popup.Props`，透传不需要改 `sheet-impl.tsx`。
- 但它必须在 `<Sidebar>` 渲染时就决定（Base UI 在 layout effect 的 microtask 里读 `initialFocusRef`），而「这次是自动弹出」这个信号只有 `StandaloneLanding` 知道。把信号送到 `<Sidebar>` 只能改 sidebar context（`sidebar/context.ts` + `sidebar-provider.tsx`）、`app-sidebar.tsx` 或 `components/sidebar.tsx` 桶文件——都不在本任务的文件范围内（其中 `packages/ui` 的其余文件本轮无人认领，但仍越界）。
- Base UI 自己的 `openMethod` 区分不了这两种打开：移动端抽屉是受控 `open`，点汉堡按钮和自动弹出都是「程序化打开」，`openInteractionType` 都是 `''`。

实现（读过 `floating-ui-react/components/FloatingFocusManager.js` 确认过副作用）：

- `apps/fe/src/lib/standalone.ts`：新增 `SHEET_CONTENT_SELECTOR = '[data-slot="sheet-content"]'` 与纯函数 `releaseFocusInsideSheet(node)`——只有焦点确实落在抽屉容器内才 `blur()`，返回是否收回。
  - 收回后 `activeElement` 确实回到 `document.body`：`handleFocusOutside` 的 restore 分支要求 `!isFocusable(target)`，而关闭按钮是可聚焦的，所以 `restoreFocus: 'popup'` 不会把焦点抢回去；关闭分支要求 `relatedTarget` 非空且 `!modal`，blur 到 body 时 `relatedTarget` 为 null 且抽屉是 modal，所以抽屉也不会被关掉。
- `apps/fe/src/components/standalone-landing.tsx`：新增导出的 `suppressAutoOpenFocus()`，在 `setOpenMobile(true)` 之后立刻挂一个 `focusin` 监听，焦点一落进抽屉就收回并撤监听；两帧之内没人动焦点就自行撤掉（不影响用户随后自己点出来的焦点）。effect 直接把它的返回值当 cleanup 返回，effect 重跑/卸载时也会撤掉。
  - 用监听而不是「rAF 里直接 blur」：Base UI 的 `enqueueFocus` 本身就在 rAF 里执行，而且它的 rAF 是在我们这次 `setState` 之后才注册的，单发 rAF 一定跑在它前面，blur 会打空。
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`：`ACTION_BUTTON_CLASS` 加 `outline-none focus-visible:ring-2 focus-visible:ring-ring`（与同文件 `ws-latency` 徽标一致），焦点环只给键盘操作。关闭按钮与设置入口共用这个类。

测试：

- `apps/fe/src/lib/standalone.test.ts`：`releaseFocusInsideSheet` 3 例（抽屉内收回 / 抽屉外不动 / 拿到非元素时安全返回）+ 选择器与 `SheetContent` 的 `data-slot` 对齐 1 例。
- 新增 `apps/fe/src/components/standalone-landing.test.ts`（5 例）：用替身 `document` + 可手动推进的 rAF 队列，验证「焦点落进抽屉 → 收回且不再拦截」「焦点在抽屉外不动」「两帧后撤监听，用户自己点的焦点不受影响」「cleanup 立刻撤监听」「无 document（SSR）时是空操作」。
- `apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx`：把 `matchMedia` 桩改成可切换视口，新增 2 例断言设置入口与手机端关闭按钮都带 `outline-none focus-visible:ring-2 focus-visible:ring-ring`。

## 改动文件

- `apps/fe/src/pages/LoginPage.tsx`
- `apps/fe/src/pages/LoginPage.test.tsx`
- `apps/fe/src/lib/standalone.ts`
- `apps/fe/src/lib/standalone.test.ts`
- `apps/fe/src/components/standalone-landing.tsx`
- `apps/fe/src/components/standalone-landing.test.ts`（新增）
- `apps/fe/src/components/page-layouts/components/sidebar-title.tsx`
- `apps/fe/src/components/page-layouts/components/sidebar-title.test.tsx`

`packages/ui` 未改动。未新增 i18n key。

## 验证

| 项 | 之前 | 之后 |
| --- | --- | --- |
| `cd apps/fe && bun test src/` | 2148 pass / 0 fail（124 文件；任务书给的 2137 是更早的快照，其它 agent 已加过用例） | 2167 pass / 0 fail（125 文件） |
| `cd packages/ui && bun test` | 370 pass / 0 fail | 370 pass / 0 fail（未改动） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 1 error（`packages/stores/src/site.ts:129`，T2b 在改） | 0 error |
| `bunx biome check <本任务 8 个文件>` | — | Checked 8 files，无问题 |

未跑 Playwright e2e（按共同规则）。全仓 `grep` 确认 e2e 里没有依赖登录页用户名预填的断言。

## 遗留

- 若之后有人愿意动 sidebar context / `app-sidebar.tsx`，把「这次是自动弹出」的信号传到 `<Sidebar>` 并改用 `initialFocus={false}`，语义上比现在的「事后收回」更干净，可以把 `suppressAutoOpenFocus` 整个删掉。
- 仓库没有 DOM 测试环境，`StandaloneLanding` 组件级（真实挂载 + 真实 Sheet）的焦点行为仍只能靠 e2e 覆盖，当前用替身 document 做了等价验证。

## 追加 — 复杂度门禁（`LoginForm: 208 > 207`）

Bug A 的改动让 `LoginForm` 多出一行，撞到门禁上限。未动 allowlist，改为把提交前的本地校验整块抽成同文件里的纯函数：

- 新增导出 `LoginPreflight` 类型与 `loginPreflight(mode, { username, password, totp })`：依次判「必填缺失 → `auth.login.credentialsRequired`」「TOTP 开着但不满六位 → `auth.login.totpRequired`」「`kdfParams` 缺失 → `auth.errors.invalidCredentials`（与密码错同一句，不泄露账号是否存在）」，通过时把 `kdfParams` 一并带出来（判别联合，`establishSessionFromPassword` 直接用 `preflight.kdfParams`，省掉原来那次 `!mode.kdfParams` 收窄）。
- `onSubmit` 里 13 行三段 if 换成 5 行；`LoginForm` 208 → 200 行，门禁不再报它。
- `LoginPage.test.tsx`：把 BASE 的 KDF 参数提为 `KDF_PARAMS` 常量（非空类型，供断言用），新增 `describe('loginPreflight')` 4 个用例覆盖上述四条分支。

复查：

| 项 | 结果 |
| --- | --- |
| `cd apps/fe && bun test src/` | 2171 pass / 0 fail（125 文件） |
| `cd apps/fe && bunx tsc --noEmit -p .` | 0 error |
| `bunx biome check <本任务 8 个文件>` | 干净 |
| `bun scripts/complexity/gate.ts` | `LoginPage.tsx LoginForm` 一行已消失；另一个 agent 的 `createSiteStore` 也已被其修掉，当前剩余违规为 `apps/gateway/src/mesh/forwarder.ts` 与 `packages/panels/.../use-device-management-state.ts`，均非本任务文件 |

注：仓库根 `bun run lint` 仍以非零退出，但卡在 `biome check` 阶段（`apps/gateway/src/auth/cookies.ts` 的格式，属其它 agent 的在途改动），因此 `&&` 后的门禁不会执行——上表的门禁结果是单独跑 `bun scripts/complexity/gate.ts` 得到的。本任务 8 个文件的 biome 均干净。

## 追加 2 — Bug B 改走 `initialFocus={false}`（R2-4 审查意见）

审查驳回了 focusin/blur 的做法，两条都成立：(a) 两帧的窗口期里用户点抽屉内任何控件都会被 blur；(b) 应用外面裹着 `StrictMode`，模拟卸载会在 `firedRef` 已为 true 的情况下摘掉监听，真正的第二次 setup 直接早退，监听再也装不上，焦点根本收不回来。已按显式路线重做。

### Base UI 语义（读 node_modules 确认，非猜测）

`@base-ui/react@1.2.0`：

- `dialog/popup/DialogPopup.js`：`const resolvedInitialFocus = initialFocus === undefined ? defaultInitialFocus : initialFocus;` —— 传 `undefined` 就是交回它的默认行为（触摸打开聚焦弹层本身，其余聚焦第一个可聚焦元素），传 `false` 会原样交给 `FloatingFocusManager`。
- `floating-ui-react/components/FloatingFocusManager.js:377-410` 的初始焦点 effect：`if (resolvedInitialFocus === undefined || resolvedInitialFocus === false) { return; }` —— `false` 即「打开时不移动焦点」。
- 同文件 `:144` 的 `ignoreInitialFocus = initialFocus === false` 只额外影响 “untrapped typeable combobox” 分支（要求 domReference 是可输入控件），侧边栏抽屉不涉及，无副作用。
- `dialog/popup/DialogPopup.d.ts` 也写明 `false: Do not move focus.`

### 改动

新增 `packages/ui/src/components/sidebar/mobile-open.ts`（纯函数，无 React）：

- `MobileSidebarState = { open, suppressInitialFocus }`、`CLOSED_MOBILE_SIDEBAR`；
- `setMobileSidebarOpen(state, open)`：用户自己开关，一律把 `suppressInitialFocus` 复位；状态没变时返回同一个对象（避免白白重渲染）；
- `autoOpenMobileSidebar(state)`：替用户弹出，置位跳过焦点；已经是这个状态时返回原对象 → **幂等**，StrictMode 下 effect 跑两遍没有副作用；
- `mobileSheetInitialFocus(state)`：`false | undefined`，直接喂给 `SheetContent`。

`packages/ui/src/components/sidebar/context.ts`：`SidebarContextProps` 加两个字段 `openMobileWithoutFocus: () => void` 与 `mobileInitialFocus: false | undefined`。`openMobile` / `setOpenMobile` 签名不变，既有消费者（`nav-link`、`flow-bridges`、`sidebar-title`、panels 的 `file-leaf-menu` / `device-tree-navigation`）一行没改。

`packages/ui/src/components/sidebar/sidebar-provider.tsx`：抽出 `useMobileSidebarState()`，内部用上面的纯函数维护状态；`setOpenMobile` 仍接受布尔或 updater（`toggleSidebar` 用的是 updater 形态）。`SidebarProvider` 里只剩 `const mobile = useMobileSidebarState()` + `...mobile` 展开进 contextValue（同时把 `SidebarProvider` 的行数压回门禁线内，见下）。

`packages/ui/src/components/sidebar/sidebar-layout.tsx`：移动端分支的 `<SheetContent>` 加 `initialFocus={mobileInitialFocus}`。手动打开时该值是 `undefined`，Base UI 默认行为不变。`sheet-impl.tsx` 未改（`SheetContent` 的 props 本来就是 `SheetPrimitive.Popup.Props`，`initialFocus` 直接透传）；`packages/ui` 的 barrel `index.ts` / `components/sidebar.tsx` 也未动。

`apps/fe/src/components/standalone-landing.tsx`：`setOpenMobile(true)` → `openMobileWithoutFocus()`，删掉 focusin/rAF 那一整套，effect 不再返回 cleanup。

删除：`apps/fe/src/lib/standalone.ts` 里的 `SHEET_CONTENT_SELECTOR` / `releaseFocusInsideSheet` 及其测试，整个 `apps/fe/src/components/standalone-landing.test.ts`（`suppressAutoOpenFocus` 已不存在）。

保留：`sidebar-title.tsx` 的 `outline-none focus-visible:ring-2 focus-visible:ring-ring` 与对应的两个测试。

`apps/fe/src/page-wrapper.tsx`、`app-sidebar.tsx` 无需改动：手动打开走 `SidebarTrigger` → `toggleSidebar()` → `setOpenMobile(updater)`，命中 `setMobileSidebarOpen`，`suppressInitialFocus` 保持 false。

### 新测试（`packages/ui/src/components/sidebar/mobile-open.test.ts`，8 例）

- 自动弹出 → `mobileSheetInitialFocus` 为 `false`；
- 手动打开 / 关闭后再打开 → `undefined`（标记只对那一次生效）；
- 自动弹出后收到手动打开 → 标记复位；
- StrictMode 双跑：`autoOpenMobileSidebar` 第二次返回同一个对象（幂等）；
- 关掉后重新自动弹出（重新挂载）仍跳过焦点；
- 状态无变化时返回同一对象（引用相等）；
- `mobileSheetInitialFocus` 的三种取值。

### 复查

| 项 | 结果 |
| --- | --- |
| `cd packages/ui && bun test` | 412 pass / 0 fail（370 → 412，本任务新增 8 例，其余为其它 agent） |
| `cd packages/ui && bunx tsc --noEmit -p .` | 0 error |
| `cd apps/fe && bun test src/` | 本任务 3 个测试文件 65 pass / 0 fail；全量剩 8 fail，全部落在 `src/pages/settings/nodes|relay/**`（另一 agent 正在大改，`git status` 里那批文件有增删），与本任务无关 |
| `cd apps/fe && bunx tsc --noEmit -p .` | 报错只在 `src/pages/settings/nodes/{nodes-tab,local-machine-card}.test.tsx`（同上，非本任务文件） |
| `cd packages/panels && bun test` / `tsc` | 930 pass / 0 fail，tsc 0 error（确认 context 加字段没有波及 panels 里的 `useSidebar` 消费者） |
| `bunx biome check <本任务 12 个文件>` | 干净 |
| `bun scripts/complexity/gate.ts` | 本任务文件零违规。抽 `useMobileSidebarState()` 之前 `SidebarProvider` 曾 126 > 120，抽完已消。当前剩余违规为 `apps/gateway/src/mesh/forwarder.ts`（3 条）与 `packages/shared/src/link/mux.ts`，均非本任务文件 |
