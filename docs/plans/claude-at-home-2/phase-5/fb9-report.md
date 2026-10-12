# FB-9 report: phone polish (the sidebar regression, the phone sidebar, no chords on touch, the review bar's words, the list heading, a crowding sweep)

Model: Sonnet 5.5 (`claude-sonnet-5-5`). Branch `fix/friction-phone-polish` in `.claude/worktrees/art-fb9`, six commits on top of `314a19e15`
(`314a19e15..4bed2135a`), one per item. Status: DONE (one item, 5, found more than it fixed: see "Elsewhere that crowds").

| Commit | Item |
|---|---|
| `3f80bbab1` | 0. a press on the sidebar's rail opens it, whoever put it on the rail |
| `7db595a25` | 1. the phone sidebar's project row gives its count and its buttons a place each |
| `c58e319db` | 2. no keyboard chord is drawn on a touch screen |
| `690c4e68d` | 3. the phone review bar says Megtartom and Visszavonom |
| `1946d9448` | 4. the panel's list says what this chat made once |
| `4bed2135a` | 5. sweep: the conversation menu and the search field stop crowding in Hungarian |

## Gates (`scripts/gates.sh agent ... --port 5480 --workers 4`, run once at the end, all passed, 4m27s)

```
check      ok   0 errors, 17 warnings (baseline) in 8,474 files
biome      ok   2,644 files
migrations ok
vitest     ok   1,065 files, 18,112 tests passed, 2 skipped
build      ok   unused-css=32 aria=2 (baseline 32/2)
chunks     ok   editor closure 70.9 kB gzip; chat route first paint 556,353 B in 83 chunks (information only)
fallow     ok   total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright ok   179 passed, 0 skipped, 0 failed, 0 flaky (production build, 4 workers, 1m42s)
```
Specs run in full: `phone-polish` (new), `artifacts-panel-scope`, `artifact-panel-motion`, `artifact-document-keyboard`,
`artifact-document-review-bar`, `artifact-canvas-pill`, `artifact-canvas-pill-phone`, `search-modal`, `mobile-design`,
`project-page`, `home-projects`, `incognito-indicator`, `artifact-panel-history`, `conversation`; plus the `@smoke` set.

**The Canvas editor's first paint (exclusive closure, exact bytes): 72,625 B before, 72,615 B after (-10 B)**; ceiling 72,704, so
89 B of headroom now (was 79). Item 2 touched `CanvasToolbar` and `CanvasSelectionPill`: the rule is one small function in
the module they already import, and the call sites got shorter than the template strings they replaced. `isTouchDevice`
lives in a chunk the app shell already loads, so it costs nothing of the closure.

## Item 0: the regression (`stores/ui.ts`, `routes/(app)/chat/[conversationId]/+page.svelte`)

Diagnosis, confirmed by reproducing FB-5's five red tests first (`artifacts-panel-scope.spec.ts`, real "Expand sidebar" press at
1280 px with a panel docked): the page said "the panel needs the room" only while the reader's own setting was open
(`!$sidebarCollapsed` in `sidebarNeededForPanel`). A reader whose setting is the rail pressed Expand, the setting flipped to open,
the panel then needed the room, and the fold put the sidebar straight back on its rail: nothing opened. (FB-5's first candidate,
"do not flag a fold while collapsed", was already the page's rule and is what caused it.)

Fix: the page says what the panel needs whatever the reader's own choice is (the clause is gone, so a press can stand), and the
store's `toggleSidebarCollapsed()` treats any rail (folded for a panel, or chosen) alike: it opens the sidebar and, when a panel that
needs the room is docked (`sidebarFoldNeeded`, new, the page's last word), remembers the press (`sidebarFoldDismissed`) so the
fold does not return until the panel goes; on the open sidebar it collapses it, as before. The fold still returns the sidebar when
the panel closes and folds it again for the next squeezing panel; a press with no such panel is only the reader's preference (a
test holds that the dismissal does not leak into a later panel). `sidebarFoldedForPanel` can now be true while the reader's own
setting is the rail: nothing changes on screen (`isCollapsed` is an OR), it only lets the press stand.

Tests: `stores/ui.test.ts` +2 (a collapsed reader's press stands and the panel does not fold it back, then the next panel folds it;
the press is not carried over to a later panel). `artifacts-panel-scope.spec.ts` 7/7 (was 2/7), and the F3 fold tests of
`artifact-panel-motion.spec.ts` stay green.

One more, a test race and not a product bug: after the sidebar fix `artifacts-panel-scope.spec.ts:313` still failed, differently.
Since FB-3 the left chat's board plays a closing motion (about 500 ms after the click on the other chat), and
`openCanvasPanel` (`artifact-canvas-helpers.ts`, shared) treats a canvas editor still on screen within its 2 s wait as "already
open", so it returned, the board then went away and the assertion waited for a private board that was never opened. The spec now
asserts the stranger's panel is gone (`toHaveCount(0)`) before opening, as its sibling tests already do. The helper itself still has
the race for any spec that opens a panel right after moving to another chat without that assertion (none today).

## Item 1: the phone sidebar (`components/sidebar/ProjectItem.svelte`)

Reproduced with real touch (`hasTouch` + `isMobile`, Hungarian, 390/360/430): the collision is in the project folder's row. Below
`md` there is no hover, so the folder's three dots are always drawn, and the chat count that shares their 44 x 44 slot (it only gives
way to the dots on hover) was painted on top of them: one garbled glyph. Also the row was 34 px high with 44 px buttons spilling out of
it, so the folder's dots and the first chat's dots shared four pixel rows of hit area.

