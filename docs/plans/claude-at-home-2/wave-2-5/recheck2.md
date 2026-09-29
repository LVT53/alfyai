# Re-check 2 · the owner's walk fixes, walked the way the owner will · findings

Model: claude-sonnet-5-5. Head checked: `aaf863ad` (worktree `rv-rd`, own dev server on :5450, Hungarian UI, fresh browser context per
viewport). Report only: no product or test file changed. I drove the app with throwaway Playwright specs (seed with the real
services + fake-provider `create_artifact` / `edit_artifact` calls), all deleted before finishing (`git status` clean). Facts (every
number below) are in `rd/recheck2-facts.jsonl`; the screenshots I looked at are in `rd/shots/recheck2/`. I looked at 24 of my own
images (two were mis-clipped and re-shot; the brief's "~16" was exceeded for that reason and because the walk found a blocker
that needed three extra probes). The seed: a long Document ("Bécsi utazás", 4 tabs, 20 open comments over 4 tabs, 18 paragraphs on
tab 1, 3 pending Alfy changes, 8 versions with restore / Undo summaries), a small Document for the version walk, a real
`create_artifact` Document, an "Open as document" Document, a produced file, an App, a fork of an incognito chat.

## Verdict: NOT READY. Two blockers, both found by walking a second Document / a re-open, neither in the owner's list of eight

- **B1 (Critical)** — the panel header loses its Comments toggle, its Download popover and its Versions button as soon as the panel
  swaps to a different Document. See D1. This makes checks 1 and 2 unusable in any chat that has two items.
- **B2 (Important)** — a live Alfy change is replayed on every later re-open of that Document in the same session: the count doubles
  ("2 módosítás vár rád" with one change) and a change the owner already Kept comes back as pending. See D2. It is exactly the
  walk of check 3 (edit → Undo → back to the list → open again).
- Everything on the owner's list is otherwise built and works; the rest are small (D3, D4, nits).

## The eight checks

1. **Comments — OK** (for the first-opened Document; see B1 for the second).
   - Layout, four laptop windows, chat open, fresh context each (panel = 68 % of what is left beside the 48 px rail, capped at 950):
     1280×800 panel 837.8, text column 535.8, words 495.8; 1366×768 894.2 / 594.2 / 554.2; 1440×900 946.5 / 644.5 / 604.5; 1512×982
     950 / 648 / 608. Comment column 300 px, full height, review bar 48 px (one row) in every window. Expanded: text 937–1169 px
     column, words capped at 708 (62ch), column 300, bar 48. Screens: `c1-1280x800-chat-open-mid.png`, `c1-1440x900-chat-open-mid.png`,
     `c1-1280x800-expanded.png`, `c1-1512x982-expanded.png`.
   - Stays in view: the column's rectangle is identical before and after the wheel scrolls (y 206.7, height 593 / 561 / 693 / 775 by
     window); it is a plain stack, 10.0 px between every card (11 cards, 10 gaps of 10). Follows the reading position: the active card is
     the thread nearest the top of the text (Spanyol → három órát → Café Sperl → készpénzt → Mahler → névtelen) and the list glides to it in
     70–320 ms. With the pointer parked off the words, 8 of 8 notch scrolls ended with the followed card fully in the list (and 12 of 12
     trackpad-style scrolls, pointer at the text centre). (Earlier reads that showed the active card below the fold were my pointer resting on highlighted words:
     hovering words makes THAT thread active and deliberately does not scroll the list; a `scrollIntoView` log showed no reveal for that
     card, and parking the pointer off the words removed every case. By design, not a defect.)
   - Never fights the user: pointer in the list, list wheeled to 500, text scrolled +700 twice by script, list scrollTop stayed 500
     (`c1.fight.pointerInList`); pointer out, the list follows again in one glide. Clicking a card (not on a control) scrolls the text
     to its words (centred); clicking words brings the card in.
   - Cards match the mockup (`shots/g2b/mock-doc-1440-hu-light.png`): amber-ruled italic quote, avatar + name + time, TIPP, ghost
     Válasz / Lezárás, active card deepened; header "Megjegyzések" + amber count chip + quiet "1 lezárva" toggle; removed-text
     group and "Más fülek" rows at the end of the same list. Creating a comment through the bubble (Ctrl+Enter) puts its card at
     the right document position, fully visible; Lezárás moves the chip 14 → 13 and the toggle to "2 lezárva"; no console error.
   - Header icon: aria-pressed true → false → true; inline columns 1 → 0 → 1 (never two), the text takes the freed width (535.8 →
     835.8); expanded panel the same. Drawer: a 1024×768 window gives a 663.7 px panel, no inline column, the icon opens a 280 px
     drawer inside the panel below the header, stopping above the review bar, one list only, the icon closes it
     (`c1-drawer-1024x768.png`). Phone: a sheet (`e7-phone-comments-sheet.png`, 57 buttons, none under 44 px).
