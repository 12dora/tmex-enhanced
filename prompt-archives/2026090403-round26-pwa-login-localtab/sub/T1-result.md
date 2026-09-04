# T1 结果 — CI 确定性失败与 tsc 基线

## 结论

T1 范围内的测试失败与 tsc 错误已清零。`bun test src/relay` 与 `apps/gateway` 全量测试 exit 0 且无 Unhandled error。`packages/panels` 全量 0 fail。三包 tsc 均为 0 error。

根目录 `bun run lint` 的 **biome check 已绿**；复杂度门禁仍有 **2 条越界，均不在 T1 范围**（并行 agent 改动）：

- `apps/fe/src/pages/LoginPage.tsx:208 LoginForm: 208 lines > 207`
- `packages/stores/src/site.ts:62 createSiteStore: 155 lines > 135`

`apps/gateway/src/mesh/auth-routes.ts` 已压回 allowlist（`fileLines` 767）。

## 改动

1. **relay unhandled rejection**  
   `relay-hardening.test.ts` 保留 reader，`.read().catch()`，测试结束前 `cancel()`，避免 harness `abortBoth()` 时无人观察的 `LinkError: relay-rst`。

2. **panels `mock.module` 污染**  
   去掉 `device-folder-tree.test.tsx` 的进程级 `react-i18next` mock，改为独立 i18n 实例 + `I18nextProvider`（与 `device-card.test.tsx` / `chat-thread.test.tsx` 相同）。断言改为译文 / 结构。

3. **tsc → 0**
   - stores：helper 类型补 `value: string`
   - api-client：`FetchLike` 标注 mock；`Uint8Array` 拷成 `ArrayBuffer` 再进 `Response`
   - gateway TS5097：`native-datachannel.ts` 动态 import 去掉 `.ts`。Bun runtime / `bun build --target bun` 都能解析无后缀；`packages/app` 的 `allowImportingTsExtensions` 不强制后缀。未改 gateway tsconfig（该文件不是 noEmit-only）。

4. **`GET /api/auth/mode` 标识符用户名**  
   `authModeDisplayUsername`：username 等于 uid、或匹配 UUID / 32-hex 时返回 `null`。HTTP 测试覆盖 join 路径（username=uid）；单测覆盖 UUID / 32-hex / 正常显示名。

5. **CI retry（可选）**  
   gateway 目录级失败后，按测试文件隔离重跑一次；单文件目标仍整命令重跑。exit code 语义不变，不按错误文本过滤。

## 文件

- `apps/gateway/src/relay/relay-hardening.test.ts`
- `apps/gateway/src/mesh/auth-routes.ts`
- `apps/gateway/src/mesh/auth-routes.test.ts`
- `packages/panels/src/device-folders/device-folder-tree.test.tsx`
- `packages/stores/src/host-services.test.ts`
- `packages/api-client/src/client.test.ts`
- `packages/api-client/src/files-download.test.ts`
- `packages/app/src/lib/native-datachannel.ts`
- `scripts/ci/unit-tests.ts`

## 验证

| 项 | 基线 | 现在 |
| --- | --- | --- |
| `apps/gateway bun test src/relay` | 126 pass / 0 fail / **2 errors** / exit 1 | 126 pass / 0 fail / **0 errors** / exit 0 |
| `apps/gateway bun test` | 4312 pass / 0 fail + 2 errors | **4319 pass / 0 fail / exit 0**（含本任务 +2 条 auth-mode 测试；其余增量来自并行 worktree） |
| `packages/panels bun test` | 907 pass / 15 fail | **922 pass / 0 fail** |
| `packages/stores bun test` | — | 431 pass / 0 fail |
| `packages/api-client bun test` | — | 209 pass / 0 fail |
| stores tsc | 1 error | **0** |
| api-client tsc | 5 errors | **0** |
| gateway tsc | 1 error (TS5097) | **0** |
| packages/app tsc | — | 0（确认去后缀后仍通过） |
| biome（本任务文件） | — | clean |
| `bun run lint` | green | biome green；复杂度 2 条越界（LoginForm / createSiteStore，越权未改） |

## 未做 / 留给别人

- 未改 `packages/shared/src/link/mux.ts`、relay router、未加全局 unhandledRejection 过滤。
- 未跑 Playwright e2e。
- 未跑完整 `scripts/ci/unit-tests.ts`（会扫全仓库；逻辑改动仅 gateway retry 路径）。
- 根 lint 的两条复杂度失败属于并行 agent 的 `LoginPage.tsx` / `site.ts`，不在 T1 scope。
