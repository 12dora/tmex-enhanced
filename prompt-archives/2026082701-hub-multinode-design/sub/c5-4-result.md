# C5-4 结果 — CLI 安全审查修复

## 做了什么

按 `c5-1-review.md` 十条审查落地：Node CLI 不再加载 gateway；鉴权命令走安装版 Bun 的 `runtime/cli-auth.js`；join 只信任 key log 投影、锚点语义、UID 绑定、单事务提交；HTTPS `redirect:error` + 生产禁用 `--insecure-local`；genesis+self-admit 单事务；enroll SIGINT 可退出并按 JSON 形状轮询证书；TOTP 登录；reset 先停服务再擦 registry。

未改 `runtime/**`、`commands/direct.ts`、`hub-runtime.ts`。未碰生产 tmex / 默认 tmux session `tmex`。

## 文件

新增：

| 路径 | 作用 |
|---|---|
| `packages/app/src/cli-auth-entry.ts` | Bun 鉴权入口：`dispatchAuthCli` / `main` |
| `packages/app/src/lib/auth-spawn.ts` | Node 侧解析 bun + `runtime/cli-auth.js` 并 spawn |
| `packages/app/src/lib/hub-client.test.ts` | HTTPS / insecure-local / redeem 重试 |

修改：

| 路径 | 作用 |
|---|---|
| `packages/app/src/index.ts` | 鉴权命令只 spawn Bun；Node 路径无 gateway import |
| `packages/app/src/index.test.ts` | fake bun 转发 argv；node 打包 cli-node 再 spawn |
| `packages/app/src/commands/hub.ts` | join 原子提交、UID、node_certs 比对、user add 拒重名、reset stop→wipe→start |
| `packages/app/src/commands/hub.test.ts` | 重名拒绝；reset 顺序 |
| `packages/app/src/commands/join.test.ts` | 篡改 certs / 伪造 uid / production insecure |
| `packages/app/src/commands/enroll.ts` | SIGINT AbortController、authorizationJson 轮询、TOTP |
| `packages/app/src/commands/enroll.test.ts` | abort / JSON poll / TOTP login / hub nodes poller |
| `packages/app/src/commands/mesh.ts` | `bootstrapUserWithSelfAdmit` |
| `packages/app/src/lib/hub-client.ts` | `redirect:'error'`、生产禁 insecure、redeem 网络重试、totp |
| `packages/app/src/lib/env-file.ts` | temp + rename 写 `app.env` |
| `packages/app/src/lib/install-layout.ts` | `runtimeCliAuthPath` |
| `packages/app/scripts/build-runtime.ts` | 额外打包 `dist/runtime/cli-auth.js` |
| `apps/gateway/src/auth/user-key-service.ts` | 锚点 `verifyChainForJoin`、`commitJoin`、`bootstrapUserWithSelfAdmit` |
| `apps/gateway/src/auth/user-key-service.test.ts` | 锚点 / commitJoin / self-admit |

`bundle-resources.sh` 只拷 fe-dist / drizzle，runtime 由 `deployRuntimeFiles` / `build-artifacts.ts` 整目录复制 `dist/runtime`，**不必改**；`cli-auth.js` 与 `server.js` 同目录即可进 tarball。

## 公开 API

```ts
// packages/app/src/cli-auth-entry.ts
export async function dispatchAuthCli(parsed: ParsedArgs, lang: CliLang): Promise<void>
export async function main(): Promise<void>

// packages/app/src/lib/auth-spawn.ts
export const AUTH_COMMANDS: Set<string>
export type AuthSpawnPlan = { bunBin: string; cliAuthPath: string; argv: string[]; env: NodeJS.ProcessEnv }
export async function resolveAuthSpawnPlan(parsed, argv, deps?): Promise<AuthSpawnPlan>
export async function spawnAuthCli(plan, deps?): Promise<{ code: number; stdout: string; stderr: string }>

// packages/app/src/index.ts
export async function dispatchCli(parsed, lang, options?: { argv?: string[] }): Promise<void>
export async function main(): Promise<void>

// hub-client
export function assertHubJoinUrl(raw: string, insecureLocal?: boolean, nodeEnv?: string): URL
export const REDEEM_NETWORK_RETRY_LIMIT = 3
export async function loginWithRootKey(options: { ..., totp?: { code: string; kTotp: Uint8Array } }): Promise<HubLoginResult>
export type HubAuthMode = { ..., totpEnabled: boolean }
export type HubNodeListItem = { id: string; name?: string; certificate?: string; cert_sig?: string; enrollment_token_id?: string }

// enroll
export function parseEnrollmentAuthorizationJson(json: string): AdmitCandidate | null
export async function pollLocalEnrollmentRedeem(ctx, enrollPk): Promise<AdmitCandidate | null>
export async function pollHubNodesForCertificate(options): Promise<AdmitCandidate | null>

// UserKeyService
async verifyChainForJoin(records, expectedRootPublicKey, expectedHeadHash, options?: { anchorHash?: Uint8Array }): Promise<VerifyChainForJoinResult>
async commitJoin(input: CommitJoinInput): Promise<VerifyChainForJoinResult>
async bootstrapUserWithSelfAdmit(input: { username; password; identity: NodeIdentityKeys; now?: number }): Promise<BootstrapUserResult>

export type CommitJoinInput = {
  records: ApplyKeyLogInput[];
  expectedRootPublicKey: Uint8Array;
  anchorHash: Uint8Array;
  username: string;
  expectedUserId: string;
  identity?: SaveNodeIdentityInput;
  now?: number;
}
```

