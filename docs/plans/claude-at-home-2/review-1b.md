# RV-1B — independent review of Slice 1's Document editor and UI (client side)

**Status: complete.** The editor/UI review's own ten findings (below) were fixed and gated clean first. This
branch then merged RV-1A's parallel engine/server review (`feat/artifacts-s1-review-engine`, `4003da51`, 32
fixes) and picked up eight further cross-cutting fixes the orchestrator assigned once both sides were on one
branch — see "Coordinator-assigned fixes (post-merge)" below for those, and "Gate summary" for the final run at
the branch's actual HEAD.

**Scope:** the Document kind's editor and UI only — `src/lib/components/artifacts/document/`,
`src/lib/components/artifacts/RefusalNotice.svelte`, `src/app.css`'s mobile stylesheet, and the chat page's
`findLiveDocumentAlfyActivity` wiring (`src/routes/(app)/chat/[conversationId]/_helpers.ts` and `+page.svelte`).
Reviewed against `AGENTS.md` (Artifacts, Svelte 5 rules, icons/tokens, "Artifact" never in the UI),
`docs/plans/claude-at-home-2/slice-1.md` (Global Constraints, Review Focus, UI states, Tasks T7–T11), and
`decisions.md` rulings 10, 11, 35, 45, 47, 51, 53. The server side (patch protocol, hash guard, versions, routes,
`@Alfy`, export, the card preview's server projection) is RV-1A's scope in a sibling worktree, not re-litigated
here except where the client's own correctness depends on it. That boundary held for the ten findings above; the
eight coordinator-assigned items below, picked up after the two branches merged onto this one, correctly reach
into `blocks.ts`, `patch.ts`-adjacent types, and `comments.ts` where the editor-visible defect's root cause lives
there (items 2, 3, 4, 5, 7, 8) — each is still an editor-reachable bug, just one this slice's shared/server
modules also participate in fixing.

**Method:** every defect below was reproduced with a failing test first (the red run is quoted or described with
its exact numbers), fixed with the smallest change, and re-verified — including, for the two most consequential
findings, an explicit revert-and-retest of the fix itself (temporarily undoing just the new logic, confirming the
regression test goes red again with the predicted symptom, then restoring the fix) rather than trusting a single
green run. Every intermittent failure was rerun in isolation before being called a defect or dismissed as
environment noise; two were dismissed that way (both `toBeEnabled()` timeouts in shared `login`/`sendMessage`
helpers unrelated to any file this review touched, both gone on an isolated rerun, both consistent with the
machine being shared while other gates ran concurrently).

## Verdict: **merge with these fixes**

The already-landed code is careful and mostly correct — the mint-before-hash order, the canonical-form hasher,
the per-op refusal guard's three-way comparison, the chip's canonical-token-never-localized design, the
Keep/Undo inverse mechanism (JSON round-tripped through the live editor's own schema to avoid a cross-schema
node-splicing bug the code's own comments document having found empirically), and the lazy-chunk boundary are
all correctly built and enforced by both source-scan tests and a fresh production build's manifest. But this
pass found four defects serious enough that they should not ship as found: a live Alfy edit can lose its own
visual proof (finding 5) under an easily-reachable timing window, a page reload can resurrect an old,
already-resolved edit's Keep/Undo bar as if Alfy had just made it again (finding 8) — directly undermining "your
words win" being *visibly* true, which Review Focus 4 names as the whole point of the feature — T6's entire
version-history/restore UI was built and unit-tested but never connected to anything a user can click (finding
9), and a refused checklist tick could leave a card's checkbox lying about the document's real state (finding
10, flagged mid-review by the orchestrator and confirmed reproducible here). All four are fixed here with
red-then-green proof; the three items flagged as already-known were also root-caused and fixed rather than
merely un-skipped.

The eight coordinator-assigned items picked up after the merge (below) were, on balance, more severe than this
half's own ten: an ordinary `![alt](url)` crashed the editor outright (item 1), a `|` typed in a table cell
silently dropped the cell after it (item 2), a code block containing its own fence-length backticks silently
split into three blocks (item 3), a task item's own hard break silently split its checked box from its text on
the very next autosave (item 5), two browser tabs on the same Document could silently overwrite each other
(item 6), and Undo could leave Alfy's own extra blocks behind forever (item 7) — four of these are silent data
corruption on ordinary use, not edge cases, and none had any test coverage naming them before this pass. Verdict
is unchanged: merge, now with all eighteen fixed.

## Findings

| # | Severity | Where | What breaks, for whom | Test | Commit |
|---|---|---|---|---|---|
| 1 | Low (test hygiene) | `tests/e2e/artifact-document.spec.ts`'s T8 live suite | The known `test.fail()` on "marks the applied block and shows the refusal notice for the refused one" carried a stale reason (a since-fixed editor crash). The real, current failure was a strict-mode locator collision: `RefusalNotice` renders a refused block's own label as its item text, which for this fixture is the identical string ("Book the flight.") as the untouched paragraph still sitting in the editor, so a page-wide `getByText(...)` matched both — the test was quarantined for the wrong reason and was proving nothing. | Scoped locators (the editor's own ProseMirror root vs. the notice's own testid); added the missing "untouched text is still there" assertion | `c70eeee3` |
| 2 | Medium | `src/app.css`'s `@media (max-width: 767px)` block | The mobile toolbar measured 53px against its 48px budget (T11.1). Root cause: `MobileToolbar.svelte`'s own comment correctly computes 45px (2×4px padding + 1px border + 36px button), but a global "mobile icon controls should meet the 44px target" rule applies `min-height: 44px !important` to every `.btn-icon-bare`, including this toolbar's, silently overriding its 36px back up to 44px. | The existing T11.1 e2e assertion (was `test.fail()`'d); ran green | `d26e33d6` |
| 3 | Medium | `DocumentBody.svelte`'s `.document-content`/`.document-editor-host` CSS | The SAME T11.1 test's second half (the editor must keep ≥60% of a 390×844 viewport) also failed once #2 was fixed: measured 28.4%. `.document-editor-host` had only `min-height: 240px`, never `flex: 1`, so on a short/empty document it hugged its floor and left the rest of the panel visually blank below the toolbar instead of filling the available space. Bundled into the same commit as #2 since both feed the one T11.1 assertion. | Same T11.1 e2e assertion, second half; ran green | `d26e33d6` |
| 4 | Low, but one half is a landmine | `src/lib/components/artifacts/document/extensions.ts` | `buildBlockIdTransaction` (mint-only) and `absorbBlockMarkers` (absorb-only) were superseded by `buildAbsorbAndMintTransaction` (does both atomically so the two steps can never race) but left behind with no caller — biome's `noUnusedVariables` correctly flagged both. `absorbBlockMarkers` was worse than dead: it dispatched without the `preventUpdate` meta flag that fixed the T7 `RangeError` crash (unbounded `onUpdate` re-entrancy through `readMarkdown`). If a future change had wired it in as a seemingly-lighter alternative to `ensureBlockIds`, it would have silently reintroduced that exact crash. | `npx biome check` (was 2 warnings, now 0) | `b84a6a3f` |
| 5 | **High** | `DocumentBody.svelte`'s `alfyActivity` `$effect` | A live `edit_artifact`/`create_artifact` call that **settles before** the lazy editor's `runLoad()` (`Promise.all([loadEditorModule(), fetchArtifact(...)])`) resolves is **lost forever**: `landAlfyActivity` no-ops while `editor`/`loadMarkdownFn`/`applyAlfyChangesFn` are still null, but the effect set `handledActivityKey` *before* that check, so the call was marked "handled" and never retried once the editor became ready — no Keep/Undo mark, no refusal notice, ever, even though the document body itself updates correctly (via a separate reload path), silently contradicting Review Focus 4 ("the refusal being invisible is a bug"). Found by rerunning the T8 live e2e test in isolation several times: it failed intermittently (~1 run in 6 on a cold dev server) with the exact symptom. Root cause confirmed with targeted debug logging (`landAlfyActivity enter {"hasEditor":false,...}`) before being fixed. | `DocumentBody.test.ts`: new unit test renders with an already-`applied` `alfyActivity` while `fetchArtifact` is held pending, asserts `mockApplyAlfyChanges` is eventually called once the load resolves — failed against the old effect, passes against the fix (reading `editorReady` inside the effect so it re-runs — and retries — the instant the editor becomes ready, instead of consuming the "handled" flag before it can act) | `63ac867d`, `e574f2ef` (a `svelte-check` regression in the new test's own TS, fixed same day) |
| 6 | Medium (performance) | `MarginPanel.svelte`'s comment re-measurement `$effect` | Hunt item 7 asks for "no layout thrash on each keystroke" at ~50 comments. `measureAnchorTops`'s own comment claimed its per-anchored-block `querySelector`+`getBoundingClientRect` pass was "cheap enough to re-run on every edit... since a Document only ever has a handful of open comment threads" — never checked at the ~50-comment scale the plan names, and the effect had no debounce. Measured directly: 10 rapid `blocks` updates (10 keystrokes' shape) against 50 open comments cost **510** uncoalesced reflow reads instead of one pass. | New test in `MarginPanel.test.ts`: spies on `getBoundingClientRect`, drives a 10-update burst, asserts the count under fake timers — failed at 510 calls, passes at 51 (one pass) after debouncing the effect at 120ms via its own cleanup (Svelte cancels the previous run's timer before the next) | `1bb35815` |
| 7 | Medium-High (accessibility) | `MobileToolbar.svelte`'s "More" sheet | The sheet renders `role="dialog" aria-modal="true"` and the UI states contract requires "The More sheet traps focus while open," but there was **no Tab handling at all** — only Escape was wired. A keyboard user could Tab straight through the "modal" sheet into the primary toolbar row behind the backdrop, which is worse than not claiming modality (assistive tech is told it's a modal; keyboard nav says otherwise). | Three new tests mirroring `DialogShell.test.ts`'s own "Tab focus trap" shape (jsdom has no native Tab-moves-focus behaviour, so only a positive "focus actively wraps" assertion proves anything): Shift+Tab from the first sheet action wraps to the last, Tab from the last wraps to the first, and a stray focus outside the sheet is pulled back in — all failed against the unfixed component, pass against a self-contained trap modelled on `DialogShell.svelte`'s own `trapTabNavigation` | `9a8e5f7a` |
| 8 | **High** | `+page.svelte`'s `liveDocumentAlfyActivity` derivation | Hunt item 4 asks whether "a reconnecting stream or a page reload does not replay stale marks." It did not hold. `findLiveDocumentAlfyActivity` deliberately scans the *whole* message list for the most recent Document call with no regard for age (correct, and already tested that way — "picks the MOST RECENT Document call across the whole message list"), but `DocumentBody.svelte`'s own replay guard (`handledActivityKey`) lives on the component instance and starts fresh on every mount. A full page reload re-fetches the whole conversation history, including a Document edit that may already have been Kept/Undone in a *previous* session, and it looked exactly like a brand-new settled call — replaying its Keep/Undo mark and refusal notice as if Alfy had just made the change again. | Extended the T8 live e2e test: after the real edit lands, reload the page and reopen the document, assert no stale `alfy-change-bar`/`refusal-notice`. Confirmed the regression is real by temporarily reverting *only* the new suppression wiring and rerunning: `alfy-change-bar` count came back `1` instead of `0`, exactly the predicted symptom, before the fix was restored. Fix: `_helpers.ts`'s new `liveDocumentAlfyActivityExcluding` suppresses exactly the one key the scan already returned the first time this conversation's history was observed this session (captured via `untrack()` in an effect keyed on `data.conversation.id`, so it re-arms on every conversation switch); a live call that settles while the page is open always has a fresh `callId` and is never suppressed. Four new unit tests cover the pure suppression rule directly. | `bc5544ae` |
| 9 | **High** (feature completeness) | `toolbar-actions.ts` / `DocumentBody.svelte` | T6's version-history/restore UI (`VersionsSheet.svelte`) was built and unit-tested on its own, but had **no way to open it anywhere in the running app**: a repo-wide search for its own exports and for `fetchArtifactVersions`/`restoreArtifactVersion` found exactly one importer each — their own test files. `toolbar-actions.ts`, explicitly the one action list both the desktop and mobile toolbars render from, had no `history`/`versions` action id at all, and no other menu or affordance opened it either. A user had no way to see a Document's history or restore an older version, despite the server routes, client API, and sheet component all already working correctly in isolation. | New `DocumentBody.test.ts` test — first run: `TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "History"` (confirming no such control existed at all) — now opens the sheet from a new "History" toolbar action (mirroring exactly how "download" already opens `DownloadSheet`), asserts it fetches the artifact's own versions, and that restoring reloads the editor through the existing `retryLoad()` path | `54c879ef` |
| 10 | **Medium-High** | `ArtifactCard.svelte`'s tickable checklist checkbox | Flagged mid-review by the orchestrator (from the in-chat card's own review): ticking a card's checklist item that gets refused (a version conflict, a dropped network request) could leave the checkbox **visually ticked while the stored document still says otherwise**. `checked={tickItem.done}` only re-syncs the DOM when `done`'s VALUE changes, but the input used `onchange`, and a checkbox's native click *always* flips its own `.checked` property immediately as the click's default action, independent of any framework binding. `handleToggleDocumentTask` (`+page.svelte`) correctly leaves the card's data untouched on a refusal (`if (!result.ok) return;`) — exactly the case where `done` never changes — so Svelte never had a reason to touch the checkbox again, leaving the browser's own native toggle uncorrected. Checked `ToolActivityRow.svelte` (the in-chat activity row that also renders `ArtifactCard`) to see whether a second, separate checklist implementation existed there: it does not — today it only builds a File-kind card view, with no `tickable` field, so a Document's checklist has no inline-chat renderer yet. The fix still matters for that future integration, not only today's panel list: it lives in the one shared `ArtifactCard.svelte` (`AGENTS.md`: "the one card every kind renders as"), so whenever a chat-inline Document card is wired up, it inherits the correct behaviour automatically rather than needing the same fix twice. | New `ArtifactCard.test.ts` test: an `onToggle` that deliberately leaves `done` unchanged (simulating the refusal) — clicked, then asserted `checkbox.checked` was still `false`; came back `true`, reproducing the bug exactly. Fixed by moving the handler to `onclick` with `event.preventDefault()`, so the native toggle never fires and `checked` is the only thing that ever moves the box. The existing e2e "ticking an item writes it through the same patch path" test (the success path) still passes unmodified. | `e07470e9` |

