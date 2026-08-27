# C5-1 结果 — CLI hub/mesh/enroll/init --role / app.env

## 做了什么

在 `packages/app` 落地嵌套命令分派、密码隐藏输入、本机 DB 直连鉴权命令、join/enroll HTTP 客户端、`init --role` 与 upgrade 只补缺失 `app.env` 键。未改 `apps/gateway` / `packages/shared` / `runtime/server.ts` / `cli-node.ts`。

`direct enable|disable` **未实现**：C5-2 已有 `commands/direct.ts` `runDirect`，本任务只在 `index.ts` 做动态 import 分派。

## 文件清单

新增：

| 文件 | 作用 |
|---|---|
| `src/index.ts` | `dispatchCli` / `main`（auth 命令先 `loadInstallEnv` 再动态 import，避免 `config.ts` 捕获空 `TMEX_MASTER_KEY`） |
| `src/cli/help.ts` | 新命令 help（en / zh-CN） |
| `src/lib/roles.ts` | `standalone \| node \| hub,node` |
| `src/lib/duration.ts` | `--ttl 10m` |
| `src/lib/password.ts` | TTY / `TMEX_PASSWORD` |
| `src/lib/totp-uri.ts` | otpauth URI + 根公钥指纹 |
| `src/lib/local-auth.ts` | 打开本机库、跑迁移、组装 stores |
| `src/lib/hub-client.ts` | join URL 校验、mode/challenge/login、enrollments create/redeem |
| `src/lib/test-master-key.ts` | 测试用 master key 占位 |
| `src/commands/hub.ts` | `hub user add\|passwd\|totp\|reset`、`hub join\|leave` |
| `src/commands/mesh.ts` | `mesh reset-root` |
| `src/commands/enroll.ts` | `enroll` |
| `src/commands/*.test.ts` + `lib/duration.test.ts` | 单测 |

修改：`lib/args.ts`（nested resolve）、`lib/env-file.ts`（merge missing）、`lib/install.ts`（新 env 键）、`lib/install-layout.ts`（`nativeDir`）、`lib/prompt.ts`（hidden password）、`lib/service.ts`（`restartService`）、`commands/init.ts`（`--role`）、`commands/upgrade.ts`（只追加缺失键）。

## 命令与 flags

| 命令 | flags / 位置参 |
|---|---|
| `hub user add <username>` | 密码确认 |
| `hub user passwd <username>` | 旧密码 + 新密码确认 |
| `hub user totp <username>` | 密码；打印 otpauth URI（无 ASCII QR，仓库无依赖） |
| `hub user reset` | 清空 `nodes` + `enrollment_tokens` |
| `hub join <https-url> --token <t> [--name] [--insecure-local]` | 仅 `https:`；`http://127.0.0.1\|localhost` 需 `--insecure-local` |
| `hub leave` | 清 `node_identity.hub_url`，`TMEX_ROLES=standalone`，重启 |
| `mesh reset-root` | standalone 拒绝；`bootstrapUser` 保 username 后自签 `admit-node` |
| `enroll [--ttl 10m]` | hub 机写本地 token；非 hub POST hub + login |
| `direct enable\|disable` | 分派到 C5-2 `runDirect` |
| `init --role standalone\|node\|hub,node` | `--hub-url` `--hub-public-url` `--peer-port` `--stun-servers`；非交互 `hub,node` 必填 `--hub-public-url` |

全局仍支持 `--install-dir`、`--lang`。

非 TTY 密码：`TMEX_PASSWORD`；`passwd` 旧密码 `TMEX_PASSWORD_OLD`。NFKC 由 `deriveSeed` 处理。

## 公开 API

```ts
parseArgs(argv: string[]): ParsedArgs
resolveNestedCommand(parsed: ParsedArgs): { name: NestedCommandName; rest: string[]; raw: string | null }
cliHelpText(lang: CliLang): string
dispatchCli(parsed: ParsedArgs, lang: CliLang): Promise<void>
main(): Promise<void>

parseTmexRoleName(raw?: string): 'standalone' | 'node' | 'hub,node'
parseTmexRoles(raw?: string): { hub: boolean; node: boolean }
parseDurationMs(input: string, fallbackUnit?: string): number
promptPassword(message, { envKey?, confirm?, confirmMessage? }): Promise<string>
restartService(serviceName: string, installDir?: string): Promise<void>
mergeMissingKeys(existing, defaults): { next; added: string[] }
mergeMissingEnvFileKeys(filePath, defaults): Promise<string[]>
hubEnvDefaults(input?): Record<string, string>
buildAppEnvValues(input: AppEnvInput): Record<string, string>  // 增 role/hubUrl/peerPort/hubPublicUrl/stunServers
createInstallLayout(...): InstallLayout  // 增 nativeDir

openLocalAuth({ databaseUrl?, migrationsFolder?, env?, memory? }): Promise<LocalAuthContext>
openInstallAuth(parsed?): Promise<LocalAuthContext>
loadInstallEnv(parsed?): Promise<{ installDir; envPath; env }>

assertHubJoinUrl(raw: string, insecureLocal?: boolean): URL
fetchAuthMode(baseUrl, fetcher?): Promise<HubAuthMode>
loginWithRootKey({ baseUrl, rootKey, uid, fetcher? }): Promise<HubLoginResult>
postEnrollment({ baseUrl, cookieHeader, enrollPk, authorization, authorizationSig, exp, fetcher? })
redeemEnrollment({ baseUrl, certificate, certSig, name?, version?, fetcher? }): Promise<RedeemResponse>
listHubNodes({ baseUrl, cookieHeader, fetcher? })

runHubUserAdd(parsed, username, io?): Promise<{ userId; fingerprint; rootEpoch }>
runHubUserPasswd(parsed, username, io?): Promise<{ rootEpoch }>
runHubUserTotp(parsed, username, io?): Promise<{ uri; secret }>
runHubUserReset(parsed, io?): Promise<{ wiped }>
runHubJoin(parsed, url, io?): Promise<{ userId; hubUrl }>
runHubLeave(parsed, io?): Promise<void>
runMeshResetRoot(parsed, io?): Promise<{ userId; rootEpoch; fingerprint }>
runEnroll(parsed, io?): Promise<{ token; joinCommand; admitted }>
fakeLocalRedeem(ctx, { enrollPk, certificateBytes, certSig, name? }): Promise<void>
```

