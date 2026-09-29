# Polish agent G1-A · The comment margin, after the owner's walk (Wave 2.5 polish)

The owner walked the redesign on ai.dev (`1e755e0b`) and said, about the Document's comments:
> "the comments section is a little awkward looking with its styling. Not to mention that it doesn't really fit properly
> on my laptop's screen … The comments themselves should scroll with the viewport, not just the section title. And
> currently it looks like I can open comments 2 times, the second time being clicking on the icon in the top right, but it
> would be much better if that icon just closed and opened the already open comments sidebar."

See it as they did: `rd/shots/review/02-d-doc-light.png` (same folder as this brief): cards float at their anchors'
heights with uneven gaps and no card shape, the removed-text toggle is uppercase, "MÁS FÜLEKEN" is cut off by the review
bar, and the header's comment icon (top right, badge "4") opens a second comments view.

**Agent G1-B runs at the same time** on the Versions popover, the chat header's count button, the toast, the in-chat
card's deleted state and Undo's version summary (`VersionsSheet.svelte`, `DownloadSheet.svelte`, `Toast.svelte`,
`ArtifactCard.svelte`, `ToolActivityRow.svelte`, the chat page, the artifacts read model): do not edit those.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g1a`, branch
  `polish/artifacts-comments`, e2e port **5500**, label `g1a`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/g1a-report.md`
- Screenshots: `…/scratchpad/rd/shots/g1a/` (same scratchpad as the report).
- Read first: `rd/common.md`; then the hand-off sections of `rd/rd3a-report.md`, `rd/rd3b-report.md`, `rd/fxb-report.md`
  (the one-scroll layout and review-bar placement) and `rd/fxc-report.md`; the mockup's rail (`index.html`: `#rail`,
  `.rail-filter`, `#railBody` and the thread cards — open it in Playwright, HU) is the visual reference the owner approved.

## Rulings for this work (orchestrator, from the owner's words)

1. **The comment list stays in view while the text scrolls.** The desktop rail becomes a sticky column (below the panel's
   header/tabs/toolbar, above the review bar) whose list scrolls on its own when longer than the viewport. Cards are
   stacked with even gaps, ordered by their words' position in the document. As the reader scrolls the text, the thread
   whose words are nearest the top of the reading area gets the active state and is brought into view in the list
   (never while the pointer or focus is inside the list — do not fight the user). Clicking a card scrolls the text to its
   words; clicking highlighted words brings the thread into view and focuses it (today's two-way linking stays). The
   anchor-height placement (`margin-layout.ts`) no longer drives the desktop rail; if that leaves it unused, delete it and
   its test (Fallow must end with zero new findings).
2. **The header's comment icon toggles the margin; it never opens a second copy.** Desktop: it shows/hides the rail
   (pressed = shown), and the text column takes the freed width. Narrow panel: it opens/closes the drawer. Phone: it opens
   the sheet. One comments surface at a time. The choice is remembered per device through the existing UI store
   (`src/lib/stores/ui.ts`), not a new raw storage key. Default: shown when the panel is wide enough for both columns.
3. **Laptop fit.** With the chat and the panel side by side at 1280×800, 1366×768, 1440×900 and 1512×982 (and the
   expanded panel), the text column never drops below a comfortable reading width (about 440 px): the rail narrows
   (about 240–300 px) and, below that, starts hidden with the toggle to open it as a drawer. Measure it; state the numbers
   in the report.
4. **Styling to the approved mockup:** each thread is a real card (surface, border, radius, padding from the tokens),
   consistent 8–12 px gaps, the quote line, avatar/name/time, `@Alfy` highlight, actions as small ghost buttons; the
   header shows "Megjegyzések", the count and the quiet Open/All toggle; the removed-text group and the other-tab rows sit
   at the end of the list in sentence case and are never hidden behind the review bar.

## Also yours (from the review, `rd/review-2-5.md`)

- (239–244) Comments sheet and drawer: plain stacking (no anchor offsets), refusal notes first, threads grouped by tab;
  the drawer starts below the panel header and does not cover its actions; it respects the expanded presentation.
- (245–250) Rail copy and counts: no zero counts ("1 nyitott", not "1 nyitott · 0 lezárva"), other-tab counts match the
  tab badges (orphaned threads counted the same way), sentence case, the single-tab empty text.
- (265–268) Refusal placement: a warning card of the comment family in the list at its line's position (and first in the
  phone sheet), with the dashed amber rule on the refused line — not a full-width banner above the text.
- (233–238) the Comments sheet's phone touch targets (filter toggle, quote buttons, removed-text toggle, other-tab rows)
  at 44 px, with `::after` hit areas where the visual size should stay.

## Proof

- Tests first: the rail's order and active-thread follow (and that it does not move while the user is in the list), the
  toggle's three presentations and remembered choice, the laptop-width behaviour, the sheet/drawer stacking and
  refusal-first order, the copy/count rules.
- Playwright: every artifact suite at the end (`rd/common.md` gate 4); geometry checks wait with
  `waitForStableBoundingBox`.
- Screenshots in Hungarian, and **look at each one yourself against the mockup**: a long Document scrolled to the middle
  at 1280×800, 1440×900 and 1512×982 (light; 1440 also dark) with the chat open; the rail hidden by the toggle; the narrow
  drawer; the phone sheet at 390×844.
