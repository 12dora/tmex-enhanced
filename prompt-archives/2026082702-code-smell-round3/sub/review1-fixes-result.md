# review1 修复结果：site 设置重拉竞态 + 输出门控溢出恢复

## 1. `packages/stores/src/site.ts`：并发重拉的乱序提交

### 问题

`handleSettingsUpdate('site')` 对每个 S2C 失效信号都发一次 `refreshSettings()`，而 `refreshSettings()`
在 await 之后无条件 `set({ settings, loading: false })`。两次重拉重叠时，先发出的请求若后返回，
就会把更旧的 `settings`（连带 `theme` / `language`，因为 `commitSettings` 还会 `i18next.changeLanguage`
与 `syncThemeToUIStore`）盖回 store。

### 修复

在 `createSiteStore` 闭包里加请求代次（generation）：

- `beginSettingsRequest()` 自增并返回本次代次，`isLatestSettingsRequest(gen)` 判断是否仍是最新；
- `fetchSettings` / `refreshSettings` 都在发起前取代次，await 回来后**只有最新代次允许提交**；
  落后的响应直接返回 `get().settings`（已提交的最新值）而不落库，也不改 `loading`；
- 失败分支同样受代次保护：落后的失败不会把 `loading` 提前置回 `false`，`refreshSettings` 仍照旧 `throw`
  （`handleSettingsUpdate` 内部已 catch），`fetchSettings` 的 `DEFAULT_SETTINGS` 回落也只在最新代次生效；
- 三处重复的「提交 + changeLanguage + syncTheme」收敛为 `commitSettings()`，因此 `create()` 的初始化函数
  改为块函数体（diff 中大量行只是缩进变化）。

`fetchSettings` 与 `refreshSettings` 共用同一个代次计数器，两者互相重叠时同样按「最新者胜」。

### 回归测试

新增 `packages/stores/src/site-refresh.test.ts`（4 例，用可手动 settle 的 deferred fetch mock）：

- 两次重拉乱序返回：新的先回、旧的后到 → `settings` / `theme` / `language` / `useUIStore.theme` 都保持最新值；
- 落后请求的返回值也是最新提交的设置；
- 旧请求先返回时不落库、`loading` 保持 `true`，直到最新请求提交才归位；
- 连续两次 `handleSettingsUpdate('site')` 以最后一次响应为准。

注：该文件自带完整 `document` 桩（`documentElement.classList.toggle`）并在 `afterEach` 还原——
同进程其它测试文件（如 `tmux-clipboard-host.test.ts`）会留下只有 `visibilityState` 的 `document` 桩，
`syncThemeToUIStore` 会踩空。

## 2. `packages/ws-client/src/state-machine.ts`：门控溢出后的画面恢复

### 2a. `outputGapped` 只写不读，rebase 快照会被事务提交覆盖

溢出后立即请求 rebase，但事务仍在进行：若替换快照先于 HISTORY / LIVE_RESUME 落到终端，
`handleHistory()` 仍会 `onResetTerminal` + `onApplyHistory`，`handleLiveResume()` 还会 flush 空缓冲，
把刚恢复的画面又清掉。

修复：

- `handleHistory()`：仍推进到 `HISTORY_APPLIED` 并续期 progress deadline（避免退化成 `history_missing` 失败），
  但 `transaction.outputGapped` 为真时**不提交** history，也不写 `deferredHistories`；
- `handleLiveResume()`：`outputGapped` 时不 reset、不 flush（缓冲已被丢弃），直接 `completeTransaction()`
  收敛到 `STABLE`，再 `replayDeferred()` 让非事务 pane 的 deferred 输出与待发 rebase 正常放行。

事务收敛后 live 输出恢复直投，画面由 rebase 快照重建。

### 2b. `onRebaseRequired` 缺席时溢出请求被永久丢弃

`setCallbacks()` 支持晚到注册，注册前发生的溢出会静默丢掉恢复请求。

修复：新增 `pendingRebases: Map<deviceId, Map<paneId, reason>>`。

- `requestRebase()`：回调在就直发，不在就按 pane 记账（同 pane 去重）；
- `flushPendingRebases()` 在 `replayDeferred()` 开头执行（独立于 history/flush 的提交条件，
  所以放在那些 early-return 之前），事务收敛与 `setCallbacks()` 都会走到；
- `setCallbacks()` 增加对 `pendingRebases` 的设备遍历，回调补齐后立刻补发一次；
- `cleanup()` / `cleanupAll()` 清理 `pendingRebases`（设备断开后不再补发）。

`cancelTransaction` / `failTransaction` 不清 pending rebase：缺口是 pane 级事实，事务失败/被顶掉后
仍需要重建请求。

### 测试（`state-machine.test.ts`）

- 更新既有溢出用例：溢出后不再回放空缓冲（断言由 `flushes == [[]]` 改为 `flushes == []`），并断言事务收敛到 `STABLE`；
- 新增「溢出后 HISTORY/LIVE_RESUME 不再提交 history，也不回放缓冲」：溢出 → ACK → HISTORY → LIVE_RESUME，
  断言 reset/history/flush/失败回调一个都没触发、rebase 只发一次、状态回到 `STABLE`，且事务后的 live 输出恢复直投；
- 新增「回调晚到时溢出的 rebase 在 setCallbacks 后补发一次」：无回调时溢出 → `setCallbacks` → 回调触发一次，
  再次 `setCallbacks` 不重复触发。

## 验证

- `cd packages/stores && bun test` → 214 pass / 0 fail（基线 210，+4 新增）；
  `bunx tsc --noEmit` 仅剩既有的 `host-services.test.ts(93,23)` 一处错误。
- `cd packages/ws-client && bun test` → 84 pass / 0 fail（基线 82，+2 新增）；`bunx tsc --noEmit` 0 错误。
- `bunx biome check` 四个改动文件均通过。

未触碰 `pane-sink-registry.ts` 与新增的 coalescer（其它 agent 并行改动）。

## 备注 / 未处理项

- rebase 请求仍在溢出瞬间发出（回调存在时），而不是等事务收敛后再发：2a 修好后事务侧不会再覆盖快照，
  越早发缺口窗口越短；「事务收敛后再发」只对回调晚到的 pending 路径成立。
- 仍存在一个同类但更窄的竞态未处理（不在本次 finding 范围）：`setThemeFromS2C` / `updateTheme` 写入 theme 后，
  若此前发出的重拉才返回，会把 theme 覆盖回服务端旧值。需要的话可让这两个入口也参与代次记账。
