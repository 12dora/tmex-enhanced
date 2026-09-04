# T2b 结果 —— 首屏语言跟随站点语言与浏览器语言（Web + PWA）

## 结论

首屏（含登录页）语言不再固定从 `navigator.language` 猜、也不再被取数失败掀回 `en_US`。
优先级：**localStorage 缓存的站点语言 → `navigator.languages` 逐个匹配 → manifest 默认语言**。
站点设置取数成功时写缓存，失败时保持当前语言。Web 与 PWA 完全同一条路径，未引入 `display-mode` 分支。

## 改动

### 新增

- `packages/stores/src/site-language-cache.ts`
  浏览器级站点语言缓存。`SITE_LANGUAGE_CACHE_KEY = 'tmex.site.language'`（裸 key，与 `tmex-ui` 同理），
  导出 `isLocaleCode` / `readCachedSiteLanguage` / `writeCachedSiteLanguage`；读写全部 try/catch，
  写入前用 `SUPPORTED_LOCALES` 校验，垃圾值既不写也读不出。
  放在 `packages/stores` 而非 `apps/fe`：写入方是 site store（`packages/stores`），读取方是 fe 的 i18n 初始化，
  只有放在 stores 才能让两侧共用同一个 key 与校验，且 fe 已经通过 `@tmex/stores/*` 通配 exports 引子路径
  （同 `@tmex/ui/sidebar` 的写法，vite 与 bun 都能解析）。

- `apps/fe/src/i18n/initial-language.ts`
  纯函数模块：`matchBrowserTag`（`zh*`→`zh_CN`、`ja*`→`ja_JP`、`en*`→`en_US`，按 BCP 47 主子标签匹配，
  `zh-Hans-CN` / `zh_CN` / `en-GB` 都能命中）、`browserLanguages()`（优先 `navigator.languages`，
  空或缺失退回 `navigator.language`）、`resolveInitialLanguage({ cached?, languages? })`（可注入参数所以可纯测，
  缺省时读缓存与 navigator）。
  单独成文件而不是写进 `i18n/index.ts`：后者含 `import.meta.glob`，bun test 里加载即抛，无法直接测。

- `apps/fe/src/i18n/initial-language.test.ts`（11 个用例）
- `packages/stores/src/site-language-cache.test.ts`（4 个用例）

### 修改

- `apps/fe/src/i18n/index.ts`
  删掉 `detectBrowserLocale()`，改为在 `i18n.init` 之前算出 `const initialLanguage = resolveInitialLanguage()`，
  并以它作为 `lng`。因此 `i18nReady` await 的就是该语言的 core chunk，`main.tsx` 的 `createRoot` 在它之后执行，
  首帧即为目标语言 —— 任务点 3 无需改 `main.tsx`（原逻辑本就是「await i18nReady 再渲染」），故 `main.tsx` 未动。

- `packages/stores/src/site-settings-loader.ts`
  `SiteSettingsLoaderOptions` 新增 `commitFallback: (settings) => SiteSettings`，与成功路径的 `commit` 分离。
  失败兜底走新的 `commitFallbackIfCurrent()`，并**返回真正落库的那份**（store 会把 language 改写掉，
  调用方必须拿到改写后的值，否则 `fetchSettings()` 的返回值仍是 `en_US`）。
  成功路径与代次/在途共享语义完全未变。

- `packages/stores/src/site.ts`
  - `commitSettings`：`controlsBrowserPrefs` 为真时，除 `i18next.changeLanguage` 外再 `writeCachedSiteLanguage()`。
    远端 node 的 runtime 依旧既不改全局语言也不写缓存（保持 `site-language.test.ts` 的隔离语义）。
  - 新增 `commitFallbackSettings`：失败时 language 取 `缓存 → i18next 当前语言 → 兜底值` 三级，
    非语言字段照常补齐 `DEFAULT_SETTINGS`，theme 同步与 loading 复位行为不变；**不调用 `changeLanguage`**。

- `packages/stores/src/site-language.test.ts`
  i18next 桩改为可变对象（失败兜底要读 `resolvedLanguage`/`language`）；新增 6 个用例：
  成功写缓存 / 远端 node 不写缓存 / 失败不调 `changeLanguage` / 失败沿用缓存语言 /
  失败沿用 i18next 当前语言 / 两者都无才落 `en_US`（且非语言默认值照常补齐）/ 远端 node 失败兜底不读缓存。

