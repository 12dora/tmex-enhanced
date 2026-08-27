#!/bin/zsh
# Phase 0 基线：各包 bun test 摘要 + tsc 错误数。在 worktree 根执行。
set -u
cd "$(dirname "$0")/../../.." || exit 1
OUT="prompt-archives/2026082701-hub-multinode-design/sub/baseline.md"
{
  echo "# Phase 0 基线（$(date '+%Y-%m-%d %H:%M')，commit $(git rev-parse --short HEAD)）"
  echo
  echo "| 包 | bun test 摘要 | tsc 错误数 |"
  echo "|---|---|---|"
} > "$OUT"
for pkg in apps/gateway apps/fe packages/shared packages/ws-client packages/stores packages/api-client packages/panels packages/app packages/terminal-ui packages/ui packages/notifications packages/theme; do
  [ -d "$pkg" ] || continue
  if [ "$pkg" = "apps/fe" ]; then target="src/"; else target=""; fi
  summary=$(cd "$pkg" && NODE_ENV=test bun test $target 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^ *[0-9]+ (pass|fail)|Ran [0-9]+ tests' | tr '\n' ' ')
  [ -z "$summary" ] && summary="(no tests / not run)"
  if [ -f "$pkg/tsconfig.json" ]; then
    tsc_out=$(cd "$pkg" && bunx tsc --noEmit -p . 2>&1)
    tsc_n=$(printf '%s\n' "$tsc_out" | grep -c 'error TS' || true)
  else
    tsc_n="(no tsconfig)"
  fi
  echo "| $pkg | $summary | $tsc_n |" >> "$OUT"
done
echo >> "$OUT"
echo "注：apps/fe 单测用 \`bun test src/\`（裸 bun test 会误拾 Playwright spec）；e2e 基线见记忆 e2e-baseline-failures。" >> "$OUT"
echo done
