# F-auth2：ensureNodeLogin 的 chunk 加载失败不再吞掉门闸

## 背景
review-fe2-report 第 2 条：`apps/fe/src/auth/session-key-store.ts` 的 `ensureNodeLogin` 把
`import('./session-login')` 的失败原样 reject 出去。`use-node-login.ts` 没有 rejection 分支，
门闸会永远停在 `pending`，`NodeLoginButton` 也一直是 disabled——离线或部署换了 chunk hash 时
用户没有任何出路。

## 改动
- `apps/fe/src/auth/session-key-store.ts`
  - 把动态 import 抽成模块级 `loadLogin`（默认仍是 `() => import('./session-login')`，
    保持 dynamic-import、不会回到首屏 chunk），并新增仅测试用的 `setLoginLoaderForTest(loader?)`，
    不传参即还原默认加载器。
  - 在 `markLoggedIn` 之后、`finally` 之前加一段 `.catch()`，把加载失败折成
    `{ ok: false, code: 'NETWORK_ERROR' }`（`LoginFailureCode` 已有的码）。`finally` 里的
    `nodeLoginsInFlight.delete` 不变，所以单飞语义与失败后可重试都保留：失败的那次调用
    结束即从在途表移除，下一次调用重新走加载器。
  - `loginToNode` 自身所有 await 都带 `.catch`，正常路径不会 reject，因此这层 catch 实际只
    兜住 chunk 加载失败与意外异常，不改变任何既有返回码。
- `apps/fe/src/auth/session-key-store.test.ts`
  - 全局 `afterEach` 加 `setLoginLoaderForTest()` 还原加载器。
  - 新增「登录 chunk 拉不下来时返回 NETWORK_ERROR，下一次调用重新加载」：第一次加载器 reject
    ⇒ 得到 `{ ok:false, code:'NETWORK_ERROR' }` 且 mesh 行不被标已登录；第二次调用重新触发
    加载（`loads === 2`）并成功标记。
  - 新增「并发调用只加载一次实现、只登录一次」：用可控 gate 卡住加载器，断言两次调用返回
    同一个 Promise 引用，加载器与 `loginToNode` 各只跑一次。

## 验证
- `cd apps/fe && bun test src/` → 880 pass / 0 fail（基线 878 + 新增 2）。
- `bunx tsc --noEmit -p .` → 0 error。
- `bunx biome check src/auth/session-key-store.ts src/auth/session-key-store.test.ts` → 无问题。
- 既有「常驻模块的静态依赖」用例仍通过：`./session-login` 依旧是 dynamic-import，
  store 不静态引 `@tmex/shared/auth`。

## 剩余风险
无。改动只新增一条 catch 分支与一个测试专用 setter，成功/失败码路径与 zeroing 均未变动。
