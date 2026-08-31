# hub-ops —— 经 tmex Hub API 运维远端机器

没有 SSH 通道时，用 Hub 自己的 HTTP + WebSocket 接口（与浏览器完全等价）在 mesh 里的任意
node 上列设备、在 tmux pane 里跑命令、上传文件。

- 脚本：`hub-ops.ts`（Bun，单文件）
- 运行时依赖仓库源码里的 `packages/shared/src/auth` 与 `packages/shared/src/ws-borsh`，
  用 `TMEX_SRC` 指向任一 tmex 工作区根目录（默认 `/Users/konata/code/tmex-enhanced-wt-r9`）。
- 口令只从环境变量 `HUB_PASSWORD` 读取，**只驻留内存**：不写文件、不打印、不进日志。
  会话 cookie（`tmex_s_self` / `tmex_s_<nodeId>`）同样只在进程内的 cookie jar 里。

## 用法

```
HUB_PASSWORD=... bun hub-ops.ts <子命令> [参数]

  nodes
  devices    [--node <nodeId|self>]
  run        [--node <nodeId|self>] --device <id> --cmd '<单行 shell>'
             （二选一）--pane <%N> [--window <@N>]
                       --new-window [--window-name <名字>] [--cwd </abs/dir>]
             [--timeout 60]
  roots      [--node <nodeId|self>]
  root-add   [--node ...] --device <id> --dir </abs/path>
  upload     [--node ...] --root <rootId> [--path <目标目录>] [--name <文件名>] --file <本地文件>
```

环境变量：`HUB_PASSWORD`（必需）、`HUB_BASE`（默认 `https://ai.jiefakj.com:18443`）、`TMEX_SRC`。

`run` 的退出码就是远端命令的退出码；超时退 124；任何鉴权/协议错误退 1 并打印原因。

## 实现要点（踩过的坑）

1. **`TMUX_SELECT` 必须同时带 `windowId` 和 `paneId`。**
   `apps/gateway/src/ws/tmux-command-handlers.ts` 里 `if (!windowId || !paneId) return;` ——
   只给 paneId 会被**静默丢弃**，没有 ACK 也没有 ERROR，客户端只会干等到超时。
   （`scripts/hub-e2e/driver/terminal.ts` 就踩了这个坑，它的 select 实际是空操作。）
   本脚本用 `GET /api/tmux/tree` 或 `STATE_SNAPSHOT` 反查 windowId。
2. **pane 不在服务端快照里时 `TMUX_SELECT` 同样被静默丢弃**，所以拿到 `SWITCH_ACK` 之前
   每 1.5s 重发一次 select。
3. **只在 `LIVE_RESUME` 之后才发输入**：切换屏障解除前的 output 会被网关缓冲，
   在此之后收到的 `TERM_OUTPUT` 才保证是本次命令产生的。
4. **命令必须压成一行**。多行输入会被 shell 分两次回显，回显文本会混进采集结果。
   命令被包成
   `printf 'BEG%s_%s\n' 'IN' <nonce>; <cmd>; __hub_rc=$?; printf 'DON%s_%s_%s\n' 'E' <nonce> "$__hub_rc"`
   ——标记串被 `%s` 拆开，所以 shell 回显那一行**不含**完整标记，只有真正执行的输出才含
   `BEGIN_<nonce>` / `DONE_<nonce>_<rc>`；两个标记之间即为命令输出，`rc` 即退出码。
5. **解析 `TERM_OUTPUT`（live），不解析 `TERM_HISTORY`。** history 来自 `capture-pane`，
   按 pane 宽度硬换行；live 是原始 pty 字节流，不会插入换行，适合逐行解析。
6. **`CHUNK`（0x0501）要重组**：超过帧上限的 `STATE_SNAPSHOT`/`TERM_OUTPUT` 会被分片下发，
   用 shared 的 `ChunkReassembler`。