2. **Versions popover — OK** (first-opened Document). Under its `v8` button (8.5 px below, left edge within 0.3 px), 340 px wide,
   inside the panel at 1440 and 1280; rows pitch 49.3 px (current row 53.6 with its "Jelenlegi" pill); Restore is opacity 0 →
   1 on hover (110×24 "Visszaállítás") and on keyboard focus, with a 2 px accent ring (`p7-restore-focused.png`); localized
   summaries "Visszaállítva: v1", "Visszaállítva: v2", "Szerkesztve", "Alfy megírta az első vázlatot", and after Undo all
   "Alfy módosításának visszavonása" (stored as "Undid Alfy's change"). Screen: `c2-versions-1440x900-hover.png`.
3. **One version number — OK for the number.** Walk create → user edit → Alfy edit (live) → Undo → restore v1 → undo the restore →
   reload, read in the owner's order (header + chat card first, then the list row, then the popover): v1 v2 v3 v4 v5 v6 v6,
   header = card = list row = popover = the server's newest row at every step, first read after the action (0–5 ms), no reload
   (`c3.*`). Summaries stored: Undid Alfy's change / Restored v1 / Restored v4; toast "Visszaállítva: v1 mint v5 · Visszavonás".
   The pending label beside the number is NOT right after a re-open: B2 (the row read "1 módosítás vár rád" after Undo).
4. **Count button — OK.** 12 px from the header's right edge at 1280 and 1440, panel closed (`c4-header-1440x900-closed.png`)
   and open (`c4-header-1280x800-open.png`, at the chat column's right end), pending dot shown.
5. **Delete — OK** with D4. Header trash and list-row "⋯" both ask first (popover under the trash; a one-item menu from the row), copy
   per kind in Hungarian, item leaves the list, count button/panel follow (panel closes with the last item; count 2 → 1), toast
   "Dokumentum törölve". Chat card flips to the dashed "Ez a dokumentum törölve lett" + "Újragenerálás" (`d1b-deleted-card.png`),
   still deleted after a reload. Regenerate: real `create_artifact` Document (same id, from the persisted arguments, toast
   "„Weekend plan” újragenerálva", opens with its text); "Open as document" Document (the message action again makes it again);
   produced file (row "A fájl törölve lett" + Újragenerálás, POST 200, the row gives way to the re-queued job; the seeded stub request
   is not run to completion here); App: delete asked with its own copy and worked, Regenerate not exercised (not cheap). Fork of an
   incognito chat: the parent's item is a dashed card "Az eredeti beszélgetésben készült", no Open, no Regenerate, no button at all
   (`d4-fork-card.png`); the parent chat shows a normal card.
6. **Keyboard undo/redo — OK.** Real Chromium, both key maps (Linux Ctrl, macOS Cmd forced on `navigator.platform` and
   `userAgentData`): Mod-Z ×2 undoes the two typed words, Mod-Shift-Z and Ctrl-Y / Cmd-Y both redo, a redo with nothing to redo
   changes nothing, Mod-Z from a focused toolbar button undoes the text; Alfy's pill and text survive Ctrl-Z (only the reader's typing
   goes). Tooltips / accessible names: "Visszavonás (Ctrl+Z)" / "Újra (Ctrl+Y)" and on a Mac "Visszavonás (⌘Z)" / "Újra (⇧⌘Z)", with
   `aria-keyshortcuts`.
7. **Phone 390×844 — NOT OK, one target (D3).** Toolbar 7 buttons 44×44; tabs ≥ 44 both ways; the ⋯ 44×44; chip selects 44 tall
   (96.8 / 69.7 wide, hugging the value); the 7 task ticks 44×44 tap areas (17 px boxes); review bar flush (0 px from the text
   column's bottom and the viewport's), full width, radius 0, no shadow, `elementFromPoint` on its last pixel row at left / middle
   / right is the bar, three stacked rows 153 px, nothing beneath (`e7-phone-top.png`, `e7-phone-scrolled-bar.png`,
   `e7-phone-teendok.png`); comments sheet OK (`e7-phone-comments-sheet.png`); Versions sheet OK, Restore always shown as a 44 px
   column, rows 60 px (`e7-phone-versions-sheet.png`). NOT OK: the tab strip's **+** is 14×44 when the strip overflows (D3).
