# Canonical State Feed Implementation Prompt

## 2026-07-22

Implement the tmex-owned portion of the canonical terminal state architecture described by the
cross-repository plan at
`../../../../prompt-archives/2026072204-canonical-terminal-stream/plan-00.md`.

Requirements:

- one canonical feed per managed Gateway runtime instead of one terminal stream per consumer;
- stable source identities for sessions, windows, and panes;
- realtime metadata projection for title, current directory, foreground process, layout, activity,
  and lifecycle changes;
- an explicit subscription union for terminal bytes, with active/hot/cold states and bounded screen
  and replay history;
- legacy Gateway and frontend adapters must consume the same projection during migration;
- title and metadata updates must not wait behind a periodic full-list refresh;
- preserve the public tmex behavior and keep the implementation transport-neutral;
- retain compatibility until all consumers have migrated, then remove the legacy execution path
  only after the rollout gate passes.

Safety constraints:

- never touch an installed tmex service or the default tmux socket/session;
- use repository-local temporary instances and dedicated test sockets only;
- do not run destructive workspace cleans;
- keep commits neutral and suitable for the open-source repository.
