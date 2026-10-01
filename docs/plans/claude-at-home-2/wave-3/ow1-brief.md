# Owner-walk agent OW-1 · Undo, the Keep/Undo pill's place, and frames that behave like groups

The owner walked the Canvas on ai.dev (`63bc6626`) and hit four things every gate had passed. Quote: "I can't undo
actions." — "sometimes the 'Keep Undo' row moves into weird locations far from the element" — "what's the point of
adding canvas elements into bigger groups if I can't even select the group when I click inside its empty areas or even
move it/resize it anywhere?" **Reproduce each in the real app first** (the e2e fake provider, a seeded board, real
pointer and keyboard input through Playwright, the way a person does it) and find the root cause before you change code
(the systematic-debugging discipline: evidence, hypothesis, a failing test, the fix).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-ow1`, branch
  `fix/canvas-owner-walk-1` (from `feat/artifacts`), e2e port **5610**, label `ow1`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/ow1-report.md`;
  screenshots `…/scratchpad/w3/shots/ow1/`.
- **Agent OW-C runs at the same time** on chart blocks (`canvas/nodes/ChartNode.svelte`, chart registration, the chat's
  `Chart.svelte`, the "From this chat" listing's chart source). Stay out of those.
- After you, agent OW-2 adds multi-select move/resize on the same board code: leave the selection and drag plumbing
  clean and say in your hand-off where multi-select plugs in.

## Read first

`wave-3/common.md`; rulings 16 (two undos: your own steps with ⌘/Ctrl+Z vs Alfy's change with Keep/Undo) and 63; AGENTS.md's
Canvas subsection; the hand-offs of `s3f-report.md` (the unified in-session history, frames, the drag handler),
`s3c-report.md` (`land` empties the reader's undo), `s3a-report.md` (the pill and review bar), `fb-report.md` (I3, Minor
11 the pill), `fc-report.md` (flush and rebase), `fd-report.md` (N3: floating layers inside the pane).

## 1 · Undo works

Reproduce: move a note, add a note, draw a stroke, delete a block, change a frame — then ⌘Z (Mac) / Ctrl+Z, and the
toolbar's Undo; also after the autosave has written (wait > 1 s) and after reopening the panel. Find why nothing is undone
(suspects to rule in or out with evidence: the history emptied by every server re-read that `land`/`adoptServerBoard` or
the rebase treats as new; the key event never reaching the board — focus, Svelte Flow, the workspace's shortcut
handling; the toolbar button disabled). Fix the cause; Redo too. e2e per action type, red first.

## 2 · The Keep/Undo pill stays with what changed

Reproduce the pill far from its element: a change to a note **inside a frame** (frame-relative positions), a change after
panning/zooming, a change touching blocks far apart, a phone. The pill belongs next to the changed block(s) — for several
far-apart blocks, next to the one the review bar is showing, never at an empty bounding-box corner. e2e measuring the
pill's distance from the changed block's box, red first.

## 3 · A frame is a group you can grab

- Clicking **anywhere inside a frame's empty area** selects the frame (a click on a child still selects the child).
- Dragging a selected frame by its body (not only its label bar) moves it **with its children**; the children keep their
  places inside it.
- A selected frame has resize handles on all four corners and edges; resizing never cuts a child off (the frame cannot
  shrink past its children, or the children stay put and the frame shows they overflow — pick one, say why).
- Keyboard: a selected frame moves with the arrow keys like any block; Delete keeps ruling-backed behaviour (children
  re-homed, S3-P).
- Each is a version the reader can undo (step 1). e2e for select-by-empty-area, drag-with-children, each resize handle.

## Proof

Screenshots you look at yourself (HU, 1440 light and 390): a frame selected with its handles, mid-resize, the pill beside a
changed note inside a frame. Full gates once at the end (`common.md`, the size budgets as their own step).
