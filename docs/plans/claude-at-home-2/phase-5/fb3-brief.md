# FB-3 — the panel's motion and layout: one motion language (F3, F4, F15, F19, F26)

Part of the friction build (`phase-5/build-plan.md`, ruling 77). This is the audit's main "clanky" pattern: layout
changes are instant cuts while the content they make room for fades in 100–250 ms later. Read `phase-5/common.md` and
the two files it names first, then `phase-5/fa-report.md` §1, §3 (pattern 1) and the paragraphs for **F3, F4, F15,
F19, F26** in §2, ruling 77's F3 and F4 (with F15, F18, F19, F25, F26), and the redesign's motion spec
(`docs/design/artifacts-redesign/redesign.md` §7, by range). Screenshots: `<scratchpad>/p5/fa-shots/` (`F03*`, `F04*`,
`F15*`, `F19*`, `F26*`).

- Branch / worktree: `fix/friction-panel` in `.claude/worktrees/art-fb3`, from `feat/artifacts`. Ports 5400–5409.
- Report: `<scratchpad>/p5/fb3-report.md`. Beside you: FB-4 (the board, `components/artifacts/canvas/**`) and FB-6 (the
  Document and comments, `components/artifacts/document/**`, `ReviewBar.svelte`, the comment components). Owns: the
  build plan's FB-3 row. `DocumentWorkspace.svelte`'s rows, list, headers and history entries are FB-5's later: change
  only the shell parts (dock, expand, close, the delete flow, where the tour card goes).

## What to fix

1. **F4.** Opening, closing, expanding, deleting and reloading with the panel open move the chat column and the panel
   together, on the same curve and duration (`MOTION_DURATION` and the existing motion helper), so the chat re-wraps once
   while the panel arrives, never a cut followed by a fade; reduced motion makes both instant. Measure the layout shift
   of each change before and after (the audit's numbers: open 0.25, reload 0.18, expand 1.0, delete 2.35); the target is
   that nothing jumps after its first frame.
2. **F3.** While the panel is docked and the chat column would fall below a floor (choose it from the audit's numbers:
   the composer is usable at ~340 px, not at 268 or 134), the sidebar folds to its rail and returns when the panel
   closes, and the panel gives up width before the chat goes under the floor. The header's crumb never collides with the
   count chip at 1100.
3. **F19.** Deleting the open item shows the list without closing the panel (no frame of a full-width chat).
4. **F26.** Expand animates like everything else; X in the expanded view closes the panel (not dock it); after a close,
   the count button brings back the item that was open, if it still exists.
5. **F15.** The tour card's room is made before the body paints (reserved or overlaid), so nothing the reader just saw
   moves; the Canvas does not re-fit for it; on a phone the text does not start below the middle of the screen while the
   card is up; the empty state's replay link hides while the replay card is up.

## Tests and gates

Red first, real input: one Playwright spec that measures layout shift (a `PerformanceObserver` for `layout-shift` read
by the test is fine; drive with real clicks) for open, reload, expand, delete, close; F3 at 1100/1280/1440 with the
sidebar open; F26's X and count button; F15 with a fresh user. Screenshots you look at yourself, at most 8 (frame strips
are fine), in `<scratchpad>/p5/fb3-shots/`. `scripts/gates.sh agent <out-dir> --port 5400 --workers 4` with your specs
plus `artifacts-panel.spec.ts`, `artifact-panel-*.spec.ts`, `artifact-tours*.spec.ts`, `artifact-chat-card.spec.ts`,
`artifact-card-narrow.spec.ts`, `chat.spec.ts`, `project-panel-over-dialog.spec.ts`.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the layout-shift numbers before →
after, concerns.
