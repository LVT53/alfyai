# Review 2.5 · Artifacts redesign (Wave 2.5) · visual, accessibility, correctness

Head reviewed: `0fcbeed9` (`feat/artifacts` = `39c6493c` + the progress note), worktree `rv-rd`, port 5450.
Seeded through the real services (`createDocumentArtifact`, `createComment`, `resolveComment`, `readDocumentForAlfy` +
`applyDocumentPatch` for two pending Alfy versions, an App row with verdict `repaired` and Alfy's note), the live flow
through the fake provider (`AI_SMOKE_EDIT_ARTIFACT_MARKER`). UI in Hungarian, 1440×900 and 390×844, light and dark.
Screenshots: `scratchpad/rd/shots/review/` (NN-*.png below). DOM facts (aria snapshots, contrast scan, touch-target scan,
tab walk, `elementFromPoint` topmost checks): `scratchpad/rd/rv/facts.jsonl`. The throwaway capture spec is
`scratchpad/rd/rv/zz-rv-capture.spec.ts` (removed from the worktree; nothing committed, worktree clean).

What held up: the header, list rows, tabs strip, grouped toolbar with "Mentve", prose, inline task rows, tracker
table and chips, comment highlights, the rail's cards (quote button, avatars, Guess tag, @Alfy, Reply/Resolve with
icons), the Open/All toggle (ruling 61), Versions/Download popovers in the docked panel (topmost, Escape closes, focus
returns to the trigger), the narrow drawer (topmost, Escape, focus return), the phone Comments and Versions sheets
(topmost), the App status row/segmented control/popover (desktop, docked), the Knowledge chips (disabled zero chips with a
reason in `aria-describedby`). Automated contrast scan: 0 failures in the panel in light and dark, desktop and phone
(81 + 81 + 34 + 34 text nodes). Ruling 61's server side is right on ownership, the shared 404, `?conversationId=`,
"no marker → nothing pending", creation never pending, and "Undo is a user edit". Redo after Undo works (re-checked for
a restored and a live change). Select-all + type inside one tab replaced only that tab's section; hidden sections survived.

Counts: **3 Critical** (2 [doc], 1 [shell]) · **15 Important** (11 [doc], 4 [shell]) · **20 Minor** (13 [doc], 7 [shell]).

---

## Critical

### Critical · Phone selection composer · "Alfy megkérdezése"/"Megjegyzés" opens its sheet behind the phone panel — nothing appears [doc]
- Evidence: `14-p-composer-sheet.png` — the dialog "Alfy megkérdezése erről: „Négy nap Bécsben,”" exists at [0,406,390,438],
  but `elementFromPoint` at its centre hits `.review-bar-msg` of the panel underneath (`topDialog.phone.composerSheet`).
  `SelectionBubble.svelte:266` `<DialogShell title={composerLabel} onClose={cancel} phonePresentation="sheet">` has no
  `zIndexClass`, so it portals at `z-50` under `.workspace-mobile-backdrop` (`z-index: 95`).
- Spec: §4.3 Phone row ("composer in a sheet"); rd3b hand-off: every phone sheet opened from inside the mobile shell needs
  `zIndexClass="z-[150]"` (4a ran in parallel with 3b and missed it). Asking Alfy or commenting from a selection is
  impossible on a phone.
- Fix: add `zIndexClass="z-[150]"`; add an `elementFromPoint` "is topmost" assertion to the phone selection e2e, like
  3b's regression test in `artifact-document-comments.spec.ts`.

### Critical · App panel on phone · "Módosítás…" opens the regenerate sheet behind the phone panel [shell]
- Evidence: `15-p-app-regen.png` — dialog "Min változtasson?" at [0,534,390,310], `elementFromPoint` hits
  `IFRAME.app-frame` (`topDialog.phone.appRegen`). `AppBody.svelte:647` `<DialogShell … phonePresentation="sheet">`
  without `zIndexClass`.
- Spec: §6.2 "Change this app… opens a popover (a sheet on phones)". v2 cannot be requested on a phone.
- Fix: `zIndexClass="z-[150]"` + a topmost assertion in `artifact-app.spec.ts` at 390×844.

