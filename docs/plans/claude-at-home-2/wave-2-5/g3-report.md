# Polish agent G3 report — keyboard undo/redo, the editor's undo edges, tabs ARIA and targets, named rows, phone review bar, ticked tasks, the dot's test

Model: claude-sonnet-5-5. Worktree `…/.claude/worktrees/art-g3`, branch `polish/artifacts-keys-and-edges`, e2e port 5520.
Commit range `924452a7..00b68c6f` (14 commits, 46 files, about +3,860/−400). Nothing pushed, merged or rebased. Status: **DONE**
(with concerns listed at the end).

## Gates (final HEAD `00b68c6f`)

1. `npm run check`: **0 errors, 17 warnings** (the pre-existing 17: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
2. `npx biome check src scripts tests`: clean (2,175 files).
3. `npm test`: **910 files passed (1 skipped), 14,150 tests passed (2 skipped)**.
4. Playwright on 5520, every artifact suite + knowledge + chat + conversation (`artifact*.spec.ts artifacts-*.spec.ts knowledge.spec.ts chat.spec.ts conversation.spec.ts`), one run: **167 passed, 0 failed** (7.7 min). Log: `rd/g3-e2e.log`.
5. Fallow: **124 issues, 4 circular dependencies**: exactly the baseline (`/tmp/fallow-g3.json`).

## Item 1 — keyboard undo/redo: what I found, and what I changed

### What works today (measured, not assumed)
Real Chromium through Playwright, on both key mappings (Playwright's Desktop Chrome reports a Windows platform, so I forced
`navigator.platform` **and** `navigator.userAgentData` to a Mac / Linux pair before load; forcing only the first leaves the client
hint saying Windows):

- **Editor focused:** Mod-Z, Mod-Shift-Z and Mod-Y (Ctrl on Windows/Linux, Cmd on macOS; Ctrl-Shift-Z and Ctrl-Y both redo on
  Windows/Linux, Cmd-Y also on a Mac) already undo and redo the reader's own typing, through Tiptap StarterKit's `UndoRedo` binding.
  Nothing global swallows them: I read every window/document `keydown` listener (Escape in DocumentWorkspace, SelectionBubble's
  Escape and ⌘/Ctrl+Alt+M, the composer's slash, the sidebar's ⌘K); none touches Z or Y.
- **After the toolbar's Undo/Redo click:** focus comes back to the text (`chain().focus()`, deferred by a frame), so the keys work.
- **Where it did NOT work:**
  1. **With the focus anywhere else in the panel** (a toolbar button reached by keyboard, a tab, a pill's button, the review bar,
     the panel title `openDocument` leaves focus on): the keys did nothing.
  2. **With nothing to undo or redo** the editor's binding returns false, so the key is unhandled and falls to the **browser's own
     undo**, which rewrites the DOM behind ProseMirror. (Harmless in my runs, but a hazard.)
  3. **After Alfy's edit landed, Cmd/Ctrl+Z took Alfy's change back through the reader's own history.** `loadMarkdown` (Alfy's edit
     landing, a comment refresh that found a newer version) replaced the whole document with an ordinary, undoable `setContent`.
     Proved in a unit test (with the 500 ms history grouping stepped past): the first undo reverts Alfy's text, the second the
     reader's typing. That breaks "Alfy's changes are governed by Keep/Undo, not the text history", bypasses the pill state
     machine and the "Undid Alfy's change" version, and buries the reader's earlier edits under a step whose inverse is the whole
     old document.
  4. **The pill's buttons were not keyboard-operable.** Tab reaches them (Keep, Undo, Keep, Undo, then the review bar), but every key
     and click made on the pill bubbles into ProseMirror, because the pill lives in the editor's own DOM: **Enter split the
     paragraph at the text's caret (an empty block inserted, the change silently acknowledged as a user edit, the button never
     activated) and Space was typed into the text.** Measured: after Enter on Undo the document had an extra empty paragraph and the
     change had lost its pill without being undone.
  5. The tooltips did not mention any shortcut.

### What I changed
- **`document/keyboard-shortcuts.ts` (new, pure, no Tiptap):** the one place that says what a key event means and how a chord is
  written. `historyShortcutFor(event)`: Undo/Redo, ⌘ on Apple, Ctrl elsewhere, never with Alt, not during an IME composition,
  follows the key the reader pressed (QWERTZ's Z sits on QWERTY's Y position), falls back to the physical key for layouts with no Latin
  letter (Russian Я). `alfyChangeShortcutFor(event)`: the pill's chord (below). Labels (`⌘Z`, `⇧⌘Z`, `Ctrl+Z`, `Ctrl+Y`, `⌥⌘Z`,
  `Ctrl+Alt+Z`, …) and `aria-keyshortcuts` strings (every chord that works).
