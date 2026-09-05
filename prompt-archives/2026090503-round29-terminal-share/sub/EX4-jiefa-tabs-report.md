# EX4 — jiefa-app 的 tab 被自动关闭（Opus explore，2026-09-06，节选）

用户现象：**单个 tab 消失且里面的 claude/codex 进程也没了**（非整体清空、非 UI 假象）；时机不确定。

## 证据边界
- jiefa-app node id `6b07817ba725bb2f7e9ef9e63333b553`，端点 `ws://10.110.88.3:39001/peer` / `ws://100.75.213.124:39001/peer`，**版本 1.1.27**（其余节点 1.1.30，本机 1.1.33）。
- 本机只是入口，浏览器↔jiefa-app 的帧走不透明 mux 流；`inbound_kinds` 只统计本机设备。**远端 tmux 事件在本机日志里不可见**，决定性日志在 jiefa-app 的 `journalctl --user -u tmex`。
- 本机日志证明环境：jiefa-app 的浏览器流 3 天 45 次 failover（全部 `cause=stream_close close_reason=reset from=relay`），直连从未成功（`datachannel open timeout`，端点退避到 32 min）。`2026-09-05T14:01:13` 恢复流的 HELLO 无版本被 fail-closed 拒绝（`canonical-state-v1.1 required … version unknown`）。

## 能销毁窗口的代码（穷举）
`apps/gateway/src/tmux-client/external/session-commands.ts`：`:171 kill-pane`（仅 WS CLOSE_PANE）、`:536 kill-window`（仅 WS CLOSE_WINDOW）、`:503 kill-window`（**自动**：每次控制客户端 (re)attach 建/删 `tmex-park`）。无 kill-session/kill-server。agent 工具、watch、消息机器人不建/删窗口，只写输入。运行时拆卸只杀 `tmux -C attach` 客户端。`remain-on-exit` 从未设置 → tmux 默认：**pane 最后一个进程退出即销毁窗口，无任何 tmex 日志**。

## 假设排序
- **H1（最可能）断线期间缓冲的按键在恢复后原样重放**：`packages/ws-client/src/websocket-transport.ts:275-345`（`enqueueCommand`/`flushPendingCommands`）、`pending-send-queue.ts:54-104`、`canonical-pending-commands.ts:26-34`；转发侧 `mesh/forwarder-failover.ts:279 host.flushQueue(pump)`。用户对着卡住的终端敲的 `exit`/Ctrl-D/`q` 在几秒到几分钟后才落到 pane。另有 agent `send-input`（`terminal-encoding.ts:30-31` ctrl_c/ctrl_d）、`run-command.ts:144,172`、`run-command-spawn.ts:72`、消息 `run.ts:40` 直接往用户 pane 写输入。
- **H2（可能，外因）进程被 OS/systemd 杀**：`packages/app/src/lib/service.ts:59 KillMode=process` 于 2026-06-14（`f2be81e9`）才加入，单元只在安装/升级时重写（`docs/deployment/2026061400-process-survival.md`）；jiefa-app 仍 1.1.27，若单元是旧的，`Restart=always` 崩溃重启会 SIGTERM 整个 cgroup；无 `loginctl enable-linger` 时登出/重启拆整个 user slice；systemd-oomd/OOM。
- **H3** 真实 CLOSE_WINDOW/CLOSE_PANE 帧（前端有确认框，`use-close-dialog.ts:56-63`），卡顿时点击也会被 H1 的队列延迟投递。
- **H4（真缺陷，解释「闪断/被拉走」）`tmex-park` 窗口抖动**：`control-mode-lifecycle.ts:59-71` 每次 `startControlClient()` 都 `createParkingWindow()`（`session-commands.ts:477-496`，`new-window` 无 `-d` → 成为活动窗口）→ ≤3 s 后 `last-window` + `kill-window`；快照从未过滤 `PARKING_WINDOW_NAME`（`external-tmux-core.ts:37` 死导入）；前端跟随活动窗口（`use-pane-active-follow.ts`）会被拉进 park 再被杀。心跳超时 10 s（`control-mode-lifecycle.ts:137-145`）、stdout EOF 都会触发重连。
- **H5（会是整体清空，排除）** tmux 服务重启后 `ensureSession` 建同名空会话（`session-commands.ts:405-424`）；特征日志 `tmux session gone` / `tmux server gone` / `ignoring tmux snapshot with no valid windows`。
- **H6（UI-only，与现象矛盾）** `%window-close` 与 `%unlinked-window-close` 同映射（`control-mode/metadata.ts:56-59`）。
- failover **不会**重建设备会话（`device-session-runtime.ts`、`runtime-registry.ts`、`device-connection-registry.ts` 无 kill-session/new-session -A）。

## 远端只读取证（jiefa-app）
```
tmux ls; tmux list-windows -a -F '#{session_name} #{window_id} #{window_index} #{window_name} #{window_panes}'
tmux show -g remain-on-exit; tmux display -p '#{pid}'
systemctl --user cat tmex | grep -E 'KillMode|Restart|ExecStart'; systemctl --user show tmex -p KillMode -p NRestarts -p ActiveEnterTimestamp
cat /proc/$(tmux display -p '#{pid}')/cgroup; loginctl show-user "$USER" -p Linger
journalctl --user -u tmex --since '3 days ago' | grep -iE 'kill|session gone|server gone|no valid windows|control client|park|Stopped|Started|Main process|run-command|send-input|heartbeat timeout'
journalctl -k --since '3 days ago' | grep -iE 'oom|killed process'; journalctl -u systemd-oomd --since '3 days ago'
tmux ls -F '#{session_name} #{session_created} #{session_windows}'; cat ~/.local/share/tmex/install-meta.json
```