### Critical · Review bar on phone · The bar balloons to ~390 px and covers half the document [doc]
- Evidence: `11-p-doc-light.png`, `16-p-doc-dark.png` — bar rect y 392→780 on an 844 px screen (`phone.reviewbar`); the
  change pill and the text around it are hidden, the summary floats in an empty box. Cause: `ReviewBar.svelte:123`
  `.review-bar-msg { flex: 1 1 16.25rem }`; under the ≤480 px rule (`:178 flex-direction: column`) that 260 px basis
  becomes a height.
- Spec: §4.3 Phone — "bar above the toolbar with 44 px Keep all / Undo all"; mockup's compact bar.
- Fix: in the phone query set `.review-bar-msg { flex: 0 0 auto }` (or keep row direction and let it wrap); while there,
  make prev/next 44 px (4b's open item #4) and give the text column bottom padding equal to the bar so the last lines
  can scroll above it.

---

## Important

### Important · Chat card, list row, count-button dot · They ignore the review state (before and after a reload) [shell]
- Evidence (live flow, `17/18/19-live-*.png`): after "Mindet megtartom" the server's pending set is 0
  (`live.serverPendingAfterKeep`), yet the in-chat card still reads "1 módosítás vár rád · 1 részt nem érintett ·
  Átnézés ›" — while the panel is open and after it closes — and the count button shows its dot again once the panel is
  closed (`19-live-after-keep-closed.png`). The reverse after a reload: the document has 2 pending changes (review bar
  "Alfy 2 részt módosított.", `02-d-doc-light.png`) but the list row (`01-d-list-light.png`), the card and the dot show
  nothing. All three read the ephemeral `liveDocumentAlfyActivity` (`+page.svelte:973`, `ToolActivityRow.svelte:143`,
  `DocumentWorkspace.svelte:532`).
- Spec: §4.2 "Afterwards the card reads ✓ Reviewed"; §5.3 dot = "a change waits while the panel is closed"; ruling 61
  (pending survives a reload). This is 4b's open item #3, and it is wider than the dot.
- Fix: one pending count per Document as the single source — add `pendingReviewCount` to `ArtifactCardSummary`
  (`artifacts/read-model.ts`, from `getDocumentReviewState`'s pure computation) for load/refresh, and let the open body
  report its live count (`onPendingReviewCountChange?: (n) => void` in `ArtifactBodyProps`, wired in
  `DocumentWorkspace.svelte`/`+page.svelte`). Card: "✓ Átnézve" once an activity's changes are all decided; dot and row
  pill from the same count. Split: [shell] owns `artifact-bodies.ts`, read model, page, card, list; the [doc] agent adds
  the one call in `DocumentBody.svelte` (`onPendingReviewCountChange?.(pendingList.length)` in an effect).

### Important · Document opened from the chat card · Each applied change is counted twice [doc]
- Evidence: `18-live-opened-from-card.png` — one applied change, one pill, but "Alfy 2 részt módosított." and "1 / 2"
  (`live.opened.pills` 1). When the edit lands while the panel is closed and the user opens it from the card (the main
  "Átnézés ›" path), `runLoad` resets `handledActivityKey` (`DocumentBody.svelte:1502`), so the `alfyActivity` effect
  replays `landAlfyActivity` (entries keyed by op id) and `restorePendingReview` (`:1036`) adds entries keyed by block id
  for the same block. The later mark replaces the earlier one (same mark type), so the ghost entry has no pill but is
  counted; the stepper's second stop goes nowhere.
- Fix: one entry per block — when restoring, skip block ids that already have a live entry (and when landing live, drop
  a restored entry for the same block); better, skip the replay when the body mounts after the activity settled and let
  the server restore (which carries the true parent text) own it.

### Important · Document scroll · "One scroll" is two nested scrollers, so rail cards drift from their words [doc]
- Evidence: long document with comments at paragraphs 3 and 40 (`06b-d-longdoc-outer-scrolled.png`, `longdoc.*`):
  `.document-content-text` scrolls on its own (185 px) inside the `.document-content` grid scroller; after scrolling,
  paragraph 40's card sits at y 768 while its highlight is at y 522. Cause: `DocumentBody.svelte:1999`
  `.document-content-text { overflow-x: auto }` — a non-visible `overflow-x` makes the column a vertical scroller too.
- Spec: §3.2 "the rail is a 300 px column inside the same scroll container … one scroll, so nothing is out of reach, and
  the scroll-sync effect goes".
- Fix: make `.document-content` the only vertical scroller — put horizontal overflow on the table wrapper only (or use
  `overflow-x: clip` on the column), and add an e2e that scrolls a long commented document and compares a card's top
  with its highlight's.

### Important · Review bar placement · It scrolls away, covers the rail, and hides the last lines [doc]
- Evidence: the bar is `position: absolute` inside the scroller (`DocumentBody.svelte:2024`). (1) Once the grid scrolls
  (any document whose rail is taller than the panel) the bar goes with it: y −1272 after scrolling to the end while a
  change is still pending (`longdoc.outer`, `06b`). (2) It spans both grid columns and covers the rail's last rows —
  "Más füleken · Költségvetés …" is cut under it in `02-d-doc-light.png`. (3) The text has no bottom padding: at the end
  of a long document the last paragraph (y 845–900) stays under the bar (y 830–886); a pill on an appended paragraph
  would be unreachable.
- Spec: §4.2 item 5 "rises at the bottom of the text column"; mockup `.review` pinned under the text column.
- Fix: `position: sticky; bottom: …` inside the text column (or mount it in `.document-main` outside the scroller),
  width limited to the text column, and bottom padding equal to its height while it shows.

### Important · Versions · Opening a Document with pending changes writes an empty "Edited" user version [doc]
- Evidence: after only opening a seeded document (v1 user, v2/v3 Alfy) the history gains "v4 · user · Edited" whose body
  is byte-identical to v3 (sqlite diff empty; `versions.afterSecondOpen`); the live flow shows the same ("v3 user
  Edited", `live.versions`). The Versions popover then lists "Te · v4 · Jelenlegi · Edited" while the header still says
  v3 (`03-d-versions-light.png`). Cause: `remarkAlfyChange` (`marks.ts:325`, ruling 61's restore) and the live mark /
  Keep's mark clear are doc-changing transactions; `createDocumentEditor`'s `onUpdate` (`document-editor.ts:85`) treats
  every doc change as a user edit → `handleUpdate` → autosave; the server stores the identical body as a new version.
- Why it matters: history pollution on every reload with pending changes, a fake "you edited" entry, a version bump the
  user did not cause; "Edited" is also English in the HU UI.
- Fix: mark-only transactions set a meta (e.g. `alfyMarkOnly`) that `onUpdate`/`handleDirty` ignore, or schedule only
  when the canonical markdown differs from the last saved; server-side, a save whose hash equals the current body
  should not append a version.

### Important · Review stepper · Next/previous never switch tabs; a change in another tab is unreachable [doc]
- Evidence: two pending changes, in Áttekintés and Napról napra; after "Következő módosítás" the selected tab stays
  Áttekintés and nothing visible happens (`review.nextSwitchesTab`). `handleReviewNext` (`DocumentBody.svelte:1016`) →
  `seeChange` → `scrollToChangeFn`; the target block is `display:none` in the hidden section.
- Spec: §4.3 "Several changes — stepper moves between them (switching tab if needed)".
- Fix: map the change's block to its tab (`mapBlocksToTabs`), `handleTabActivate(tabId)` first, then scroll and flash
  after `tick()`. Same for "See change" from a comment chip and the refusal's "Nézd meg, mit csinált Alfy".

### Important · Ruling 61 persistence · A kept block that Alfy changes again is never pending again after a reload [doc]
- Evidence (service-level repro, `M.review`): Alfy edit A changes b1 and b2 → Keep b1 → Alfy edit B changes b1 again →
  `getDocumentReviewState` returns only b2; stored `{ throughVersion: 1, keptBlockIds: ["py6jg7"] }`.
  `computePendingReviewBlocks` (`document-ops.ts`) excludes any id in `keptBlockIds` whatever version was kept, and the
  list is cleared only when nothing is pending. Realistic flow: keep one of two changes, ask Alfy to refine the same
  paragraph, reload — the refinement is silently treated as reviewed.
- Fix: record what was kept per version (`{ blockId, version }` or `"id@n"`) and exclude a block only when its last Alfy
  change is not newer than the kept version; or remove a block id from `keptBlockIds` in `applyDocumentPatch` when a
  new Alfy version changes it. While there: `POST /review` stores any strings it is sent — keep only ids in the current
  pending set. (Server file, but part of the review surface — the [doc] agent owns it; no [shell] finding touches it.)

### Important · Pending change · A user's own edit of the block does not acknowledge it in the session [doc]
- Evidence: typed " most" into the pending hotel paragraph: the pill and "Alfy 2 részt módosított." stay
  (`userEdit.pillsAfter` 2) while the server has already dropped it (`userEdit.serverPending` lists only Hétfő). Clicking
  Undo now restores the pre-Alfy text and throws away the user's own typing with it.
- Spec: ruling 61 "a user's own edit to such a block acknowledges it" (today only true after a reload).
- Fix: in `handleUpdate`, when a non-mark-only transaction touches a pending entry's block, drop the entry (or set it
  kept) and call `acknowledgeReview([blockId])`.

### Important · Header when opened from the chat card · No version button and no time [shell]
- Evidence: `18-live-opened-from-card.png` — the meta line shows only "Dokumentum". `ToolActivityRow.svelte:238`
  `handleOpenArtifact` builds the item without `versionNumber`/`updatedAt`; the header draws the version button only
  when `versionNumber > 0` (`DocumentWorkspace.svelte:1329`). The version button is the only way into Versions now, and
  "Átnézés ›" is the main way into a changed document. Related: the header shows the item's snapshot, not the body's
  live number (v3 while the server is at v4), so §7.2 #15's bump never happens.
- Fix: when opening from a card, fill `versionNumber`/`updatedAt` from `conversationArtifacts`; better, let the body
  report its live version (same callback shape as the pending count) and feed the header from it.

### Important · Expanded panel · The App popover renders under the panel; one Escape closes the popover and the expanded view [shell]
- Evidence: expanded, "Módosítás…" → `elementFromPoint` hits the iframe (`topmost.appRegen.expanded` isTop false):
  `.app-regen-popover { z-index: 60 }` (`AppBody.svelte:1022`) vs `.workspace-shell-expanded { z-index: 115 }`
  (`DocumentWorkspace.svelte:2632`). With the Versions popover open in expanded mode, one Escape closed the popover and
  returned the panel to docked (`expanded.afterEscVersions.panelExpanded`): the workspace's window keydown listener
  (`:801`) is registered before the popover's focus trap, so it runs first and `defaultPrevented` is still false.
- Spec: §5.4 "Escape closes the innermost layer first (popover, sheet, composer, then the panel)".
- Fix: popovers above the expanded shell (e.g. 130, one shared constant); `handleWindowKeydown` returns early while a
  popover/sheet/composer is registered (DialogShell's `isTopmostDialog` stack, which the popovers already join).

### Important · Expanded panel · The Versions popover is off-screen and under the panel; Download is under it too [doc]
- Evidence: `05-d-expanded-versions.png` — popover at x −138 and not topmost (hit = the tab strip). `VersionsSheet.svelte:164`
  right-aligns the 340 px popover to the trigger's right edge; the trigger sits near the panel's left edge, so it runs
  off-screen in expanded mode and over the chat column in docked mode (`03-d-versions-light.png`). Both popovers use
  `z-index: 60` (`VersionsSheet.svelte:354`, `DownloadSheet.svelte:254`).
- Fix: anchor Versions to the trigger's left edge, clamp into the viewport, and use the shared popover z-index from the
  [shell] fix above.

### Important · App panel · Status row, Preview/Code and "Módosítás…" sit flush against the panel edges [shell]
- Evidence: `08-d-app-dark.png`, `09-d-app-regen-light.png`, `15-p-app-regen.png` — the shield icon starts at the panel
  border (x≈497 vs the header text at 515), the "Módosítás…" button and "Alfy megjegyzésének elolvasása" touch the right
  border; on the phone everything starts at x≈2 while the header has 20 px.
- Spec: mockup d / §6.2 — the status row and the Preview/Code row align with the header.
- Fix: give `.app-status`, the segmented row and the stage the header's inline padding (20 px desktop, 16 px phone).

### Important · Tabs · The ⋯ menu is clipped inside the tab strip; Rename/Delete are unreachable [doc]
- Evidence: `23-d-budget-tab-menu.png` — after ⋯ only a 2 px sliver shows; the menu box is y 157–236, the strip ends at
  162 with `overflow-x: auto` (`Tabs.svelte:275`, computed overflow-y auto); `elementFromPoint` at the menu's centre hits a
  toolbar button (`tabmenu.geom`). Keyboard: focus stays on ⋯, ArrowDown does nothing, Escape leaves the menu open.
- Spec: §5.2 "Rename and Delete move into a ⋯ menu on the active tab".
- Fix: portal the menu to body (`portalToBody`, positioned from the button rect), focus the first item on open, arrow
  keys, Escape closes and returns focus to ⋯.

### Important · Tabs · A new tab shows the whole document [doc]
- Evidence: after "+" the new tab "Új szakasz" is selected and all 15 blocks stay visible (`newtab`); `extensions.ts:662`
  returns an empty decoration set when the active tab owns no block (rd2's safety net).
- Spec: ruling 61 "Tabs show only their own section"; §5.2.
- Fix (rd2's own suggestion): `addTab` appends an empty paragraph with a minted id, uses it as the tab's `startBlockId`,
  and puts the caret there; then the fallback is unreachable.

### Important · Selection pill · Not reachable by keyboard [doc]
- Evidence: with text selected in the first paragraph, Tab goes to the next comment highlight inside the editor
  (`selection.tabInto`: SPAN "hosszú ebédek", not in the bubble); the pill comes after every highlight, chip select,
  change pill and checkbox in the editor. Only ⌘/Ctrl+Alt+M (Comment) reaches the composer; Ask Alfy has no keyboard path.
- Spec: §4.4 "Tab from a non-collapsed selection moves into it; Escape returns to the text with the selection intact".
- Fix: a ProseMirror `handleKeyDown` for Tab when the selection is non-empty and the bubble shows → focus the pill's
  first button; arrow keys inside the `role="toolbar"`; Escape restores focus and selection.

---

## Minor

### Minor · Change pill · Its group name has an empty quote; HU names do not contain the visible labels [doc]
`doc.pillGroupNames` = ["Alfy módosítása: ", …] — `change-pill-decoration.ts` never passes `blockLabel` to `ChangeBar`
(and `ChangePillEntry` has no label). HU accessible names "Alfy módosításának megtartása/visszavonása/megismétlése" do
not contain the visible "Megtartom/Visszavonom/Újra" (WCAG 2.5.3 Label in Name). Keep/Undo re-mount the widget, so
focus drops to `<body>`. Fix: carry `blockLabel` in the entry; start the HU names with the visible word ("Megtartom —
Alfy módosítása"); after Keep/Undo move focus to the new pill's Redo or the review bar.

### Minor · Announcements · Status changes are not announced [doc]
No polite announcement for comment added/resolved, Alfy's reply landing, Kept/Undone (§3.4, §4.4). The review bar and
the refusal notice are `role="status"` regions inserted together with their text (commonly not announced), and the
review bar's region wraps its buttons, so every stepper move re-reads the whole bar. Fix: one visually hidden announcer
mounted with the body, fed by these events; the bar becomes a plain `region`.

### Minor · Tabs ARIA [doc]
`aria-controls="document-tabpanel-…"` points to ids that do not exist (`doc.tabs.controls`); the tablist also owns the
⋯ and + buttons (`doc.tabs.aria`); the badge reads as a bare number ("Áttekintés 3"). Fix: give the editor host
`role="tabpanel"` with the active id (or drop `aria-controls`), move ⋯/+ out of the tablist element, sr-only "3 nyitott
megjegyzés" for the badge.

### Minor · Composer · Escape only works from the textarea [doc]
Escape on a suggestion chip or on Mégse leaves the composer open (`composer.escapeFromChip.stillOpen` 1). Fix: handle
Escape on the composer container (§4.2 "Escape cancels and restores the selection").

### Minor · Phone touch targets under 44 px [doc] (+ two [shell])
`targets.phone-doc`: tabs 28 px tall, ⋯ 20×20, + 24×24, mobile toolbar 36×36 (§5.4 says 44), chip selects 22 px, task
checkboxes 17 px (rd1's deviation); in the Comments sheet the filter toggle 17 px, quote buttons 19 px, removed-text
toggle 17 px, other-tab rows 27 px (`targets.phone-comments-sheet`; §3.4 "44 px in the phone sheet"). [shell]: the
breadcrumb 28 px and the version button 22 px tall. Fix: `::after` hit areas in the phone query, as the change pill does.

### Minor · Comments sheet and drawer · Cards keep the rail's anchor offsets; drawer covers the header [doc]
The first card starts ~150 px down in an otherwise empty sheet (`12-p-comments-sheet.png`) and drawer
(`22-d-narrow-drawer.png`); the sheet does not put refusal notes first or group threads by tab (§3.2 Phone); the drawer is
`top: 0` and covers the panel header's actions (`CommentsSheet.svelte:151`). Fix: plain stacking when rendered in a
sheet/drawer; start the drawer below the header.

### Minor · Rail copy and counts [doc]
"Költségvetés · 1 nyitott · 0 lezárva" shows the zero (mockup omits it); the other-tab row counts exclude orphaned
threads while the tab badge includes them (Áttekintés badge 3 vs "2 nyitott", `23-…png`); the removed-text toggle is
uppercase ("1 MEGJEGYZÉS TÖRÖLT SZÖVEGEN") where the mockup uses sentence case; a single-tab document says "Nincs
megjegyzés ezen a fülön".

### Minor · Prose · Loose checklists; chip select width [doc]
Every task item is its own `ul[data-type=taskList]` (one block each), so each carries `margin: 6px 0 16px` and the list
reads ~22 px looser per row than the mockup (`02-d-doc-light.png`); fix with a sibling rule collapsing the margin between
adjacent task lists. The status chip select is as wide as its longest option ("Kifizetve" with an empty tail).

### Minor · English strings in the HU UI [doc]
Chip select accessible name "status"; task checkbox names "Task item checkbox for …" (Tiptap's default); version
summaries "Edited" and "restored …" (server strings shown verbatim in the Versions popover). Fix: localized
`aria-label`s; map known server summaries to i18n keys in the popover.

### Minor · Versions popover rows [doc]
The hidden Restore button reserves its space, so rows have uneven gaps (`03-d-versions-light.png`); use
`visibility`-free layout (absolute or zero-height until hover/focus).

### Minor · Refusal placement [doc]
Shown as a full-width tinted banner above the text and the rail (`18-…png`), not a margin card beside the refused
line; on phones it is not the first item in the Comments sheet (§4.2). rd4a's knowing deviation — triaged "can wait".

### Minor · Undo's version summary [doc]
Undo saves through the generic autosave ("Edited"), not "Undid Alfy's change" (§4.2 item 6).

### Minor · Comment and Versions avatars · The user is a placeholder "U" next to "Te" [doc]
`02-d-doc-light.png`, `03-…png` (rd3a's deviation). Fix: pass the signed-in user's initial/avatar (the layout already
has it) to `CommentCard`/`VersionsSheet`.

### Minor · Panel focus and name [shell]
Opening the panel does not move focus to the title / first row (§5.4); the `<aside>` is named "Dokumentum-munkaterület"
for every item rather than "Bécsi utazás, Dokumentum".

### Minor · App a11y details [shell]
The collapsed "Alfy megjegyzése" stays in the accessibility tree (`app.status.aria`); the busy veil is a live region
inserted with its text (may not announce). Fix: `hidden`/`inert` while collapsed; a persistent live region.

### Minor · Knowledge chips on phones [shell]
Chips are 29 px tall (§6.4: 36 px with 44 px hit areas), and they carry no kind icons (§6.2).

### Minor · btn-primary hover contrast [shell]
"Módosítás…" measured 4.36:1 while hovered (11.5 px text) — the 18 % hover tint drops `--accent-text` under 4.5:1
(`contrast.desktop-light-app`). Fix: keep the hover tint at 12 % and change the border only, or darken the hover text.

### Minor · In-chat card version is stale [shell]
The card says "v1" after the edit made v2 (`19-…png`).

### Minor · Header meta [shell]
"Dokumentum · v3 · épp most" — the mockup's "Te és Alfy · szerkesztve 2 perce" authorship is missing.

### Minor · Motion details [shell]
The toast enters from above (`in:flyIn={{ y: -12 }}`), §7.2 #33 says it rises; popovers/drawer use hard-coded 150/220 ms
with the same in/out timing instead of the tokens (§7.2 #23: out micro · ease-in). Everything else checked in code has a
reduced path (every Svelte transition is wrapped in `reducedMotionAware`, CSS rides app.css's global override, the flash
holds a static ring). Reduced motion was not exercised in a browser this pass.

---

## Not verified this pass
"Alfy is writing" in place (the fake model's tool call and result arrive in one chunk); the creating/failed in-chat
cards (unit-tested only); the App busy veil and v2 toast live (no fake regenerate scenario — the code path is right:
`versions[0]` is the newest, Undo restores it through `restoreArtifactVersion`, the frame is `inert` while busy); the
Knowledge Files tray (no uploads seeded).

---

## Deferred items · triage

| Item (source) | Call | Reason |
|---|---|---|
| Count button dot does not follow the persisted state (rd4b #3, progress) | **Fix first** | Part of Important "Chat card, list row, count-button dot"; the owner hits it on the first review |
| "Reviewed" card state (rd5a) | **Fix first** | Same fix; the card must stop saying "1 módosítás vár rád" after Keep |
| A new empty tab shows the whole document (rd2) | **Fix first** | Ruling 61 tabs; the first "+" the owner clicks shows everything |
| No version button on a Document header (progress, rd2) | **Fix first** | Missing on the card path (Important "Header when opened from the chat card"); list path is fine |
| Review bar prev/next 40 px on phones (rd4b #4) | **Fix first** | One line in the same phone rule as the Critical review-bar fix |
| User avatar placeholder "U" (rd3a) | **Fix first** | Visible on every thread and version row; one prop |
| Redo loses extra blocks of a multi-block insert (rd4b #1) | Can wait | Rare; the primary block redoes correctly |
| Thread change chip has no badge after a reload (rd3a, rd4b #2) | Can wait | Cosmetic; pill/bar carry the state |
| `undoAlfyChange` collapses an existing empty block (rd4b #5, pre-existing) | Can wait | Rare (Alfy filling an empty paragraph); fix before Canvas/Slides reuse it, since a tab's start block could vanish |
| Removed-text group not tab-scoped (rd3a) | Can wait | Needs stored "original tab"; harmless |
| Refusal not pinned in the margin; not first in the phone sheet (rd4a) | Can wait | Works as a banner with the dashed line rule |
| No "reading → writing" two-phase label (rd4a) | Can wait | No real signal behind it |
| `blockRect` exported but unused (rd4a) | Can wait | Dead code cleanup |
| Pending highlight shows from the pill stage (rd4a) | Can wait | Deliberate, harmless |
| Drawer ignores the expanded presentation (rd3b) | Can wait | Narrow window + expanded only; take it with the popover z-index pass |
| No wide-desktop rail-hide toggle (rd3b) | Can wait | Not asked; no content lost |
| Document checkboxes 17 px on phones (rd1) | Can wait | Do it with the Minor touch-target pass if time allows |
| "Cancelled" → warning tone; h1/h4–h6 sizes (rd1) | Can wait | Reasonable calls, no spec value |
| No chevron on status chips, no date icon (rd1) | Can wait | Cosmetic |
| No Tailwind easing utilities (rd1) | Can wait | Nothing uses them |
| Item view width does not animate; push navigation entrance only (rd2) | Can wait | Motion polish |
| "Deleted" card state (rd5a) | Can wait | Needs a server signal |
| Per-chip 20 ms stagger and collapse-out (rd5k) | Can wait | Motion polish |
| Unused `knowledge.documents.totalLabel` (rd5k) | Can wait | Wire into the summary or delete in a cleanup |
| "Alkalmazások 0" clips at 390 px HU (rd5k, pre-existing) | Can wait | Not reproduced this pass (chips wrapped) |
| Summary line shape, canvas/slides counts not pluralized (rd5k) | Can wait | Copy polish |
| No Preview↔Code cross-fade (rd5b) | Can wait | Motion polish; reduced path already correct |
| No download-busy feedback in the header (rd5b) | Can wait | Double submit is guarded |
| No Versions browsing for App (rd5b) | Can wait | The mockup has none either |
| Regenerate popover repeats its title as the label (rd5b) | Can wait | Make the label `sr-only` when convenient |
| Creating/failed cards not captured in HU (rd5b) | Can wait | Unit-tested; the owner will see them live |

---

## Verdict

**Not ready for the owner as it stands; ready after fixes.** Fix first: the 3 Critical findings, all 15 Important
findings, and the six "fix first" deferred items above (most overlap). Then re-run the phone pass (390×844, HU): the two
sheets topmost, a compact review bar, the pill and the last lines visible; and the live card flow: edit with the panel
closed → "Átnézés ›" → one change counted → Mindet megtartom → card "Átnézve", no dot → reload → nothing pending.
