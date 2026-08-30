# OI 结果：站点设置 single-flight 竞态修复 + 设备查询 AbortSignal 复核

## 1 & 2（P1）site-settings-loader 代次与在途共享 —— 已修复

两条 finding 都成立，且同源：**代次绑在调用方而不是物理请求上**。

原实现里每次 `load()` / `fetchSettings()` 都先 `begin()` 把 `generation += 1`，然后才决定要不要搭
在途请求的车。由此产生：

- **finding 1（stale 提交回滚乐观更新）**：`updateTheme()` 调 `invalidate()` 只是把 `generation` 加一，
  在途那次 GET 仍留在 `inflight` 里可被搭车。紧接着的 `ensureFreshSettings()` 搭上去、并且自己
  `begin()` 又把 generation 推到最新，于是这次**保存前发出的响应**在 `commitIfLatest` 里代次相等，
  照常 `commit()` —— 刚落的 theme 被旧数据盖回。
- **finding 2（失败时 settings 恒为 null）**：多个搭车方共享同一个 promise，但各自持有不同代次，
  只有最后一个调用方的代次等于 `generation`。请求失败时，先发起的 `fetchSettings()` 走
  `commitIfLatest(旧代次, fallback)` → 代次不等 → 只返回不落库，`options.current()` 又是 null，
  于是返回 fallback 而 store 里 `settings` 一直是 null（`loading` 也可能停在 true）。

### 修法

`packages/stores/src/site-settings-loader.ts` 改为：

- `inflight` 从 `Promise` 变成 `{ generation, promise }`：代次在**物理请求发出那一刻**分配并终生不变。
- `acquire(join)`：只有 `inflight.generation === generation` 才允许搭车。`invalidate()` 把 generation
  推进一格后，在途请求同时变成**不可搭车**且**不可提交**（`commitIfCurrent` 代次比对失败）。
- 提交与失败清理都挂在物理请求自身的 `then/catch` 上（单一所有者），与搭车顺序无关：
  搭车方只 `await entry.promise` 拿结果，不再自己 `begin()`、不再重复复位 `loading`、不再重复打日志。
- `fetchSettings()` 失败兜底：先看 `options.current()`（第一个失败者已落兜底 / 期间已有新数据），
  否则 `commitIfCurrent(entry.generation, fallback)` —— 兜底只提交一次，所有搭车方拿到**同一个对象**。
  若代次已过期（有更新的请求在途）则不落库，交给那次新请求提交，语义仍然一致。
- 失败时 `setLoading(false)` 仅在“自己仍是最新那次”时执行（旧请求失败、新请求在途 → loading 保持 true）。

`packages/stores/src/site.ts` **无需改动**：loader 对外契约不变（四个方法签名与语义一致）。

### 新增测试

`packages/stores/src/site-settings-loader.test.ts`（新文件，8 个用例，直接对 loader 打桩，
不经 store/fetch，用可控 deferred 请求）：

- invalidate 在途 → 搭车方另起新请求；旧响应无论**后到**还是**先到**都被丢弃、不落库、不抢占后续提交（2 例）
- 搭车方不抢代次：单次请求 + 三个调用方，结果照常落库且只 commit 一次
- 保存后重拉不会被保存前的在途响应盖掉（`refreshSettings` 另起 + 旧响应后到）
- 失败 + 多搭车方：兜底只提交一次，各方拿到同一份；`fetchSettings` 兜底 / `ensureFreshSettings` 抛出，
  混合搭车时行为一致；失败后下一次取数照常发新请求并落库；旧请求失败不提前复位 loading（4 例）

原有 `site-refresh.test.ts` 的 9 个并发/共享用例全部未改动即通过。

## 3（P2）devices query 的 AbortSignal —— 未改，按约定跳过

复核结论：**当前无法在不改 api-client 的前提下把 signal 传下去**。

- `packages/api-client/src/client.ts:67` 的 `ApiClient.fetch(path, init?: RequestInit)` 本身支持
  `signal`；
- 但 `packages/api-client/src/devices.ts:26` 的 `fetchDevices(client: ApiClient = defaultApiClient)`
  **只有 client 一个参数**，内部写死 `client.fetch('/api/devices')`，没有透传 init 的口子。

按任务约定（“如果 device-list 函数不改 api-client 就拿不到 signal，就记录并跳过”），
`apps/fe/src/components/global-device-provider.tsx` 未做改动。

若指挥官决定要做，最小改动是（本次未执行，涉及不在我 scope 内的 `packages/api-client`）：

```ts
// packages/api-client/src/devices.ts
export async function fetchDevices(
  client: ApiClient = defaultApiClient,
  init?: RequestInit
): Promise<DevicesResponse> {
  const res = await client.fetch('/api/devices', init);
  ...
```

然后 `devicesQueryOptions` 里 `queryFn: ({ signal }) => fetchDevices(apiClient, { signal })`。
风险很低（纯增量可选参数，其余调用点不受影响），收益是 `enabled:false`（node 掉线）时
已经在途的 GET / 重试能被 react-query 真正 abort，而不是跑完再丢弃结果。

## 验证

- `packages/stores`：`bun test` → **365 pass / 0 fail**（基线 357 + 新增 8）
- `packages/stores`：`bunx tsc --noEmit` → 仅 1 条既有错误（`src/host-services.test.ts(93,23)`），无新增
- `apps/fe`：`bun test src/` → **903 pass / 0 fail**；`bunx tsc --noEmit` → 0 error
- `bunx biome check`（改动文件）→ clean
- `bun scripts/complexity/gate.ts` → ok（1061 files / 8814 functions）

## 改动文件

- `packages/stores/src/site-settings-loader.ts`（重写代次/在途共享逻辑）
- `packages/stores/src/site-settings-loader.test.ts`（新增）
