# OH：延迟剪贴板写入器的两条审查跟进（P1×2）

## 结论

两条 finding 均**成立**，已按建议实现并补测。核心机制统一为「逻辑写入代次（generation）+ disposed 标志」，
外加把 writer 的释放接进 stores 的 runtime 拆卸链。

## 1. 并发逻辑写入乱序完成破坏 latest-wins（成立）

`packages/shared/src/browser-clipboard.ts` 原 `write()` 直接 `await this.writeText(text)`，完成后无条件处理结果。
两条真实坏路径：

- 新写入先成功 → `clearPending()`；随后**旧**写入迟到失败 → `defer(旧文本)`，把已经过时的文本重新挂起，
  下一次手势会把旧文本写进剪贴板。
- 新写入先失败 → 挂起新文本；随后**旧**写入迟到成功 → `clearPending()` 把**更新的**挂起文本清掉并弹「已复制」，
  用户实际拿到的是旧文本，新文本静默丢失。

### 修法

- 每次 `write()` 入口 `nextGeneration()` 取一个代次；完成（成功或失败）前先 `isStale(generation)` 判定，
  非最新代次的完成结果一律忽略（既不 set/clear pending，也不发通知）。
- 手势重试属于**同一次逻辑写入**，因此新增 `pendingGeneration` 记录挂起文本所属代次，`onGesture` 沿用它而不是另开新代。
  这样「挂起 a、在途写 b、此时手势触发」时，a 的重试结果因 b 更新而被忽略，b 失败后重新挂起 b —— 挂起态始终是最新文本。

## 2. dispose 挡不住在途失败重挂监听 + writer 从不被释放（成立）

- `dispose()` 只调 `clearPending()`：一个**已经在途**的失败写入随后进 `defer()`，会重新 `addEventListener` 注册全局手势监听并弹 `onPending`。卸载后仍然活着。
- `packages/stores/src/tmux-event-router.ts` 的 writer 按 ctx 存在 `WeakMap` 里，**没有任何路径调用它的 `dispose()`**。
  `WeakMap` 只在 ctx 被 GC 后才回收，而挂起中的 writer 通过 window 上的手势监听强引用自己 → ctx 存活，
  卸载后的一次点击仍会写剪贴板并弹 toast。

### 修法

- writer 新增 `disposed` 标志，`isStale()` 首先看它 —— dispose 之后所有在途完成一律 inert（不 defer、不注册监听、不发通知）；
  `write()` 入口也直接对已 dispose 的实例短路，不再发起写入。
- `createTmuxEventRouter(ctx, disposers?)` 新增可选 `disposers` 形参，创建时 push 一个 `disposeClipboardWriter(ctx)`
  （查 WeakMap → delete → `writer.dispose()`）。`packages/stores/src/tmux.ts` 的 `setupTransportHandlers` 把 store 已有的
  `disposers` 数组传进去 —— 该数组正是 `app-runtime.ts` 里 `AppRuntime.dispose()` 遍历执行的那一份，
  于是 runtime 拆卸即释放 writer。改动面 3 处，无新增导出、无签名破坏（第二参数可选，旧调用点不变）。

## 测试

`packages/shared/src/browser-clipboard.test.ts` 新增 3 例（配 `gatedWrite()` 手工控制每次写入的完成时机以构造乱序）：

- 乱序完成：新写入先成功后，迟到的旧写入失败不再挂起（仅 `success`，无监听残留）
- 乱序完成：新写入失败挂起后，迟到的旧写入成功不清掉挂起的新文本；后续手势重试的仍是新文本（`['stale','fresh','fresh']`）
- dispose 后在途写入失败：无回调、无挂起、监听数为 0

`packages/stores/src/tmux-event-router.test.ts`：harness 现在自持 `disposers` 并暴露 `dispose()`；新增 1 例
「router 拆卸释放延迟剪贴板写入器」——挂起后 `dispose()` 摘掉 pointerdown 监听，手动调用已摘掉的旧 listener
也不再触发 `writeClipboardText` / success / error 通知。

三条 shared 用例与这条 stores 用例在修复前都会失败（旧实现分别产出 `['success','pending']`、
`['pending','success']`+`hasPending()===false`、`listenerCount()>0`，以及 dispose 后监听数仍为 1）。

## 验证

- `packages/shared` `bun test`：**387 pass / 0 fail**（基线 384，+3 新增）；`tsc --noEmit` **0 error**
- `packages/stores` `bun test`：**366 pass / 0 fail**（基线 357，+1 为本任务新增，其余 +8 来自并行 agent 新增的测试文件，
  文件数 35→36）；`tsc --noEmit` 仅 1 条既有报错 `src/host-services.test.ts(93,23) TS2339`，与基线一致
- `bunx biome check` 5 个改动文件：clean
- `bun scripts/complexity/gate.ts`：ok（1061 files / 8815 functions），本次改动文件均未上榜

## 改动文件

- `/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/browser-clipboard.ts`
- `/Users/konata/code/tmex-enhanced-wt-r7/packages/shared/src/browser-clipboard.test.ts`
- `/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/tmux-event-router.ts`
- `/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/tmux-event-router.test.ts`
- `/Users/konata/code/tmex-enhanced-wt-r7/packages/stores/src/tmux.ts`（仅把已有 `disposers` 传给 router）

## 备注 / 遗留

- `dispose()` 后若再来 `clipboard-write` 事件，`disposeClipboardWriter` 已从 WeakMap 删除条目，会新建一个 writer。
  实际路径上 transport 的 `onEvent` 注销与 writer 释放在同一个 disposers 数组里，拆卸后不会再有事件进来，故未额外加锁。
- 手势重试失败时仍是「报一次 failure 后放弃」，未改为重新挂起 —— 保持既有语义。
