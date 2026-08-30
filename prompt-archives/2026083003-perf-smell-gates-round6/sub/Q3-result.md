# Q3 结果 — fe 启动：把 Ghostty 与登录密码学移出 entry chunk

## 结论

Y1 报告的第 2、3 两项均已在代码中复核属实并修复。entry chunk 从 **1,342,557 → 1,140,739** 字节
raw（−201,818，−15.0%），gzip **415,966 → 352,379**（−63,587，−15.3%）。entry 里 `ghostty` /
`argon2` / `hash-wasm` / `noble` 四类标记全部归零。

## 改动

### 1. `main.tsx` 只从窄子路径引键盘避让 hook

`apps/fe/src/main.tsx:29` 原来 `from '@tmex/terminal-ui'`，包根 barrel 会 re-export
`Terminal` / `TerminalSurface` / `SplitTerminalArea`，把整条 Ghostty 图拖进 entry。改成
`from '@tmex/terminal-ui/hooks/use-keyboard-avoidance'`。

**没有改 `packages/terminal-ui/package.json` / `src/index.ts`**：该包的 exports map 已有
`"./*": "./src/*.ts"`，vite 与 `tsc --noEmit` 都能解析这条子路径（tsc 0 error，构建通过）。
按「每处改动尽量小」的要求，不再额外加一条 `./keyboard-avoidance` 别名——加了只是同一个文件的
第二个名字，并不改变解析结果。terminal-ui 包因此完全未被触碰（无需跑它的 test/tsc）。

### 2. `session-key-store` 拆成「常驻状态」+「按需加载的登录实现」

- `apps/fe/src/auth/session-key-store.ts`（常驻）：只留状态（`current`）、订阅、快照、
  `getSessionKey` / `hasSessionKey` / `clearSessionKey` / `setTotpCode` / `clearTotpCode`、
  单飞表与 `ensureNodeLogin` 入口。对 `@tmex/shared/auth` 只剩 `import type { Delegation }`
  （类型，编译期擦除），对 `@tmex/api-client/auth/index` 也只剩类型引用——运行期依赖只有
  `@/node/mesh-nodes`。`ensureNodeLogin()` 内部改成 `import('./session-login')` 后再调
  `loginToNode`。
- `apps/fe/src/auth/session-login.ts`（新增，按需）：`establishSessionFromSeed` /
  `...FromPassword` / `...FromPasskey`、`selectPasskeyCredential`、`loginToNode`、`loginSelf`，
  以及 argon2（`deriveSeed`）、Ed25519（`createDelegation` / `signLogin` / `generateEd25519KeyPair`）、
  WebAuthn（`startAuthentication`）等全部实现代码。

两模块的接缝是两个内部函数：`readSessionSecrets()`（读内存里的私钥材料）与
`adoptSessionSecrets()`（接管新会话所有权：先 `clearSessionKey()` 清零旧的，再赋值并通知订阅者，
语义与原先 `clearSessionKey(); current = {...}; notifyState();` 逐字等价）。

**清零保证未变**：
- `clearSessionKey()` 仍清零 `sessSk` / `delegationSig` / `kTotp` 并丢弃 `totpCode`（原 `wipe()`
  小工具就地内联成 `.fill(0)` / `?.fill(0)`，行为相同）。
- `establishSessionFromSeed` 仍在派生完立刻清零 `seed` 与 `rootKey.seed`。
- `establishSessionFromPasskey` 的 `try/finally` + `owned` 转移所有权逻辑原样保留；仪式失败时
  `sess.secretKey.fill(0)` 照旧（对应用例「仪式失败时 sk_sess 立刻清零」仍通过）。

**循环依赖**：`session-login` 静态引 `session-key-store`，反向只有 `import()`，无静态环。
`@/node/mesh-nodes` 不引 auth 模块（只引 `auth-transition`），也无环。构建产物验证了这一点。

**连带改动**（必要的最小改动，都只是 import 说明符的拆分）：
- `apps/fe/src/pages/LoginPage.tsx`：`establishSessionFromPasskey` / `establishSessionFromPassword`
  / `loginSelf` 改从 `@/auth/session-login` 引（该页本身是懒加载路由，不影响首屏）。
- `apps/fe/src/auth/index.ts`：barrel 加一行 `export * from './session-login'`，对外 API 面不变。
- `apps/fe/src/auth/session-key-store.test.ts`：同样拆 import。

`apps/fe/src/node/node-runtime-boundary.tsx` **不需要改**：它只引 `NodeLoginButton` /
`login-errors` / `use-node-login`，这三条在拆分后自动变成无密码学依赖（构建结果已证实 entry 里
0 命中）。`packages/shared/src/auth/**` 也不需要拆——shared 侧本来就按文件分得够细，rollup 的
tree-shaking 已经把密码学收进单独 chunk。

### 3. 回归测试（两条守卫，均已做「反向验证」确认会红）

