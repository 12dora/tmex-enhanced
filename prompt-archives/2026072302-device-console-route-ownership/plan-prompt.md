# Device Console 路由所有权修复 Prompt

日期：2026-07-23

## 用户反馈

> 现在有一个很大的bug，在terminals页面选择的窗口，点击后会进入错误的窗口，这个窗口看起来像是某个列表的第一个项目

## 上下文

Vibe X 共享 tmex 的 `DeviceConsole`。window card 导航使用 window-only URL，组件内“目标窗口 pane 解析”
和“device 初次默认选择”两个 effect 会在同一次 render 中分别导航；后者覆盖前者，导致进入全局 active
window 或列表首项。

本修复必须保持开源中性：明确 device-only 与 window-only 路由的所有权，不引入 Vibe X 专属分支，不把
selection 重新变成 transport owner。

## 联动体验取证

真实 WebApp 验收发现 canonical device metadata 只有 device ID，导致下游 Recent 只能把 UUID 当作设备
来源。Gateway 应在 device record 的既有 name field 中提供设备显示名，让所有 canonical metadata
消费者都能稳定解析，不依赖 UI 临时 REST 查询。