`HubIo`：`password` / `oldPassword` / `newPassword` / `auth` / `skipRestart` / `restart` / `fetcher` / `log`。测试注入 memory DB，不碰生产 9883。

## app.env 键

`buildAppEnvValues` / `hubEnvDefaults` 写入：

- `TMEX_ROLES` 默认 `standalone`
- `TMEX_HUB_URL` 允许空
- `TMEX_PEER_PORT` 默认 `39001`
- `TMEX_HUB_PUBLIC_URL` 允许空（hub 角色 init 会 prompt / 非交互必填）
- `TMEX_STUN_SERVERS` 默认 `stun:stun.l.google.com:19302`

`upgrade --apply-current-package`：保留已有 `app.env`，只 append 缺失键。`run.sh` 未改。

## 行为要点 / workaround

1. **本机 DB**：memory 测试走 gateway `createMigratedAuthDb()`（drizzle 从 gateway 解析）；生产走 `loadInstallEnv` → 设 env → `runMigrations` + `getDb()`。doctor/upgrade **没有**「服务在跑就拒绝」守卫，CLI 同样不拒绝。
2. **`hub user add`**：`bootstrapUser` → `ensureNodeIdentity` → `selfSignedNodeCertificate` → `signAndApply('admit-node')`，打印 sha256(hex) 指纹。
3. **`passwd`**：旧根钥验 `users.root_public_key`，旧钥签 `rotate-root`。
4. **`enroll` hub 路径 (a)**：直写 `enrollment_tokens`。等待 redeem 后 `signAndApply(admit-node)`。hub-runtime redeem **不落证书**，CLI 用进程内 mailbox（`fakeLocalRedeem` / `noteRedeemedCertificate`）。生产 redeem 后 CLI 拿不到 cert → 等到 SIGINT 打印 `confirm in the Nodes page`。
5. **`enroll` 非 hub (b)**：`hub-client.loginWithRootKey` 打 `TMEX_HUB_URL` 的 `/api/auth/challenge|login`（cookie `tmex_s_self` + `tmex_s_<nodeId>`），再 `POST /api/hub/enrollments`。远程 wait 默认无 cert poller，同样靠 Nodes 页确认。
6. **`hub join`**：`GET /api/auth/mode` 取 uid → 证书 → redeem → `verifyChainForJoin` → upsert `node_certs` → 写 `TMEX_HUB_URL` / `TMEX_ROLES=node`（已是 `hub,node` 则保留）→ `node_identity.hub_url` → `restartService`。
7. 无 QR 依赖，TOTP 只打 URI。

## 测试

`cd packages/app && bun test src`：

```
 140 pass
 0 fail
 375 expect() calls
Ran 140 tests across 23 files. [3.34s]
```

基线 90；本任务新增 nested args/help、env merge、hub user 四条、mesh reset-root、enroll (a)、join（https 拒绝 / 假 hub 链校验 / root mismatch / leave）。其余增量来自并发 C5-2/B2-3。

覆盖的本任务文件 biome：`Checked 28 files. No fixes applied.`

## tsc

| | 数量 |
|---|---|
| 基线 `packages/app` | 1（`Cannot find type definition file for 'node'`） |
| 本次 | **1**（同条，新文件 0 增量） |

## 协调者必须接线

1. **`packages/app/src/cli-node.ts`** 改为 `export { main } from './index'`（或调用 `dispatchCli`）。现在入口仍只有 init/doctor/upgrade/uninstall。auth 命令必须先 `loadInstallEnv` 再 import gateway `config`/`crypto`，否则 `TMEX_MASTER_KEY` 被钉成 undefined，identity 用全零钥加密，runtime 解不开。
2. **`packages/app/src/i18n/index.ts` `cli.help`** 仍是旧四条命令；新 help 在 `cli/help.ts`。若继续走 `t('cli.help')` 需同步。
3. **`packages/app/src/types.ts` `InitConfig`** 未改；role 等字段在 `commands/init.ts` 本地扩展。可并入共享类型。
4. **hub redeem 证书回传**：要让 CLI `enroll` 自动 admit，需在 redeem 后把 `{certificate, cert_sig}` 留给本机（表或文件）。当前只有测试 mailbox。
5. **C5-2 `commands/direct.ts` 已存在**，`index.ts` 动态 `runDirect`；`InstallLayout.nativeDir` 已加。
6. **`getDb()` 是进程单例**。CLI 短进程可接受；不要在同一进程对多个 DATABASE_URL 调 `openLocalAuth({ memory: false })`。

未碰生产 tmex / 默认 tmux session `tmex` / `bun install`。
