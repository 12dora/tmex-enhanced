# WatchService + control-mode 行为保持拆分

Working directory: /Users/konata/code/tmex-enhanced-wt-smell

TASK 1 — watch: split WatchService into scheduler (rule timing), runtime pool (device runtime refs + lifecycle), evaluation pipeline (regex + LLM evaluation as pure-ish functions), notifier and sample store (ring buffer as its own class with tests). WatchService keeps its public API and orchestration.

TASK 2 — control mode: split control-mode-parser into framing (line/block framing), notification parsing (each %notification kind as a small parser in a table) and pane/window state handlers; split control-mode-subscription into subscription lifecycle, pane parser registry and metadata bridge. Preserve exact event sequences; add golden tests feeding recorded control-mode transcripts whole and split at arbitrary boundaries.

Do NOT touch pane-stream-parser*, external-connection*, pane-retention.ts, canonical-feed-session.ts, ws/index.ts.
No git commit / stash / checkout / add.
