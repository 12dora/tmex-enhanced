# Common context for exploration agents (read-only)

Repository: tmex — a Bun-only monorepo (`apps/gateway` = Bun HTTP/WS gateway that drives tmux; `apps/fe` = Vite/React SPA + PWA; `packages/*` = shared libs: `shared`, `ws-client`, `api-client`, `stores`, `terminal-ui`, `ghostty-terminal`, `panels`, `ui`, `theme`, `notifications`, `app` = npm CLI/installer). The gateway also runs a "mesh" of nodes (hub + peer links, `apps/gateway/src/mesh`, `apps/gateway/src/hub`, `packages/shared/src/uplink`). Docs live under `docs/` (Chinese); `docs/known-issues.md` and `docs/ws-protocol`, `docs/performance`, `docs/hub`, `docs/terminal`, `docs/files` are the most relevant.

You are running in READ-ONLY mode: do not modify files. You cannot write result files — **output your complete report as your final message**. Write the report in English, in Markdown, with precise `path:line` references for every claim. Do not guess: every statement about behaviour must be backed by code you actually read. Where you propose changes, be concrete (which file/function, what to change) and flag trade-offs. Keep the report focused and dense (no filler); target 800–2500 words.

You are one of several explorers running in parallel; stay within your assigned question.