- `packages/stores/src/site-settings-loader.test.ts`（不在原始 scope，但 `commitFallback` 是必填项，
  不改 harness 该文件无法编译）：harness 补 `commitFallback`（同时记入 `commits` 与新的 `fallbackCommits`，
  保持既有断言不变），并新增 2 个用例：兜底走 `commitFallback` 而非 `commit`、兜底提交返回真正落库的那份。

## 验证

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `packages/stores` `bun test` | 418 pass / 0 fail，tsc 1 error | **431 pass / 0 fail**，tsc **0 error** |
| `apps/fe` `bun test src/` | 2137 pass / 0 fail，tsc 0 | **2148 pass / 0 fail**，tsc **0 error** |
| `bunx biome check`（全部改动文件，9 个） | — | clean |

说明：

- stores 基线里 `host-services.test.ts` 的 1 个 tsc error 在我这次跑的时候已经不存在（另一位 agent 已修），现为 0。
- `apps/fe` 全量跑最后一次时出现 1 个 `LoginPage.test.tsx` 失败（`mesh 模式渲染品牌 + 用户名 / 密码表单`，
  期望 `value="alice"`）。该文件与 `LoginPage.tsx` 属于并行 agent 的 scope，`LoginPage.tsx` 的 mtime 就在那次跑之前
  22 秒，且我改动前后的两次全量跑（同一份我的代码）第一次是 2148 pass / 0 fail。与本任务无关，属对方在途编辑。

## 未做 / 备注

- `apps/fe/src/main.tsx` 未修改（任务点 3 已由现有的「await i18nReady 再 createRoot」满足，改语言解析点即可）。
- `apps/fe/src/main.test.ts` 未修改（它守的是 entry 静态依赖，本次未新增包根 import）。
- 未新增任何 i18n key，故未跑 `build:i18n`。
- `sidebar-title.tsx` / `LoginPage` / `standalone-landing` / `packages/ui` 均未触碰。

## 追加：复杂度门禁（coordinator 追问）

`bun run lint` 的复杂度门禁报 `packages/stores/src/site.ts:createSiteStore: 155 lines > 135`
（allowlist 里 `createSiteStore` 的上限就是 135，即改前它已顶格）。

修法：把新加的语言解析 / 缓存逻辑从 `createSiteStore` 的闭包里提到**同文件模块作用域**的三个小函数：

- `currentBrowserLanguage(): LocaleCode | null` —— 读 `i18next.resolvedLanguage ?? i18next.language` 并校验
- `resolveFallbackLanguage(fallback, controlsBrowserPrefs): LocaleCode` —— 「缓存 → i18next 当前语言 → 兜底值」三级
- `createSettingsCommitters(deps): { commitSettings, commitFallbackSettings }` —— 依赖注入 `controlsBrowserPrefs` / `set` / `syncTheme`

`createSiteStore` 里原先 30 行的两个提交函数收成 6 行的一次工厂调用。行为、导出面与全部断言不变
（`set` 直接透传给工厂，`syncTheme` 传的就是闭包内的 `syncThemeToUIStore`，仍能读到 `getUIStore()`）。
**未改 allowlist。**

复核：

- `createSiteStore` 现为 **132 行**（116–247），在 135 上限内。
- `bun scripts/complexity/gate.ts` → `complexity gate ok (1490 files, 13425 functions)`，**零 violation**
  （`createSiteStore` 与另一 agent 的 `LoginForm` 两条都已消失）。
- `cd packages/stores && bun test` → **431 pass / 0 fail**；`bunx tsc --noEmit -p .` → **0 error**。
- `cd apps/fe && bun test src/` → **2171 pass / 0 fail**（本轮跑时另一 agent 的 LoginPage 已修好，用例数也涨了）。
- `bunx biome check`（9 个改动文件）→ clean。
- 根 `bun run lint` 仍以 1 退出，但两条 format 报错都在别人的文件里：
  `apps/fe/src/pages/LoginPage.tsx`、`packages/api-client/src/client.ts`。因 `biome check .` 先失败，
  `bun run lint` 不会走到门禁那一步，故门禁单独跑（见上，已 ok）。