## 修法
1. 断线期间缓冲的**有序终端输入**超过 TTL（3 s）不再重放，改为丢弃并提示；转发侧队列同理。
2. `tmex-park` 从快照与 window 事件里过滤，前端永远看不到。
3. 网关对自己发出的 kill-window/kill-pane 与观察到的 `%window-close` 打带原因/最后命令的日志。
4. Linux 启动时自检 `tmex.service` 是否含 `KillMode=process`，缺失则大声告警；并升级 jiefa-app 脱离 1.1.27。

## 远端取证结果（2026-09-06 00:20，经本机 tmex 网页在 jiefa-app 新建窗口 @45/@46 跑只读命令，产物 ~/tmex-diag*.txt）
- tmux 3.6，服务器 pid 30951 存活 458426 s（5.3 天，在 `tmex.service` cgroup 内，单元 `KillMode=process`、`Restart=always`、`NRestarts=0`、Linger=yes）；session `tmex` 3 窗口（@44 claude / @45 diag / @7 bash），窗口 id 已到 @46 → 5 天里建过 40+ 个窗口。`remain-on-exit off`、`destroy-unattached off`、`detach-on-destroy on`。
- **7 天 `[ws-metrics] inbound_kinds` 从未出现 0204/0205（CLOSE_WINDOW/CLOSE_PANE）**，journal 无 kill-window/kill-pane/park/session gone 记录 → 窗口不是 tmex 关的，是 pane 的 shell 自己退出。
- `TMOUT` 未设置；logind 无 KillUserProcesses。
- 内核 OOM 14 天 3 次：09-04 12:23 tsgo 10.9 GB、09-04 15:19 tsgo 10.0 GB（docker cgroup）、09-05 23:41 由 `tmux: server` 触发、杀 `next-server` 12.5 GB（memcg `app.slice/tmux-spawn-<uuid>.scope`，tmux 3.6 每 pane 一个 scope）。OOM 只杀 pane 内大进程，shell 存活。
- 主机：23.5 GB 内存已用 15.4 GB + swap 4.4 GB，load 10.3/14.0/13.3，next-server 8.6 GB、tsc、pytest、playwright、cursor-agent、claude 并跑。
- 结论：单窗口消失 = bash 收到 Ctrl-D/`exit` 退出；在高负载 + 3 天 45 次 failover 的环境下，断线期间缓冲的按键迟到重放（H1）是最一致的解释；OOM 是叠加因素（claude/codex 被杀后 bash 空闲，后续 Ctrl-D 直接关窗）。修法：T11（过期输入丢弃 + 提示、park 窗口过滤、销毁日志、单元自检）；建议升级 jiefa-app 脱离 1.1.27，并给主机减负/加内存。

## 第三轮取证（2026-09-06 00:30，窗口 @47）——真因确定
- 所有 pane scope `memory.oom.group=0`、`memory.max=max`；systemd-oomd 未安装（inactive）；TMOUT 未设。
- **systemd 用户管理器的 scope 生命周期日志**（`journalctl --user | grep tmux-spawn`）给出了每次 pane 死亡的精确时间与原因：
  - 09-04 12:23:14 `tmux-spawn-2b35853c.scope: The kernel OOM killer killed some processes in this unit.` → 12:23:24 `Failed with result 'oom-kill'`，`Consumed … 18.3G memory peak, 3.4G memory swap`
  - 09-04 15:19:21 `tmux-spawn-31aea67c.scope` 同上 → 15:19:24 oom-kill，`19.1G memory peak`（该 pane 13:24 才创建）
  - 09-05 23:41:52 `tmux-spawn-1e9aa3bc.scope` 同上 → 23:43:22 `Stopping timed out. Killing process 951751 (docker) with signal SIGKILL` → `Failed with result 'oom-kill'`，`15.2G memory peak`
- 机制：内核 OOM 只杀 pane 内最大的进程（tsgo 10.9/10.0 GB、next-server 12.5 GB），但 systemd 对 scope 的默认 `OOMPolicy=stop`（`DefaultOOMPolicy=stop`）会在检测到单元内发生 OOM 击杀后**停止整个 scope**：向 pane 内全部进程（bash、claude、docker…）发 SIGTERM，超时 SIGKILL。shell 退出 → tmux `remain-on-exit off` 销毁窗口。tmex 未发送任何关闭命令、未杀任何进程。
- 7 天内 `Started tmux-spawn` 48 次；非 OOM 的 pane 结束（09-03 09:37 / 16:29 / 20:32）无异常记录，应为用户正常关闭。
- 处置建议（jiefa-app 本机）：`~/.config/systemd/user.conf.d/oom.conf` 写 `[Manager]\nDefaultOOMPolicy=continue` 后 `systemctl --user daemon-reexec`（新建的 pane 生效），这样 OOM 只杀超限的那个子进程、pane 与 claude 存活；同时限制 tsgo/tsc/next 的内存（`NODE_OPTIONS=--max-old-space-size`）或加内存/减并发。tmex 侧：T11 增加窗口销毁日志；可选后续：tmex 会话 `remain-on-exit on` + 「进程已退出/重开」UI，让死掉的 pane 留在 tab 里而不是消失。
