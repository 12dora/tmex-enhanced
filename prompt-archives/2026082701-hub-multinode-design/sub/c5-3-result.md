# C5-3 结果 — CLI 接线（C5-1 / C5-2 leftover）

## 做了什么

把 C5-1/C5-2 留下的 CLI 入口、help 真源、`InitConfig`、init/upgrade native 钩子、`run.sh` `TMEX_NATIVE_DIR`、`hub join` 防火墙提示接到 `packages/app/src`。未改 `runtime/**`、`commands/direct.ts`、gateway/shared。未碰生产 tmex / 默认 tmux session `tmex`。

## 文件

新增：

| 路径 | 作用 |
|---|---|
| `src/index.test.ts` | `cli-node` 委托 `main`；子进程 `dispatchCli` 先 `loadInstallEnv` 再评估 gateway `config` |
| `src/commands/init.test.ts` | `enableDirectAfterInit` fake（无网络） |
| `src/commands/upgrade.test.ts` | `reenableDirectAfterUpgrade` fake（无网络） |

修改：

| 路径 | 作用 |
|---|---|
| `src/cli-node.ts` | `export { main } from './index'`（仍是 `build:cli` 入口） |
| `src/index.ts` | help 走 `t('cli.help')`；`dispatchCli` 内 `setLang` |
| `src/types.ts` | `InitConfig` 增加 role / hub 字段 |
| `src/i18n/index.ts` | 删除旧 `cli.help`；`t('cli.help')` → `cliHelpText` |
| `src/i18n/index.test.ts` | en/zh-CN 与 `cliHelpText` 同源 |
| `src/commands/init.ts` | 部署 runtime 后 `enableDirectAfterInit`（非致命） |
| `src/commands/upgrade.ts` | `deployRuntimeFiles` 后 `reenableDirectAfterUpgrade`（非致命） |
| `src/commands/hub.ts` | join 打印 LAN 防火墙 + 实际 `TMEX_PEER_PORT` |
| `src/commands/join.test.ts` | 断言 firewall 提醒 |
| `src/lib/install.ts` | `writeRunScript` 导出 `TMEX_NATIVE_DIR` |
| `src/lib/install.test.ts` | native dir 引号 |

## 公开 API

```ts
// src/cli-node.ts / src/index.ts
export async function main(): Promise<void>
export async function dispatchCli(parsed: ParsedArgs, lang: CliLang): Promise<void>

// src/types.ts
export interface InitConfig {
  installDir: string;
  host: string;
  port: number;
  databasePath: string;
  autostart: boolean;
  serviceName: string;
  force: boolean;
  nonInteractive: boolean;
  installDeps: boolean;
  skipDepCheck: boolean;
  role: TmexRoleName;          // 'standalone' | 'node' | 'hub,node'
  hubUrl: string;
  hubPublicUrl: string;
  peerPort: number;
  stunServers: string;
}

// src/commands/init.ts
export async function enableDirectAfterInit(
  config: Pick<InitConfig, 'role' | 'installDir'>,
  deps?: {
    enableDirect?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
    log?: (message: string) => void;
  }
): Promise<void>
export type { InitConfig }

// src/commands/upgrade.ts
export async function reenableDirectAfterUpgrade(
  installDir: string,
  deps?: {
    reenableDirectIfNeeded?: (options: EnableDirectOptions) => Promise<DirectEnableResult>;
    log?: (message: string) => void;
  }
): Promise<void>

// src/i18n
t('cli.help') === cliHelpText(currentLang)
```

接线行为：

- auth 命令：`loadInstallEnv` → 动态 `import('./commands/hub'|mesh|enroll)`，避免 gateway `config.masterKey` 钉成 `undefined`。
- `runInit`：`deployRuntimeFiles` 之后，`shouldEnableDirectForRoles(role)` 为真才 `enableDirect`；失败只打日志。
- `runUpgrade`：`deployRuntimeFiles` 之后 `reenableDirectIfNeeded`；standalone 无 `native/` 会 skip。
- `writeRunScript`：`export TMEX_NATIVE_DIR=<installDir>/native`（POSIX 单引号）。
- `hub join`：`allow inbound TMEX_PEER_PORT (<port>) on the LAN firewall for direct links`。

## 测试

`cd packages/app && bun test src`：

```
 151 pass
 0 fail
 399 expect() calls
Ran 151 tests across 26 files. [3.51s]
```

基线 140；本任务 +11（cli-node 委托、dispatchCli 子进程 master key、enableDirect 四条、reenable 三条、cli.help 同源）。`index.test.ts` 子进程 unset `TMEX_MASTER_KEY`/`DATABASE_URL`，临时 `app.env` 含已知 master key；`dispatchCli(['hub','user','add','alice', ...])` 后 `config.masterKey` / `config.databaseUrl` 等于 install env，且 `dispatchError === null`。

## tsc

| | 数量 |
|---|---|
| 基线 `packages/app` | 1（`Cannot find type definition file for 'node'`） |
| 本次 | **1**（同条，新文件 0 增量） |

## biome / build:cli

- 上述源文件：`Checked 14 files. No fixes applied.`
- `bun build src/cli-node.ts --outfile /tmp/tmex-c53-cli-node.js --target node --format esm`：**Bundled 244 modules**，`export { main }` 仍在产物末尾（0.81 MB）。未写入 `packages/app/dist/`。

## 未能做的 / 协调者

无阻塞缺口。本任务范围内已接完 C5-1 items 1–3 与 C5-2 的 init/upgrade/`run.sh` 钩子。

协调者无需改 scope 外文件。若其他 agent 同时改 `index.ts` / `init.ts` / `upgrade.ts`，合并时保留：

1. `cli-node.ts` 只 re-export `main`
2. auth 先 `loadInstallEnv` 再动态 import hub
3. `deployRuntimeFiles` 后的 `enableDirectAfterInit` / `reenableDirectAfterUpgrade`
4. `t('cli.help')` 走 `cliHelpText`

C5-1 仍未做（不在本任务）：hub redeem 证书回传、`getDb()` 进程单例说明。
