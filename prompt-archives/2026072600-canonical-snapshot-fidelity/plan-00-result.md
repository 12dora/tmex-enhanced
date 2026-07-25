# 执行结果

分支 `vibex/canonical-snapshot-fidelity`（基于 `vibex/use-mobile-hook-race`），
改动与验收见 plan-00.md。

- 单测：gateway 1051 全绿；全仓各包 0 fail；新增/更新测试：parser literal 块
  空行保留、原子截屏三连命令与 historyText、ScreenBegin 批次按 baseSeq 切分、
  pane-sink pending 无基线不回放。
- e2e（真实链路）：空行行号/光标行逐项一致；alt 屏（primary 277 行历史）
  buffer 零旧内容；全屏 TUI 冷启/切换行级对齐 10/10；既有回归矩阵（鼠标模式
  恢复、路由稳定、洪峰零撕裂 0/12、输入时延 393ms、合帧 1633B@8/s）全部保持。
