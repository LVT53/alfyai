# FB-4 — the board: blocks land where they can be used, and changes read as the reader sees them (F8, F11, F12, F18, F24, F28, F9)

Part of the friction build (`phase-5/build-plan.md`, ruling 77). Read `phase-5/common.md` and the two files it names
first, then `phase-5/fa-report.md` §1 and the paragraphs for **F8, F11, F12, F18 (the board part), F24 (the board
part), F28 (handles, the attribution), F9 (the Insert menu's rows)** in §2, ruling 77's F12 and F28, and AGENTS.md's
Canvas subsection (the placer, the floating layers, the editor's lazy entries and its size gate). Screenshots:
`<scratchpad>/p5/fa-shots/` (`F08*`, `F09b*`, `F11*`, `F12*`, `F24*`, `F28*`).

- Branch / worktree: `fix/friction-board` in `.claude/worktrees/art-fb4`, from `feat/artifacts`. Ports 5420–5429.
- Report: `<scratchpad>/p5/fb4-report.md`. Beside you: FB-3 (the panel shell) and FB-6 (the Document; it owns
  `ReviewBar.svelte`). Owns: the build plan's FB-4 row.
- **The editor's first-paint closure has about 80 B of room** (72,621 of 72,704 B). Put what you add in the lazy entries
  where it belongs; if a fix cannot fit, measure exactly, say why it belongs in the first paint, and stop to report
  before raising the ceiling (ruling 68: a raise needs a recorded reason; the owner's "do all" is that reason only if
  the bytes are really needed there).

## What to fix

1. **F8.** Insert places each new block on free ground inside the visible pane (the placer, `board-placement.ts`, is the
   one place that decides where; extend it for the reader's Insert rather than placing in a component), clear of the
   board's toolbar and edges, never stacked on the block before it, and reveals it; every kind takes the focus the same
   way (the audit: Note, Text, Frame do, Chart and Checklist do not).
2. **F11.** A wide flowchart is sized by its width (or drawn top-down when the block is narrow), so its text is readable
   at 100 %; the block never shows its raw Mermaid source before the drawing (it can show a quiet placeholder).
3. **F12 (ruling 77).** Alfy's board change is counted and worded as the reader sees it: one note added is one change; a
   rewrite of a block is a change, not "removed and added" (fix it where the diff is made or read, `board-ops.ts`,
   `canvas-review.ts`, the board branch of `review.ts`, so the count, the card, the list row and the review bar agree);
   a frame that grew to make room is part of the addition. On landing the camera stays still unless the change is
   off-screen.
4. **F18 (board).** Keep and Undo leave the toolbar, the overview and the zoom control where they are (no 48 px slide).
5. **F24 (board).** Opening the comments column re-fits a board the reader has not moved (the existing `followsPane`
   rule), and never cuts a column of blocks without a way to see it.
6. **F28 (board, ruling 77).** Resize handles keep a small visible dot and get a finger-sized hit area; the "Svelte Flow"
   attribution stays but is unobtrusive (position and contrast; check the library's own option, never remove it).
7. **F9 (the Insert menu).** Items with the same name are told apart in "From this chat" (a file's extension and size,
   an item's time; no version number, ruling 76).

## Tests and gates

Red first, real input (the board specs show how: `page.mouse`, wheel, touch): F8 (five Inserts in a row on a populated
board: no overlap, all inside the pane, focus), F11 (a wide `LR` chart's label height at 100 %, no raw source frame),
F12 (one added note → "1"), F18 (no chrome moves on Keep), F24, F28 (a touch on a handle's hit area resizes). Unit tests
for the placer and the counting. Screenshots you look at yourself, at most 8, in `<scratchpad>/p5/fb4-shots/`.
`scripts/gates.sh agent <out-dir> --port 5420 --workers 4` with your specs plus every `artifact-canvas*.spec.ts` you
touch and `artifact-canvas-review.spec.ts`, `artifact-canvas-alfy-blocks.spec.ts`, `artifact-canvas-blocks.spec.ts`;
`check:artifact-chunks` exit 0.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the editor closure before → after,
concerns.
