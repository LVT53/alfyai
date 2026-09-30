# Fix agent F-B · the Canvas board UI (RV-3 cluster B)

The Opus review (`wave-3/rv3-review.md`) split its fixes into three clusters with disjoint files. You fix **cluster B**,
the board UI. F-A fixed the protocol (merged before you: duplicate ids refused and repaired on read, a stored default
footprint for what Alfy makes, ruling 67's allow-list and stale refusal); F-C runs beside you on the App frame and the
reader's unsaved step (`AppFrame.svelte`, `CanvasEditor.svelte`, `artifact-bodies.ts`, `DocumentWorkspace.svelte`, the
chat page). Stay out of F-C's files.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxb3`, branch
  `fix/artifacts-w3-board` (from `feat/artifacts` after S3-X's and F-A's merges), e2e port **5560**, label `fb`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/fb-report.md`;
  screenshots `…/scratchpad/w3/shots/fb/`.

## Read first

`wave-3/common.md`; `wave-3/rv3-review.md` — C1 and C2 (the board's half), I2 (only its reworded conflict banner), I3,
I4, Minor 1, 2, 3, 4, 8 (the Hungarian strings), 9, 10, 11, and the fix plan's cluster B (its file list is yours);
`fa-report.md` (what the protocol now guarantees — key the checklist by the ids it repairs); `s3x-report.md` (what the
export and the chunk budget changed in the same components).

## The fixes (test first, each red before green)

C1's board half (stable keys for checklist items and any keyed list the review names; a `<svelte:boundary>` so one bad
block never keeps the whole board on its skeleton); C2's board half (an unsized legacy node is drawn at the default
footprint, never at its text's width); I3 (Undo → Redo → Undo ends clean, and the card's count follows the server); I4
(the Comment tool comments on the block that is clicked); I2's banner wording (it names what happened, never
"someone who was drawing"); the Minors listed. Keep the editor's initial chunk at or under S3-X's figure.

## Proof

Screenshots you look at yourself for every visible fix (HU; desktop, and 390×844 where the finding was on a phone). Full
gates once at the end, every artifact e2e suite included.
