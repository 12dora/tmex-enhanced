# plan-00 执行结果：hub 多容器 e2e + 多主题

分支 `chore/merge-hub-tabs`（worktree `../tmex-enhanced-wt-merge`）。所有子任务的 prompt / result / review 在 `sub/`。

## 任务 2：多主题（已完成）

提交：`dd6c134`（功能）、`ae6e45c`（审查修复）。

- 14 套命名配色（Dracula、Tokyo Night ×3、Catppuccin ×2、Nord、One Dark、Solarized ×2、Gruvbox ×2、GitHub ×2）作为本地 preset（`data-theme-preset`），同时驱动 UI token（含 `--code-*` 高亮、`--fc-*`）与终端 16 色 + fg/bg/cursor/selection；TS 调色板为真源，`bun run build:theme-presets` 生成 CSS，测试断言生成物未过期。
- 服务端 `theme` 继续只表示外观 `dark|light`（tmux DECSET 997 / OSC 11 / Borsh 帧不变）；选 preset 时同步站点外观，服务端外观与 preset 不符时清 preset；多标签页经 `storage` 事件同步；在途 settings 请求在本地主题变更后作废。
- 侧栏 Sun/Moon 按钮改为主题菜单（`theme-menu-trigger` / `theme-option-*`，Base UI DropdownMenu，含三色预览）；设置页深色开关移除；i18n `settings.theme` → Theme/主题/テーマ。
- 验证：theme 52、stores 257、terminal-ui 315、panels 368、shared 325、fe 330 单测全过，tsc 与基线一致；Playwright `theme-presets`/`theme-broadcast`/`theme-propagation`/`theme-notify-2031`/`settings` 通过（`ws-borsh-theme-resize:39` 为既有基线失败）；浏览器实测截图见会话记录。
- 已知取舍：gateway 侧 tmux window-style / OSC 11 仍按外观取 seoul256 色，与 preset 的终端底色不一致（设计上接受，见 `sub/wp-a2-result.md`）。codex 审查 #2（"原子事务"）与 #4 判定为过度设计/理论问题，未修。

## 任务 1：hub 多容器端到端验证

harness：`scripts/hub-e2e/`（提交 `79f412c`、`4ea05c0`、`f03e54d`、`44138c7`），文档 `docs/hub/2026082801-hub-docker-e2e.md`。拓扑 caddy（私有 CA）+ hub(`hub,node`) + node-a + node-b（不同 bridge，模拟 NAT）+ driver。远程测试机为原生 x86，一轮 3.5 分钟（本机 qemu 15–25 分钟）；迭代环脚本在会话 scratchpad（含凭据，不入库）。

### 最终场景表（远程 tag `p3`，commit `44138c7`）

| 场景 | 结果 |
|---|---|
| 1 hub 健康 / `hub user add` / `auth/mode` mesh 字段 | PASS |
| 2 enroll + join node-a/node-b，hub 注册表 online | PASS |
| 3 hub 入口登录、登录 node-b、建 device、tmux tree、`reach=relay`、终端 marker 回环 | PASS |
| 4 node-a 作入口登录 node-b；连 lan 后 60s 内 `reach=lan`；LAN 路径 marker | PASS |
| 5 经入口列目录 / 读 node-b 文件 | PASS |
| 6 hub 停机：终端 marker、文件列表仍通，mesh 仍列出 node-b | PASS |
| 7 hub 恢复：90s 内 online，旧 cookie 无需重登 | PASS |
| 8 `direct enable` 后重启，`self.direct_capable=true` | PASS |

对应设计遗留验收：1（双机 LAN）✔、2（hub 停机）✔；3（直连中断不丢字）未覆盖（需 RTC 数据面注入中断，见文档已知限制）。

### 实测发现并修复的产品缺陷

| 提交 | 缺陷 |
|---|---|
| `764dbba` | `direct enable` 在 Node CLI 中引用 Bun API 静默失败；非 hub 机 `enroll` 期望 login JSON 带 `sid`；`hub join/leave` 无服务管理器时报错（新增 `--no-restart`） |
| `fa19aaf` | `detectServiceManager` 未探测 `systemctl --user` 连接 |
| `c8fa053`、`e60c515` | 认证子进程 stdout 实时转发、信号接管与 `128+signal` 退出码；`writeEnvFile` 对 symlink（含悬空/相对）写真实文件 |
| `cddeba7` | hub `node.list` 里 `version:null` 使整帧解码失败被静默吞掉；catch-up 后回写 `peer_cache`；`onNodeList` 误删 hub 哨兵 |
| `0a83e41` | **生产装配 `assembleTmex` 未传 `userId`**，刚 join 的节点无自身证书 → key-log catch-up 永不生效（进程内测试显式传 userId 所以一直绿）；超时不再视为完成；帧需 `auth.ok` 后受理；去掉推测性 reach |
| `44138c7` | relay 链存活时不会升级到 LAN（endpoints 变化后无后台升级拨号）；self 行 `direct_capable/version/inventory` 从不填 |

