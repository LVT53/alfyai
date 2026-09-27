# Agent 2 report — Panel shell (redesign steps 3–5)

Worktree `art-rd2`, branch `feat/artifacts-rd2-shell`, e2e port 5410.
Commit range: `988ab94e..33065621` (this agent's 20 commits, `f9702a8f` through `33065621`;
`988ab94e` is agent 1's tip / the merge-base with `feat/artifacts`).
26 files changed, 3199 insertions(+), 706 deletions(-).

## Step 3 — The shared header (`ArtifactPanelHeader`)

- New `src/lib/components/artifacts/ArtifactPanelHeader.svelte` (257 lines): kind icon, breadcrumb
  back-button ("‹ This chat N", `aria-label` from `artifacts.panel.backA11y`), serif `<h2>` title,
  kind + version (button via `onVersions` when provided, else static text) + meta line, and a
  caller-supplied `actions` snippet. Knows nothing about Tiptap or any specific kind.
- New `src/lib/components/artifacts/kind-icons.ts`: `ARTIFACT_KIND_ICONS` extracted from
  `ArtifactCard`'s local map so the card and the header share one icon source.
- Wired into `DocumentWorkspace.svelte` for both the mobile and desktop shells, gated on
  `activeDocument.kind` (truthy for any of the five artifact kinds; plain uploaded/library
  documents and search-result opens have no `.kind` and keep the pre-existing legacy header,
  `OpenDocumentsRail`, and the grid-icon "Show list"/History buttons — verified via
  `knowledge.spec.ts`, which has zero references to anything this wave touched).
- New `artifactHeaderActionsSnippet()`: Download (delegates to a body's registered
  `openDownload` action when present, else falls back to the pre-existing
  `atlasDownloadControl`), a divider, Expand (reuses the existing `workspace-expand-button`
  class/CSS), Close. Deliberately no Comments action — that is agent 3's surface, and redesign
  §5.2 explicitly says not to add a disabled placeholder for an unwired feature.
- `src/lib/components/artifacts/artifact-bodies.ts` gained `ArtifactPanelBodyActions`
  (`openVersions?`, `openDownload?`) and a `registerPanelActions?` prop on `ArtifactBodyProps`, so
  a body can hand the header real actions without the header knowing about the body's internals.
  `DocumentBody.svelte` is the one implementation so far (`openVersionsSheet()`/`openDownloadSheet()`,
  registered once the editor is ready).
- Tests: `ArtifactPanelHeader.test.ts` (8 tests: rendering, version button vs. static text,
  breadcrumb click/name, actions snippet, kind label).

## Step 4 — List rows, push navigation, motion, count button

- `ArtifactCard.svelte` gained `chrome="row"` (append-only; `"full"` and `"body"` untouched, per
  the brief — agent 5 owns the standalone card): one line per item, icon tile, title, muted
  subtitle-or-kind+version line, time + a pending-review pill or a chevron. Never renders a
  tickable checklist inline (redesign §5.1 problem 4) — ticking a task is something the *open*
  document does now, not the list row. The panel list (`DocumentWorkspace.svelte`) switched from
  `chrome="full"` to `chrome="row"`.
- List → item push navigation and open/close motion, through agent 1's `reducedMotionAnimate` /
  `MOTION_DURATION` / `MOTION_EASING`: `pendingEntrance` state drives a right-to-left entrance on
  opening an item and a left-to-right one on returning to the list; a real bug was fixed along the
  way (`desktopShellTransform` had the slide-in sign backwards — sliding from the left instead of
  the spec's right). The panel's own open/close width transition is CSS-driven
  (`.workspace-shell-desktop` 0→target width) with a `prefers-reduced-motion` override already
  covered by the existing global CSS rule (§7.3).
- Chat page count button (`artifact-count-button` / `-compact`): new `isArtifactPanelOpen` derived
  (mirrors `DocumentWorkspace`'s own `shouldShowWorkspaceShell` formula) fixes a real bug where
  `aria-pressed` cleared as soon as the user opened an item from the list (the old check only
  looked at `artifactListOpen`, which goes false on that exact transition even though the panel is
  still showing). The button now also **toggles**: clicking it while the panel is open closes it,
  matching the mockup's `#madeBtn`. The pending-change dot (`.artifact-count-dot`) is driven by a
  new `hasUnreviewedArtifactChange`/`showArtifactPendingDot` pair sourced from
  `liveDocumentAlfyActivity` — explicitly documented in the component as an ephemeral, session-only
  signal that agent 4 is expected to replace with a durable one (its own "pending review survives a
  reload" work), kept as a single clear derived value for that reason.
- Tests: `DocumentWorkspace.test.ts` new describe blocks "panel header" (6 tests) and "panel
  motion" (5 tests, `HTMLElement.prototype.animate` stubbing pattern from `motion.test.ts`);
  `ArtifactCard.test.ts` +86 lines for `chrome="row"`; a new regression test in
  `page-runtime.test.ts` for the count button's toggle-close (added this session — see "Found and
  fixed after the first gate run" below).

## Step 5 — Tabs, toolbar, More sheet

- **Tabs actually switch sections** (ruling 61's third point). `document/extensions.ts` gained
  `tabSectionPluginKey`, `buildTabSectionDecorations(doc, tabs, activeTabId)` (pure function:
  walks the doc, hides every block outside the active tab's range via a `Decoration.node(...,
  {style:"display:none"})`; returns `DecorationSet.empty` when there is 0 or 1 tab), and a
  `TabSections` Tiptap extension wired into `buildDocumentExtensions()`. `document-editor.ts`
  gained `setActiveDocumentTab(editor, tabs, activeTabId)`, dispatching a transaction with
  `addToHistory: false` / `preventUpdate: true` (switching tabs is not an undo step). Proved in
  `extensions.test.ts` (10 new tests, using real minted block ids from a mounted editor) that
  **`readMarkdown` still returns every section's text regardless of the active tab** — decorations
  are view-only, never touching the document model search/export/Alfy reads walk.
  `Tabs.svelte`: sliding underline positioned via `offsetLeft`/`offsetWidth`, a `⋯` menu
  (Rename/Delete) rendered only on the active tab (replacing a pencil+cross on every tab), badge
  counts (`Record<string, number>`, computed in `DocumentBody.svelte`'s `computeTabBadgeCounts()`
  from open text-anchor comment threads per tab), roving tabindex with arrow-key
  navigation-and-wraparound per the WAI tabs pattern.
- **Toolbar**: `toolbar-actions.ts` actions gained a `group` field; `DOCUMENT_TOOLBAR_ACTIONS`
  dropped the Code/Download/History entries (Download and version history moved to the header);
  `DocumentToolbar.svelte` renders grouped with dividers between groups, one roving tabindex, and
  a right-aligned save-state indicator (`saveState` prop: saving/saved/offline/conflict, driven by
  `DocumentBody.svelte`'s new `toolbarSaveState` derived and `isDirty` state).
- **Phone More sheet**: `MobileToolbar.svelte` now opens `DialogShell` with
  `phonePresentation="sheet"` instead of a ~80-line hand-rolled focus-trap/backdrop/Escape
  implementation — gains a title ("More formatting") and a real close affordance (the grabber)
  for free. `zIndexClass="z-[150]"` — see "bugs found via screenshot" below.
- Tests: `Tabs.test.ts` rewritten (18 tests), `extensions.test.ts` (+10), `DocumentToolbar.test.ts`
  (~20 tests: no Download/History, divider count, roving tabindex incl. Home/End, save-state
  rendering for all four states), `MobileToolbar.test.ts` rewritten to integration-level
  (DialogShell's own focus-trap/Escape contract is DialogShell's own test file's job).

## i18n additions (English + Hungarian together, `src/lib/i18n/artifacts.ts`)

`artifacts.panel.pendingReview`, `artifacts.panel.backA11y`, `artifacts.header.buttonA11yPending`,
`artifacts.document.tab.menu`, `artifacts.document.toolbar.saveState.{saving,saved,offline,conflict}`
— 8 keys, all bilingual.

## Bugs found and fixed along the way

- **Slide-in direction backwards**: `desktopShellTransform` slid the panel in from the left;
  spec wants the right. Fixed (`translateX(-20px)` → `translateX(32px)`).
- **Count button `aria-pressed` bug**: cleared on list→item navigation because it only watched
  `artifactListOpen`. Fixed with `isArtifactPanelOpen`, mirroring `DocumentWorkspace`'s own
  `shouldShowWorkspaceShell` formula.
- **More sheet invisible in a real browser, invisible to every test**: `DialogShell`'s default
  `z-50` rendered behind `DocumentWorkspace.svelte`'s own `.workspace-mobile-backdrop` (`z-index:
  95`) — every jsdom/Playwright DOM check (role, text, geometry) passed because none of them check
  paint order/stacking context, but a real screenshot showed the sheet under a blurred backdrop.
  Fixed with `zIndexClass="z-[150]"`, plus a regression test asserting the parent wrapper's
  className. **This bug justifies the visual-verification step in the brief** — it was invisible
  to every automated check except looking at the actual pixels.
- **`readMarkdown` stack overflow** (pre-existing, found while building tab decorations, fixed in
  `document-editor.ts`/`extensions.ts`, not part of my step scope but blocking `artifact-document.spec.ts`
  entirely): internal marker-insert/-delete transactions during `readMarkdown` lacked
  `preventUpdate: true`, so each one re-entered `DocumentBody.svelte`'s `handleUpdate` →
  `currentCanonicalMarkdown` → `readMarkdown` → ... unboundedly. Regression-covered by
  "sustained edits ... never crash the editor" in `artifact-document.spec.ts`.

## Found and fixed after the first gate run (this session)

The first full 7-file Playwright run (24 minutes) surfaced two separate problems, which I want to
report honestly rather than fold quietly into "all green":

1. **A shared-database contamination incident, not a real regression.** A throwaway screenshot
   script I ran concurrently on a different port (`E2E_PORT=5411`) pointed at the *same*
   `data/playwright-e2e-chat.db` file as the gate run (confirmed in `playwright.config.ts`:
   `E2E_DATABASE_PATH` is not derived from `E2E_PORT`), and its `uiLanguage: 'hu'` update to the
   shared `admin@local` test user leaked into the concurrently-running gate, producing Hungarian-UI
   failures in `knowledge.spec.ts`/`conversation.spec.ts`. Fixed by resetting
   `users.ui_language` back to `'en'` directly in the DB, confirmed clean before the final re-run,
   and no longer running any concurrent script against the shared E2E DB.
2. **Real staleness in three E2E spec files**, all the same root cause: `chrome="row"` (Step 4)
   removed the list row's separate "Open" button (the whole row is the button now, `data-testid
   "artifact-row"`), which broke every helper/locator across the suite still built around a nested
   "Open" button — `artifact-document.spec.ts` (the shared `openDocumentFromPanel()` helper, used
   by nearly every test in the file, plus the "checklist in the row" tests for the now-removed
   inline checklist), `artifact-app.spec.ts` (`openAppPanel()`, an inline `openFromList()` helper
   that also used the now-gone `artifact-card` testid, and a mobile-viewport test), and
   `artifacts-panel.spec.ts` (three more inline call sites). Fixed all of them onto
   `getByTestId("artifact-row")`. `artifact-chat-card.spec.ts` was checked and needs no fix — its
   "Open" button is on `chrome="body"` (`ToolActivityRow`'s in-chat card), which this wave did not
   touch. `knowledge.spec.ts`/`chat.spec.ts`/`conversation.spec.ts` were checked and have zero
   references to anything this wave changed.

   While fixing `artifact-app.spec.ts` I also found that `artifactHeaderActionsSnippet`'s header
   comment ("App/File" get `ArtifactPanelHeader`) meant `artifact-app.spec.ts`'s "Show list"
   grid-icon click no longer has a target for an artifact-kind item — replaced with the same
   breadcrumb click `artifact-document.spec.ts` already uses.

3. **A real regression this wave introduced, found while investigating #2**:
   `DocumentWorkspace.svelte` hid `OpenDocumentsRail` for *every* artifact kind
   (`{#if !activeDocument.kind}`), but only Document actually has a built replacement for
   "switch between multiple open items" (the breadcrumb + in-document tabs). App does not yet, and
   `artifact-app.spec.ts`'s "switching apps in the rail" test specifically depends on the rail's
   persisted iframe `WindowProxy` for its cross-app storage-isolation security coverage — hiding
   the rail broke that test with no replacement in place. Narrowed the condition to
   `activeDocument.kind !== "document"`, restoring App/Canvas/Slides/File to their prior,
   still-tested behaviour, and left a comment explaining the boundary for whichever agent builds
   App's own panel treatment next. **Flagging this explicitly**: whether App (and Canvas/Slides/File)
   keep the rail long-term, or eventually get their own push-navigation replacement, is a real design
   question I did not have the scope or the App-panel context to answer — I only fixed the
   accidental regression and preserved the status quo for kinds outside my brief.
4. Also added a direct unit test for the count button's toggle-close behaviour
   (`page-runtime.test.ts`), which turned out to have no dedicated test — only a single-click-open
   test existed. Verified passing in isolation.

Also fixed a reload-race in `openDocumentFromPanel()`: a synchronous `isVisible()` check raced the
client-side restore of a persisted-open document after `page.reload({waitUntil:"networkidle"})`
(networkidle only covers the network leg, not the client-side re-selection that follows); replaced
with a bounded `waitFor`.

## Found and fixed after the SECOND (post-fix) gate run

Re-running the full 7-file gate after the fixes above surfaced two more failures — both real,
neither contamination:

5. **A genuine content-visibility bug in Step 5's own tab-section decorations.**
   `artifact-document.spec.ts`'s pre-existing "sustained edits" test (predates this wave; a
   regression test for an unrelated `readMarkdown` stack-overflow bug) clicks "Add a tab" and then
   keeps editing the document's existing content (a status chip) in the same still-open editor.
   `Tabs.svelte`'s `addTab()` (pre-existing, unchanged by this wave) activates the brand-new tab in
   the same breath it creates it, and gives it `startBlockId: ""` — a value no real block ever
   carries. `buildTabSectionDecorations`'s walk therefore attributed every existing block to some
   *other*, real tab, and since none of them matched the newly-active (and content-less) tab, it
   hid the **entire document** the instant "Add a tab" was clicked — a real regression Step 5
   introduced, just never observed before because tabs had no visibility effect until this wave.
   Fixed in `extensions.ts`'s `buildTabSectionDecorations`: if the active tab ends up owning zero
   blocks after the walk, return `DecorationSet.empty` (show everything) instead of the
   accumulated hide-decorations — never worse than hiding the whole document with nothing to show
   in its place, and self-correcting the moment the new tab gains a real `startBlockId`. Covered by
   a new regression test in `extensions.test.ts` reproducing the exact scenario (an added tab with
   `startBlockId: ""`, asserting both existing paragraphs stay visible).
6. `artifact-app.spec.ts`'s `openAppPanel()` had the same reload-race as `openDocumentFromPanel()`
   (found and fixed for the Document spec in the first pass, but not yet applied here): "saved
   state survives a reload" calls it a second time after `page.reload()`, where the panel is very
   likely already restored-open by the time it runs, and an unconditional count-button click would
   toggle it closed instead of finding it already open. Applied the identical bounded-`waitFor`
   guard.

Both were verified passing individually before the final full gate re-run below.

## Gates

1. `npm run check` — 0 errors, 17 warnings (exactly the documented pre-existing baseline:
   `ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1). Clean.
2. `npx biome check src scripts tests` — clean (two formatting auto-fixes applied along the way).
3. `npm test` (full vitest) — **13528 passed, 2 skipped, 0 failed** (893 test files, 1 skipped),
   re-run clean after every fix in this report, including the `extensions.ts` tab-visibility fix.
4. Playwright, port 5410, the 7 files the brief names
   (`artifacts-panel.spec.ts artifact-document.spec.ts artifact-app.spec.ts
   artifact-chat-card.spec.ts knowledge.spec.ts chat.spec.ts conversation.spec.ts`):
   **68 passed, 0 failed** (2.9 minutes), on a clean re-run after every fix in this report. This
   took three passes to get here, documented honestly below rather than only reporting the final
   green number:
   - **Pass 1** (24 minutes, before this session's fixes): a database-contamination false alarm
     (see below) plus 14 genuinely stale `artifact-document.spec.ts` tests.
   - **Pass 2** (after fixing `artifact-document.spec.ts` and auditing the other two panel-list
     specs): 2 real failures — `artifact-app.spec.ts`'s reload test (same reload-race class of bug,
     not yet applied to that file) and `artifact-document.spec.ts`'s "sustained edits" test
     (the genuine tab-visibility bug, item 5 below).
   - **Pass 3** (this run): clean, 68/68.
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd2.json` —
   **124 total issues, 4 circular dependencies** — exactly the documented baseline, zero new
   findings (an earlier `unused_types` finding for an internal `TabSectionPluginState` interface
   was caught and fixed by removing an unnecessary `export`).

## Screenshots (Hungarian, not committed)

`/private/tmp/claude-501/.../scratchpad/rd/shots/rd2/`:

- `panel-list-hu-desktop-light.png` (1440×900) — the "what this chat made" list, rows in
  `chrome="row"`.
- `panel-list-hu-phone-light.png` (390×844).
- `document-hu-desktop-light.png` / `document-hu-desktop-dark.png` (1440×900) — a Document open:
  `ArtifactPanelHeader`, sliding-underline tabs, grouped toolbar with save state. This is the main
  surface, so it got both themes per the brief.
- `document-hu-phone-light.png` (390×844) — mobile toolbar (6 primary + More) fitting its budget.
- `more-sheet-hu-phone-light.png` (390×844) — the More sheet on top of the mobile document (this
  is the shot that caught the z-index bug above).

All six were looked at once each; the z-index bug was the only visual mismatch against the mockup
found and fixed. Minor, accepted simplifications visible in the screenshots: version
badge/collaborator-attribution text is plainer than the mockup's because the seeded E2E fixtures
don't populate that metadata — a fixture-data gap, not a component gap.

## Deviations from spec, with reasons

- **Item view's width does not animate from 0** — only the list view's width does. I attempted to
  gate the item view's own inline `style:width` on an `isVisible` flag (to animate it the same
  way), but this broke three pre-existing "Resizable panel" tests in `DocumentWorkspace.test.ts`
  that read `style.width` synchronously right after render, before the `requestAnimationFrame`
  that flips `isVisible` ever runs. Reverted to the item view's original unconditional width;
  only the list view (no inline-style conflict to fight) got the CSS 0→target width transition.
- **Push navigation has no exit animation, entrance-only** — `pendingEntrance` drives the
  *incoming* view's slide direction; the outgoing view is simply removed. A true crossfade/exit
  would need coordinating two overlapping views during the transition, which felt like scope
  creep against Step 4's actual ask ("push navigation... through agent 1's motion helper").
- **No Comments action in the header** — redesign §5.2 explicitly says not to add a disabled
  placeholder for a feature whose count isn't wired yet; that is agent 3's surface entirely.
- **OpenDocumentsRail scoping** (see "Found and fixed after the first gate run" #3 above) — kept
  deliberately conservative (Document-only) rather than making a call for App/Canvas/Slides/File
  that belongs to their own agents.
- **A new, empty tab shows the whole document rather than a truly blank section** (see "Found and
  fixed after the second gate run" #5 above) — the more complete fix would have `addTab()` (or
  `DocumentBody.svelte`'s handling of it) insert a real empty paragraph into the document and give
  the new tab that paragraph's own minted block id as its `startBlockId`, so a fresh tab shows an
  actually-empty, typeable section instead of everything. That touches transaction dispatch and
  block-id minting in `document-editor.ts`, which felt like a larger, separate change from a
  same-session bug fix; the safety-net fallback fixes the concrete regression (content
  disappearing with nothing to replace it) without it.

## Hand-off for later agents

- `ArtifactPanelHeader` (`src/lib/components/artifacts/ArtifactPanelHeader.svelte`): props
  `kind, title, versionNumber, onVersions?, meta?, itemCount?, onBack, actions?` (a `Snippet`).
  Reuse this for Canvas/Slides bodies rather than inventing another header — it already handles
  the version-button-vs-static-text branch and the breadcrumb.
- `registerPanelActions` pattern (`artifact-bodies.ts`'s `ArtifactPanelBodyActions`:
  `openVersions?`, `openDownload?`): a body calls this once ready to hand the header real actions
  without the header importing the body's internals. `DocumentBody.svelte` is the reference
  implementation; a future App/Canvas/Slides body should follow the same shape rather than the
  header special-casing each kind.
- `ArtifactCard`'s `chrome="row"` (`data-testid="artifact-row"`, the whole row is one `<button>`,
  named by its own text content — no separate "Open" affordance). `chrome="full"`/`"body"` are
  untouched and still exist for agent 5's standalone card and `ToolActivityRow`'s in-chat card.
- `isArtifactPanelOpen` / `hasUnreviewedArtifactChange` / `showArtifactPendingDot` derived pattern
  in `+page.svelte`: agent 4's durable pending-review work should feed
  `hasUnreviewedArtifactChange` from real persisted state instead of the current ephemeral
  `liveDocumentAlfyActivity` session signal — the prop/derived shape is meant to stay the same,
  only its source needs to become durable.
- `tabSectionPluginKey` / `buildTabSectionDecorations` / `setActiveDocumentTab`
  (`document/extensions.ts`, `document/document-editor.ts`): the mechanism for "only this tab's
  blocks are visible" — view-only decorations, never touching the document model. Any future
  per-tab UI (e.g. a tab-scoped search) should call `buildTabSectionDecorations` rather than
  re-deriving block-to-tab membership. Note its "active tab owns zero blocks → show everything"
  fallback (added this session after a real bug — see above): a future feature that gives a new
  tab a real anchor block at creation time (so it is never actually empty) would make this
  fallback path unreachable in practice, which is fine — it is a safety net, not a feature.
- `group` field on `DocumentToolbarAction` (`toolbar-actions.ts`): toolbar dividers are driven by
  `group` changing between adjacent actions — a new action should get the right group number
  rather than always appending to the last group.
- `activeDocument.kind !== "document"` gate on `OpenDocumentsRail` in `DocumentWorkspace.svelte`:
  whichever agent builds App's own panel treatment should treat this as a decision point, not an
  accident — either give App its own push-navigation replacement and narrow the condition further,
  or make an intentional call to keep the rail for App long-term.
- Kept test ids stable throughout, per the brief: `artifact-count-button`, `artifact-panel-list`,
  `alfy-change-bar`, `refusal-notice`, `margin-comment`, `selection-bubble`, `document-tabs`.
