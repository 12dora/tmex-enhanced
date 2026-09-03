# OA 结果：F2（api-client CRUD 模板收敛）+ F4（`prepareDownload` 合一）

## 1. 做了什么

### F2 — `packages/api-client/src/json-mutation.ts`（新建，87 行）

抽出三个导出：

- `requestOk(client, path, options)`：拼 `RequestInit`（`method` / `body` 自动附 JSON 头并序列化 / `signal`）→ 非 2xx 交错误工厂 → 返回原始 `Response`，供 void 与 204 空体调用方使用。
- `requestJson<TWire, TResult>(client, path, options)`：在 `requestOk` 之上解析 JSON，`pick` 回调负责从 `{device}` / `{folder}` / `{session}` 一类信封里取值，不引入 magic string。
- `readCodedError(res, fallback, make)`：`{error:{code,message}}` 契约错误体的解析（含 `{error:"..."}` 老形态兼容），由 §3.10 J=0.76 的 `tls-api.readError` ↔ `local-api.readError` 两份合一而来。

关键设计约束（保证调用方看到的错误形状零变化）：

- 错误类型由 `toError` 承载，不由模板决定：默认 `new Error(await parseApiError(res, errorFallback))`（devices / device-folders / llm-providers / watch / agent / terminal-shortcuts 族），文件族传 `toError: parseError` 抛 `FileApiError`（保留 `status` / `code`），local 族传 `readCodedError` 包装抛 `TlsApiError` / `LocalApiError`。
- `allowStatus` 承载「非 2xx 但不是错误」的两处既有语义：`fetchAgentSession` 404 → null、`decideAgentConfirmation` 409 → `'conflict'`。
- 无 `method`/`body`/`signal` 时不构造 `init`，底层仍以 `client.fetch(path, undefined)` 调用——既有测试里 `expect(calls[0].init).toBeUndefined()` 的断言原样通过。

改写的文件（**全部公开函数签名与抛出形状不变**）：`devices.ts`、`device-folders.ts`、`llm-providers.ts`、`watch.ts`、`agent.ts`、`terminal-shortcuts.ts`、`file-resources.ts`、`local/tls-api.ts`、`local/local-api.ts`。除 backlog 点名的 17 个 mutation 外，同族的 GET 端点形状完全一致，一并收敛（共 40 个函数）。

三个函数**刻意保留原样**，因为它们的语义不是模板：

- `devices.fetchDevices`：需要透传调用方的完整 `RequestInit`（signal 等）；
- `watch.fetchWatchRule`：任意非 2xx 都返回 null（不是特定状态码），`allowStatus` 表达不了；
- `file-resources` / `local/*` 各自再包一层 `fileJson` / `private json()`，把「这一族固定用哪个错误工厂」提到一处，调用点回落到 1–4 行。

### F4 — `prepareDownload` 合一

`packages/api-client/src/download-transfer.ts` 的 `prepareDownload` 由私有改为导出（并给返回值命名 `PreparedDownload`），`packages/panels/src/files/bulk-transfer.ts` 删除自己那份 44 行副本与配套的 `DownloadPrepareEvent` 类型，改 `import { prepareDownload } from '@tmex/api-client/download-transfer'`（该包 `exports` 已有 `"./*"` 通配，无需改 `index.ts`）。两份差异只有参数顺序（panels 版 client 在前）与 opts 类型（`TransferPathOpts extends TransferOpts`），按 api-client 版的顺序调用即可，行为一致。

## 2. 新增测试

- `packages/api-client/src/json-mutation.test.ts`（194 行，15 个用例）：成功路径（GET 不拼 init / body 自动序列化 + pick 拆信封 / signal 透传）、非 2xx 带 JSON error 体、非 2xx 纯文本体退化 fallback、未给 fallback 时状态码兜底、`toError` 决定错误类型（`FileApiError` 的 message/status）、网络异常原样上抛不被错误工厂吞、`allowStatus` 命中不抛错、204 空体不解析 JSON、`readCodedError` 四条分支。
- `packages/api-client/src/download-transfer.test.ts`（166 行，7 个用例）：happy path（POST prepare + leg1 进度 + done 事件字段）、done 缺 name 时回落入参文件名、多文件（连续两次 prepare 各拿独立 downloadId）、prepare 非 2xx 抛 `FileApiError`（文案/状态码/code）、流内 error 事件转 `FileApiError` 且已上报的 downloadId 仍交调用方回收、无 downloadId 抛 unknown、abort（signal 透传 + `AbortError` 原样上抛）。

## 3. 度量

### 测试 / 类型 / lint / 门禁

