# GP 结果：T1 passkey / rtc / peer 测试夹具抽取

## 改动文件

新建：

- `apps/gateway/src/auth/passkey-test-fixtures.ts`（230 行）
- `apps/gateway/src/mesh/rtc/rtc-test-fixtures.ts`（48 行）
- `apps/gateway/src/mesh/peer-test-fixtures.ts`（66 行）

改为 import 共享夹具（断言未改）：

- `apps/gateway/src/auth/passkey.test.ts`
- `apps/gateway/src/mesh/auth-routes.test.ts`
- `apps/gateway/src/hub/hub-runtime.test.ts`
- `apps/gateway/src/mesh/integration/dc-http-bulk.integration.test.ts`
- `apps/gateway/src/mesh/rtc/rtc-peer-manager.test.ts`
- `apps/gateway/src/mesh/rtc/rtc-loopback.integration.ts`（文件名未改，仍不被默认 `bun test` 发现）
- `apps/gateway/src/mesh/peer-manager.test.ts`
- `apps/gateway/src/mesh/peer-manager.backoff.test.ts`
- `apps/gateway/src/mesh/peer-manager.upgrade.test.ts`
- `apps/gateway/src/mesh/rtc/rtc-dial-breaker.test.ts`

未改：`apps/gateway/src/mesh/test-support.ts`（peer 夹具落到新建的 `peer-test-fixtures.ts`，不往 test-support 塞 uplink 依赖）。无生产文件。

## 副本差异（参数化，行为等价）

1. **passkey `credentialId`**：`passkey.test.ts` / `hub-runtime.test.ts` 用 `randomBytes(16)`；`auth-routes.test.ts` 用 `crypto.getRandomValues(new Uint8Array(16))`。共享函数 `createEs256Authenticator({ credentialId? })`，默认 `randomBytes`；auth-routes 留 4 行包装继续走 `getRandomValues`。
2. **`dummyUplink` `wsFactory`**：三份 peer-manager 测试用 `fakeSocketPair()[0]`；`rtc-dial-breaker.test.ts` 抛 `no-ws`。第四参 `options.wsFactory`，breaker 侧显式传入抛错工厂。
3. **`derInt`**：hub 版变量名 `trimmed`、while 写成单行，其余两份是 `stripped` + 花括号。循环与符号位填充相同，统一为带花括号的 `stripped` 版，未参数化。
4. **rtc `setup()` / `managers()` 未合并**：不是逐字副本。`rtc-peer-manager` 带 mismatch 指纹覆盖；`dc-http-bulk` 设 `liveness: false`；`rtc-loopback` 走真实 native、15s timeout、Google STUN。只抽了逐字相同的 `loopbackSignaling`（含内嵌 `subscribe`/`deliver`）。`rtc-dial-breaker` 没有 loopback 信令，只改用 peer 夹具。

## 行数

| 文件 | 前 | 后 | Δ |
|---|---:|---:|---:|
| `auth/passkey.test.ts` | 650 | 441 | −209 |
| `mesh/auth-routes.test.ts` | 3676 | 3472 | −204 |
| `hub/hub-runtime.test.ts` | 2339 | 2131 | −208 |
| `mesh/integration/dc-http-bulk.integration.test.ts` | 875 | 828 | −47 |
| `mesh/rtc/rtc-peer-manager.test.ts` | 728 | 682 | −46 |
| `mesh/rtc/rtc-loopback.integration.ts` | 294 | 250 | −44 |
| `mesh/peer-manager.test.ts` | 3851 | 3786 | −65 |
| `mesh/peer-manager.backoff.test.ts` | 412 | 345 | −67 |
| `mesh/peer-manager.upgrade.test.ts` | 1008 | 941 | −67 |
| `mesh/rtc/rtc-dial-breaker.test.ts` | 486 | 438 | −48 |
| `mesh/test-support.ts` | 181 | 181 | 0 |
| `auth/passkey-test-fixtures.ts`（新） | — | 230 | +230 |
| `mesh/rtc/rtc-test-fixtures.ts`（新） | — | 48 | +48 |
| `mesh/peer-test-fixtures.ts`（新） | — | 66 | +66 |
| **合计** | **14500** | **13839** | **−661** |

分族净省：passkey −391、rtc `loopbackSignaling` −89、peer −181。比 backlog 估的 ~620 略多（顺手删了夹具搬走后的无用 import）。

## 每文件用例数（抽取前后相同）

口径：文件内 `test(` 声明数；拥有的 9 个会被 `bun test` 发现的文件实测合计 **228 pass / 0 fail / 1763 expect**（前=后）。`rtc-loopback.integration.ts` 4 条仍不进默认发现。

| 文件 | 前 | 后 |
|---|---:|---:|
| `auth/passkey.test.ts` | 4 | 4 |
| `mesh/auth-routes.test.ts` | 63 | 63 |
| `hub/hub-runtime.test.ts` | 23 | 23 |
| `mesh/integration/dc-http-bulk.integration.test.ts` | 8 | 8 |
| `mesh/rtc/rtc-peer-manager.test.ts` | 18 | 18 |
| `mesh/rtc/rtc-loopback.integration.ts` | 4（不发现） | 4（不发现） |
| `mesh/peer-manager.test.ts` | 74 | 74 |
| `mesh/peer-manager.backoff.test.ts` | 6 | 6 |
| `mesh/peer-manager.upgrade.test.ts` | 17 | 17 |
| `mesh/rtc/rtc-dial-breaker.test.ts` | 15 | 15 |

`cd apps/gateway && bun test src/auth src/mesh src/hub`：**1368 pass / 0 fail**（96 files）。全量套件改前未跑（并行 agent 同时改 mesh）；拥有文件的 228/1763 与改前逐字相同。输出中无 `rtc-loopback.integration`、无 `*-test-fixtures.ts`。

## tsc / biome

- 改前 `bunx tsc --noEmit -p .`：0 error。
- 改后本任务文件：0 error。仓库现有 `uplink-client.ts` / `peer-ws-race.ts` 报 TS2440 重导出冲突，属于并行 B5，未触碰。
- `bunx biome check`（13 个本任务文件）：通过。

## 未做

- §5.2 第四组 `fakeGateway`：落在 `mesh-runtime.test.ts` / `mesh-runtime-node-presence.test.ts` / `hub-contract.integration.test.ts`，不在本任务文件清单，未改。
- rtc 的 `setup()`/`managers()` 因行为参数不同未强行合并，见上。
