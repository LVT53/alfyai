# Owner-walk agent OW-2 · select several blocks and move, resize or delete them together

The owner, walking the Canvas on ai.dev: "I'd also like a new option added, to multi-select elements on the canvas and
move them/resize them together." OW-1 (merged before you) fixed undo, the pill's place and frames as groups; read its
hand-off first — it says where multi-select plugs in.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-ow2`, branch
  `feat/canvas-multi-select` (from `feat/artifacts` after OW-1's merge), e2e port **5630**, label `ow2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/ow2-report.md`;
  screenshots `…/scratchpad/w3/shots/ow2/`.

## Read first

`wave-3/common.md`; `ow1-report.md` (hand-off); AGENTS.md's Canvas subsection; ruling 16 (your steps are one undoable
history); the Svelte Flow **v1** multi-selection API in the installed `@xyflow/svelte` `.d.ts` (`selectionOnDrag`,
`selectionMode`, `multiSelectionKey`, `panOnDrag`, `onselectionchange`, the selection box) — never React Flow memory.

## What to build

1. **Selecting several** — Shift-click (and ⌘/Ctrl-click) adds or removes a block; with the Select tool, a drag on empty
   board draws a marquee that selects what it covers (partial or full — pick the one that feels like Figma/Miro and say
   so); panning stays on the Hand tool, Space+drag, the middle button, two fingers and the trackpad. Escape clears. On a
   phone: a long-press starts a selection and taps add to it (or the toolbar's Select mode does — say which), 44 px targets.
2. **Moving together** — dragging any selected block moves all of them; arrow keys nudge all; a move into or out of a
   frame reparents each block by the same rule as a single drag.
3. **Resizing together** — one bounding box with corner/edge handles around the selection; resizing scales the blocks'
   positions and sizes proportionally inside it (text blocks and notes keep a readable minimum; say what you clamp).
4. **Together, not piecemeal** — each gesture on a selection is **one** step in the reader's undo history and one save;
   Delete removes all selected (a frame's children re-homed as today); the selection pill's Ask Alfy / Comment act on
   the whole selection where they already take several blocks.
5. Tests: e2e for shift-click, marquee, group drag, group resize (positions and sizes checked), undo of each as one step,
   Delete, reload keeps the result; unit tests for the scaling math. Red first.

Keep the editor's first paint within ruling 68 (anything heavy loads when a selection first has two blocks).

## Proof

Screenshots you look at yourself (HU, 1440 light and dark, 390): a marquee, a selection with its box and handles, mid-group-
resize. Full gates once at the end (the size budgets as their own step).
