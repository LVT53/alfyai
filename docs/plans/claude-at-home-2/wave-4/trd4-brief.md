# Agent TR-D4 · on a phone, the block being typed in stays in view when the keyboard opens

TR-D3 (merged; `wave-4/trd3-report.md`, concern 1) made a board stop moving at the reader's first touch. That leaves one
gap it measured: with `interactive-widget=resizes-content` (`src/app.html`) an Android keyboard shortens the pane, so a note
lower than the keyboard's top edge is hidden while the reader types in it (390×844, a 336 px keyboard: the sixth note 116 px
below the pane), and the browser cannot scroll it into view (the flow library undoes the wrapper's scroll). **The owner
asked for this fix (2026-10-06).**

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-trd4`, branch
  `fix/canvas-keyboard-reveal` (from `feat/artifacts` `86a736b5`, which holds TR-D3), e2e port **5490**, label `trd4`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/trd4-report.md`;
  screenshots `…/scratchpad/w4/shots/trd4/`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); TR-D3's report (its rule,
  its `artifact-canvas-refit.spec.ts` and the suggested design under concern 1); ruling 68 and its notes; AGENTS.md's Canvas
  subsection (the floating layers paragraph and "The board follows its pane only until the reader touches it").

## The rule (orchestrator)

When a field inside a block is being edited and the part of the pane the reader can see stops covering that block —
the keyboard shortens the pane (Android), or the visual viewport shrinks over it (iOS overlays its keyboard: read
`window.visualViewport` where it exists) — the camera **pans by the least distance** that brings the block (or, for a block
taller than the room left, the field with the caret) fully into view, clear of the board's own floating toolbar, with a
small margin. **Never zoom.** Once per focus: after that the camera is the reader's again, and a pan of their own is never
fought. Nothing happens when the block is already in view, on desktop, or when the keyboard closes (the camera stays). Under
reduced motion the pan is instant; otherwise short.

## Steps

1. **Red first, real input.** Playwright at 390×844 with touch: a board whose lowest note sits near the pane's bottom; a
   real tap to edit it; the viewport shortened by 336 px the way a keyboard does (`page.setViewportSize`); type: the note's
   field is fully inside the visible pane above the toolbar and the zoom is unchanged; restore the height: nothing jumps. A
   note already in view: the camera does not move. Desktop: no movement. TR-D3's refit spec stays green.
2. **The fix, smallest that holds**, with the pan arithmetic as a pure function and unit tests (least distance in x and y,
   the margin, the toolbar's box, a block taller than the room, never a zoom). Keep it out of a lazy entry only if it is tiny;
   measure the editor's first paint and report before/after. The ceiling is 71,680 B with ~108 B left: if you need more,
   **do not edit the ceiling yourself** — report the measured number and the orchestrator records the raise (ruling 68 note,
   the owner's request).

**The chat route on your base is over its budget** by FU-2's and W4-B's merged strings (~350 B): the orchestrator re-baselines
that on `feat/artifacts` separately. Report your own chat-route growth measured against your base; do not move
`--chat-baseline`. Then the full gates once (Wave 3 rules' list; Playwright with every artifact suite including the tours').
Screenshots you look at yourself: the phone board before the keyboard, with it (the note visible above the toolbar), after.

**Runs beside you:** W4-E (evidence rows in the message's Sources panel; `message-evidence.ts`, `MessageEvidenceDetails.svelte`,
`i18n/artifacts.ts`). No shared files.
