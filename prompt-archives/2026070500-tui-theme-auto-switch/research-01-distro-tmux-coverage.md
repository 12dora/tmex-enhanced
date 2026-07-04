# tmux ≥3.6 在主流发行版/macOS 软件源的覆盖面（2026-07-05）

补充调研：评估路线 A（依赖 tmux 3.6 的 mode 2031 原生代理）的现实覆盖面。上游时间线：3.4（2024-02-13）、3.5a（2024-10-05）、**3.6（2025-11-26，mode 2031 起点）**、3.6b（2026-05-20）、3.7b（2026-07-01，当前最新）。凡在 2025-11-26 前 freeze 的发行版主仓一定 <3.6。

## 版本表（仅支持期内版本）

### macOS（全绿）

| 源 | tmux | ≥3.6 |
|---|---|---|
| Homebrew | 3.7b | ✅ |
| MacPorts | 3.7b | ✅ |
| nixpkgs unstable / 26.05 stable | 3.7b / 3.6a | ✅ |

### Linux / BSD

| 发行版 | 支持截止 | 主仓 tmux | ≥3.6 | 备注 |
|---|---|---|---|---|
| Debian 13 trixie (stable) | 2028-08（LTS 2030-06） | 3.5a | ❌ | **trixie-backports 有 3.6b** ✅ |
| Debian 12 bookworm | 2026-07-11（LTS 2028-06） | 3.3a | ❌ | backports 仅 3.5a，到 EOL 拿不到 3.6 |
| Debian testing/sid | — | 3.7 | ✅ | |
| Ubuntu 22.04 LTS | 2027-04（ESM 2032） | 3.2a | ❌ | 无 backports |
| Ubuntu 24.04 LTS | 2029-05 | 3.4 | ❌ | 无 backports；当前部署量最大的 <3.6 存量 |
| Ubuntu 26.04 LTS | 2031-04 | 3.6a | ✅ | 首个开箱 ≥3.6 的 Ubuntu LTS |
| RHEL/Rocky/Alma 8 | 2029-05 | 2.7 | ❌ | EPEL 无 tmux；<3.0，本就不满足 tmex control mode 门槛 |
| RHEL/Rocky/Alma 9 | 2032-05 | 3.2a | ❌ | 同上；且 <3.3，连 OSC 11 代答都没有 |
| RHEL/Rocky/Alma 10 | 2035-05 | 3.3a | ❌ | EPEL 无 tmux，整个生命周期不升版本 |
| Fedora 43 | 2026-12 | 3.5a | ❌ | updates-testing 已有 3.7，可能转正（不确定） |
| Fedora 44 | 2027-06 | 3.6b | ✅ | |
| Arch | 滚动 | 3.7b | ✅ | |
| Alpine 3.23 / 3.24 / edge | 2027-11 / 2028-06 / — | 3.6 / 3.6b / 3.7b | ✅ | |
| Alpine 3.21 / 3.22 | 2026-11 / 2027-05 | 3.5a | ❌ | |
| openSUSE Leap 16.0 | 2027-10 | 3.5a | ❌ | OBS utilities devel 工程有 3.6b（社区源） |
| openSUSE Tumbleweed | 滚动 | 3.6b+（repology，未二次核实） | ✅ | |
| Amazon Linux 2023 | 2029-06 | 3.6a（2026-05-14 更新前长期 3.2a） | ✅ | `dnf update` 即得 |
| FreeBSD ports | — | 3.7b | ✅ | |

## 结论

- **macOS 本地设备 100% 可达 3.6+**（三大源全是 3.6a~3.7b），路线 A 对 tmex 本地场景无障碍。
- **SSH 远端存在长期洼地**：RHEL/Rocky/Alma 9/10（3.2a/3.3a 直到 2032/2035）、Ubuntu 24.04（3.4 直到 2029）、Debian 12（3.3a）、Ubuntu 22.04（3.2a）。均无官方升级渠道（EPEL 无 tmux、Ubuntu 无 backports）；tmux 上游不发布官方二进制，只有源码 tarball。第三方途径：Homebrew on Linux、Nix、mise/asdf 社区静态构建、源码编译。
- 因此 **mode 2031 只能做渐进增强，不能做硬门槛**；路线 B（gateway 模拟注入）对 SSH 远端不是可有可无的兜底，而是未来数年内 Ubuntu 24.04 / RHEL 9/10 这类主力服务器平台的**主要路径**。
- 设备能力实际分三档（`tmux-version.ts` 建议按此建模）：
  1. **≥3.6**：路线 A（tmux 原生 2031 代理）；
  2. **3.4–3.5**（含 3.3a 近似）：路线 B（OSC 11 代答可用 + gateway 注入 997）；
  3. **<3.3**（RHEL 9 的 3.2a、Ubuntu 22.04 的 3.2a）：window-style 的 OSC 11 代答不可用，连"新启动 TUI 初始亮暗检测"都缺失，TUI 退回 COLORFGBG/默认值——只能靠路线 B 注入 997（订阅了 2031 的 TUI 收到后重查 OSC 11 也拿不到答案，claude 可直接吃 997 值本身），能力上限明显更低，文档如实说明。

## 数据来源

repology.org 全景 + 各发行版官方包页/镜像目录逐一核实（packages.debian.org、packages.ubuntu.com、Rocky 镜像目录、packages.fedoraproject.org、archlinux.org、pkgs.alpinelinux.org、AL2023 release notes、formulae.brew.sh、ports.macports.org、nixpkgs、freshports）；EOL 数据取 endoflife.date 并以各发行版官方口径校准。不确定项：Tumbleweed 版本仅 repology；Leap 16.0 经 manpages.opensuse.org 侧证；Fedora 43 的 3.7 转正与否属推测。