- `apps/fe/src/auth/session-key-store.test.ts` 新增 `常驻模块的静态依赖`：用
  `Bun.Transpiler().scanImports()` 断言 ①`session-key-store.ts` 对 `./session-login` 只有
  `dynamic-import`、且不静态引 `@tmex/shared/auth`；②两条常驻入口 `NodeLoginButton.tsx` /
  `use-node-login.ts` 也不直接引实现或密码学。反向验证：往 store 加一行
  `import { bytesEqual } from '@tmex/shared/auth'` → 该用例 fail。
- `apps/fe/src/main.test.ts`（新增，13 行）：断言 main.tsx 引的是
  `@tmex/terminal-ui/hooks/use-keyboard-avoidance` 而**不是**包根。反向验证：改回包根 → fail。

行为本身的回归由既有用例覆盖（`loginToNode` / `loginSelf` / `ensureNodeLogin` / TOTP /
`establishSessionFromPasskey` 共 32 条，全绿且未改断言）。

## 测量

`cd apps/fe && bun run build`（vite 5 生产构建，dist 已 gitignore；`git status` 只有源文件改动）。

| 指标 | before | after | 差值 |
|---|---:|---:|---:|
| entry raw | 1,342,557 B | 1,140,739 B | −201,818 B（−15.0%） |
| entry gzip | 415,966 B | 352,379 B | −63,587 B（−15.3%） |

entry chunk 内标记命中数（`grep -oi`）：

| 标记 | before | after |
|---|---:|---:|
| `ghostty` | 180 | **0** |
| `argon2` | 3 | **0** |
| `hash-wasm` | 2 | **0** |
| `noble` | 5 | **0** |

**密码学落在哪个 chunk**：新的动态 chunk `assets/session-login-*.js`（5,652 B）+ 它唯一的依赖
`assets/totp-*.js`（57,849 B，rollup 按共享模块命名，实际内容是 argon2/hash-wasm + @noble
ed25519 那一坨）。entry 里只剩 `__vite__mapDeps` 里的两个文件名字符串，`ensureNodeLogin()` 命中
时才 `import()`；`hasSessionKey()` 为假的快速路径连这个 chunk 都不加载（既有用例
「会话钥不在内存里时立刻返回 NO_SESSION_KEY，一个请求都不发」仍通过）。
该 crypto chunk 被 `LoginPage` / `SettingsPage` / `account-security-panel` / `credential-prompt`
/ `nodes-tab` / `session-login` 共享，全部是懒加载路由或面板。

Ghostty 现在落在共享的终端 chunk `assets/ShortcutButtonRow-*.js`（141,974 B），随设备/终端页加载。

## 验证

| 项 | 结果 | 基线 |
|---|---|---|
| `cd apps/fe && bun test src/` | **878 pass / 0 fail**（2330 expect） | 876/0（+2 为本次新增守卫） |
| `cd apps/fe && bunx tsc --noEmit -p .` | **0 error** | 0 |
| `bunx biome check <改动文件>` | 6 个文件干净；`main.tsx` 仅剩 1 条**既有**的 `lint/correctness/useExhaustiveDependencies`（`StatusBarSync` 的 effect 依赖，第 85 行，与本次改动无关；已用 `git show HEAD:apps/fe/src/main.tsx` 拿原文件跑 biome 复核，同样报这一条） | 同 |
| `packages/terminal-ui` | 未触碰，无需验证 | — |
| Playwright | 按要求未运行 | — |

## 行数

净 **+59** 行（生产代码 +24，测试 +35）。拆分本身不可避免地多出一份模块头注释、一份 import 块
和两个接缝函数；没有引入任何为将来准备的抽象。

```
 apps/fe/src/auth/index.ts                  +1  -0
 apps/fe/src/auth/session-key-store.ts     +20 -407
 apps/fe/src/auth/session-login.ts        +409（新增）
 apps/fe/src/auth/session-key-store.test.ts +25  -4
 apps/fe/src/main.tsx                       +1  -1
 apps/fe/src/main.test.ts                  +13（新增）
 apps/fe/src/pages/LoginPage.tsx            +4  -2
```

## 风险 / 遗留

- `LoginPage.tsx` 不在任务列出的 scope 里，但拆分后它必须换 import 来源，否则常驻路径会被它的
  静态 re-export 重新拖回密码学。改动仅限 import 说明符拆分，无逻辑变化。
- `ensureNodeLogin()` 首次触发登录时多一次 chunk 网络请求（~58 KiB gzip 前）。它本来就在
  `await` 网络往返里，用户可感知的额外延迟基本为零；且失败快速路径（无会话钥）不加载。
- entry 里 `noble` 也归零属意外收获：Y1 提到 direct-carrier 也用曲线，但它本就在懒 chunk 里，
  之前是被 auth 这条常驻路径顺带拉进 entry 的。
- `@tmex/terminal-ui` 的子路径依赖包内 `"./*": "./src/*.ts"` 通配。若将来有人收紧该包的 exports
  map，`main.test.ts` 不会报错（它只看 import 说明符），但构建会直接失败，不会静默退化。
