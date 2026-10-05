# Fix agent TR-D1 · the tour card arrives without moving what the reader is looking at (RC-T, reader side)

RC-T re-checked the tours (`wave-4/rct-report.md`: verdict ready, 2 Important, 14 Minor). You fix the reader side before
they go to ai.dev; TR-D2 fixes the admin side beside you. **Read RC-T's report first**: I-1 and Minors 5, 6, 7, 8(a, b),
11, and its "Method notes for a fix agent" (how to reproduce I-1: delay `**/api/artifact-tours/*` 400–500 ms, a tall board
of 21 notes, a fresh user from `tests/e2e/artifact-tours-helpers.ts`).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-trd1`, branch
  `fix/tours-reader` (from `feat/artifacts-tours` `c66d80c1`), e2e port **5410**, label `trd1`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/trd1-report.md`;
  screenshots `…/scratchpad/w4/shots/trd1/`.
- Read first: `wave-4/common.md` (+ the Wave 3 rules); rulings 33, 68 (its last note), 71; the TR-B hand-off
  (`wave-4/trb-report.md`); AGENTS.md's Tours section and the Canvas subsection's "floating layers" paragraph.

## Steps

1. **I-1, red first with real input and the delayed answer.** The card must not shove the item down after the reader can
   already read it, and a populated board must never be left with rows under the fold. Your design, within these rules:
   ask for the tour as early as the panel knows the kind (not after the body painted), keep what a reader has already
   answered for this session (Minor 11: one request per kind per page load, invalidated by a 409) — which also removes
   Minor 7's flash of the default empty line — let the card enter and leave with a short height transition (instant under
   reduced motion) rather than in one frame, and have the Canvas **re-fit when its pane changes size while the reader has
   not moved the camera since the last fit** (the card arriving, the card leaving, a window resize), never once they have.
   Prove: the Document's text does not jump more than a transition; the 21-note board shows every note with the card up
   and after it closes; the camera stays where the reader put it once they panned.
2. **The small ones.** Minor 6: the live region announces the new step's title (and position) when Next/Back is pressed.
   Minor 5: the list row's menu either behaves as a menu (ArrowDown/ArrowUp move between its items, focus starts on the
   first item, Escape closes and returns focus) or stops claiming `role="menu"` — pick one, test it with the keyboard.
   Minor 8(b): the step line reads "1. lépés / 3" (EN "Step 1 of 3" stays). Minor 8(a) is TR-D2's (it is the server's
   default copy).

The chat route has ~25 B of headroom: keep the session cache and any transition code small, measure, and move
`--chat-baseline` only by your measured growth with the numbers (ruling 68's note). Then the full gates once (Wave 3 rules'
list; Playwright with `artifact-tours*.spec.ts` and every artifact suite). Screenshots you look at yourself (HU, 1440
light): the 21-note board with the card up and after closing; the Document mid-entrance is not needed — prove it with
numbers in the test.

**Runs beside you:** TR-D2 on `fix/tours-admin` (admin pane, campaigns service, tour defaults, the badge route,
`settings.ts`). You touch `DocumentWorkspace.svelte`, `artifacts/tour/**`, `canvas/**` for the re-fit,
`ArtifactDeletePopover.svelte`, `client/api/artifact-tours.ts` (reader functions only) and `i18n/artifacts.ts`.
