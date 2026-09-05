# T12 结果 — Linux 托管安装自动写入 systemd `DefaultOOMPolicy=continue`

真因（EX4 第三轮取证）：tmux ≥ 3.6 为每个 pane 建 `tmux-spawn-<uuid>.scope`，systemd 用户管理器默认 `DefaultOOMPolicy=stop` 会在内核 OOM 杀掉 scope 内任意进程后停掉整个 scope，shell 随之退出、tmux 窗口消失。本任务把 jiefa-app 上手工验证过的修法固化进产品：1.1.34 起每台 Linux 托管安装升级时自动落地。

## 1. 新增 `packages/app/src/lib/systemd-oom-policy.ts`

纯函数 + 可注入依赖（`configDir` / `run` / `log` / `warn`），无全局状态。

- `OOM_DROP_IN_CONTENT`：带 5 行英文头注释（解释 tmux scope + OOMPolicy 机制）+ `[Manager]\nDefaultOOMPolicy=continue\n`。
- `systemdOomPolicyPaths(configDir?)` → `{ userConf, dropInDir, dropIn }`，默认 `~/.config/systemd/{user.conf, user.conf.d/tmex-oom.conf}`。
- `declaresDefaultOomPolicy(content)` / `findExplicitOomPolicy(paths)`：扫 `user.conf` 与 `user.conf.d/*.conf`（排除自己那份），正则 `^\s*DefaultOOMPolicy\s*=\s*\S`——**注释行 `#DefaultOOMPolicy=` 不算**（发行版默认 `user.conf` 全是注释）。
- `ensureSystemdOomPolicyDropIn(deps)` → `'written' | 'unchanged' | 'skipped-explicit' | 'failed'`
  1. 用户已显式配置 → 打日志 `[service] DefaultOOMPolicy already set in <path>; leaving systemd OOM policy as is`，**不写**；
  2. 现有内容逐字节相同 → `unchanged`，不写不重载（幂等）；
  3. 否则 `ensureDir` + 原子写（复用 `writeText`），日志 `[service] wrote <path> (DefaultOOMPolicy=continue)`；
  4. 然后 `systemctl --user daemon-reexec`（10 s 超时），失败退回 `daemon-reload` 并告警，两者都失败只打一行告警说明「下次登录或 daemon-reexec 后生效」。
  - **任何异常都被吞掉并降级为 `[service] could not write …` 告警**，绝不抛出。
- `removeSystemdOomPolicyDropIn(deps)` → `'removed' | 'kept-modified' | 'absent' | 'failed'`：只在文件与 `OOM_DROP_IN_CONTENT` 逐字节相同时删除并重载；用户改过就保留并打日志。
- 自检核心（纯函数）：`parseDefaultOomPolicy`（兼容 `DefaultOOMPolicy=stop` 与裸值，大小写归一）、`parseTmuxVersion`（`tmux 3.6` / `3.5a` / `next-3.7` / `master`→null）、`tmuxUsesSystemdScopes`（≥ 3.6；**版本未知 → true，按可能受影响处理**）、`shouldWarnAboutOomPolicy(policy, tmuxVersion)`。
- `SYSTEMD_OOM_POLICY_WARNING`：按任务书原文，未做改写。

## 2. 接入 `packages/app/src/lib/service.ts`（仅 systemd 分支，3 行）

- `installSystemdService()`：写完 unit 后、`daemon-reload` 前 `await ensureSystemdOomPolicyDropIn().catch(() => 'failed')`。该函数同时被 `commands/init.ts` 与 `lib/upgrade-apply.ts` 的 `createManagedServiceControl().start()` 调用，**所以每次 `tmex upgrade` 都会跑一遍**。
- `uninstallSystemdService()`：删 unit 后 `await removeSystemdOomPolicyDropIn().catch(() => 'failed')`。
- macOS/launchd 路径与 `buildSystemdServiceContent` 模板完全未动。

## 3. 网关启动自检 `packages/app/src/runtime/service-selfcheck.ts`

新增 `warnOnSystemdOomPolicy(deps)`（保留 T11 的 `warnOnStaleSystemdUnit` 不变）：

