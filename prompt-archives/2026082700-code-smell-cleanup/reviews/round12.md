## 审查发现

### 低：日期 helper 放宽 locale 类型，允许编译通过但运行时崩溃

- 严重度：低
- 置信度：高
- 位置：[packages/shared/src/format-date.ts:15](/Users/konata/code/tmex-enhanced-wt-smell/packages/shared/src/format-date.ts:15)，同类问题见第 20 行
- 失败场景：`language` 声明为任意 `string`，随后通过 `as LocaleCode` 绕过类型检查。因此以下调用可通过 TypeScript：

  ```ts
  formatDateTime('2026-08-27T00:00:00Z', 'not_a_locale');
  ```

  实测会抛出：

  ```text
  RangeError: invalid language tag: not-a_locale
  ```

  这削弱了项目现有的 `LocaleCode` 类型约束。

- 最小修复：将 `formatDateTime()` 和 `formatDate()` 的 `language` 参数改为 `LocaleCode`，并移除 `as LocaleCode`。建议补一个使用 `@ts-expect-error` 的非法 locale 类型测试。

其余重点检查项未发现可报告的回归，包括路由顺序与参数解码、Markdown 路径越权、尾斜杠、剪贴板 fallback，以及有效测试覆盖的迁移。