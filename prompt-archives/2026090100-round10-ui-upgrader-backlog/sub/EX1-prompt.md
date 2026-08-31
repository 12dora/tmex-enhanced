# EX1: Frontend geometry exploration (read-only)

You are a read-only code explorer for the tmex monorepo (Bun + React frontend in `apps/fe`). Do NOT modify any files. Output your FULL report as your final message (the harness captures it to a file).

## Goal

Locate the exact components/CSS responsible for the following, and propose minimal concrete changes (file:line, current values, suggested values/approach) for each:

1. **Left sidebar bottom button group** ("接入设备" / "管理设备" buttons at the bottom of the sidebar). The right-hand terminal area has two nested layers: an inner terminal border and an outer black frame. Requirement: move the button group down so its bottom edge aligns with the OUTER black frame's bottom edge, and reduce the vertical padding/gaps around the buttons so the terminal list above gets more vertical space. Identify: the sidebar layout container, the button group component, current paddings/margins/heights, and what the outer frame's bottom inset is (so we know the alignment target).
2. **Sidebar top tab switcher** (the tab switcher at the top of the sidebar). Requirement: move it up slightly so it aligns with the terminal area's top edge. Identify current top offset and the terminal area top edge inset.
3. **Devices management page ("管理设备") device card drag-and-drop**: dragging a card triggers displacement/avoidance of other cards way too early (even when far away). We want iOS-home-screen-like behavior where displacement only happens at a reasonable proximity. Find the DnD implementation (library? custom? collision detection strategy?), where the collision/over detection threshold lives, and propose how to make avoidance distance-based (e.g. closest-center within radius, pointer-within, or custom collision detection). Note there was prior work on drag 退避 in round4 (`prompt-archives/2026083001-dnd-ios-shift-sidebar-anim-smell-round4` may have context, and sidebar drag ordering exists too — but the target here is the devices page one-level group/card grid).
4. **SelectionToolbar swallowing clicks** (backlog P2.1): with an active selection, the toolbar overlays ~3 rows top-center of the pane and blocks starting a new selection there. See analysis at the end of `prompt-archives/2026083102-relay-files-switch-lan-round9/sub/O3-result.md`. Locate the toolbar component and terminal pointer handlers; recommend one of: dismiss toolbar on terminal pointer-down before selection starts, or move toolbar out of the text area. Give concrete file:line pointers.
5. **`node-login-<id>` testid duplication** (backlog P2.2): rendered by both the devices page and the sidebar Files node sections; `apps/fe/tests/helpers/mesh.ts:241` bare getByTestId conflicts in Playwright strict mode when Files tab is open. See `prompt-archives/2026083102-relay-files-switch-lan-round9/sub/V1-result.md` observation O5. Recommend: scope by container in the helper or rename one testid; list every render site and the helper usages.

## Output format

Markdown report with one section per item: relevant files with line numbers, current code excerpts (short), root-cause analysis, and a minimal-change proposal an implementer can follow without re-exploring. Also note any shared files between items 1-5 (for parallel-agent file ownership planning).