Also added (no defect — hardening plus closing a coverage gap the hunt list named explicitly): hunt item 8 asks
for "no horizontal overflow at 390 px." Nothing tested this for an *open* document with real content —
`artifacts-panel.spec.ts`'s own 390×844 overflow check covers only the panel list, by its own header comment. A
wide table is the one Document block kind actually likely to force this. Measured first, and it does **not**
currently overflow: `.document-content`'s `overflow-y: auto` computes `overflow-x` to `auto` too, under the CSS
spec's "if one axis is visible and the other is not, visible becomes auto" rule, giving a wide table its own
horizontal scrollbar inside the content area. That protection was real but entirely implicit and undocumented,
so a future edit to that one `overflow-y` declaration could silently reintroduce page-level horizontal scroll
with nothing to catch it. Added the missing e2e coverage (green from the start — this is hardening an
already-correct-but-fragile behaviour, not a red-to-green fix) and made the guard explicit with its own
`overflow-x: auto`. Commit `416c15ac`.

A note on why finding 9 wasn't already caught by the existing gates: Fallow's own `unused_files` list (124
total findings, unchanged by this review) never named `VersionsSheet.svelte` — its cross-file reachability graph
counts `VersionsSheet.test.ts`'s import as a legitimate consumer, same as any production import, so a file
reachable only from its own test is invisible to that class of static analysis. Confirmed by checking every
other Document component the same way (grepped each `.svelte` file's own name against the whole `src` tree,
excluding its own file and test): `VersionsSheet.svelte` was the only one with zero non-test importers before
this fix. This is specifically the kind of gap only a manual "can a user actually reach this" trace catches.

