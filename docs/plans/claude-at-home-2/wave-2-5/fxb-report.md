# Fix agent B report — Document layout, phone composer/review bar, popovers, tabs (round F1)

**Status:** DONE. All 8 assigned findings fixed, each backed by a failing→passing test, each in its own commit. All 5 gates pass with zero regressions.

**Worktree:** `art-fxb`, branch `fix/artifacts-rd-doc-layout`, e2e port 5485.

**Commit range:** `957bc07a..198ef385` (9 commits on top of `145c199e`, the shared starting point):

```
957bc07a fix(artifacts): raise the phone selection composer sheet above the mobile panel   [finding 1]
32b5c685 fix(artifacts): stop the phone review bar from ballooning over the document        [finding 2]
456e5df8 fix(artifacts): stop .document-content-text from being a second scroller           [finding 3]
51344ef5 fix(artifacts): pin the review bar to the text column, not the whole grid          [finding 4]
ef5e1e19 fix(artifacts): anchor the Versions/Download popovers to their trigger's left edge [finding 5]
4c8035cc fix(artifacts): portal the tab ⋯ menu so it can't be clipped, add keyboard access  [finding 6]
aefd6adf fix(artifacts): give a brand-new tab a real anchor block, not the whole document   [finding 7]
c5d51adc fix(artifacts): make the selection pill reachable and usable by keyboard           [finding 8]
198ef385 style(artifacts): fix indentation on the portalled tab menu's own attributes       [cosmetic follow-up to 6]
```

---

## Finding 1 (Critical, review.md:27-37) — phone composer sheet opens behind the mobile panel

**Fix:** `src/lib/components/artifacts/document/SelectionBubble.svelte` — the phone `<DialogShell>` (Ask Alfy / Comment composer) now gets `zIndexClass="z-[150]"`, matching the codebase's existing convention for phone sheets that must sit above the mobile workspace shell (`.workspace-shell-expanded` is z-index 115; the mobile backdrop is 95).

**Tests:** `tests/e2e/artifact-document-selection-bubble.spec.ts`, new `describe("Phone selection composer sheet is topmost (Wave 2.5 review fix)")` — two tests (Ask Alfy, Comment) using `document.elementFromPoint` at the sheet's own center to prove it is the actual topmost element, not just `toBeVisible()` (which does not catch a z-index/stacking bug). Both wait on `waitForStableBoundingBox(sheet)` before the point-check, since the sheet's own entrance slide otherwise produces a flaky read mid-animation.

---

## Finding 2 (Critical, review.md:45-56) — phone review bar balloons to ~390px; prev/next below 44px

**Fix:** `src/lib/components/artifacts/ReviewBar.svelte`, inside the existing `@media (max-width: 480px)` block:
- `.review-bar-msg { flex: 0 0 auto; }` — stops the message text from being given `flex: 1 1 auto` sizing that let it balloon to fill available cross-axis space.
- `.review-bar-nav { align-self: flex-start; }`
- `.review-bar-nav :global(button.btn-icon) { min-height: 44px; min-width: 44px; }` — the prev/next icon buttons now meet the WCAG/iOS 44px touch-target minimum on phones.

**Tests:** new file `tests/e2e/artifact-document-review-bar.spec.ts` — `seedPendingChanges` helper (via `readDocumentForAlfy` + `applyDocumentPatch` from the artifacts facade). Test "stays compact at 390x844 instead of ballooning... with 44px prev/next" asserts the bar's own bounding-box height stays under a fixed budget and each nav button's box is ≥44×44.

---

## Finding 3 (Important, review.md:87-97) — "one scroll" is really two nested scrollers; rail cards drift from their highlights

**Root cause:** `.document-content-text` had `overflow-x: auto`. Per the CSS overflow spec, a non-`visible` value on one axis (`overflow-x`) forces the other axis's `visible` default to compute as `auto` too — so `.document-content-text` silently became its own vertical scroller, nested inside the real outer scroller, and the two drifted out of sync under real scroll input.

