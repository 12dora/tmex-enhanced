# ghostty-terminal 输入侧 code smell 清理结果

## 范围

`packages/ghostty-terminal/src/` 下的 `ghostty-wasm.ts`（仅 `parseHexRgb`）、`terminal-input-bridge.ts`、`terminal-pointer.ts`，新增 `wheel-delta.ts`、`terminal-pointer-handlers.ts` 及对应测试。未触碰 `render-state.ts` / `canvas-renderer.ts` / `terminal-render-coordinator.ts` / `terminal.ts`。

## 1. `parseHexRgb` 只校验长度（bug）

原实现只判断 `normalized.length !== 6`，`#zzzzzz` 会被放行 → `Number.parseInt('zz', 16)` 得到 `NaN` → `DataView.setUint8` 把 `NaN` 写成 `0`，非法颜色静默变成黑色；而 `setTerminalTheme()` 的失败路径设计前提是「非法颜色一定抛错」。

改为 `HEX_RGB_PATTERN = /^[0-9a-fA-F]{6}$/`，大小写混写仍然合法。

回归测试加在 `ghostty-wasm.alloc.test.ts` 的 `setTerminalTheme 分配记账` 里：

- `#zzzzzz`（foreground）与 `#12345g`（palette 基色）必须抛 `expected #RRGGBB color`，且分配全部归还；
- `#AbCdEf` 正常通过，并读取 WASM 线性内存断言写入字节为 `[0xab, 0xcd, 0xef]`。

为读取写入值，`createTrackedBindings()` 额外返回 `memory` 与 `terminalSetCalls`（记录 `ghostty_terminal_set` 的 option/ptr），未改变原有记账行为。

已验证：把校验退回长度判断后，新测试失败。

## 2. `resetPointerAccumulation()` 漏清横向余量（bug）

原实现只清 `wheelPixelDelta`，`wheelPixelDeltaX` 保留。清除选择后，上一次不足一格的横向像素余量会继续参与换算，导致下一次横向滚动提前跨格、多发一个 SGR 按钮 6/7。

现在两条累加器一起清零。回归测试见新增的 `terminal-input-bridge.test.ts`：

- `partial horizontal scroll → reset → new scroll starts from zero`：5px（< 9px cell）→ reset → 再 5px，必须仍不产出鼠标事件；再 4px 才产出一次按钮 7；
- 对照测试：不 reset 时 5px + 5px 累积成一格（保证第一条测试不是因为累积失效而通过）；
- 纵向余量的同类断言；
- reset 同时清空 `pressedButtons`。

已验证：只清纵向累加器时第一条测试失败（期望 0 实得 1）。

## 3. `gestureToLines` / `gestureToColumns` 重复（duplication）

两个方法各自重复了 pixel / line / page 三种 `deltaMode` 的取整与余量累积逻辑（约 60 行）。抽出 `wheel-delta.ts`：

- `consumeWheelDelta({ delta, cellSize, deltaMode, viewportUnits, accumulator })` — 行模式向外取整并清余量、页模式按 `Math.max(1, viewportUnits)` 放大后向外取整并清余量、像素模式按 `cellSize` 累积并只消费整格；
- `createWheelAccumulator()` / `WheelAccumulator`（`{ pixels: number }`）；
- `roundAwayFromZero()`（触摸手势分支复用）。

`TerminalInputBridge` 改持有 `wheelAccumulatorY` / `wheelAccumulatorX` 两个累加器，两个方法各自缩到 ~15 行。

`wheel-delta.test.ts` 先写了 characterization 测试：文件内保留一份「抽取前」的参考实现 `legacyConsume`，用 14 步混合序列（正负、跨模式、非整数 cell、0、大位移、`deltaMode` 缺省）逐步对拍返回值与余量；另有像素累积、余量结转、符号反转抵消、行/页模式清余量、`viewportUnits=0` 兜底等单测。

行为等价性注意点：像素模式在负半轴会产出 `-0`（`Math.ceil(-10/16)`），与抽取前完全一致；调用方只做 `=== 0` / `Math.abs()` 判断，不受影响。测试里显式锁了这一点。

## 4. `bindMouseEvents()` 巨型函数（~193 行）

拆出 `terminal-pointer-handlers.ts`，导出 `createPointerListeners(context: PointerEventContext): PointerListeners`，内部按监听器拆成 7 个小工厂，mousedown 里的上报分支与链接分支再抽成 `consumeReportingMousedown()` / `consumeLinkMousedown()`（返回是否已消费）。

`bindMouseEvents()` 现在只剩注册 + 注销（132 行文件里约 30 行）。注册顺序与目标严格保持：`root:click` → `surface:mousedown` → `surface:mousemove` → `surface:mouseleave` → `root:wheel {passive:false}` → `window:mousemove` → `window:mouseup`。

新增 `terminal-pointer.test.ts` 锁住这个契约：注册顺序与目标、wheel 的 `{ passive: false }`、注销时函数引用一致且覆盖全部注册、无 `window` 时只注册 5 个元素级监听。原有的 `terminal.canvas.test.ts`（Shift+左键 bypass、同 cell 去重、1016 / 1003 / 1002、水平滚轮 6/7 等）全部保持通过。

需要知道的一点：`terminal-pointer.ts` 与 `terminal-pointer-handlers.ts` 之间存在 ESM 循环引用（handlers 用 `mouseButtonFromEvent` / `mouseButtonFromButtons` 与 `PointerEventContext` 类型）。所有跨模块引用都是函数声明且只在事件触发时调用，hoisting 保证初始化期不会有 TDZ 问题；如果后续想彻底消除，需要把鼠标按钮常量与两个映射函数再抽一个模块（本次未做，避免超出授权的文件范围）。

## 验证

```
cd packages/ghostty-terminal
bun test        # 159 pass / 0 fail（基线 138 + 新增 21）
bunx tsc --noEmit -p .   # 0 error
bunx biome check <改动文件>  # No fixes applied
```

`window.__tmexE2eXterm` 兼容成员未改动。

注意：`bunx biome check --write` 会把整个 `ghostty-wasm.ts` 重排版（该文件存在既有的格式漂移），已把这些无关格式变更还原，`ghostty-wasm.ts` 的 diff 只有 `parseHexRgb` 的 4 行。