| 项 | 基线 | 现在 |
|---|---|---|
| `packages/api-client` `bun test` | 155 pass / 0 fail（15 文件） | **177 pass / 0 fail**（17 文件） |
| `packages/api-client` `tsc --noEmit` | 5 errors（全在既有测试文件：`client.test.ts` ×4、`files-download.test.ts` ×1） | **5**（同一批，未新增） |
| `packages/panels` `bun test src/files` | 85 pass / 0 fail | 85 pass / 0 fail |
| `packages/panels` `bun test`（全量） | — | 798 pass / 0 fail |
| `packages/panels` `tsc --noEmit` | 0 | 0 |
| `apps/fe` `bun test src/` | — | 1744 pass / 0 fail |
| `apps/fe` `tsc --noEmit` | — | 0 |
| `packages/stores` / `packages/ws-client` | — | 439 / 382 pass，0 fail |
| `biome check`（我的全部文件 + 整个 `packages/api-client/src`） | — | **clean，无 fix 待应用** |

`bun scripts/complexity/gate.ts`：**我的文件零违规**。仓库当前 gate 为 fail，违规项在别的 agent 的文件上（先后观察到 `packages/panels/src/settings/integration-account-form-modal.tsx:219 useIntegrationSubmit 121 行`、`apps/gateway/src/hub/uplink-server.ts:1536 handleKeyLogAppend 122 行`），按共同规则未触碰。

### `wc -l` delta（生产代码）

| 文件 | 前 | 后 | Δ |
|---|---:|---:|---:|
| `api-client/src/devices.ts` | 113 | 100 | **-13** |
| `api-client/src/device-folders.ts` | 96 | 79 | **-17** |
| `api-client/src/llm-providers.ts` | 69 | 54 | **-15** |
| `api-client/src/watch.ts` | 112 | 97 | **-15** |
| `api-client/src/agent.ts` | 230 | 224 | **-6** |
| `api-client/src/terminal-shortcuts.ts` | 31 | 36 | +5 |
| `api-client/src/file-resources.ts` | 117 | 105 | **-12** |
| `api-client/src/download-transfer.ts` | 132 | 140 | +8 |
| `api-client/src/local/tls-api.ts` | 83 | 69 | **-14** |
| `api-client/src/local/local-api.ts` | 80 | 68 | **-12** |
| `api-client/src/json-mutation.ts` | — | 87 | +87 |
| `panels/src/files/bulk-transfer.ts` | 382 | 321 | **-61** |
| **合计** | **1445** | **1380** | **-65** |

测试代码 +360 行（两个新文件），此前 `llm-providers` / `watch` / `agent` / `terminal-shortcuts` / `download-transfer` 的模板与 leg1 逻辑没有直接单测，现在核心模板与 `prepareDownload` 都有直测。

### 与 backlog 的 -220 行预估的差距（需要指挥官知情）

EX4 §3.6 估的「消掉 ~220 行」是按「45 处 × 15 行模板」的裸行数算的，**没有计入两项现实成本**：

1. 替换后的调用点在 biome 的 100 列打印宽度下仍要 4–8 行（`return requestJson<Wire, Result>(client, path, { method, body, errorFallback, pick })` 单行 118+ 字符，必然被拆成多行）；
2. 新模板模块自身 87 行（含错误工厂类型、`readCodedError`、必要注释）。

实测过位置参数版 `mutateJson(client, method, path, body, fallback, pick)`：6 个位置参数同样会被 biome 拆成 8 行，行数不降反而可读性变差，故采用 `(client, path, options)` 形态。结论是 **api-client 生产代码净变化约 -4 行（1063 → 1059），真正的行数收益来自 panels 侧删掉整份副本的 -61 行**；本任务的实际价值是「45 处模板复制 → 1 处」「三套错误映射各自唯一」「模板首次被直测覆盖」，而不是行数。若要真正压掉 200 行，只能动公开函数签名（去掉 `errorFallback` / `client` 的默认参数尾巴），那会破坏 F2 的硬约束，未做。

## 4. 未做 / 边界

- 未改 `packages/api-client/src/index.ts`：panels 走子路径 `@tmex/api-client/download-transfer`（`package.json` 的 `exports` 已声明 `"./*"`），不需要新增 barrel 导出。
- 未改 `packages/api-client/src/files.ts`（不在我的文件清单内，且 `downloadFileWithProgress` 的再导出无需变动）。
- 未改 `packages/api-client/src/{site,domain-access,capabilities,node-url,local/setup-api,local/tunnel-api}.ts`：不在任务清单内。其中 `local/setup-api.ts`、`local/tunnel-api.ts` 同样能收敛到 `readCodedError`/`requestJson`，属于同一模式的后续可选清扫，记账留给下一轮。
- 既有测试断言一条未删、未弱化。
