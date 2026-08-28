# grok-cli-fixes 结果

工作区：`/Users/konata/code/tmex-enhanced-wt-merge`（仅改 `packages/app/`，未做 git 操作）。

## 基线 vs 最终

| 检查 | 基线 | 最终 |
| --- | --- | --- |
| `packages/app` `bun test` | 213 pass / 0 fail（29 files） | 227 pass / 0 fail（29 files，+14 用例） |
| `bunx tsc --noEmit -p .` | 1 error（`TS2688` Cannot find type definition file for 'node'） | 1 error（同基线，未新增） |
| `bunx biome check <changed files>` | — | clean |

tsc 基线那条 `TS2688` 与本次改动无关（`@types/node` 未装进 `packages/app`）。

## Defect 1 — `direct enable\|disable` 在 Node CLI 进程里调用 Bun API

**根因**

- Node 入口 `src/index.ts` 在 `dist/cli-node.js`（`--target node`）里直接 `dispatchDirect`。
- `commands/direct.ts` 用 `Bun.write` 写 addon；`lib/native-datachannel.ts` 用 `Bun.file` 读 addon 做 sha256。Node 下抛 `ReferenceError: Bun is not defined`。
- `runDirect` 把任意 `ok: false` 都打成 `direct enable skipped` 并以 exit 0 返回；`init --role node` 的 `enableDirectAfterInit` 再吞掉异常，容器里看起来像成功。

**Node CLI 可达的 `Bun.` 排查**

从 `index.ts` 不经 `auth-spawn` 的 import 链：`init` / `direct` / `native-datachannel` / `native-manifest` / `native-tarball` / `fs-utils` 等。生产代码里 Node 可达的 `Bun.*` 已清掉。

仍保留 Bun API 的文件：

- `runtime/server.ts`、`runtime/assemble.ts`、`runtime/serve-frontend.ts`（`build-runtime.ts` 的 bun target）
- 测试里的 `Bun.serve` / `Bun.spawn`（只在 `bun test` 下跑）

sha512 完整性校验本来就在 `native-manifest.ts` 用 `node:crypto`，无需再改。

**改动**

- `direct.ts`：`writeFile` 写 addon；`pin === undefined` 才 `detectCurrentNativePin`，`pin === null` 视为平台不支持；失败结果带 `unsupported?: true`。
- `runDirect`：仅 `unsupported` 走 skip / exit 0；其它失败 `console.error` + `process.exitCode = 1`。
- `native-datachannel.ts`：`readFile` + `Uint8Array` 代替 `Bun.file`.
- `init` 的容忍行为未改：失败仍不中止 init，但日志打真实 `reason` / thrown message。

**测试**

- `direct.test.ts`：Node `fetchImpl` 写盘 + sha256 回读；`win32` unsupported；下载 503 的非零退出；`pin: null` 的 skip/0。断言存在性改为 `pathExists`，不再用 `Bun.file().exists()`。
- `init.test.ts`：吞异常时必须打印真实错误信息。

## Defect 2 — `enroll` 非 hub 节点从 login JSON 读 `sid`

**根因**

- `loginWithRootKey` 读 `loginBody.sid`。
- 网关 `auth-routes.ts` login 成功体是 `{ expires_at }`，session 在 `x-tmex-set-session: ${sid};${maxAgeSec}`。
- `session-middleware.consumeSetSessionForBrowser`：对本机 `via=self` 把该头转成 `Set-Cookie: tmex_s_self=...` 并删掉 `x-tmex-set-session`（CLI 直连 hub 的常见路径）；远程 entry 才保留 header、不 Set-Cookie。
- 后续鉴权：`authenticateRequest` 对本机只读 cookie `tmex_s_self`，不接受 Bearer。`enroll.ts` 已经用 `cookie:` 头发后续 `POST /api/hub/enrollments` / `GET /api/hub/nodes`，缺的是 login 侧没把 sid 解析出来。
- `enroll.test.ts` 旧 mock 在 body 里塞 `sid`，测不到真实形状。

**改动**

- `hub-client.ts`：`sessionIdFromLoginResponse` 优先 `x-tmex-set-session`（`;` 前为 sid），否则解析 `Set-Cookie` 的 `tmex_s_self` / `tmex_s_<nodeId>` / 任意 `tmex_s_*`。
- 后续请求 cookie：`tmex_s_self=<sid>`，nodeId 不是 `self` 时再附 `tmex_s_<nodeId>=<sid>`。
- `enroll.ts` 无需改调用方式。

**测试**

- `hub-client.test.ts`：header 路径、`tmex_s_self` fallback、`tmex_s_<nodeId>` fallback、body `sid` 被忽略、`postEnrollment` 带 cookie。
- `enroll.test.ts`：totp 用例改为真实网关形状（body 无 sid，Set-Cookie）；新增 header 路径用例，断言 enrollments POST 带 `tmex_s_self=`。

## Defect 3 — `hub join` / `hub leave` 总是尝试重启服务管理器

**根因**

- `maybeRestart()` 在 app.env / identity 写完之后无条件调 `restartService`。
- 容器/CI 上 `detectServiceManager() === 'none'` 时 `restartService` 抛 `service.install.unsupportedPlatform`，命令非零退出，但 join/leave 状态已经成功。

**改动**

- `parseArgs` 本身已把 `--no-restart` 解析成 boolean，无需改解析器。
- `maybeRestart`：
  1. `--no-restart`：不重启，打印 `skipped service restart; restart tmex manually to apply the change`，exit 0。
  2. 无注入 `io.restart` 且 manager 为 `none`：同样 hint，不抛。
  3. 保留 `io.restart` / `io.skipRestart` 测试注入语义（reset 用例仍能注入 restart）。
- `help.ts`（中英）：`hub join` / `hub leave` 用法加上 `[--no-restart]`。

**测试**

- `args.test.ts`：join/leave 解析 `--no-restart`；help 含该 flag。
- `join.test.ts`：leave `--no-restart` 不调 restart；leave + `serviceManager: 'none'` 不抛；join `--no-restart` 成功后 skip restart。无 manager 用例注入 `serviceManager: 'none'`，避免打到本机 launchd。

## 改动文件

生产：

- `packages/app/src/commands/direct.ts`
- `packages/app/src/lib/native-datachannel.ts`
- `packages/app/src/lib/hub-client.ts`
- `packages/app/src/commands/hub.ts`
- `packages/app/src/cli/help.ts`

测试：

- `packages/app/src/commands/direct.test.ts`
- `packages/app/src/commands/init.test.ts`
- `packages/app/src/lib/hub-client.test.ts`
- `packages/app/src/commands/enroll.test.ts`
- `packages/app/src/commands/join.test.ts`
- `packages/app/src/lib/args.test.ts`
- `packages/app/src/i18n/index.test.ts`

`enroll.ts` 未改（后续请求本来就发 Cookie）。

## `packages/app` 以外仍需的改动

**网关不需要改。** login 体 `{ expires_at }` + header/Set-Cookie 的契约是对的；缺陷在 CLI 解析。后续请求用 `Cookie: tmex_s_self=<sid>` 即可通过 `requireSession`。

容器 e2e 侧建议：

- 无 systemd/launchd 的镜像用 `hub join … --no-restart`（或不传 flag，现在也会 hint 后 exit 0）。
- 手动起 gateway 进程以加载新的 `TMEX_ROLES` / `TMEX_HUB_URL`。
- `direct enable` 在 linux/musl（Alpine）上仍是 unsupported skip/0；glibc 节点失败会非零退出，不再被 init 静默吃掉（init 仍不中止）。
