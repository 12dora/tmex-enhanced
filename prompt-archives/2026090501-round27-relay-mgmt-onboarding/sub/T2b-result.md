# T2b 结果：中继切换流程的两处评审问题

## 结论

两条评审问题均已修复并有回归测试覆盖。`bun test src/node src/pages/settings/nodes` 1152 pass / 0 fail；`apps/fe` 全量单测 2389 pass / 0 fail；`bunx tsc --noEmit -p apps/fe` 无输出；biome 对本任务 6 个文件无修复项。

## 改动

### 1. 陈旧轮询覆盖刚切好的链路（`apps/fe/src/node/mesh-relay.ts`）

- 新增模块级 `generation`（代数）。`switchMeshRelay` 成功后 `generation += 1`；`store.reset`（`onReset`）也 +1，让归零之前的在途请求一并作废。
- `inFlight` 由 `Promise<void> | null` 改为 `{ promise, generation } | null`：
  - **只复用同一代的在途请求**——切换之后的刷新必须自己发一次，不再被切换前那次在途请求顶掉（原来 `if (inFlight) return inFlight` 会让 uplink 面板的 `onChanged: refresh` 变成空转）。
  - `finally` 里按 `inFlight?.generation === started` 清理，避免旧代请求把新代的在途标记抹掉。
- `/status` 的成功与失败两条路径都先判 `started !== generation`，不是当代就整份丢弃（既不写链路，也不写 error / unsupported）。

### 2. 切换在途期间对话框可被关掉 / 重开（`use-relay-switch.ts` + `relay-switch-dialog.tsx`）

- `use-relay-switch.ts` 把状态从 `useState` 挪进一份普通 store：新增导出 `createRelaySwitchCore(deps)`（`getState` / `subscribe` / `request` / `dismiss` / `confirm`），`useRelaySwitch` 退化成 `useSyncExternalStore` 订阅 + toast/i18n 接线（`t`、`onChanged`、`relayApi` 走 `latest` ref，与 `use-hub-role-switch.ts` 同一套写法）。这么做的直接原因是 apps/fe 没有 DOM 测试环境，SSR 探针测不了「在途→解锁」这种时序。
- 语义：`busy` 期间 `request` / `dismiss` / 再次 `confirm` 全部忽略；成功后 `onDone` → 仅当 `target.url` 仍等于本次动作发起时的地址才清空 `target` → 最后解 `busy`；失败保留确认框（可再点一次），错误交给 `onError`。
- 新增导出类型 `RelaySwitchState` / `RelaySwitchCore` / `RelaySwitchCoreDeps`；`RelaySwitchController` 改为 `extends RelaySwitchState`，对外形状（`target` / `busy` / `request` / `dismiss` / `confirm`）不变，调用方无需改动。
- 对话框：`AlertDialogCancel` 加 `disabled={controller.busy}`；确认按钮在途时补一个 `Loader2` 自旋（与 `RelayEnrollDialog` 一致），否则整框禁用后没有任何进行中的反馈。`onOpenChange` 仍只调 `dismiss()`（它自己会拒），且 `open` 恒为受控的 `true`，Esc / 点外面都关不掉。

### 3. `relay-uplink-panel.tsx`

未改动。面板侧的问题（`onChanged: refresh` 被 `inFlight` 吞掉）真因在 store，已在第 1 条修掉；链路行在 busy 期间的点击由 `request` 自身拒掉（`relay-rows.tsx` 不在本任务范围）。

## 测试

- `apps/fe/src/node/mesh-relay.test.ts`（+4 用例，新增 `describe('切换与轮询交错')`，另加 `apiWith` / `deferred` 辅助）：
  1. 切换前发出的 `/status` 晚回：链路仍是切后的 b；
  2. 切换前那次 `/status` 失败：`error` 不落进已切好的这一份；
  3. 切换之后的刷新自己发一次（`calls === 2`），不复用切换前的在途请求；
  4. 未切换时同一拍的重复刷新仍只打一次（保住原有去重）。
  - 反证：临时把代数判定改成恒 false、并把 `inFlight` 复用改回无条件，上述 1/2/3 三条立刻 fail（第 3 条直接超时），改回后 12 pass。
- `apps/fe/src/pages/settings/nodes/relay/use-relay-switch.test.ts`（新文件，4 个用例）：打开/取消/无目标时确认为空转；在途期间换目标（A→B）、关框、再次确认全被忽略且只发了一次 `switchRelay`，A 完成后 `target` 清空、`busy` 解开、随后 `request(B)` 又能开框；订阅方通知与退订；失败保留确认框并解锁。
- 运行记录：
  - `cd apps/fe && bun test src/node src/pages/settings/nodes` → 1152 pass / 0 fail（63 文件）
  - `cd apps/fe && bun test src/` → 2389 pass / 0 fail（134 文件）
  - `bunx tsc --noEmit -p apps/fe` → 无错误（未见 `bandwidthBytesPerSec` 相关报错）
  - `bunx biome check --write <6 个文件>` → No fixes applied
  - `bun scripts/complexity/gate.ts` → 仅 `apps/gateway/src/mesh/relay-routes.ts`(646) 与 `relay-uplink-client.ts`(609) 超限，均非本任务文件

## 遗留 / 不确定

- 「成功回来时 `target` 已被换成别的地址」这条守卫（按 URL 比对再清空）在当前语义下走不到：`busy` 期间 `request` / `dismiss` 都被拒，目标不可能变。保留它是防御性不变量（若将来放开在途期间改目标，行为仍正确），因此没有为这条分支单独写用例。
- 对话框本身（Cancel 禁用、自旋）无法用静态渲染断言：Base UI 走 portal 且实现按需到货，SSR 输出为空。这部分只能靠 e2e，本任务按要求未跑 Playwright。
- `use-relay-switch.ts` 复用了 `@/node/create-polling-store` 的 `createStateStore`（只 import，未改该文件）。