8. **Details — OK.** Checklists tight: row pitch 30.4–30.5 px (mockup 30.475), ticked rows `line-through` and muted (#6b6b6b vs
   #1a1a1a); chip selects hug their value ("Kifizetve" 53.7 px for a 51 px label, "Lefoglalandó" 80.8 for 78; `field-sizing: content`); review
   bar 48 px one row, flush 0 px, at 1280 / 1366 / 1440 / 1512 with three pending changes (`c8-teendok-1440x900.png`); the ⋯ and + are
   outside the tablist (only the four `tab`s are in it); rows named "Bécsi utazás, Dokumentum, 4 fül, v8, épp most, 3 módosítás vár rád",
   panel landmarks "Bécsi utazás, Dokumentum" / "Amit ez a beszélgetés készített".

## New defects

- **D1 — Critical (blocker).** Swap the open item in the panel (chat card → another card, or list → another row, or back) and the header
  loses the Comments toggle (with its badge), the Download popover (only the generic download icon is left) and the Versions button (the
  version pill is plain text). The body itself is right (title, text, tabs, review bar, rail are the new item's; nothing leaks). Sequence
  (real `create_artifact`-shaped cards, two Documents): open A → fine; open B → `[artifact-delete-button]` only, pill `SPAN`; open A →
  same; open B → same (`p10.cardSwitch`, `p9.switch`, screen `p10-second-doc-header.png`). Re-opening the SAME item (A → list → A)
  is fine, and a reload fixes it. Phone shell has the same code. Cause: G3's `00b68c6f` renders the body through `{#if}`
  so it is no longer torn down when the open item changes, while the workspace still nulls the registered actions on an item change and the
  body registers them once. `src/lib/components/document-workspace/DocumentWorkspace.svelte:280-286` (reset on `activeDocumentIdentity`),
  `:1824-1836` (mobile) and `:2140-2155` (desktop) (`<ArtifactBody>` is not keyed by the item), `src/lib/components/artifacts/document/DocumentBody.svelte:1704-1711`
  (registers once; its own comment names this case). One-line fix candidates: `{#key activeDocument.artifactId ?? activeDocument.id}` around
  both `<ArtifactBody>`s, or read `artifactId` in that registration effect. No test switches between two Documents.
- **D2 — Important (blocker for the walk).** After an Alfy edit that lands while the Document is open, any later re-mount of that
  Document's body in the same session (list → open again, close the panel → open from the card) replays that settled `alfyActivity`
  on top of the pending set the body restores from the server, so the change exists twice. Evidence: card and review bar say "2
  módosítás vár rád / Alfy 2 részt módosított … 1 / 2" with one pill and one change on the server (`p3.C.reopenedFromCard`,
  `p2.reviewBarText`, `p2-reopened-doc.png`); Undo of that pill leaves "Alfy 1 részt módosított … 1 / 1" with buttons, the card and the list row saying "1
  módosítás vár rád" while the server has 0 (`p2.4-undo-*`; it also made check 3's row read a pending change after Undo); and after
  Keep all, list → open again brings the Kept change back as pending (`p3.E.reopened`). A reload fixes it. Not affected: panel closed at
  edit time then open from the card (`p3.B`), list showing while Alfy edits (`p3.D`). Cause: `DocumentWorkspace.svelte:199-227`
  (`alfyActivitySeenOpenKeys` is never cleared, so `bodyAlfyActivity` keeps handing a settled activity to every later body) +
  `DocumentBody.svelte:891-916` / `:929-975` (`landAlfyActivity` adds entries keyed by op id) next to `:1444-1461` (restore keyed by block id).
  Pre-existing since the Wave 2.5 F1 fix (which only covered the never-seen-open case), so not from this round, but it is what the owner's
  own check-3 walk hits.
- **D3 — Minor.** `Tabs.svelte:585-589` gives the "+" `width: 44px` but it is a shrinkable flex item in a scrolling strip: 14×44 with 4
  tabs at 390 px (and with 3 tabs at 360 px), 40.8×44 with 3 tabs at 390 px; 2 tabs (any width) and 3 tabs at 430 px are 44×44
  (`e7.tabStrip`, `p5.*`). `flex: none` on `.document-tab-add` fixes it.
- **D4 — Minor.** The delete confirm of a Document made live by `create_artifact` says "Ez nem vonható vissza" although Regenerate exists
  (the deleted card then offers it); after a reload it correctly says "A beszélgetésből újra létrehozhatod" (`d1b.live.rowConfirm` vs
  `d1b.reloaded.rowConfirm`; also seen from the header, `d1.confirmText`). The live hydrate at the tool call runs before the message is
  persisted, so `markRegenerableArtifacts` (`conversation-detail/read-model.ts:118-138`) cannot mark it. Errs on the safe side.

## Observations (not blockers, not new work)

- Expanded panel: the 62ch text sits left in its column, leaving 190 px (1280) to 440 px (1512) of empty space between the words and the
  comment column (`c1-1512x982-expanded.png`).
- The header version pill's phone hit area is 42 px tall (its `::after` inset is measured from the padding box, the 1 px border is not
  counted): `ArtifactPanelHeader.svelte:281-286`. The Versions popover keeps the current row 4 px taller than the others.
- The "N megjegyzés törölt szövegen" group is not tab-scoped (it shows the Áttekintés threads' removed-text comments on the Teendők tab);
  deliberately left in the earlier review.
- The no-flash regression from the previous re-check is gone: opening a Document with a pending change from its card shows one stable label
  ("1 módosítás vár rád", `p3.B.cardTextTimeline`).

## Not verified

App Regenerate (needs a model call), a produced file regenerated to completion (seeded stub request), dark theme, the drawer inside an expanded
panel (no desktop layout reaches it), a real Mac keyboard (both key maps were forced in Chromium), the Alfy-writing / refusal paths.