- 非 Linux **直接返回，不 spawn 任何进程**；
- `systemctl --user show -p DefaultOOMPolicy`（3 s 超时，try/catch，非 0 退出码按「探测失败」静默）；策略不是 `stop` 就**短路返回，连 `tmux -V` 都不探**；
- 仅当策略为 `stop` 才跑 `tmux -V`，交给纯函数 `shouldWarnAboutOomPolicy` 决策，命中打一行 `SYSTEMD_OOM_POLICY_WARNING`。
- `runtime/server.ts`：`void warnOnSystemdOomPolicy().catch(() => undefined)`——**故意不 await**，避免两次 spawn 的超时拖慢网关启动。

## 4. 文档

- `docs/terminal/2026090601-pane-oom-policy.md`：「处置」重写为「tmex 自动处理（1.1.34 起）」+「需要用户自己做的」两节，写清幂等 / 尊重用户配置 / 不阻断安装 / 卸载规则 / 自检行为，并给出验证命令（`systemctl --user show -p DefaultOOMPolicy`、`systemctl --user show 'tmux-spawn-*.scope' -p OOMPolicy`）。
- `docs/deployment/2026061400-process-survival.md`：新增一节「相关：pane 级 OOM 策略（Linux，1.1.34 起）」，说明它与 `KillMode=process` 是两条不同的杀伤路径，指向终端侧文档。

## 5. 测试

新增 `packages/app/src/lib/systemd-oom-policy.test.ts`（22 项，真实 tmp 目录 + 注入的假 `run`）：

| 分组 | 用例 |
| --- | --- |
| ensure | 全新写入并 `daemon-reexec`；内容相同幂等（0 次重载）；`user.conf` 显式配置跳过；其他 drop-in 显式配置跳过 + 注释行不算配置；目录不可创建（父路径是普通文件 → ENOTDIR）只告警返回 `failed` 且不重载；reexec 失败回退 reload；两次重载都失败只告警仍返回 `written` |
| remove | 逐字节相同才删（并重载）；用户改过保留；文件不存在无操作 |
| 解析 | `parseTmuxVersion` 6 例、`parseDefaultOomPolicy` 5 例 |
| 决策 | `shouldWarnAboutOomPolicy`：stop+3.6 告警、stop+版本未知告警、stop+3.5 不告警、continue/null 不告警 |

`packages/app/src/runtime/service-selfcheck.test.ts` 追加 4 项：非 Linux 零 spawn、Linux+stop+3.6 打固定告警、continue 时安静且不探 tmux、systemctl 探测失败静默。

验证结果：

- `cd packages/app && bun test` → **936 pass / 1 skip / 0 fail**（85 文件；T11 基线 907 pass）
- `cd packages/app && bunx tsc --noEmit -p .` → 0 错误
- `bunx biome check <6 个改动文件>` → clean（格式化过一次，仅限自己的文件）
- 仓库根 `bun scripts/complexity/gate.ts` → `complexity gate ok (1674 files, 14697 functions)`

## 偏差与注意事项

1. **未加任何 i18n key**，全部走英文 `[service] …` 日志（与 T11 的 `SYSTEMD_KILL_MODE_WARNING` 一致），`apps/gateway/src/i18n` 与 `packages/shared` locale 未动。
2. 显式配置检测只看**用户级**文件（`~/.config/systemd/user.conf` 与 `user.conf.d/*.conf`），不读 `/etc/systemd/user.conf` 及其 drop-in。系统级若被管理员设成 `stop`，tmex 的用户级 drop-in 优先级更高会覆盖它——这符合「保护 pane」的目的；若管理员设成别的值，用户级 drop-in 同样覆盖。要放弃覆盖只需在用户级写一行 `DefaultOOMPolicy=`。
3. `daemon-reexec` 在升级流程里发生于服务停止之后、重启之前（`upgrade-apply` 的 `start()` → `installService`），已在 jiefa-app 上手工验证过 reexec 不影响运行中的单元。
4. 首次升级到 1.1.34 时，drop-in 对**已存在的 pane scope** 也会生效（`daemon-reexec` 后 `systemctl --user show 'tmux-spawn-*.scope' -p OOMPolicy` 全为 `continue`），无需重开窗口。
5. 自检为 fire-and-forget，告警行可能出现在启动日志中其他行之后；这是刻意的（避免 spawn 超时阻塞 `Bun.serve`）。
6. scope 外的最小改动：`packages/app/src/runtime/server.ts` 一行调用 + import。