- **The editor claims the history keys always** (`document-editor.ts` `handleKeyDown`, before Tiptap's own binding so a key never
  undoes twice), even with nothing to undo, so the browser's undo never runs. It reads the platform live.
- **The panel claims them for any other focus in it** (`DocumentBody.svelte` `handleBodyKeydown` on `.document-body`): a toolbar
  button, a tab, a pill's button, the review bar → the same undo the toolbar button runs (focus comes back into the text). A comment
  or reply field (`textarea`, text `input`) keeps its own undo; keys from the text itself are the editor's.
- **Toolbar tooltips and accessible names, localized:** `Undo (Ctrl+Z)` / `Redo (Ctrl+Y)`, `Undo (⌘Z)` / `Redo (⇧⌘Z)`, and
  `Visszavonás (Ctrl+Z)` / `Újra (Ctrl+Y)` (keys `artifacts.document.toolbar.undoWithShortcut/redoWithShortcut`), plus
  `aria-keyshortcuts` on the buttons. The phone toolbar's Undo says them too; its Redo, in the More sheet, keeps its plain visible
  label and carries the chords for assistive technology only.
- **The pill (the "documented shortcut" and the keyboard bug):**
  - The widget now sets **`stopEvent: () => true`** (`change-pill-decoration.ts`): ProseMirror ignores every event from inside the
    pill, so its buttons are buttons. Enter and Space operate them and edit nothing. (`data-change-id` on the mount span lets the
    panel find which change a focused button belongs to.)
  - **Focus loop:** Undo (Enter) puts the focus on Redo (already so); a Redo pressed on the pill puts it on the new Undo
    (`focusPillUndo`), so the two toggle from the keys. An Undo by chord from the text leaves the focus in the text: `ChangeBar`'s
    Redo autofocus now only fires when the focus was dropped (`document.activeElement` is `<body>`).
  - **A chord of its own, because Alfy's change is not in the text history: Cmd/Ctrl+Alt+Z undoes it, Cmd/Ctrl+Alt+Shift+Z redoes it**
    (the family of the comment composer's ⌘/Ctrl+Alt+M; Alt is held, so it can never be shadowed by or mistaken for Mod-Z). Target:
    the change whose pill has the focus, else the one in the block the caret is in, else the one the review bar shows (Undo) / the one
    Undo ran on last (Redo), else the first. The caret is read from the browser's own selection first (`view.posAtDOM`), because
    ProseMirror learns of a click on the next `selectionchange` and a chord pressed right after one saw the previous position (found
    by the e2e). Documented in the pill buttons' tooltips (`Undo Alfy's change (Ctrl+Alt+Z)`, Hungarian too) and `aria-keyshortcuts`;
    the accessible names are unchanged (no test or label-in-name churn). Keep has no chord (Tab + Enter reach it; Keep all is on the bar).
  - AltGr: on Windows/Linux Ctrl+Alt is AltGr on many keyboards, so the chord only fires when the key really reported "z" (a keyboard
    that types a character with AltGr+Z reports that character); on a Mac the physical key stands in (Option turns ⌥Z into Ω, and ⌘ chords never type).
- **`loadMarkdown` is no longer a step in the reader's history** and is applied as the smallest replacement of whole top-level blocks
  (the leading and trailing runs of blocks both documents share are left alone; `addToHistory: false`, `preventUpdate`). What the
  reader typed in a block the load left alone stays undoable and redoable and the caret stays put; the blocks Alfy replaced are not in
  the history (earlier entries inside them map away). One consequence, documented: a reader edit in a block Alfy then replaced can no
  longer be undone.
- Two bugs found on the way, both in this feature's path:
  - **The "Undone · Redo" pill slid into the next paragraph** whenever Undo shortened the text: its anchor was the end of the mark's
    range read before Undo. It anchors at the end of the restored block, read after Undo (`blockContentEnd`; the now-unused
    `changeDocRange`/`alfyChangeDocRange` are removed, their two tests moved to `findAlfyChangeMarkRange`).
  - **Every Keep rebuilt the whole Document body** (editor element, caret, scroll, the reader's undo history, pills), then reloaded it from
    the server. Root cause (traced in the browser to `BranchManager.ensure` inside `flushSync` ← `tick()` in `focusAfterKeep`): the workspace
    rendered the body inside `{#await ensureArtifactBodyModule(...)}`; Svelte 5.55's `{#await}` has no same-promise short circuit, its block
    re-runs when the open item is re-issued (a Keep changes the review count), and a `flushSync` landing in that turn runs Svelte's queued
    tasks before the already-resolved promise answers, so it shows the pending state and destroys the resolved branch. `DocumentWorkspace.svelte`
    now keeps the resolved component per kind in `$state.raw` and renders it through `{#if}`. This is outside the brief's letter, but
    the reader's undo history did not survive a Keep, which is exactly the feature; a browser test pins it (fails on the `{#await}` version).

Alfy's changes stay governed by Keep/Undo: pill Undo/Redo and the mark/restore paths were already `addToHistory: false`; now the landing is too,
and a browser test seeds two pending changes, types, presses Ctrl+Z four times, and Alfy's text and both pills are still there.

## Item 2 — `undoAlfyChange` and an existing blank block (`marks.ts`)
Reproduced first: given `previousMarkdown: ""` for an existing block the editor keeps an empty paragraph, but the Markdown model cannot store one
(`splitIntoSegments` drops a marker with nothing after it), so the next save/`parseDocument` loses the block: the document "collapses by one block".
`isNewBlock` stays the explicit "delete it" answer; a blank existing block (or one holding only the zero-width placeholder) is restored as the
same zero-width-space anchor a new tab uses, which a save keeps. Tests: four in `marks.test.ts` (3 → 3 blocks through a canonical save and reload; reads
blank outside the editor; `isNewBlock` still deletes; both cases in one document). Note: the server's block model cannot produce such an entry
today (an empty block cannot be stored), so this is a robustness fix for the API's contract, not a reachable data-loss path.

## Item 3 — Redo after a multi-block insert (`marks.ts`, `DocumentBody`, `document-editor.ts`)
New `redoAlfyChange(editor, {blockId, appliedMarkdown, insertedBlocks}, extensions)` puts the first block back and re-inserts each extra block, in
order, right after it, with the id it had (already-present blocks are skipped: a second Redo adds nothing). `handleUndoChange` captures the extra blocks'
markdown (from `blocks`) before Undo deletes them; `handleRedoChange` calls `redoChangeFn` (its own export, `redoChange`) instead of reusing Undo.
Tests: 4 in `marks.test.ts` (round trip through Undo/Redo/Undo; ids and text identical; idempotent; single-block change unchanged) + 1 in `DocumentBody.test.ts`.

## Item 4 — tabs (`Tabs.svelte`)
`role="tablist"` now owns only tabs: the ⋯ and + buttons are siblings inside the strip (`data-testid="document-tabs"` moved to the strip). The ⋯ still belongs
to the active tab: it is absolutely positioned right after that tab's label from the tab button's rect (the active tab reserves 22px), re-placed by a
guarded `ResizeObserver`. The fix B menu (portalled, focus-first-item, arrows, Escape returns to the trigger) is untouched.
**Found:** the sliding underline was measured with `offsetLeft` inside a positioned wrapper, so it always sat 8px from the strip's start (measured against
the previous file: ink x=503 with "Budget" active at x=552); it uses the same rect measure now and slides (e2e asserts it sits under the active tab).
Phones (≤767px): tabs `min-height/min-width: 44px` (label padding moves into the button), ⋯ and + 44×44 real boxes (the strip is a scroller, so a grown
`::after` would be clipped); the strip's own padding is dropped so the strip is 44px, the single-tab `+` is 44px too (the row grows 16px on phones).
Tests: 5 in `Tabs.test.ts` (⋯/+ outside the tablist, only tabs below it, tab order, arrows, ⋯ follows the active tab); 2 in `artifact-document-touch-targets.spec.ts`
(390×844: every tab/⋯/+ ≥ 43.5px in both axes, no overlap, ink under the active tab; single-tab `+`).

## Item 5 — named panel rows (and the landmark the ~10 suites selected)
The brief says "rows" but the ~10 suites in fxd's report select the **panel landmark** by its old fixed name, so I did both:
- **Landmark:** an open item names it `{title}, {kind}` (`artifacts.panel.landmark`; a file is `name, File`), desktop `<aside>` and phone `<section>`;
  the list state is named for its own heading (`What this chat made` / `Amit ez a beszélgetés készített`).
- **Row:** the button's `aria-label` reads title, kind, facts, version, time and review state, comma-separated (`Bécsi utazás, Dokumentum, 1 fül, v2, épp most, 1 módosítás vár rád`),
  and always says the kind even when a caller's subtitle does not. Every piece is visible on the row (label-in-name holds).
- **Suites updated in the same change:** nine e2e files (`core-user-flows-smoke`, `artifact-document`, `-review-bar`, `-comments`, `-selection-bubble`, `artifacts-panel`,
  `artifact-delete`, `artifact-chat-card`, `attachment-modal.helpers`) now use a shared `workspacePanel(page)` (`helpers.ts`); four unit files
  (`DocumentWorkspace.test`, `page-runtime.test`, `KnowledgeWorkspaceCoordinator.test`, `ProjectFilesDialog.test`) use a landmark pattern or the exact name.
- Tests: 5 in `DocumentWorkspace.test.ts` (Document, App, file, follows the selection, list), 5 in `ArtifactCard.test.ts` (row name incl. Hungarian), and a new
  `artifact-panel-names.spec.ts` (role/name queries in EN and HU).

## Item 6 — the phone review bar (`ReviewBar.svelte`, `DocumentBody.svelte`)
Removed the phone-only rules (`bottom: 4rem`, side insets, the rounded floating card): a phone gets the same docked bar as the desktop (`bottom: 0`, full width,
flat, rule on top), with a `env(safe-area-inset-bottom)` padding for a home indicator. The reserved scroll room is still measured from the bar. Test: 3 phone cases
(390×844 with 1 and 2 pending, 360×740) in Hungarian: bottom edge = the text column's within 1px, full width, the bottom row and both side columns paint as the
bar, radius 0 and no shadow, the last line scrolls fully clear, buttons keep 44px.

## Item 7 — ticked tasks (`DocumentBody.svelte` CSS)
`li[data-checked='true'] > div > p` is muted (`--text-muted`) and struck through (real `text-decoration`, so a wrapped item is struck on every line); scoped to the
item's own paragraphs so a nested list keeps states of its own; the colour eases in (reduced motion collapses it). Deviation: the mockup's left-to-right draw uses a
`background-size` gradient that strikes one line only, so I did not copy it (§7.2 #27's "strike draws" is therefore a fade of the colour, not a wipe). Test: computed style
in light and dark (line-through, muted token, open items unchanged, the checkbox label not struck).

## Item 8 — the count-button dot
Not covered before: the one e2e walked a live edit, Keep all, and a reload with **nothing** pending. The case the code's own comment names as the original bug (a reload
with a change genuinely waiting) had no test. Added: 4 page-derivation unit tests in `page-runtime.test.ts` (lit for a reported count with the a11y name, dark for 0 and for never
edited, lit for any row, hidden while the panel is open and back on close) and 2 browser tests in `artifact-document-review-bar.spec.ts` (a change seeded straight into the
stored Document lights the dot on a fresh load and through another; Keep all darkens it for good through a close and a reload).

## Coordinator's extra — the flaky "topmost" check
Cause: `waitForStableBoundingBox` returns once a rect is equal across two frames, so a sheet whose entrance has not *started* (first frames on a loaded machine) reads as
settled at its off-screen start, where `elementFromPoint` returns null. New `waitForMotionToSettle(page)` (no finite animation/transition left, looping for one that starts another)
and `expectTopmost(locator, {message, probe})` (waits for that, then polls the probe with `expect.poll`, so it still fails after a bounded wait if something really covers the
element). Applied to every sheet/popover/drawer topmost check: both phone composer sheets (the reported one), the Comments sheet, the Versions popover (desktop) and its phone sheet,
the header's Comments button under the drawer, the App's regenerate sheet and popover. Ran the two selection-bubble tests 3× each and the App tests: green. I could not reproduce the
original failure locally (it needed load), so the proof is the mechanism, not a repro.

## Screenshots (Hungarian, looked at once each; `rd/shots/g3/`, not committed)
- `g3-phone-tab-strip-hu-390.png`: 44px tabs, ink under the active tab, ⋯ right after its label, + at the end.
- `g3-phone-review-bar-hu-390.png`: the bar flush at the bottom, full width, flat, three stacked rows, text scrolled beneath the rule and nothing beneath the bar.
- `g3-tabs-toolbar-hu-1440.png`: desktop strip (ink under "Költségvetés", ⋯ after it), toolbar with Undo/Redo, the docked review bar.
- `g3-panel-list-hu-1440.png`: the list (visually unchanged by the row names).
- `g3-ticked-tasks-hu-light-1440.png` / `-dark-1440.png`: struck-through muted ticked items, including one that wraps.
- **The toolbar tooltip is not in a screenshot:** it is the native `title` attribute (as every toolbar tooltip in the app), which headless Chromium never paints. Its text is asserted
  in unit and browser tests (`Undo (Ctrl+Z)`, `Undo (⌘Z)`, `Visszavonás (Ctrl+Z)`; the pill's `Undo Alfy's change (Ctrl+Alt+Z)`).

## Tests added (summary)
Unit: `marks.test` +10, `DocumentBody.test` +13, `document-editor.test` +13 (8 loadMarkdown/history, 5 keys), `keyboard-shortcuts.test` 17 (new), `DocumentToolbar.test` +5,
`MobileToolbar.test` +1, `ChangeBar.test` +6, `change-pill-decoration.test` +1 assertion, `Tabs.test` +5, `DocumentWorkspace.test` +5, `ArtifactCard.test` +5, `page-runtime.test` +4.
Browser: `artifact-document-keyboard.spec.ts` (new, 15 runs: two key mappings × 4, comment box keeps its undo, Alfy stays apart from the text history, chord acts on the caret's block and keeps
focus in the text, Tab/Enter/Space on the pill, Ctrl+Z from a pill button, Keep does not rebuild the editor, Hungarian chords), `artifact-panel-names.spec.ts` (new, 2),
`artifact-document-touch-targets` +2, `-prose` +1, `-review-bar` +5 (3 phone flush, 2 dot).

## Deviations and decisions
- Item 5's "rows" also covered the landmark (see above): the suites that "select rows by their old name" select the landmark; no suite selected a row by name (rows are found by `data-testid`).
- Item 2's bug is not reachable through the server's block model today (see above); fixed at the contract.
- The Alfy chord is Cmd/Ctrl+Alt+Z, not on Windows layouts where AltGr+Z types a character (it steps aside there); Keep has no chord.
- The wipe animation of the ticked strike is a colour fade (above).
- One change outside the brief: `DocumentWorkspace.svelte`'s body no longer renders through `{#await}` (item 1's third bug); a change to a 2,500-line shared file, contained to the two body-mount sites plus one `$effect`.
- `AGENTS.md`: two bullets in the Artifacts section (the keyboard rules; the pill's `stopEvent` and the `{#await}` rule).

## Concerns (not touched)
- **Redo after Undo does not un-acknowledge the change on the server**: Undo writes the block into the review state (`acknowledgeReview`) and Redo does not take it back, so after a reload
  the redone change is not pending again. Pre-existing (rd4b), unchanged.
- `focusAfterKeep` and the other four `await tick()` sites in `DocumentBody.svelte` are unchanged; with the `{#await}` gone they no longer tear the body down, but any *other* `{#await}` in the
  workspace (the preview renderer for files) has the same latent behaviour.
- Cmd+Option+Z on a Hungarian *Mac* layout: I relied on the physical key when Option changes the character; not tried on a real Hungarian Mac keyboard.
- The single-tab `+` row is 44px on phones (16px more chrome above the toolbar); the alternative (a grown hit area) would overlap the toolbar's 44px buttons.
- Tracked throwaway specs from earlier rounds (`tests/e2e/zz-capture-*.spec.ts`, `zz-knowledge-polish-capture.spec.ts`) are still in the repo, outside gate 4's list.

## Hand-off — reuse these
- `document/keyboard-shortcuts.ts`: `historyShortcutFor`, `alfyChangeShortcutFor`, `*ShortcutLabel`, `*AriaKeyShortcuts`, `isApplePlatform`. Any new Document (or Canvas/Slides) key must be read
  here, not with a fresh `event.key === "z"`. `toolbar-actions.ts` `toolbarActionText(action, $t)` builds a toolbar button's label and `aria-keyshortcuts`.
- `stopEvent: () => true` on any widget decoration that mounts real controls inside a ProseMirror view. `data-change-id` on the mount span is how the panel maps a focused control to a change.
- `loadMarkdown` (`document-editor.ts`) is the only way server content enters the editor; it is outside the history. `redoChange`/`RedoBlock`, `blockContentEnd` (the Undone pill's anchor).
- `DocumentWorkspace.svelte`: `loadedArtifactBodies` (do not put an `{#await}` back around a body). `panelLandmarkLabel`, `artifacts.panel.landmark`.
- e2e: `workspacePanel(page)`, `waitForMotionToSettle(page)`, `expectTopmost(locator, {message, probe})` in `tests/e2e/helpers.ts`; `seedDocument({ tabs })` in `artifact-document-polish-helpers.ts`;
  to emulate a Mac force **both** `Navigator.prototype.platform` and `userAgentData` (`artifact-document-keyboard.spec.ts` `forcePlatform`).
- Tabs: the ⋯ is positioned by `positionInk()` from the active tab button's rect; a new element that must follow the active tab goes in the same function, never inside the tablist.