Fix (CSS/markup only): below `md` the slot dissolves (`max-md:contents`), the count takes its own place before the two buttons
(`max-md:static order-first min-w-5 shrink-0`), and the row is as tall as its 44 px buttons (`max-md:min-h-[46px]`, same as a chat
row). The title was already truncating, so it gives way to the count and the buttons. Desktop and tablet-with-hover are unchanged.
Test (`phone-polish.spec.ts`, 3 widths): count, new-chat button and dots do not overlap (bounding boxes), all inside the row, 44 px,
no two buttons in the whole list share a pixel, a long chat title leaves its dots whole, and a real tap on the dots opens the menu.
Red before the fix at all three widths. Shot: `fb9-shots/sidebar-360.png`, `sidebar-390.png` (taken before item 2, so the old Ctrl+K chip
is still at the top of the second).

## Item 2: no chord on a touch screen

`artifacts/document/keyboard-shortcuts.ts` gets `chordsAreDrawn()` and `withChord(text, chord)`: where the primary pointer is a finger
no chord is written; the shortcuts, `historyShortcutFor` & co and every `aria-keyshortcuts` are untouched (a tablet with a keyboard
keeps them). Every surface that writes a chord asks there:
- Document toolbar Undo/Redo, both the desktop and the phone toolbar (`toolbar-actions.ts`: the plain label key on touch);
- the change pill's Undo/Redo tooltips (`ChangeBar.svelte`: no title on touch, the name is the aria-label);
- the board's toolbar Undo/Redo and the selection pill's Ask/Comment tooltips (`withChord`);
- the sidebar's search chip ("Ctrl+K"): a `@media (hover: none) and (pointer: coarse)` rule in `Sidebar.svelte`, not a conditional, because the sidebar is
  server-rendered and the server cannot know the pointer;
- the search modal's key legend (arrows, enter, new-tab chord, esc): gone on touch, the result count stays and the footer
  goes when it has nothing left (`SearchModal.svelte`, `showsKeyLegend`);
- the composer's "Press / to start typing" hint (`MessageInput.svelte`, one condition; the file is not on my list, but it is
  the same complaint).
`AGENTS.md` (the Document keyboard paragraph) says where the rule lives.

Deviation: `chordsAreDrawn()` asks `isTouchDevice()`, the app's one detection (`viewport.svelte.ts`: `(hover: none) and (pointer: coarse)`),
and not the bare `(pointer: coarse)` of the brief; they differ only on a coarse-primary device that can hover.

Tests: `keyboard-shortcuts.test.ts` +4; `DocumentToolbar`, `MobileToolbar`, `ChangeBar` +1 each (touch draws none, `aria-keyshortcuts`
stays). `MobileToolbar.test.ts` stubbed every media query as true, which also made it a coarse pointer; it answers only reduced
motion now. e2e (`phone-polish.spec.ts`): 3 touch tests at 390 (sidebar chip hidden, no `.search-kbd`/footer, no slash hint; the
Document's Undo name and every tooltip/aria-label under the panel free of `Ctrl|⌘|⌥|⇧`; the board's toolbar and selection pill) and one
desktop control (chip, legend, `Undo your last step (Ctrl+Z)` / `(⌘Z)`, `Ask Alfy (Ctrl+Alt+A)` still there). Red on the unfixed source for the 3
touch tests.

Not done on purpose: History's help line (`HistoryMode.svelte:326` passes `historyShortcutLabel("undo")` into `artifacts.history.help`):
FB-8's; they can ask `chordsAreDrawn()`. The Canvas's screen-reader instructions ("Press Enter or Space ...") are spoken text, not drawn.
`messageBubble.sendShortcut` ("Cmd+Enter to send") is an unused dictionary key.

## Item 3: the review bar's words (`i18n/artifacts.ts`)

`keepShort` / `undoShort` in Hungarian are now "Megtartom" / "Visszavonom", the change pill's own words; English "Keep" / "Undo" stay.
Measured with touch, Hungarian, at 390 x 1 pending, 390 x 2 and 360 x 2 (the worst, with the stepper): the word fits inside its
button, the button inside the bar, the bar is one row (<= 64 px), 44 px targets, the "1 / 2" stepper shares the row; accessible names
("Mindet megtartom" / "Mindet visszavonom") unchanged. Red first on the old stems. Shots: `review-bar-360-2.png`, `review-bar-390-1.png`,
`review-bar-390-2.png`. It is tight at 360 with two changes (nothing to spare), so another word added to that row needs a second look.

