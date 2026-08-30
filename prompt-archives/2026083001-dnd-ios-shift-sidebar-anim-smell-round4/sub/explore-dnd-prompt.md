You are a read-only code explorer for a Bun + React monorepo (tmex). Do NOT modify files. Write your findings as a markdown report to stdout (concise, technical, with file:line references).

Topic: the device-management page drag-and-drop in `packages/panels/src/device-folders/` (device-folder-tree.tsx, collision.ts, snap-to-cursor.ts, folder-tree-model.ts, and related hooks) plus its consumer `apps/fe/src/pages/devices/`. It uses @dnd-kit (core + sortable).

Bug report from the user: a device card A sits at index 0. The user presses the drag handle and drags to position 2, then 3 — the other cards shift out of the way ("displace", like iOS home-screen icons). But when dragging A back toward its original position (e.g. back over index 0/1), the other cards do NOT shift back / do not displace. The desired behaviour is full iOS-style displacement: no matter where the dragged card is, siblings always re-flow around it, including when returning to the original slot.

Please find out:
1. Exactly how the "optimistic layout during drag" is computed: which state holds the in-flight order, how `onDragOver` / collision detection updates it, and what the hit-test regions are (droppable rects, sortable strategy, `closestCenter` filtering in collision.ts).
2. Why moving back over the original slot (or over the placeholder / the dragged item's own slot) doesn't trigger a re-order. Typical suspects: the collision detection returning the active item's own id (ignored), the placeholder occupying the original slot so `over === active.id` short-circuits, the `over` id not changing when hovering the gap, rect cache not updated after optimistic reorder (measuring config), or `arrayMove` being skipped when `overIndex === activeIndex`.
3. How the existing tests (`collision.test.ts`, `device-tree-dnd.test.ts`, `device-folders-view.test.tsx`) cover this, so a regression test can be added.
4. Propose the minimal concrete fix (which file, which function, what logic) to achieve iOS-style displacement in both directions, keeping the existing cross-container placeholder behaviour. Mention any dnd-kit config knobs (`measuring`, `MeasuringStrategy.Always`, `rectSortingStrategy` vs custom, `useSortable`'s `transform` when `isDragging`) that matter.

Keep the report under ~250 lines.
