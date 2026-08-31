# O1：侧栏底部按钮组下沉对齐 + 顶部 Tab 上移

改动文件仅两处（均在所有权范围内）：

- `apps/fe/src/components/page-layouts/components/app-sidebar.tsx`
- `apps/fe/src/components/page-layouts/components/nav-main.tsx`

未触碰 `packages/ui` 任何 primitive（`SidebarFooter` / `SidebarGroup` / `SidebarMenuButton` / `tabs.tsx` 全部原样），也未改 `main.tsx` / `page-wrapper.tsx`。

## 任务 1：底部「接入设备 / 管理设备」按钮组

### 改动

`app-sidebar.tsx`（footer）：

```diff
-<SidebarFooter>
+<SidebarFooter className="gap-0 px-2 pt-1.5 pb-0">
   <NavMain items={footerItems} />
   <div className="h-[var(--tmex-safe-area-bottom)]" />
 </SidebarFooter>
```

`nav-main.tsx`（分组容器）：

```diff
-<SidebarGroup>
+<SidebarGroup className="px-2 py-0">
```

`nav-main.tsx`（按钮）：

```diff
 <SidebarMenuButton
   isActive={active}
+  size="sm"
   tooltip={t(item.title)}
   aria-label={t(item.title)}
-  className="justify-center gap-1.5 px-1.5 text-xs"
+  className="justify-center gap-1.5 px-1.5 py-1 text-xs"
```

### 几何账（桌面端，1rem = 16px）

| 项 | 改前 | 改后 |
|---|---:|---:|
| Footer 下内边距 | 8px (`p-2`) | 0 (`pb-0`) |
| Footer 子元素 gap（按钮组 ↔ 安全区占位） | 8px (`gap-2`) | 0 (`gap-0`) |
| SidebarGroup 下内边距 | 8px (`p-2`) | 0 (`py-0`) |
| **按钮组下缘距侧栏内容底部** | **24px** | **0px（齐平）** |
| 按钮组上方留白（Footer pt + Group pt） | 16px | 6px (`pt-1.5`) |
| 按钮高度 | 32px (`h-8`) | 28px (`h-7`，`size="sm"`) |
| 按钮横向内边距 | footer 8 + group 8 = 16px | 不变（`px-2` + `px-2` = 16px） |

侧栏自身处在 `variant="inset"` 的 8px 视口内缩里，右侧 `SidebarInset` 同样是 `md:m-2`，所以「按钮组下缘 = 侧栏内容底部」即等于「外层黑框下缘」，达成对齐要求。

终端列表（`SidebarContent`）因此向下多得 24px、向上多得 10px，合计 **34px** 垂直空间。

### 几处刻意的取舍

- **保留 footer/group 的横向 `px-2`**：按钮左右位置与改前完全一致，只动垂直方向。
- **保留移动端安全区**：`<div className="h-[var(--tmex-safe-area-bottom)]" />` 原样留在 footer 内；桌面端该变量为 0（不占高），移动端仍把按钮组顶到安全区之上，行为未变。
- **没有把 `SidebarMenu` 的 `gap-1` 改成 `gap-0.5`**（EX1 报告的建议之一）：展开态该菜单是 `flex-row`，`gap-1` 是两个按钮之间的**横向**间距，压缩它省不到任何垂直空间，只会让两颗按钮贴在一起；只有 `collapsible=icon` 竖排态才是纵向 gap，那是折叠图标条，不是本次要对齐的场景。故不动。
- **按钮补 `py-1`**：`sidebarMenuButtonVariants` 基类带 `p-2`（上下各 8px），与 `size="sm"` 的 `h-7`(28px) 相加会让内容盒只剩 12px、图文 16px 反向溢出；显式 `py-1` 把上下内边距压到 4px，内容盒 20px，居中干净。28px 的点击区在这套侧栏里仍属正常密度（与列表行同一量级）。

## 任务 2：顶部 Tab 切换器上移

### 改动

`app-sidebar.tsx`（header + Tabs）：

```diff
-<SidebarHeader className="gap-5 pt-3 pb-0">
+<SidebarHeader className="gap-4 pt-3 pb-0">
   <SidebarTitle />
+  {/* 上移 5px（gap 20→16 再 -1px）：让 TabsList 里可见的 active 药丸上沿与右侧
+      终端卡片的可见上沿齐平——药丸比 TabsList 外框低 border 1px + p-1 4px。 */}
   <Tabs
-    className="mb-2.5"
+    className="-mt-px mb-2.5"
```

### 为什么是 `gap-4 + -mt-px`（−5px）而不是任务书里例举的 `-mt-1`（−4px，或与 gap-4 叠加成 −8px）

按 EX1 的实测几何：

```text
TabsList 外框上沿  = 8(inset) + 12(pt-3) + 32(title) + 20(gap-5) = 72px（视口）
可见 active 药丸上沿 = 72 + 1(border) + 4(p-1)                    = 77px
右侧终端卡片可见上沿 = 8(inset) + 64(PageWrapper header) + 0(!pt-0) = 72px
```

验收目标是「**可见**的 tab 药丸与终端面板的**可见**上沿对齐」，即药丸要从 77px 回到 72px，净位移正好 **−5px**。

- 只写 `-mt-1`：−4px，药丸落到 73px，差 1px；
- `gap-4` 与 `-mt-1` 叠加：−8px，药丸到 69px，反而比终端上沿**高出 3px**，misalign 换了个方向；
- 采用 `gap-4`(−4px) + `-mt-px`(−1px) = −5px，药丸落在 **72px**，与终端卡片上沿精确齐平，同时也照做了「trim `gap-5`」这一条，标题与 Tab 之间仍留 16px，不显局促。

副作用：header 整体矮 5px，`SidebarContent`（终端列表）再多得 5px。`mb-2.5` 未动，Tab 与下方列表之间的呼吸感保持原样。

### 明确没做的事

- 未改 `packages/ui/src/components/tabs.tsx`。
- 未动 `TabsList` 上的 `group-data-horizontal/tabs:h-11`（EX1 指出它匹配不到 `data-orientation`）。按任务要求，本次不能让可见高度跳变，故原样保留；这条留作独立的高度修正项。

## 验证

| 项 | 结果 |
|---|---|
| `bunx tsc --noEmit -p .`（`apps/fe`）改动前 | 0 errors |
| `bunx tsc --noEmit -p .`（`apps/fe`）改动后 | 0 errors（无增加） |
| `bunx biome check <两个改动文件>` | `Checked 2 files. No fixes applied.` 干净 |

注：改动后第一次跑 tsc 曾闪出 1 个 error，随即复跑为 0——同一 worktree 里有并行 agent 在改别的文件，属于中途状态，与本次改动无关（两个改动文件本身零报错）。

未跑 e2e、未起 dev server、未执行任何 git 命令。视觉验收留给 commander。

## 复核要点（给 commander）

1. 桌面端：底部两颗按钮的下边框应与右侧黑框下沿在同一条水平线上（0px 间隙）。
2. 桌面端：tab 高亮药丸的上沿应与右侧终端卡片圆角上沿齐平。
3. 移动端：底部按钮组仍在安全区之上，不被 home indicator 压住。
4. 折叠成图标条（若可达）：按钮竖排、`size="sm"` 下 `group-data-[collapsible=icon]:size-8!` 会把它强制回 32px 方块，属基类既有行为，未被本次改动破坏。
