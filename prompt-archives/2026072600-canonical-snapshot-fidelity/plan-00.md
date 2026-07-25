# canonical 快照保真修复

## 根因清单（全部实证）

1. **control-mode parser 丢弃 literal 块内空行**（`control-mode-parser.ts`）：
   capture-pane 输出的空白屏幕行在 control 流中是孤立换行，parser 对零长度行
   一律 return，导致快照正文行数缺失、整屏上移；gateway 以绝对 CUP 恢复光标，
   每丢一行错位一行。TUI 依相对移动增量重绘时全屏错乱；resize 触发应用全量
   重绘故可恢复。legacy 首屏走独立进程 stdout 不经此 parser，故只有 canonical 复现。
2. **alt 屏快照拼入 primary scrollback**（`device-session-runtime.ts`）：
   `capture-pane -S -256` 在 alternate screen 下返回 primary grid 的旧
   scrollback + alt 可见区（tmux 实测 277 行历史 + 屏幕 = 280 行），TUI 启动前
   的旧 shell 输出被整段写进快照。
3. **合帧批次在 ScreenBegin 前整体 flush**（`canonical-feed-session.ts`）：
   屏障（baseSeq）之后产生的 live 数据被排到快照事务之前发出，客户端 reset
   即抹掉且不再重发，永久丢帧。
4. **history 页拼接每页丢一个换行**（`Terminal.tsx`）：normalizeHistoryForTerminal
   吃掉页尾换行且页间无分隔，页与页、末页与快照正文粘行。
5. **无画面基线的 pending live 回放**（`pane-sink-registry.ts`）：sink 注销期间
   缓冲的流中片段在重挂载时被写进全新空终端，闪现陈旧乱码。
6. **截断从头部按字节砍**：切断 SGR/行边界（颜色混乱来源之一）。

## 修复

- parser：literal 块内空行 push('')（非 literal 块保持原行为）；
- capture 拆分为同屏障内三连命令：meta → 可见区（无 -S）→ 纯历史段
  （`-S -N -E -1`），历史段仅在非 alt 且 history_size>0 时拼接；顺带消除 -J
  跨 history/可见区边界合并折行导致的行数漂移；预算不足时整段丢弃历史
  （historyCursor 相应指向未内嵌位置），不再头部截断；
- sendScreenTransaction 按 baseSeq 切分 pending 批次：≤baseSeq 丢弃（快照已含），
  >baseSeq 扣到 ScreenCommit 后补发；sendHistoryTransaction 前置 flush；
- 快照重建时每个 history 页写后补 `\r\n`；
- pending live 仅在存在画面基线（reset/history/screen）时回放。

## 验收

单测：gateway 1051 全绿（含新增 parser 空行、批次切分、三连命令测试）；全仓
各包 0 fail（合跑 ws-client/stores/panels 的既有跨文件串扰不变）。

e2e（真实 companion→relay→webapp 链路）：空行行号逐行一致 + 光标行一致；
alt 屏（primary 277 行历史）buffer 零旧内容、无额外 scrollback；claude TUI
冷启/切换行级对齐 10/10、光标行一致；上一轮回归矩阵（鼠标模式恢复、路由
不弹回、recents 高亮、2026 洪峰零撕裂、洪峰下输入 393ms、合帧 1633B@8/s）
全部保持。