**Fix:** `src/lib/components/artifacts/document/DocumentBody.svelte` — changed `.document-content-text` to `overflow: visible` (both axes; documented inline with the CSS-spec explanation so it isn't "fixed" back by a future edit). This reopened the wide-table horizontal-scroll need that the old `overflow-x: auto` incidentally provided, so horizontal scroll was moved onto Tiptap's own `.tableWrapper` div (`renderWrapper: false` is the Tiptap `TableKit` **default**, not something this codebase sets — a stale comment had claimed the wrapper didn't exist; it does, always, in the live editor DOM): `.document-editor-host :global(.document-content .tableWrapper) { overflow-x: auto; max-width: 100%; }`.

**Tests:**
- `tests/e2e/artifact-document-comments.spec.ts`, new `describe("Document scroll is a single scroller (Wave 2.5 review fix)")`: (a) asserts `.document-content-text`'s `scrollHeight - clientHeight <= 1` (no scrollable overflow of its own); (b) "a rail card stays aligned with its highlight after scrolling a long commented document" — uses a real `page.mouse.wheel()` gesture with a **small** delta (120px, deliberately under the ~200px budget the bugged inner scroller had) so the test isolates pure inner-scroller drift rather than being masked by `scrollIntoViewIfNeeded()`, which coordinates all nested scrollers and would pass even on the unfixed code.
- `tests/e2e/artifact-document.spec.ts`'s existing "a wide table does not force horizontal page scroll" test was strengthened with an unbreakable-token cell (ordinary wrapping text never actually overflowed, which was a false-negative risk) and now also asserts `.tableWrapper`'s own `scrollWidth > clientWidth`.

---

## Finding 4 (Important, review.md:98-108) — review bar scrolls away with the text, covers the rail, hides the last lines

**Fix:** `src/lib/components/artifacts/document/DocumentBody.svelte`:
- The review-bar markup moved from being a sibling of `.document-content-text` to being its last child (nested inside the text column, after the editor host).
- `.document-review-bar-slot` changed `position: absolute` → `position: sticky` (documented inline: the old reasoning — "a direct child of the scroller stays pinned" — was backwards; `sticky` needs to be *inside* the scrolling column to pin within it, and moving it there also confines it to the text column's width so it can no longer cover the rail).
- A guarded `ResizeObserver` (matching the existing pattern in this same file) measures the review bar's rendered height into `reviewBarHeight` state; `.document-editor-host` gets `style:padding-bottom` reserving that height (+1rem) whenever `pendingList.length > 0`, so the sticky bar never permanently occludes the document's last lines.

**Tests:** `tests/e2e/artifact-document-review-bar.spec.ts`, "stays visible, confined to the text column, and never covers the last paragraph at 1440x900" — seeds a 40+ paragraph document, scrolls with `page.mouse.wheel`, checks the bar stays within the scroller's own bounds (never extends into the rail's x-range), and that the last paragraph is topmost via `elementFromPoint` even with the bar showing. Includes a `pageErrors` listener confirming the benign "ResizeObserver loop completed with undelivered notifications" warning (visible in the Playwright gate-4 run's WebServer log, e.g. at line 64 and 115 of that run) never surfaces as an actual `pageerror`.

---

## Finding 5 (Important, review.md:168-175) — in the expanded panel, Versions/Download popovers render off-screen, under the panel

**Fix:** `src/lib/components/artifacts/document/VersionsSheet.svelte` and `DownloadSheet.svelte` — both changed `measurePopover()` from right-anchoring (`right: window.innerWidth - rect.right`, which goes negative and pushes the popover off-screen when the trigger sits far enough right in the expanded/wide panel) to left-anchoring with viewport clamping (`left = clamp(rect.left, VIEWPORT_MARGIN, innerWidth - width - VIEWPORT_MARGIN)`). Both bumped `z-index: 60` → `z-index: 130`, matching `ConfirmDialog.svelte`'s existing `zIndexClass = "z-[130]"` precedent for "must clear the expanded panel" (`.workspace-shell-expanded` is 115).

**Tests:** `tests/e2e/artifact-document-comments.spec.ts`, `describe("Versions and Download popovers")`, new test "in the expanded panel, the Versions popover opens on-screen, anchored to the trigger's left edge, and topmost" — expands the panel, opens the popover, asserts `x >= 0`, anchored near (not hundreds of px before) the trigger's left edge, and topmost via `elementFromPoint`.

---

## Finding 6 (Important, review.md:183-190) — the tab `⋯` menu is clipped inside the tab strip; Rename/Delete unreachable

**Fix:** `src/lib/components/artifacts/document/Tabs.svelte` — the menu is now portalled to `<body>` via the existing `portalToBody` action (`$lib/utils/portal`), `position: fixed; z-index: 130` (same "clears the expanded panel" constant as finding 5) instead of `position: absolute; z-index: 5` inside the (overflowing) tab strip. Added keyboard access: on open, focuses the first item (`getFocusableElements(menuEl)[0]`, from `$lib/utils/focus-trap`) after `tick()`; `ArrowDown`/`ArrowUp` cycle items with wraparound; `Escape` closes and returns focus to the `⋯` trigger button (captured as `menuTriggerEl` on open).

**Tests:**
- `tests/e2e/artifact-document.spec.ts`, new test "the ⋯ menu on the active tab is not clipped by the strip's own overflow, and keyboard access works" — required `waitForStableBoundingBox(tabStrip)` before interacting (the panel's own entrance animation caused the same class of geometry race as finding 1).
- `src/lib/components/artifacts/document/Tabs.test.ts`, new `describe("keyboard access (rd/review-2-5.md:183-190)")` — focus-on-open, Arrow cycling with wraparound, Escape-returns-focus.

**Note:** this file was accidentally wiped once mid-session by a `git checkout --` (see Deviations/lessons below) and fully redone from the original edit; a follow-up commit (`198ef385`) fixed an indentation inconsistency in the new markup that biome's own Svelte formatter does not catch (biome does not reformat Svelte template markup).

---

## Finding 7 (Important, review.md:191-197; ruling 61) — a new tab shows the whole document instead of its own empty section

**Root cause:** a new tab was created with `startBlockId: ""`, and the section-resolution logic apparently treats an empty/unmatched `startBlockId` as "no boundary" → the whole document.

**Fix:** `src/lib/components/artifacts/document/document-editor.ts` — new exported `appendEmptyTabSection(editor: Editor): string | null`. It inserts a new paragraph at the end of the doc containing a **zero-width space** (`​`), not a truly empty paragraph, then selects that character (so the user's first keystroke replaces it outright), and returns the new block's minted id (from the existing `BlockIds` extension). `src/lib/components/artifacts/document/DocumentBody.svelte`'s `handleTabsChange` detects a blank new tab and rewrites its `startBlockId` to that minted id **before** the canonical markdown is read for save.

**Why a zero-width space and not a truly empty paragraph (deviation, with reason):** `blocks.ts`'s `splitIntoSegments` deliberately drops "a trailing marker with no following block" from round-tripped markdown, and `saveDocumentBody` re-canonicalizes via `parseDocument(markdown).markdown` on **every** save — so a truly empty paragraph's anchor would vanish from stored content on the very first save, reviving the whole-document bug on the next reload. This was caught by a unit test before it ever reached e2e: `document-editor.test.ts` has a reload-survival test that reproduces the server's *exact* canonicalization (`parseDocument(clientMarkdown).markdown`, then re-parse) and proves the zero-width space survives where true emptiness does not.

**Tests:**
- `document-editor.test.ts`, new `describe("appendEmptyTabSection", ...)`: minting/id, caret selects the ZWSP, distinct ids for successive tabs, undo-ability, and the two reload-survival tests above.
- `DocumentBody.test.ts`: "a newly minted anchor block's id becomes the new tab's startBlockId before it saves."
- `tests/e2e/artifact-document.spec.ts`, new test "adding a tab shows only its own (empty) section, not the whole document — and that survives a reload" — seeds tabs anchored at each section's own heading block (not `""`, which collides across multiple tabs and proves nothing), verifies hide/show on tab switch and reload persistence. Fixed a pre-existing "sustained edits" test in the same file that had accidentally relied on the old bug's "everything stays visible" behavior to reach a later chip selector.

---

## Finding 8 (Important, review.md:198-207) — the selection pill is not reachable by keyboard

**Fix:**
- `src/lib/components/artifacts/document/document-editor.ts` — `createDocumentEditor`'s `editorProps.handleKeyDown` now intercepts a plain `Tab` (no Shift/Alt) over a non-empty selection, calling a new `onTabIntoSelectionPill?: () => boolean` option; if it returns true, `event.preventDefault()`s so ProseMirror's own tab handling (which would otherwise move focus elsewhere in the editor) is skipped.
- `src/lib/components/artifacts/document/DocumentBody.svelte` — new `focusSelectionPill()` focuses the pill's first enabled button directly via `document.querySelector` (wired as `onTabIntoSelectionPill`); `dismissSelectionBubble()` now calls `editor?.view?.focus()` (ProseMirror's own **synchronous** focus) instead of `editor.commands.focus()` when focus had been on the pill, because `commands.focus()` defers via `requestAnimationFrame` and lost the race against Svelte unmounting the (about-to-be-removed) pill button — the browser's default "focused element left the DOM" behavior then sent focus to `<body>` instead of back to the editor.
- `src/lib/components/artifacts/document/SelectionBubble.svelte` — new `handleToolbarKeydown` gives the toolbar roving-tabindex-style `ArrowLeft`/`ArrowRight` navigation between its own buttons (wrapping both ways), wired on both the phone docked bar and the desktop toolbar.

**Tests:**
- `document-editor.test.ts`, new `describe("Tab into the selection pill", ...)`: dispatches a real `KeyboardEvent` at `editor.view.dom` — plain Tab over a selection calls the callback and prevents default; no interception on empty selection, Shift+Tab, a `false`-returning callback, or no callback at all.
- `DocumentBody.test.ts`: "Escape while focus is on the pill's own button refocuses the editor" (asserts the fake editor's `view.focus` was called, not `commands.focus`), plus focus/no-bubble-to-focus cases.
- `SelectionBubble.test.ts`: ArrowRight/ArrowLeft rove and wrap, on both the desktop toolbar and the phone docked bar.
- `tests/e2e/artifact-document-selection-bubble.spec.ts`, new `describe("Keyboard access into the selection pill (Wave 2.5 review fix)")`: seeds a comment highlight on paragraph 2, selects text in paragraph 1, `Tab` focuses "Ask Alfy" (scoped to the pill's own `getByTestId("selection-bubble")`, since an unscoped role/name query also matched the panel header's "Comments (N)" button), Arrow keys rove, `Escape` returns focus to `.document-editor-host` with the selection still live (`window.getSelection()` non-collapsed).

---

## Deviations from spec, with reasons

1. **Finding 3** — the review's suggested `overflow-x: clip` was tried first and rejected: it also disabled the wide table's own horizontal scroll, which depended on the same rule. Moved that scroll responsibility to Tiptap's own (always-present) `.tableWrapper` instead. No behavior regresses; the extended e2e test in `artifact-document.spec.ts` proves it.
2. **Finding 7** — used a zero-width space instead of a literally empty paragraph as the new tab's anchor content, because a truly empty paragraph does not survive this app's markdown round-trip (see Finding 7 above). Selecting the ZWSP means the user's first typed character replaces it with no visible artifact.
3. **Screenshot #05** (`05-desktop-versions-expanded-hu.png`) was captured in **English**, not Hungarian, due to a timing/crash issue in the throwaway capture script against that specific scenario (the expanded-panel Versions popover) — the DB-driven `uiLanguage` flip and the scenario's own steps didn't stay in sync in that one run, and re-running cost more than it was worth given the underlying fix is independently verified by a real, passing, committed e2e test (`artifact-document-comments.spec.ts`, "in the expanded panel, the Versions popover opens on-screen..."), which does run in Hungarian. All other 7 screenshots are genuinely Hungarian.
4. The throwaway screenshot-capture spec (`tests/e2e/zz-capture-fxb.spec.ts`) and a throwaway DB-check script were deleted before the final commit, per `common.md`'s "put throwaway capture specs outside git or delete them before committing." Confirmed absent from the tree and from `git status` as of this report.

## Lessons (process, not code)

- `git checkout -- <file>` was used twice to undo a quick manual revert-for-testing, and both times destroyed genuine uncommitted work instead (nothing was committed yet, so it reverted all the way to HEAD). Both times required manually redoing the edit from scratch. No data was ultimately lost, but note this for later agents: never use `git checkout --` to walk back a temporary edit when there's uncommitted work sitting on top of it.

---

## Gates (run once, at the end, per `common.md`)

1. **`npm run check`** — `0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS`. Exact match to the documented pre-existing baseline (`ToolActivityRow` 10 + `ThinkingBlock` 6 + `RouteItinerary` 1 = 17). Zero new diagnostics.
2. **`npx biome check src scripts tests`** — clean.
3. **`npm test`** (full vitest, once) — `Test Files 897 passed | 1 skipped (898)`, `Tests 13708 passed | 2 skipped (13710)`, exit code 0. The skips are pre-existing.
4. **Playwright**, once, port 5485, the full brief-specified suite (`tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`) — **96 passed, 0 failed**, exit code 0, 4.4 minutes. This includes every new test listed above running for real inside the full suite, not just in isolation.
5. **`npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-fxb.json`** — `total_issues: 124`, `circular_dependencies: 4`. Exact match to the documented baseline (124 issues / 4 circular deps). **Zero new findings.**

## Screenshots (Hungarian UI, `…/scratchpad/rd/shots/fxb/`, ≤8, each spot-checked)

| File | Scenario | Viewport |
|---|---|---|
| `01-phone-composer-sheet-hu.png` | Ask Alfy sheet above the mobile panel | 390×844 |
| `02-phone-reviewbar-compact-hu.png` | Compact review bar, 44px nav, light | 390×844 |
| `03-phone-reviewbar-dark-hu.png` | Compact review bar, dark | 390×844 |
| `04-desktop-rail-scrolled-hu.png` | Rail cards aligned after scroll | 1440×900 |
| `05-desktop-versions-expanded-hu.png` | Versions popover, expanded panel (captured in **English** — see Deviations #3) | 1440×900 |
| `06-desktop-tabmenu-hu.png` | Tab `⋯` menu, not clipped | 1440×900 |
| `07-desktop-newtab-empty-hu.png` | New tab shows only its own empty section | 1440×900 |
| `08-desktop-pill-focused-hu.png` | Selection pill, keyboard-focused | 1440×900 |

Not committed (scratchpad only), per `common.md`.

---

## Hand-off — tokens, classes, components, props for later agents

- **`z-index: 130`** is now the established "must clear the expanded document panel" layer (`.workspace-shell-expanded` = 115), used identically by `VersionsSheet.svelte`, `DownloadSheet.svelte`, and the portalled tab menu in `Tabs.svelte`. It mirrors `ConfirmDialog.svelte`'s pre-existing `zIndexClass = "z-[130]"` default. `z-[150]` remains the convention for a phone `<DialogShell>` sheet that must sit above the mobile workspace shell (95) — see `SelectionBubble.svelte`.
- **`appendEmptyTabSection(editor: Editor): string | null`** (`document-editor.ts`) plus the zero-width-space (`​`) technique: the reusable way to give any new addressable-but-visually-empty block a real, save-durable anchor id in this markdown-backed editor. Any future "insert an empty X" feature on this document editor should reuse this instead of inserting a literally empty node.
- **`onTabIntoSelectionPill?: () => boolean`** on `CreateDocumentEditorOptions` (`document-editor.ts`): the pattern for letting a host component intercept a ProseMirror `handleKeyDown` and redirect focus outside the editor DOM. Reusable for any future "Tab out of the editor into an overlay control" need.
- **`editor.view.focus()` vs `editor.commands.focus()`**: the latter defers via `requestAnimationFrame` and can lose a race against Svelte removing the currently-focused element from the DOM. Anywhere focus must return to the editor synchronously (e.g., as part of a dismiss/cleanup handler), prefer `editor.view.focus()`.
- **`.tableWrapper`** (Tiptap `TableKit`'s own wrapper div, present by default — `renderWrapper: false` is the library default, not something this codebase configures) is now the documented, correct home for a wide table's horizontal scroll. Do not put `overflow-x` back on `.document-content-text` or its ancestors for this purpose — that reintroduces finding 3's nested-scroller bug.
- **`reviewBarSlotEl` / `reviewBarHeight`** (`DocumentBody.svelte`): a guarded-`ResizeObserver` → `style:padding-bottom` pattern for reserving scroll-content space under a `position: sticky` overlay so the overlay never permanently occludes trailing content. Reusable anywhere else a sticky footer-like element is introduced inside a scrolling column.
- **`waitForStableBoundingBox`** (`tests/e2e/helpers.ts`) plus `document.elementFromPoint(...)`-is-topmost: the established pair for proving a z-index/stacking/clipping fix in Playwright, as opposed to `toBeVisible()` (misses stacking bugs) or `scrollIntoViewIfNeeded()` (masks nested-scroller bugs by coordinating all scrollers). Both are now used across four of this round's specs; reuse them rather than re-deriving ad hoc waits for future panel/overlay geometry tests.
- **`portalToBody`** (`$lib/utils/portal`) and **`getFocusableElements`** (`$lib/utils/focus-trap`) are the existing shared utilities `Tabs.svelte`'s menu now uses; any other strip/row-local dropdown menu that risks being clipped by its own container's overflow should reach for the same two utilities rather than inventing new positioning math.