7. **远端 node 登录的 `entry` 必须是 hub 的真实 `nodeId`**（`/api/auth/mode` 的 `nodeId`），
   不能用哨兵 `'self'`，否则 `ENTRY_MISMATCH`；本机入口才用 `'self'`。
   challenge 一次性、60s 过期，每个 node 要各自 challenge + login。
   后续请求把 `tmex_s_self` 和 `tmex_s_<nodeId>` 一起放在同一个 `Cookie` 头里。
8. **WS 鉴权失败不是 HTTP 401**，而是先升级再用 **close code 4401** 关掉。
9. **`isComposing: true` 的 `TERM_INPUT` 会被服务端丢弃**，必须传 `false`。
10. **上传分片必须严格顺序**：`?offset=` 必须等于服务端已收字节数，否则 409；
    `commit` 是 **NDJSON 流**，错误藏在 200 响应体里的 `{type:'error'}` 事件中，
    **没有 `done` 事件就是失败**，不能只看 HTTP 状态码。
11. **没有创建 tmux window 的 HTTP 接口**，只有 WS 的 `TMUX_CREATE_WINDOW`（0x0203）。
    `--new-window` 就是走它（浏览器「新建窗口」按钮同款），跑完再发 `TMUX_CLOSE_WINDOW`
    自动清理，适用于目标机所有 pane 都被交互式程序占用的情况。

## 已验证的命令与输出（2026-08-31，真实 Hub `https://ai.jiefakj.com:18443`）

### nodes

```
$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts nodes
hub: https://ai.jiefakj.com:18443  nodeId=ec42f36455c164117088e7b786c56425  uid=b3bcd19c-c3e7-4fae-8ed5-95f51f24c5ec
ID                                NAME          VERSION  ONLINE REACH  TRANSPORT  LOGGEDIN HUB STATUS
ec42f36455c164117088e7b786c56425  tmex          1.0.2    true   -      -          true     yes enrolled
668842108e0cfaca88bbcf93f99e26d3  konata-mac    1.1.3    true   lan    ws-secure  false    -   enrolled
8a8109284f77c9859d2af029c6e5b4b5  docker-node   1.0.2    true   -      -          false    -   enrolled
6b07817ba725bb2f7e9ef9e63333b553  jiefa-app     1.1.3    true   -      -          false    -   enrolled
9ccf8a4f92c3049e956bfba829b4f734  jiefa-dns-1   1.1.3    true   -      -          false    -   enrolled
```

### devices --node self（Hub 本机）

```
$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts devices --node self
device bf1c1f53-df4f-4250-9678-0e383875a882  name=s0522  type=local  session=tmex  tmuxAvailable=true  lastSeenAt=2026-08-29T10:03:25.732Z
  session $0 "tmex"
    window @0 index=0 name="bash" *active
      pane %0 index=0 120x40 cmd=bash path=/root *active
```

### devices --node jiefa-app（先自动完成该 node 的登录）

```
$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts devices --node 6b07817ba725bb2f7e9ef9e63333b553
device caf1df1f-48bf-45ad-a682-748b3dd3f15e  name=jiefa-app  type=local  session=tmex  tmuxAvailable=true  lastSeenAt=2026-08-31T09:22:21.850Z
  session $0 "tmex"
    window @0 index=0 name="codex"
      pane %0 index=0 131x45 cmd=codex path=/home/ubuntu *active
    window @3 index=1 name="codex"
      pane %3 index=0 131x45 cmd=codex path=/home/ubuntu *active
    window @4 index=2 name="grok"
      pane %4 index=0 131x45 cmd=grok path=/home/ubuntu *active
    window @5 index=3 name="grok"
      pane %5 index=0 131x45 cmd=grok path=/home/ubuntu *active
    window @6 index=4 name="grok" *active
      pane %6 index=0 131x45 cmd=grok path=/home/ubuntu *active
    window @7 index=5 name="grok"
      pane %7 index=0 131x45 cmd=grok path=/home/ubuntu *active
    window @8 index=6 name="top"
      pane %8 index=0 131x45 cmd=top path=/home/ubuntu *active
```

