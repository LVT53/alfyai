# Fix agent F-D · what the owner would trip over on the first walk (RC-3 N1, N2, N3, N5, N7, N9)

The final re-check (`wave-3/rc3-report.md`) called the Canvas ready for the owner, with one Important and a list of
Minors. You fix the ones the owner would meet on the first walk, before the deploy.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxd3`, branch
  `fix/artifacts-w3-walk` (from `feat/artifacts`), e2e port **5600**, label `fd`. No other agent runs.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/fd-report.md`;
  screenshots `…/scratchpad/w3/shots/fd/`.

## Read first

`wave-3/common.md`; `wave-3/rc3-report.md` §N1–N9 (lines ~138–153) and its screenshots it names
(`…/scratchpad/w3/shots/rc3/`); `fa-report.md` (the stored default footprint), `fb-report.md` (the drawn width);
rulings 62 (catalogue: measure, raise the ceiling by the measured cost, update both snapshots in the same commit), 67, 68.

## Fixes (each with RC-3's test sketch, red before green)

- **N1** — charts and checklists Alfy adds get their own default sizes (one table per kind, used by the create/ops path,
  the model's read, the board's draw and the eval's `sizeOf` alike), so a chart's plot is not a sliver, nothing is planned
  at a height it is not drawn at, and a checklist shows its items; one tool-text sentence if the model must know.
- **N3** — every floating layer stays inside the pane (the change pill, the phone selection bar), the selection bar never
  sits on the pill's Keep/Undo, and the phone zoom control never covers a selected block (RC-3's `elementFromPoint`
  sketch at 1440 and 390).
- **N2** — deleting a board deletes its poster files too, in the facade's cascade (not the route), with the ownership
  scope; a removed block's poster goes with it when the board next saves, if that is cheap — say which you did.
- **N5** — the exported picture leaves out the checklist's add row. **N7** — Insert → Frame places a new frame on free
  ground like other blocks. **N9** — AGENTS.md's flush sentence names the queued follow-up exception (one line).

## Proof

Screenshots you look at yourself: an Alfy-made board with a chart and a checklist (1440 light, 390 light), the pill and
the selection bar near the left edge on a phone, a board with a new frame, the exported PNG. Full gates once at the end,
every artifact suite. Final reply at most 10 lines: status, model ID, commit range, one-line gates, catalogue numbers.
