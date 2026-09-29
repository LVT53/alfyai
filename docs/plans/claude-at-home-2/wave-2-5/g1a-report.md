# G1-A report — the comment margin, after the owner's walk (Wave 2.5 polish)

Model: claude-sonnet-5-5. Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g1a`,
branch `polish/artifacts-comments`, base `78c94588`, e2e port 5500. Commit range **`78c94588..f8186844`** (7 commits).

```
1c225f3d feat(artifacts): pure helpers for the comment margin's order, tab counts and scroll-follow
050c8873 feat(ui-store): remember per device whether the Document comment column is hidden
7946ec92 feat(artifacts): the comment margin is a kept-in-view list, and the header icon toggles it
3591531b fix(artifacts): keep the review bar pinned in the new text scroller, and cover the comment column in e2e
b74f52db feat(artifacts): refusal card in the comment family, 44px phone targets, refusal placement in e2e
342da24d feat(artifacts): the comments drawer stops above the review bar; scroll-follow reads the highlights in one pass
f8186844 style(artifacts): refusal card icon gap; cover the fold and quote in CommentThread tests
```

Status: **DONE** (all four of the owner's findings and the review items fixed; gates green; two things I noticed and did
not touch are listed under "Concerns").

## The four findings, and what changed

The owner's findings were: (1) the comments look awkward, (2) they do not fit a laptop, (3) the comments scroll away with
the text ("only the section title" stayed), (4) the header icon opens a second copy of the comments.

**Layout (rulings 1 and 3).** The text column is now *the* scroller (`contentEl`, `.document-content-text`); the row
around it (`.document-content`) does not scroll; the comment column (`aside.document-content-rail`) is its sibling, full
height, with its own scrolling list (`.margin-panel-list`) under a fixed header. So the list stays in view however far the
text scrolls, and its own scrollbar is used only when it is longer than the viewport. Cards are a plain stack with a 10 px
gap in **document order** (block, then offset inside the block, then oldest first), not anchor heights. The anchor-height
engine `margin-layout.ts` and its test are **deleted** (Fallow ends at the baseline); the ordering, per-tab counts and the
follow choice live in the new pure module `document/comment-threads.ts` (26 tests).

**Scroll-follow (ruling 1).** On scroll (one animation frame, one pass over the text's highlights) the thread whose words
are nearest the top of the reading area becomes active (card chrome + its words deepen) and its card is brought into the
list (`scrollIntoView({block:"nearest"})`, instant under reduced motion). It never fires while the pointer is over the list
or focus is inside it (`pointerInside`/`focusInside` in `MarginPanel`), never takes focus, and hovering a card/words wins
over the followed thread and gives way to it again afterwards (`activeCommentId = hoverCommentId ?? followCommentId`).
Clicking a card (anywhere that is not one of its own controls, and not while text is selected) scrolls the text to its
words; clicking highlighted words scrolls to and focuses the card (unchanged); a just-created comment's card is brought in
at once so its flight lands on it.

**One toggle (ruling 2).** The header's Comments button is `aria-pressed`: on a wide panel it shows/hides the column (the
text takes the freed width) and the choice is remembered per device in the UI store (`documentCommentsRailHidden`,
`src/lib/stores/ui.ts`, no new raw key); on a narrow panel it opens/closes the drawer; on a phone the sheet. Exactly one
comments surface is mounted at a time (the inline column is no longer mounted hidden beside the drawer). Clicking
highlighted words with the column switched off brings it back. Plumbing: `ArtifactPanelBodyActions.toggleComments`
(replaces `openComments`) and `ArtifactBodyProps.onCommentsShownChange` (`artifact-bodies.ts`); tooltip says "Hide/Show
comments" while the accessible name stays "Comments (n)".

**Laptop fit (ruling 3).** `commentRailWidth(panelWidth)` = clamp(240, panel − 480, 300) px, and `null` (no inline column,
drawer instead) when the panel is under 720 px, so the text column never drops under 480 px (about 440 px of words a line).
Measured in Chromium, Hungarian UI, chat and docked panel side by side (the panel is 68 % of what is left of the window
beside the 48 px sidebar rail):

| window | panel body | text column | words per line | comment column |
|---|---|---|---|---|
| 1280×800 | 835.8 | 535.8 | 495.8 | 300 |
| 1366×768 | 894.2 | 594.2 | 554.2 | 300 |
| 1440×900 | 944.5 | 644.5 | 604.5 | 300 |
| 1512×982 | 948.0 | 648.0 | 608.0 | 300 |
| expanded 1280×800 | 1237 | 937 | 708 (62ch cap) | 300 |
| expanded 1440×900 | 1397 | 1097 | 708 | 300 |
| expanded 1512×982 | 1469 | 1169 | 708 | 300 |

Expanded at 1366×768 is asserted by the e2e (text ≥ 480, words ≥ 440, column 240–300) but I did not record its numbers.
Narrow: a 1024×768 window gives a 661.7 px panel → no inline column, drawer. The column only narrows below 300 px in the
band 720–780 px panels (e.g. 750 px → 270 px), which no laptop layout with the 48 px rail lands in; the 240 px case is
covered by a unit test and by a screenshot with the column forced to 240 px (header wraps its toggle to a second line).

**Styling to the approved mockup (ruling 4).** Each thread is a real card (`--surface-page`, `--border-default`,
`--radius-lg`, tokens only): amber-ruled italic serif quote line ("· elmozdult" when moved, struck + dashed rule for removed
text), avatar column + name/time (+ "Tipp"), `@Alfy` accent, a thin line joining the avatars, ghost actions under the words,
the change chip, the reply composer; a resolved thread is a dashed card whose fold line reads its first words (the
mockup's), the quote going with the full thread. Header: "Megjegyzések", an amber count chip (open threads on this tab —
the very number on the tab badge; sr-only "6 nyitott megjegyzés"), the quiet "N lezárva" ↔ "Csak a nyitottak" toggle
(ruling 61 kept). The removed-text group and the "Más füleken" rows are at the end of the *same* scrolling list, sentence
case, so nothing is ever behind the review bar (the bar lives in the text column only).

## Review items

- **(239–244) sheet and drawer.** `MarginPanel layout="grouped"`: plain stack, refusal note first, then every tab's threads
  under the tab's name (no name for a one-section document), then the removed-text group. The drawer is now *inside the
  panel* (`position:absolute` in `.document-content`): it starts below the header/tabs/toolbar (asserted: its top ≥ the
  header button's bottom, and the button stays the topmost element and closes it), follows the panel wherever it is, and
  stops above the review bar (`bottomInset`) so Keep all / Undo all stay reachable (asserted). Its close button is in the
  comments header row.
- **(245–250) copy and counts.** No zero counts ("1 nyitott"; `otherTabOpen`/`otherTabResolved` keys joined with " · ");
  the other-tab counts, the header count and the tab badges all come from one helper (`countCommentsByTab`), orphaned
  threads counted the same way; sentence case for the removed-text toggle; single-section empty text "Még nincs megjegyzés…"
  and "Itt minden megjegyzés le van zárva." when only resolved threads exist. All EN + HU in `src/lib/i18n/artifacts.ts`.
- **(265–268) refusal placement.** `RefusalNotice` takes the thread cards' shape (radius, border, padding, bold warning
  title, Ask again secondary + Dismiss ghost) and is listed in the comment list at its line's position (before threads on
  the same line; at the top when its line is in another tab, so it can still be seen; first in a sheet/drawer); the dashed
  amber gutter rule on the refused line was already there. The old full-width banner is gone. "Ask again" now switches to
  the refused line's tab first.
- **(233–238) phone targets.** Filter toggle, quote buttons, removed-text toggle, the change link get an invisible `::after`
  hit area (inset −14 px); rows, Reply/Resolve/Reopen, the fold line and the composer buttons are 44 px tall on phones. The
  e2e measures the real hit area (own box grown by its `::after`) at 390×844: all ≥ 43.5 px.

## Tests

Unit (vitest): `comment-threads.test.ts` 26 (order, tab counts vs badges, grouping, follow choice, `commentRailWidth`);
`MarginPanel.test.ts` 19 → 54 (order/no anchor offsets, header/count, empty states, other-tab rows, reveal + the
pointer/focus/force guards + token replay, card click, refusal position ×5, grouped layout, close button, reduced motion);
`CommentsSheet.test.ts` 5 → 8 (in-panel drawer, close in header, grouped order for sheet and drawer, `bottomInset`);
`CommentThread.test.ts` +2 (fold reads first words, quote goes with the full thread); `DocumentBody.test.ts` 65 → 78
(toggle ×3 presentations and remembered choice, widths 1000/750, drawer one-surface, highlight click revives a hidden
column, refusal card in the column, scroll-follow ×6); `ui.test.ts` +4. Deleted with the engine: `margin-layout.test.ts`
(10) and MarginPanel's measurement-debounce/`onAnchorsChange` tests.
Playwright: `artifact-document-comments.spec.ts` 13 → 19 tests (replaced the two obsolete "single scroller / card aligned
with its highlight" tests; new: one text scroller, list stays in view + follows the words, no fighting while the pointer is
in the list, even 8–12 px gaps in document order, two-way link, header toggle remembered across a reload, laptop fit ×4
docked + expanded, the narrow drawer test rewritten for 1024×768 with the below-the-header/toggle/Escape assertions, phone
44 px targets); `artifact-document-review-bar.spec.ts` +1 (drawer stops above the bar) and the scroller selector updated;
`artifact-document.spec.ts` +1 (refusal card between the threads either side of its line) + placement/dashed-rule
assertions in the existing refusal test.

## Gates (final state, `f8186844`)

1. `npm run check`: 0 errors, 17 warnings (the pre-existing 17, none new).
2. `npx biome check src scripts tests`: clean.
3. `npm test`: 897 files passed | 1 skipped, **13,849 tests passed** | 2 skipped.
4. Playwright, port 5500, the full list (`artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation`), run on
   `342da24d` (the last commit with a source-code change; after it only a CSS gap, comments and tests changed): **110 passed,
   2 failed** — `artifact-chat-card.spec.ts:211` (final assistant text not seen within 30 s; the flake rd3b already
   recorded) and `artifact-document.spec.ts:1326` (version pill read v1 where v2 was expected inside its 5 s; a timing race
   in the review-state/version refresh, G1-B's area). Both pass alone, and both whole files (26 tests) pass on a rerun. On
   the final commit `f8186844` I re-ran the comments, document, review-bar, selection-bubble and panel specs: **59 passed,
   0 failed**.
5. Fallow: **124 issues, 4 circular dependencies — exactly the baseline** (4 unused exports I introduced were un-exported).

## Screenshots (Hungarian, not committed) — `…/scratchpad/rd/shots/g1a/`

Each looked at once against the mockup's HU rail (`docs/design/artifacts-redesign/index.html`, surface a):
`01-laptop-1280x800-mid-hu-light.png`, `02-laptop-1440x900-mid-hu-light.png`, `03-laptop-1440x900-mid-hu-dark.png`,
`04-laptop-1512x982-mid-hu-light.png` (long Document scrolled to 40 %, chat open, the followed card active),
`05-rail-hidden-1440x900-hu-light.png` (toggle off: the text takes the width, the review bar is one row),
`06-narrow-drawer-1024x768-hu-light.png` (drawer in the panel below the header, stopping above the review bar),
`07-phone-sheet-390x844-hu-light.png`, `08-refusal-in-rail-1440x900-hu-light.png` (live refusal between two threads, dashed
rule on its line). `facts.jsonl` has the measured geometry. Defects the screenshots caught, all fixed: (a) the sticky review
bar scrolled away with the text once the text column became the scroller (a sticky element only travels inside its
parent's box — the scroller itself was only viewport tall; fixed with a `.document-content-flow` parent, and the existing
review-bar e2e now runs against the new scroller); (b) an active card in the removed-text group had its border clipped by
the fold; (c) the drawer covered the review bar's buttons; (d) the refusal card's Ask-again icon had no gap.

## Deviations from the spec / brief, with reasons

- Spec §3.2 (cards beside their anchors via `margin-layout.ts`, one shared scroll, 300 px rail that never goes under 280,
  drawer below 820 px) is superseded by the owner's words and rulings 1–3: plain ordered list in its own scroller, 240–300 px,
  drawer below 720 px. `docs/design/artifacts-redesign/redesign.md` §3.2/§8/§9 still describe the old layout (I did not edit
  design docs).
- The header shows a count and the *single* quiet toggle of ruling 61, not the mockup's two-button "Nyitott | Összes".
- The fold line of a resolved thread now shows its first words (the mockup) instead of its quote (rd3a's choice); the quote
  row folds away with the thread instead of sitting above the fold line.
- The rail's "in other tabs" rows exist only in the inline column; the sheet/drawer list every tab under its name instead
  (the spec's own phone description).
- Anchor resolution moved out of `MarginPanel` into `DocumentBody` (a `$derived` fed to the editor's highlights *and* passed
  down as `resolutions`), because the highlights must stay when the column is hidden or unmounted; `onAnchorsChange` and
  `contentEl` are gone from `MarginPanel`/`CommentsSheet`.
- Motion #22's *exit* (Dismiss slides 8 px right and fades) is not implemented: it never was, and Svelte out-transitions
  never finish under the repo's jsdom animation mock (the Toast problem G1-B is handling); the entrance (rise 6 px) is.
- Docs check: Context7 and the Svelte MCP were not available; I used the repo's own Svelte 5 patterns (runes, snippets,
  actions, `{@attach}`, `style:`) and relied on `svelte-check`/the compiler/the tests; I did not WebFetch svelte.dev.

## Concerns (not touched)

- `ReviewBar.svelte` wraps to two rows (≈96 px tall) inside a 645 px text column with the Hungarian strings — its
  `flex: 1 1 260px` message basis is the mockup's own; it now only covers text, never the column, but an owner-visible
  polish item for whoever owns that file (one row when the column is hidden, two rows beside the column at 1440).
- The filter (Open/All) and the removed-text fold are local to the mounted list, so they reset when the column is toggled
  off and on or the sheet is closed. Hoisting them to `DocumentBody` is a few lines if the owner minds.
- The drawer inside an *expanded* panel follows it by construction, but no desktop layout reaches it (the expanded panel is
  ≥ 728 px wide wherever the desktop shell shows), so that combination has no e2e.

## Hand-off — reuse these

- `document/comment-threads.ts`: `resolveCommentAnchors`, `commentAnchorTargets`, `orderCommentsByPosition`,
  `countCommentsByTab` / `otherTabRows` (the one tab-count rule shared with the badges), `groupResolvableByTab`,
  `tabIdForComment`, `pickFollowedComment`, `commentRailWidth`. A Canvas/Slides comment surface should reuse the *shape*
  (pure ordering/counting + a scroll-follow choice) rather than placing cards at anchors.
- `MarginPanel` props: `layout: "rail" | "grouped"`, `resolutions`, `refusal`, `focusRequest`, `revealRequest {commentId,
  token, force?}`, `onClose`; test ids `margin-comment`, `margin-orphaned-group`, new `margin-panel-list`; classes
  `.margin-panel-item.is-active/.is-resolved/.is-goto`. `CommentsSheet`: `presentation`, `bottomInset`.
- Layout classes in `DocumentBody`: `.document-content` (row, no scroll) › `.document-content-text` (the scroller =
  `contentEl`) › `.document-content-flow` (sticky parent, `min-height:100%`) › editor host + `.document-review-bar-slot`;
  sibling `.document-content-rail`. **Lesson:** `position: sticky` only travels inside its parent's box — never make the
  scroller the sticky element's parent.
- `documentCommentsRailHidden` (UI store), `ArtifactPanelBodyActions.toggleComments`, `ArtifactBodyProps.onCommentsShownChange`.
- Requests that a list acts on (`focusRequest`, `revealRequest`) are one-shot: the sender clears them once the surface that
  should act has mounted (`handleEditorAnchorActivate`), or a remount replays a stale one.
- Phone tap targets: `::after { inset: -0.875rem … }` for small text controls, `min-height: 44px` for rows/buttons, inside
  `@media (max-width: 767px)`.