Also flagged, not fixed here (out of this review's scope but worth a background task): `MobileToolbar.svelte`'s
new focus-trap logic (finding 7) duplicates `DialogShell.svelte`'s existing `isRendered`/`getFocusableElements`/
Tab-wrap logic almost exactly. Extracting a shared helper is a pure refactor with no behaviour change, so it was
spawned as a follow-up task (`task_2c19c69e`) rather than done mid-review.

## Hunt list — what checked out clean

- **The lazy chunk (hunt item 1).** Confirmed two ways: the existing source-scan test (`lazy-boundary.test.ts`,
  17 assertions) still passes, and a fresh production build's own `.vite/manifest.json` shows `document-editor.ts`
  compiling to a 451.50 kB / 142.21 kB-gzip chunk (matching the prototype's recorded ~147 kB gzip figure) reached
  **only** via `DocumentBody.svelte`'s `dynamicImports` entry — a full search of every entry in the manifest found
  no other importer, static or dynamic, of either `DocumentBody.svelte` or `document-editor.ts`'s compiled output.
- **Tiptap in Svelte 5 (hunt item 2), the rest of it.** Grepped every `editor.view.dispatch(...)` call in
  `document-editor.ts` and `extensions.ts`: every internal (non-user) dispatch correctly carries
  `preventUpdate: true` and `addToHistory: false` (or `emitUpdate: false` on `setContent`); the one dispatch that
  deliberately omits both is the tracker chip's own `<select>` change handler, which is a genuine user edit and
  must mark the document dirty — confirmed this is intentional, not an oversight. `onDestroy` correctly destroys
  the editor and bumps `loadToken` so a stale in-flight load can never clobber a newer one. The T7 crash's own
  regression test ("sustained edits... never crash the editor," driving typing, a table cell, "Add a tab," and a
  chip change back to back) still passes. Autosave's debounce/offline/404/413/conflict paths already have
  dedicated tests in `DocumentBody.test.ts` predating this review; read them and found them correctly matching
  the failure-modes table (offline keeps retrying, `too_large`/`not_found` stop the loop, a conflict keeps the
  user's text) — no new defect, no new test needed there.
- **Keep/Undo exactness (hunt item 3).** `undoAlfyChange` round-trips the inverse markdown through a **fresh**
  extension list and a temp editor, then re-parses the result via `Node.fromJSON` against the **live** editor's
  own schema before splicing it in — the code's own comments document two empirically-found pitfalls (a shared
  resolved extension list throws `RangeError: Adding different instances of a keyed plugin`; a cross-schema node
  silently drops content instead of throwing) and the implementation avoids both. `patch.ts`'s `inverses` are used
  directly, never a re-parse of an older document snapshot, so a concurrent edit to a different block can't be
  silently dropped by Undo. Existing tests cover Keep-then-second-patch-applies, Undo-then-refuses-`block_changed`,
  and Undo-twice-is-a-no-op.
- **The live channel, the rest of it (hunt item 4).** Marks are rebuilt from `reconstructDocumentPatch` using the
  server's own `refusedBlocksJson`/`appliedCount` to decide applied-vs-refused per op — never guessed — so a
  normalised-text or server-side-only refusal can't produce a mismatched mark.
- **The refusal notice (hunt item 5).** Names the block's label and count via `summarizeRefusals`; "See what Alfy
  did" is wired to `entries[0]?.changeId` and omitted entirely (`seeChangeLabel: null`) when nothing applied, so a
  full refusal correctly shows the notice alone with no dead scroll link.
- **Chips (hunt item 6, the chip half).** `chips.ts` is a pure, three-argument `(kind, value, locale) -> label`
  module with no store subscription and no `$t` import, so it structurally cannot localise stored content by
  accident; an unrecognised value falls back to being shown verbatim rather than crashing. Tabs (add/rename/
  delete/hide-at-one-tab) have existing, named test coverage in `DocumentBody.test.ts`; read the tests and the
  implementation and found them consistent, no new defect.
- **The margin, the rest of it (hunt item 7).** `layoutMarginThreads` is pure and correct-by-construction for
  no-overlap (each thread's `top` is `max(anchorTop, cursor)`, `cursor` always advances past the previous
  thread's bottom plus a gap); orphan grouping has existing, passing tests.
- **i18n (hunt item 9).** `npx vitest run src/lib/i18n.test.ts src/lib/i18n/artifacts.test.ts` — both green (12 +
  5 tests), including the no-`/artifact/i`-in-either-locale check and the `AUDITED_PREFIXES` coverage.

## Open questions for the orchestrator (no code changes — this is a product-behaviour call, not a bug)

1. **Finding 8's suppression window is "since this browser tab's session began," not "since N seconds ago."** If
   a user asks Alfy to edit a Document from one tab, then opens the *same* conversation in a brand-new second tab
   moments later (before the panel in the second tab ever mounted), the second tab's suppression snapshot is
   captured fresh at ITS OWN mount and would show the marks correctly — this case is fine. The genuinely open
   case is: could a legitimate "I just asked for this, showed the result, and reloaded the page immediately
   after" flow want the marks to survive one reload? As specified today (no grace period named anywhere in
   `slice-1.md`), the fix's conservative default (suppress anything that predates this session, full stop) is the
   defensible reading, but it's a product call, not something the spec settles explicitly.

## Coordinator-assigned fixes (post-merge)

Once this branch merged RV-1A's engine/server review (`d4e5047c`, zero conflicts requiring manual resolution
beyond git's own auto-merge), the orchestrator assigned eight further cross-cutting defects — some from the
engine review's own "open question for the editor" notes, some new — to close on the combined branch. Same
method as the ten findings above: a failing test first, the smallest fix, re-verified; for the two most
structurally risky fixes (item 5's block-splitting and item 7's Undo), an explicit revert-and-retest of the fix
itself, the same discipline finding 5 and finding 8 above used.

| # | Severity | Where | What breaks, for whom | Test | Commit |
|---|---|---|---|---|---|
| 11 (item 1) | **High** | `extensions.ts`'s `buildDocumentExtensions` | This Document registers no Image node — a completely ordinary `![alt](url)` Alfy might write into a body crashed the editor on open (`Invalid content for node doc`), because `@tiptap/markdown`'s fallback parsing for an unrecognised inline token left a bare node with only the alt text sitting directly under `doc`. | `document-editor.test.ts`: three new tests construct `![alt](url)` and `![](url)` bodies directly and load them; failed with the exact crash before the fix. Fixed two ways: a generic orphan-wrapping pass in `buildAbsorbAndMintTransaction` (wraps ANY node the schema's doc content-match rejects in a paragraph, a general safety net for this whole class of bug) plus a specific `ImageAsPlainText` handler for the no-alt-text case, which the generic wrap alone would otherwise turn into a silently blank paragraph. | `dcce614a` |
| 12 (item 2) | **High** | `document-editor.ts`'s `readMarkdown` | A literal `\|` typed inside a table cell — an ordinary character to the user — is written bare by `@tiptap/markdown`'s table serializer. On the very next parse, `blocks.ts`'s table reader counts it as an extra column, reflows the row, and once padded back to the header's column count, silently **drops** the cell after it. | `document-editor.test.ts`: table-cell round-trip tests, failed with the dropped cell before the fix. Fixed with a sentinel substituted for a cell's own `\|` before `getMarkdown()` runs and turned into the real escape only in the returned string — two more direct approaches (inserting `\|` before serializing; a sentinel containing underscores) were tried and rejected empirically first, both documented in the commit, because `getMarkdown()` itself escapes backslashes and underscores. | `a1dafd90` |
| 13 (item 3) | **High** | `document-editor.ts`'s `readMarkdown` | A code block whose own content contains a line of 3+ backticks (documentation about fencing, a pasted Markdown snippet) still got a plain 3-backtick outer fence from `getMarkdown()`. CommonMark closes a fence at the first backtick-only line at least as long as the opening one, so the inner line read as the block's own close on the next parse — one code block silently became three (a truncated code block, a paragraph, a stray second code block). | `document-editor.test.ts`: a code block built directly via ProseMirror node construction (a markdown-SOURCE test input would already be ambiguous at the first parse, proving nothing about re-serialization) containing a 3-backtick line, then a 4-backtick line; both failed (split into 3 blocks) before the fix. Fixed by finding, in the LIVE document, every code block whose content needs a longer fence and widening its fence to one backtick more than its longest internal all-backtick line. | `eeaf1907` |
| 14 (item 4) | **Medium-High** | `document-editor.ts`'s `readMarkdown` | A plain paragraph whose own first line happens to start with an ordered numeral ("2024. ") or a bullet character ("- ") is, in bare Markdown, indistinguishable from a real list — `blocks.ts`'s splitter read either shape as `kind: "list"` on the very next parse, silently changing the block's own kind, its label, and any comment anchor resolved against it. | `document-editor.test.ts`: paragraphs built directly via ProseMirror node construction (again bypassing markdown-source ambiguity) starting "2024. ", "- ", and "1) "; all three reparsed as `kind: "list"` before the fix. Fixed by escaping the look-alike marker in the OUTPUT STRING, after `getMarkdown()` already ran (never by inserting a backslash into the live text first — the same double-escaping trap item 2 already hit), found via the live document's own paragraph nodes so a REAL list's own "- " is never touched. | `ca758f9c` |
| 15 (item 5) | **High** | `blocks.ts`'s `consumeSingleListItem` | A task item cannot hold a hard break. `keepHardBreaks` already, correctly, trims a task line's hard break flush to the left margin rather than a backslash (the editor's own task-item markdown reader keeps a backslash as literal text — an existing, deliberate, tested trade-off, left untouched). But `consumeSingleListItem`, unlike `consumeListBlock` right below it, had no path at all for an UNINDENTED continuation line — exactly the shape a task's hard break always normalises to. The checked box and its own second line split into two top-level blocks, a fresh id minted for the second, on the very next reopen **or the very next client-side autosave** (`DocumentBody.svelte`'s `currentCanonicalMarkdown` runs the same `parseDocument` pass on every dirty check). | `blocks.test.ts`: a task line followed by an unindented continuation, confirmed red (`["taskList", "paragraph"]` instead of `["taskList"]`) before the fix. Explicitly re-confirmed red by temporarily removing just the new `isLazyContinuation` branch and rerunning, then restored. Fixed by giving `consumeSingleListItem` the same `isLazyContinuation` fallback `consumeListBlock` already has. All existing task/list coverage (indented continuation, nested items, sibling tasks, second paragraph after a blank line) stays green unchanged. | `47f075b3` |
| 16 (item 6) | **High** | `DocumentBody.svelte`'s `bindAutosave` | The editor's own autosave never sent `baseHash`, so two browser tabs open on the same Document could silently overwrite each other: ruling 47's coalescing lets both tabs' saves legally target the SAME, unmoved version number, so `expectVersion` alone cannot detect the clobber — only a body-hash guard can, and the route already accepted one (RV-1A) that the editor's own save call never sent. | `body.test.ts` (route): new coverage proves `baseHash` reaches `saveDocumentBody`, a stale `baseHash` answers 409, and a document save's response carries its own new `bodyHash` forward. `DocumentBody.test.ts`: proves the load-time hash is sent on the first autosave, a `stale` refusal shows the same conflict notice `version_conflict` already did without touching the user's text, and — the regression this fix exists to prevent — the SECOND autosave sends the hash the FIRST one's response just returned, not the load-time one. Fixed with a `knownBodyHash` tracked from load, every reload that follows someone else's write, `saveCopy`, and this component's own successful saves — which needed `saveDocumentBody`/the body route/the client's `SaveArtifactBodyResult` to thread the new hash back at all, since none of them did. | `b2a0bd4b` |
| 17 (item 7) | **High** | `marks.ts`'s `undoAlfyChange` | `patch.ts`'s `reblock` already mints a fresh id for every block beyond the first when an applied op's own text reads back as more than one block (a paragraph Alfy split in two, a new section appended), and records them as `PatchInverse.insertedBlockIds` — but nothing between there and the editor ever carried that field forward. Undo only ever replaced the op's own block with its pre-edit text; every block Alfy's op added stayed in the document forever, surviving an "undo" that was supposed to restore what was there before the op ran. | `marks.test.ts`: a `replaceBlock` op whose text reads back as two blocks, undone; the inserted block's id was still present in the reloaded document before the fix. Explicitly re-confirmed red by temporarily removing the new `deleteBlocksById` call and rerunning, then restored. Fixed by carrying `insertedBlockIds` through `AlfyChangeEntry`/`applyAlfyChangeMarks`/`undoAlfyChange`/`document-editor.ts`'s `undoChange` wrapper, and deleting those blocks in the SAME transaction as the text restore. `DocumentBody.svelte` needed no change — it already replays the whole `AlfyChangeEntry` object. | `e674d0f7` |
| 18 (item 8) | **Medium-High** | `comments.ts`'s `runAlfyCommentReply` | `@Alfy`'s own `ops` field is an array: the model can describe a change as several ops against the SAME anchored block in one comment reply, and a later op can be refused (most commonly `find_not_found`, when a later `replaceRange`'s own `find` text just is not in the block) independently of an earlier op's success. Alfy's "note" only ever describes what it changed, never what it could not — a reply that applied one op and refused another read in the thread as an unqualified success. | `comments.test.ts`: a two-op reply (one valid `replaceRange`, one whose `find` text does not exist) confirmed `applied: 1, refused: 1` with a bare, unqualified note before the fix; a second test confirms an ordinary fully-applied reply gets no suffix. `CommentCard.test.ts`: proves the note and a new notice both render, the raw marker never leaks, the empty-reply marker still resolves under the suffix, and a user's own comment is never mistaken for one. Fixed with a new `ALFY_PARTIAL_REFUSAL_SUFFIX` appended (never replacing, unlike the two existing whole-body markers) to the reply body when the same request both applied and refused at least one op; `CommentCard.svelte` strips it before its existing marker checks and renders a small, separately-styled, localized (English/Hungarian) notice line. | `51b743ec` |

None of the eight required touching a file the OTHER side's review had already fixed for a DIFFERENT reason — the one file both branches touched (`extensions.ts`: RV-1A's duplicate-id fix, this branch's dead-code removal) merged cleanly with git's own auto-merge, confirmed by rereading the merged file afterward rather than trusting a clean exit code alone.

## Gate summary

### Checkpoint run, at `e07470e9` (this review's own ten findings, pre-merge)

`bash gates.sh …/rv-1b 5630 rv-1b tests/e2e/artifact-document.spec.ts tests/e2e/artifact-document-comments.spec.ts
tests/e2e/artifacts-panel.spec.ts`:

```
gates rv-1b at e07470e9 Fix the card checklist's checkbox not reverting after a refused — start 14:58:21
check      exit=0 :: COMPLETED 7891 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=0 :: Checked 2039 files in 698ms. No fixes applied.
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 865 passed | 1 skipped (866)  Tests 12834 passed | 2 skipped (12836)
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ::  47 passed (1.5m)
done 15:02:24
```

Every number matched or improved on the slice's own recorded baseline: 0 errors/17 warnings unchanged, biome
clean (was 2 warnings — this review's own dead-code removal, finding 4), build 32/2 unchanged, Fallow
124/4/+0/+0 unchanged. All 47 Playwright tests (`chat.spec.ts` + `conversation.spec.ts` +
`artifact-document.spec.ts` + `artifact-document-comments.spec.ts` + `artifacts-panel.spec.ts`) passed, zero
failures, zero flakes.

One infrastructure note, not a code defect: an earlier full gate run at the same HEAD failed all 47 Playwright
tests with `Failed to hydrate: TypeError: Cannot read properties of undefined (reading 'call')` — exactly the
stale-`.svelte-kit`-cache symptom this worktree's own setup notes describe (this worktree's `node_modules` is a
shared install with `art-s1`, and repeated `npm run build`/dev-server starts across many ports over this long
review session left `.svelte-kit`'s generated output out of sync with it). Fixed per those same notes: deleted
only this worktree's `.svelte-kit` (never `node_modules/.vite`, which is shared), regenerated it with
`npx svelte-kit sync`, confirmed with two clean smoke-test runs, then reran the full gate script — the run
recorded above.

### Final run, at `51b743ec` (after the merge and all eight coordinator-assigned fixes)

Same invocation, same worktree, at the branch's actual final HEAD:

```
gates rv-1b at 51b743ec Surface a partially-refused @Alfy comment reply in the thread i — start 16:12:31
check      exit=0 :: COMPLETED 7893 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=0 :: Checked 2041 files in 653ms. No fixes applied.
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 867 passed | 1 skipped (868)  Tests 12925 passed | 2 skipped (12927)
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ::  47 passed (1.5m)
done 16:16:39
```

Still clean at the merged, fully-fixed HEAD: 0 errors/17 warnings unchanged, biome clean, build 32/2 unchanged,
Fallow still 124/4/+0/+0 (RV-1A's engine review and this review's eight post-merge fixes together introduced no
new circular dependency and closed none of the four already-known ones — expected, since none of the eighteen
fixes across both reviews touched the shared/server import graph the four known cycles live in). Test Files rose
865→867 and Tests 12834→12925 (+91) purely from new coverage — RV-1A's own merged tests plus this review's
post-merge regression tests — with zero failures and zero skips beyond the same two pre-existing skips. The same
47 Playwright specs passed again, zero failures, zero flakes, no repeat of the stale-`.svelte-kit` issue (already
fixed for this worktree at the checkpoint run above).

## Branch

`feat/artifacts-s1-review-editor`, on top of `e17c6f09`:

- 11 commits carrying this review's own ten findings (findings 2 and 3 share one commit, finding 5 spans two)
  plus one coverage-only addition, through checkpoint HEAD `e07470e9`.
- `4003da51`: RV-1A's own review doc, the tip of the merged `feat/artifacts-s1-review-engine` (32 fixes on top of
  `e17c6f09`, `7f0f0f15`..`4003da51`).
- `d4e5047c`: the merge of that branch into this one.
- 8 commits carrying the coordinator-assigned post-merge fixes above (items 1–8, one commit each, in order).
- This doc update.

Zero `test.fail()` remain in `tests/e2e/artifact-document.spec.ts`, `tests/e2e/artifact-document-comments.spec.ts`,
or `tests/e2e/artifacts-panel.spec.ts`.
