# 远端尺寸变更与初始同步竞态修复计划

日期：2026-07-10

## 背景

在移动端堆叠布局修复后的整组终端 E2E 中，`terminal-render-regressions.spec.ts` 的“另一客户端远端 resize”用例曾失败：tmux 已被测试显式改为 `60×16`，但随后又稳定回到前端容器的 `112×35`。

初步调用链表明这不是移动端堆叠布局路径：该用例为桌面单 pane。`useTerminalResize.runPostSelectResize()` 会立即、60ms 重试和字体就绪后强制上报本地容器尺寸；远端 snapshot 在本地尺寸仍处于 2 秒 pending 保护期时会被 `shouldApplyRemotePaneSize` 拒绝。二者时序交错时，延迟本地上报可能覆盖刚执行的外部 `resize-window`。

## 目标

让已建立连接的另一客户端对单 pane window 的远端 resize 可靠成为 tmux 权威尺寸，并保留首次挂载、字体加载或真实浏览器容器变化时的本地尺寸收敛。

## 实施步骤

1. 以独立 `tmex-e2e` socket 重跑该用例，必要时用临时诊断记录确认“远端 resize → 延迟本地强制 sync 覆盖”的实际时序；不以增加超时作为修复。
2. 先在 `resizeSyncGuards` 或对应 hook 测试中写出失败案例，明确：远端尺寸变更不能被启动期的重复 forced sync 覆盖；仍允许首次本地尺寸同步和真实容器尺寸变化上报。
3. 采用最小职责边界修复（优先取消已过时的 post-select 重试或给其同代标识，而非放宽所有远端保护），并保证远端 snapshot 到达后能取消／失效旧的本地 pending 同步。
4. 运行单元测试与远端 resize E2E 重复运行；再运行完整相关分屏／render E2E、类型检查和构建。

## 验收标准

- 外部 `resize-window` 后 tmux 尺寸不再被首次挂载的延迟本地 sync 回写。
- 终端最终尺寸与 tmux 一致，history refresh 后逐行内容一致。
- 真实本地容器 resize、初次挂载与字体加载后的尺寸同步仍能收敛。
- 不改动默认 tmux socket 或生产 tmex 服务。