第三参 `expectedHeadHash` 现为**锚点**（链中必须出现），不再要求等于最终 head。`options.anchorHash` 覆盖第三参。

## 分项

### 1 Runtime split（blocker 2）

Node `index.ts` 对 `hub user *` / `hub join|leave` / `mesh reset-root` / `enroll` 只 `spawnAuthCli`：`<bunBin> <installDir>/runtime/cli-auth.js <argv>`，stdio inherit，env = `process.env` ∪ `app.env`。缺 bundled 文件时回退源码 `cli-auth-entry.ts`。

测试：fake bun 回显 argv；`bun build src/cli-node.ts --target node` + `node wrapper hub user add --help --bun-path fake` 断言转发。

构建：`bun build src/cli-auth-entry.ts --outfile dist/runtime/cli-auth.js --target bun` → **Bundled 220 modules / 0.53 MB**。`bun dist/runtime/cli-auth.js` 无参打印 help。

### 2 Join trust（blocker 3）

删除 `upsertCert` 循环。内存 `verifyKeyLogChain` 得到 admit-node 投影；`node_certs.length > 0` 时逐字段比对（node_id / user_id / cert / sig / authorization / revoked），不一致抛 `node_certs mismatch` 且不 `commitJoin`。

测试：篡改 `certificate` → reject，本地 certs 为空（未被写入）。匹配数组的既有 join 测试仍绿，本地 certs = hub 投影。

### 3 Head anchor（major 3）

`verifyChainForJoin` 回放全链：必须含 `anchorHash`，锚点后禁止 `rotate-root`/`reset-root`（`epoch_changed`），最终 root pk = token root。

测试：enrollment 后再 `set-totp` 仍 join；enrollment 后再 `rotate-root` 拒绝且目标库无用户。

### 4 UID binding（major 4）

证书 UID（mode 仅用于签发）、genesis UID、`redeemed.user.id`、链上 admit-node 的 authorization/certificate UID 必须相等，否则 `join uid mismatch`，不提交。

测试：mode 返回 `forged-uid-from-mode` → reject，无用户/证书。

### 5 Atomic join（major 5）

顺序：解码+内存校验 → `commitJoin`（users/log/certs/`node_identity` 一事务）→ `writeEnvFile`（tmp+rename）→ restart。

`redeemEnrollment` 仅在**读到响应前的网络错误**重试最多 3 次，同一 `{certificate, cert_sig}`；HTTP 4xx（含 `reused`）不重试。

### 6 HTTPS（major 2）

所有 hub fetch `redirect: 'error'`。`--insecure-local` 仅 `nodeEnv !== 'production'`。测试覆盖 production 拒绝 / 非 production 允许 / fetch 带 redirect。

### 7 genesis + self-admit / 拒重名（major 7/8）

`bootstrapUserWithSelfAdmit` 内存生成 genesis+admit，一事务提交。`hub user add` 在派生前拒绝已有 username。`mesh reset-root` 是唯一破坏性路径。

### 8 Enroll（major 1）

SIGINT → `AbortController.abort()`，打印 `confirm in the Nodes page` 并结束等待。Hub 角色默认 poller：`enrollment_tokens.usedAt` + `node_id` 对应 `nodes` 行，从 `authorizationJson.certificate_b64` / `cert_sig_b64` 读证书。非 hub 用同一 poller 形状 + `GET /api/hub/nodes` fetcher。

### 9 TOTP enroll（major 6）

`GET /api/auth/mode` 的 `totpEnabled`；启用则 prompt（`TMEX_TOTP` / `io.totpCode`），`deriveTotpKey(seed, uid, epoch)` 后发 `{code, k_totp}`，随后 `kTotp.fill(0)`。

### 10 hub user reset（major 9）

`stop` → 删 `nodes` + `enrollment_tokens`（**保留 node_certs**）→ `restart`。日志提示失陷节点需 `revoke-node`。测试：stop 时 nodes 仍在，restart 时已空。