## Item 4: the list's repeated heading (`DocumentWorkspace.svelte`, `i18n/artifacts.ts`)

The eyebrow `artifacts.panel.eyebrow` ("Ez a beszélgetés" / "This chat") is gone from both list headers (desktop and phone) and the key is
deleted in both languages; the title ("Amit ez a beszélgetés készített") and the crumb stay. e2e, desktop and phone, Hungarian: the visible title is
that sentence, no visible `.workspace-eyebrow`, no "Ez a beszélgetés" text. Red first. Shot: `list-phone-390.png`.

## Item 5: the sweep

Method: a throwaway spec (deleted) visited, in Hungarian with touch at 360 and 390, the landing page, a chat, the open sidebar, the
search modal, Settings, Knowledge, a project page, a Document with two pending changes and a board with a selected note, and scanned the DOM
for controls crossing the viewport edge, covered or overlapping controls, labels that wrap or are clipped; I then looked at the screens.

Fixed in files I own (commit `4bed2135a`):
- the conversation menu's rows wrapped in its 178 px ("Rögzítés az oldalsávra", "Áthelyezés projektbe", and once pinned "Rögzítés feloldása
  az oldalsávon" on three lines): the pin labels now say what they do in the sidebar they are in (**"Rögzítés"**, **"Rögzítés feloldása"**), the menu is 200 px
  (`ConversationItem.svelte`, the longest row and its chevron on one line). Shots `menu-before-360.png`, `menu-after-360.png`.
- the search field's placeholder was cut off at 360 ("... és dokumentu"): it needed 327 px of 274 (390: of 304); HU is now
  **"Keresés a munkaterületen"** (the scope chips under it say what is searched). English unchanged.
Tests: both measured with touch at 360 and 390 (row heights under one line, pinned and not; the placeholder's text width against its field), red first on the
old strings.
Clean on the heuristic and by eye: landing, chat, sidebar, the search modal's list, the Document's toolbar, inline change pills and review bar, the board's
toolbar and selection pill.

### Elsewhere that crowds (for the next round; not mine, nothing changed)
1. **Knowledge page overflows the viewport on a phone** (390 and 360): the toolbar's search field runs under the Upload button, the sort-direction and
   Upload buttons end at x = 401 of 390, the document cards' right edge is cut, the page switcher reaches x = 375 at 360. `fb9-shots/elsewhere-knowledge-390-overflow.png`
   (`routes/(app)/knowledge/+page.svelte`).
2. **Project page: the title is squeezed** at 360: the project name shares its row with "2 csevegés · aktív: 9 másodperccel ezelőtt" and gets about 106 px, so
   a long name takes four lines. `elsewhere-project-360-title.png` (`routes/(app)/projects/[projectId]`, `.home-greeting`): stack the meta under the title below ~480 px.
3. **A Document's status chip's 44 px hit area overlaps the change pill's buttons** under it by 6 px at 390 (`select.tracker-chip-select` against
   `.alfy-change-bar-action`): a tap on the lower edge of the chip. `document-390-review-bar-and-pills.png` (DocumentBody's chips; the pill is fine).
4. Unverified by eye: Settings > Profile, the card title "A tevékenységed" (Your activity) measured clipped (scrollWidth 113 over 57 at 360); the profile jump chips
   scroll horizontally by design (the third is cut at the edge, which reads as a scroller).
5. The conversation and project menus' rows are 32 px high on a phone (a finger wants 44): not crowding, so not changed here; same classes
   (`conversation-option`, `project-option`) if the owner wants it.

## Open points and hand-off

- Copy the owner may overrule (all in the owner's "short, natural" direction): HU "Megtartom" / "Visszavonom" (bar), "Rögzítés" / "Rögzítés feloldása" (menu),
  "Keresés a munkaterületen" (search placeholder; the dialog's own title is "Munkaterület keresése", so it echoes it, a tradeoff against a longer or less clear phrase).
- `sidebarFoldedForPanel` semantics: true now also when the reader's own setting is the rail and a panel would need the room (no visible effect);
  `toggleSidebarCollapsed()` on a rail always persists "open" (the reader said Expand), and keeps it open while the squeezing panel stays.
- For FB-8 / anyone writing a chord: `chordsAreDrawn()` and `withChord(text, chord)` in `components/artifacts/document/keyboard-shortcuts.ts`;
  for a server-rendered element use the media query (see `Sidebar.svelte`).
- `tests/e2e/phone-polish.spec.ts` is mine (16 tests: sidebar x3, chords x4, review bar x3, list heading x2, menu and search x4).
- Screenshots: `fb9-shots/` (12 files, listed above). I looked at more than six while debugging and checking the sweep; the folder holds the ones that matter.
- Temporary specs and probe files were deleted; the tree is clean. Servers I started were Playwright's own (ports 5480-5483), stopped by the runner.
