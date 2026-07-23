# Device Console 路由所有权修复结果

日期：2026-07-23

## 结果

- device-only 路由继续选择 active window/pane，并在缺少 active 标记时回落到首个可用 window/pane。
- window-only 路由不再被全局默认选择 effect 接管，由目标 window effect 唯一解析其 active/first pane。
- canonical Device metadata record 增加既有 `name` field；runtime 从设备配置传入显示名，缺失时兼容回落到 device ID。
- 没有引入产品专属分支、额外连接或 selection transport side effect。

## 验证

```text
bun test packages/panels/src/device-console/selection-recovery.test.ts \
  apps/gateway/src/tmux-client/metadata-projection.test.ts            # 14 pass
bun test apps/gateway/src                                             # 1038 pass
bun run --filter @tmex/fe build                                       # PASS
```

联动宿主的真实 Webapp 验收已证明点击非首项窗口进入精确 URL，不再落到列表首项；设备显示名也可由 canonical metadata 直接消费。
