# UI interaction guards 实施计划

## 背景

tmex FE 目前只有少数列表局部声明 `select-none`，页面正文、图像和链接仍可能被选择或
触发浏览器原生拖动。Native 宿主需要桌面应用式交互，同时输入控件、可编辑区域和终端
必须保留文本选择能力。

## 实施

1. 在 `apps/fe/src/index.css` 的 base layer 对全部元素关闭 WebKit 原生拖动。
2. 在 `body` 默认关闭文本选择。
3. 对 input、textarea、select、contenteditable、xterm 和终端根恢复文本选择。
4. 仅执行格式/构建级检查，不在本轮扩写测试。

该规则保持浏览器与宿主中立，不引入任何 Vibe X/Tauri 概念。