## 测试

`cd packages/app && bun test src`：

```
 170 pass
 0 fail
 473 expect() calls
Ran 170 tests across 27 files. [5.67s]
```

基线 151（C5-3）；本任务约 +19。

`cd apps/gateway && bun test src/auth`：

```
 51 pass
 0 fail
 641 expect() calls
Ran 51 tests across 10 files. [3.01s]
```

## tsc / biome / 构建

| | 基线 | 本次 |
|---|---|---|
| `packages/app` | 1（`Cannot find type definition file for 'node'`） | **1**（同条） |
| `apps/gateway` | 23 | **24**（+1 来自 scope 外 `src/mesh/rtc/bulk.test.ts`：`Cannot find module './bulk'`，非本任务文件；`user-key-service.ts/.test.ts` 0 增量） |

biome：上述源文件 `Checked 19 files. No fixes applied.`

`cli-auth.js` 构建见上。未跑完整 `build-runtime.ts`（会重编 `server.js`）；`build-runtime.ts` 已加第二入口，发版时 `bun run build:runtime` 会同时产出 `server.js` + `cli-auth.js`。

## 协调者必须做的 hub 侧补丁（本任务 scope 外）

`apps/gateway/src/hub/hub-runtime.ts`：

**A. `StoredEnrollmentPayload` 扩展并在 redeem 写入证书（无新列）：**

```ts
type StoredEnrollmentPayload = {
  authorization_b64: string;
  entry_node_id: string | null;
  certificate_b64?: string;
  cert_sig_b64?: string;
};
```

`parseStoredEnrollment` 原样保留 `authorization_b64` / `entry_node_id`（忽略未知字段即可）。

在 `handleRedeem` 事务内 `consumeEnrollmentToken` 成功后，把证书写回同一行 JSON（需 drizzle `enrollmentTokens` + `eq`，UserStore 现无 update JSON 方法）：

```ts
const consumed = store.consumeEnrollmentToken(certificate.enroll_pk, { nodeId: hexId, now });
if (!consumed) throw new RedeemAbort('reused', 400);
tx.update(enrollmentTokens)
  .set({
    authorizationJson: JSON.stringify({
      authorization_b64: stored.authorization_b64,
      entry_node_id: stored.entry_node_id,
      certificate_b64: encodeBase64url(certBytes),
      cert_sig_b64: encodeBase64url(certSig),
    }),
  })
  .where(eq(enrollmentTokens.id, fresh.id))
  .run();
store.createNode({ id: hexId, userId: fresh.userId, name, status: 'enrolled', version: version || null, now });
```

**B. 幂等 reused（配合 CLI 网络重试）：** 若 `fresh.usedAt !== null` 且请求 cert 与已存 `certificate_b64`/`cert_sig_b64` 一致，不要 400 `reused`，直接返回与首次 redeem 相同的 `{user, user_key_log, node_certs}`。cert 不一致仍 `reused`。

**C. `GET /api/hub/nodes` 增加 `certificate` / `cert_sig`（及可选 `enrollment_token_id`）：**

```ts
private handleListNodes(auth: HubAuthResult): Response {
  const nodes = this.userStore.listNodes()
    .filter((n) => n.userId === auth.userId)
    .map((n) => {
      const tokenRow = this.db.select().from(enrollmentTokens)
        .where(eq(enrollmentTokens.nodeId, n.id)).get();
      const stored = tokenRow ? parseStoredEnrollment(tokenRow.authorizationJson) : null;
      return {
        id: n.id,
        name: n.name,
        status: n.status,
        online: Boolean(this.registry.get(n.id)?.authenticated),
        version: n.version,
        last_seen_at: n.lastSeenAt,
        direct_capable: n.directCapable,
        certificate: stored?.certificate_b64,
        cert_sig: stored?.cert_sig_b64,
        enrollment_token_id: tokenRow?.id,
      };
    });
  return json({ nodes });
}
```

CLI 已按该形状 poll；未补 C 前非 hub `enroll` 等待只能靠 Nodes 页。

**D. 可选：** UserStore 增加 `updateEnrollmentAuthorizationJson(id, json)`，避免 hub-runtime 直接打表。

## 未能做的

- 未改 `hub-runtime.ts`（明确 out of scope）；无 A/C 时 hub 机 `enroll` 默认 poller 在真实 redeem 后拿不到证书（测试用 `fakeLocalRedeem` 已写 JSON）。
- 未改 reused 为幂等返回 payload（B）；网络中断发生在 token 已消耗、响应未读完时，重试会得到 HTTP 400 `reused` 而非 join 材料。
- gateway tsc 24 的额外 1 条在 `src/mesh/rtc/bulk.test.ts`，属其他 agent。

未 `bun install`。未 commit。