> jiefa-app 上**没有空闲 shell**，7 个 pane 全被 codex / grok / top 占着，
> 因此对它一律用 `--new-window`，不要往这些 pane 里注入命令。

### run —— Hub 本机（既有空闲 pane `%0`）

```
$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts run --node self \
    --device bf1c1f53-df4f-4250-9678-0e383875a882 --pane '%0' \
    --cmd 'uname -a; whoami; echo ---; cat /root/tmex-hub/install/install-meta.json; echo ---; ls -la /root/tmex-hub/install' \
    --timeout 45
Linux s0522 7.0.0-15-generic #15-Ubuntu SMP PREEMPT_DYNAMIC Wed Apr 22 16:06:43 UTC 2026 x86_64 GNU/Linux
root
---
{
  "serviceName": "tmex",
  "platform": "linux",
  "autostart": true,
  "installDir": "/root/tmex-hub/install",
  "updatedAt": "2026-08-29T10:03:25.072Z",
  "cliVersion": "1.0.2",
  "bunPath": "/root/.bun/bin/bun"
}
---
total 36
drwxr-xr-x 6 root root 4096 Aug 29 10:03 .
drwxr-xr-x 6 root root 4096 Aug 29 10:02 ..
-rw------- 1 root root  382 Aug 29 04:14 app.env
drwxr-xr-x 2 root root 4096 Aug 29 04:12 data
-rw------- 1 root root  217 Aug 29 10:03 install-meta.json
drwxr-xr-x 2 root root 4096 Aug 29 04:14 native
drwxr-xr-x 4 root root 4096 Aug 29 10:03 resources
-rwxr-xr-x 1 root root  782 Aug 29 10:03 run.sh
drwxr-xr-x 3 root root 4096 Aug 29 10:03 runtime
--- exit code: 0 (window @0 pane %0) ---
```

### run --new-window —— jiefa-app

```
$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts run --node 6b07817ba725bb2f7e9ef9e63333b553 \
    --device caf1df1f-48bf-45ad-a682-748b3dd3f15e --new-window \
    --cmd 'uname -a; id -un; echo ---; cat ~/.local/share/tmex/install-meta.json 2>/dev/null || find / -maxdepth 4 -name install-meta.json 2>/dev/null | head' \
    --timeout 60
Linux jiefa-app 7.0.0-30-generic #30-Ubuntu SMP PREEMPT_DYNAMIC Fri Jul 31 18:22:54 UTC 2026 x86_64 GNU/Linux
ubuntu
---
{
  "serviceName": "tmex",
  "platform": "linux",
  "autostart": true,
  "installDir": "/home/ubuntu/.local/share/tmex",
  "updatedAt": "2026-08-31T09:00:12.171Z",
  "cliVersion": "1.1.3",
  "bunPath": "/home/ubuntu/.bun/bin/bun"
}
--- exit code: 0 (window @9 pane %9) ---
```

临时 window 已自动关闭，事后复查 jiefa-app 仍是原来的 7 个 window（@0/@3/@4/@5/@6/@7/@8）。

### 网络可达性（对后续从 GitHub Releases 升级很关键）

Hub（s0522）：

```
$ ... run --node self --device bf1c1f53-... --pane '%0' --cmd 'curl -sS -I -m 10 -o /dev/null -w "github:%{http_code} %{time_total}s\n" https://github.com 2>&1; curl -sS -m 10 -o /dev/null -w "api.github:%{http_code}\n" https://api.github.com 2>&1; curl -sS -m 10 -o /dev/null -w "releases:%{http_code}\n" -L https://github.com/krhougs/tmex-enhanced/releases 2>&1'
curl: (28) Operation timed out after 10000 milliseconds with 0 bytes received
github:000 10.000268s
api.github:200
curl: (28) Operation timed out after 10002 milliseconds with 0 bytes received
releases:000
--- exit code: 28 (window @0 pane %0) ---
```