注：`c8fa053` 的"Node CLI 吞 stdout"最初诊断有误——真实原因是 harness 调了 `dist/cli-node.js`（只导出 `main`，不自执行）；改动本身（pipe 转发 + 信号处理）经测试仍保留。

### 审查—修复轮次（mesh，codex gpt-5.6-sol 审 / grok 4.6 修）

| 轮 | 审查文件 → 修复提交 | 内容 |
|---|---|---|
| 1 | `review-p1.md` → `0a83e41` | catch-up 超时语义、list 代次、auth 门闩、日志 |
| 2 | `review-p1b.md` → `abbe2b0` | key-log 失败路径、认证代次、响应 id、版本水位、presence、userId 歧义、hub 限频、日志注入 |
| 3 | `review-p3.md` → `001322c` | 换链 quiesce fence、升级限流/退避/并发、status 按链去重 |
| 4 | `review-p45.md` → `0f8d00b` | 能力协商、活跃流不硬关、getLink 退避、异常重试、代次绑定、userId 守卫顺序、认证覆盖、presence 新鲜度、LRU |
| 5 | `review-p8.md` → `017aca3` | 握手去 caps、helper 绑代次、NODE_EVENT 投影、overflow 桶、mux 假在线 |
| 6 | `review-p9.md` → `8e1d542` | 入站停靠、applyMany 中止/CAS、NODE_EVENT 扩字段、overflow 公平、mux 关闭顺序 |
| 7 | `review-p10.md` → `c526f41` | 撤销 vs 停靠链、停靠链队列上限、key.log 分页、legacy 事件、overflow 显式限流、mux 关 transport |
| 8 | `review-p11.md` | 见文件（收敛判定见下） |

另：`af33b95` node_identity 持久化 userId（迁移 0020）；`6591e7e` 本机入口登录接受真实 nodeId（浏览器登录 `ENTRY_MISMATCH`，仅在真实浏览器暴露）；`97f5cda` `/login` 等顶层路由在 SidebarProvider 外渲染 `SidebarTrigger`（tabs × hub 合并静默冲突）。

### 分体拓扑：远端公网 hub × 本地 NAT node（`scripts/hub-e2e/split/`）

远端 `https://ai.jiefakj.com:18443`（Caddy + Let's Encrypt 真证书，hub `hub,node`，发布 18443/39001），本地 Docker 原生 arm64 `node-a`/`node-b`（各自 bridge，仅出站）+ `driver`。端口只提示不探测（18443 必需、39001 可选）。

最终一轮（run 5，commit `2e6309a` 的包；本地节点原生 arm64，远端 x86）：

| 场景 | 结果 |
|---|---|
| A 两 node 跨公网 join；hub 入口登录；node-a 终端经 hub relay 回环；node-b 文件 list/read | PASS |
| B node-a 作入口登录远端 hub 节点，在远端建 tmux 并回环 marker（`reach=relay`） | PASS |
| C 本地 lan 连通后 `reach=lan`；远端 hub `docker stop` 后本地终端/文件仍通、mesh 仍列 node-b；`start` 后 120s 内恢复、旧 cookie 有效 | PASS |
| D 两端 `direct enable` 后 `direct_capable=true`；流可打通但路径仍为 relay（跨 NAT RTC 未建立，见遗留） | PASS（路径 relay） |
| E node-a 重启、远端 hub 重启后均重连，无幽灵行 | PASS |
| F Playwright 真域名真证书：密码登录、侧栏列出 hub/node-a/node-b 与 tmux 窗口、node-a 终端打 marker、注册 passkey、登出后 passkey 登录 | PASS |
| G 根钥签 `revoke-node` 经 `keylog?hub=sync` 后 node-b 从入口不可达 | PASS |

过程中排除的环境因素：Google STUN 境内两端不可达（改 `stun.miwifi.com`）；远端 NTP 未启用导致 73s 时差 → `DELEGATION_ISSUED_IN_FUTURE`（已启用 NTP，脚本只检查不改时钟）；本机 DNS 被代理劫持为 fake-IP（容器 `extra_hosts`、Chromium `--host-resolver-rules`）；qemu 下 bun 偶发卡死（本地镜像改原生 arm64）；面板 ssh 暴力破解防护会拒绝突发连接（ssh 包装脚本重试）。

### 未覆盖 / 遗留

- 跨 NAT 的 RTC 直连未建立（D 停在 relay）：需要可达的 STUN/TURN 与进一步的 ICE 诊断；验收 3（直连中断不丢字）因此未验。
- TOTP、IPv6 ICE、文件 bulk 直连未测。
- 单机 harness 与分体 harness 的 `docs/hub/2026082801-hub-docker-e2e.md` 为运行指南；远端测试资源已按约定清理（见下）。
