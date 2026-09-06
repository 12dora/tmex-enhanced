# EX3 — Settings → Share 布局探索报告（Opus 子代理）

- 组件：`apps/fe/src/pages/settings/share/share-settings-card.tsx`（:83 现为 `grid gap-3 sm:grid-cols-2`，OriginField 独立一块，控件 `w-full sm:w-80`，SelectTrigger `size="sm"` 28px 与 Input 32px 不齐）。
- `FormField`（`settings/components/form-primitives.tsx:63-85`）无 className prop；跨列惯用 `<div className="sm:col-span-2">` 包裹（`relay/quota-fields.tsx:62`）。
- 现有三列先例：`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`（`relay/relay-tab.tsx:255`）。仓库不用 `md:`/`xl:`（有测试断言不存在）。
- 表单：纯 useState + `share-settings-form.ts` 校验；API `GET/PUT /api/share/settings`（`packages/shared/src/share/types.ts:30-35`）。
- 无任何测试引用该卡片 testid，布局改动安全。
- 建议：grid 改 `sm:grid-cols-2 lg:grid-cols-3`，OriginField 用 `<div className="sm:col-span-2 lg:col-span-1">` 包入；两处 `w-full sm:w-80` 改 `w-full sm:w-80 lg:w-full`；SelectTrigger 去掉 `size="sm"` 对齐高度。