同机另一轮：`objects.githubusercontent.com` → `HTTP/2 404`（可达），`registry.npmjs.org/tmex-cli` → `npm:200`。

jiefa-app：

```
github:200
api.github:403
objects:404
npm:200
--- exit code: 0 (window @10 pane %10) ---
```

**结论**：Hub 上 `github.com` 本身超时（000），但 `api.github.com`、
`objects.githubusercontent.com`、npm registry 都通；jiefa-app 反过来，`github.com` 通、
`api.github.com` 返回 403。也就是说 **Hub 无法直接从 `github.com/.../releases/download/...`
下载**（那个 URL 会先打 github.com 再 302 到 objects.githubusercontent.com），
需要绕过 github.com 直连 objects 或换源。

### 文件根 + 上传（Hub 本机）

```
$ ... run --node self --device bf1c1f53-... --pane '%0' --cmd 'mkdir -p /tmp/tmex-ops && ls -ld /tmp/tmex-ops'
drwxr-xr-x 2 root root 40 Aug 31 15:41 /tmp/tmex-ops
--- exit code: 0 (window @0 pane %0) ---

$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts root-add --node self \
    --device bf1c1f53-df4f-4250-9678-0e383875a882 --dir /tmp/tmex-ops
created root b08205e9-37e2-4316-951f-2cf455ab3159  path=/tmp/tmex-ops  device=bf1c1f53-df4f-4250-9678-0e383875a882

$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts roots --node self
root b08205e9-37e2-4316-951f-2cf455ab3159  path=/tmp/tmex-ops  name=tmex-ops  device=s0522  enabled=true

$ HUB_PASSWORD=$HUB_PASSWORD bun hub-ops.ts upload --node self \
    --root b08205e9-37e2-4316-951f-2cf455ab3159 --file <本地>/hub-ops-test.txt
upload init: id=88d2cb31-bd27-414c-805d-80a21edee701 chunkSize=8388608 size=47 dest=/tmp/tmex-ops/hub-ops-test.txt
upload done: hub-ops-test.txt
```

回读校验（内容与 md5 与本地一致）：

```
$ ... run --node self --device bf1c1f53-... --pane '%0' --cmd 'ls -l /tmp/tmex-ops; echo ---; cat /tmp/tmex-ops/hub-ops-test.txt; echo ---; md5sum /tmp/tmex-ops/hub-ops-test.txt'
total 4
-rw-r--r-- 1 root root 47 Aug 31 15:41 hub-ops-test.txt
---
hello from hub-ops
line2: 2026-08-31T15:41:16Z
---
a0cf70519b614fc21f4292ebd207a751  /tmp/tmex-ops/hub-ops-test.txt
--- exit code: 0 (window @0 pane %0) ---
# 本地 md5: a0cf70519b614fc21f4292ebd207a751  → 一致
```

清理：

```
$ ... run --node self --device bf1c1f53-... --pane '%0' --cmd 'rm -f /tmp/tmex-ops/hub-ops-test.txt; ls -la /tmp/tmex-ops'
total 0
drwxr-xr-x  2 root root  40 Aug 31 15:41 .
drwxrwxrwt 13 root root 440 Aug 31 15:41 ..
--- exit code: 0 (window @0 pane %0) ---
```

## 遗留物

测试文件已删。**Hub 上保留了两样东西**（后续如不需要请手动清理）：

- 目录 `/tmp/tmex-ops`（空）
- 文件根 `b08205e9-37e2-4316-951f-2cf455ab3159` → `/tmp/tmex-ops`
  （删除：`DELETE /api/files/roots/b08205e9-37e2-4316-951f-2cf455ab3159`）

其余机器未做任何写操作；jiefa-app 上的临时 window 已自动关闭。
