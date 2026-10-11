# VB-2 report — History mode, the latest moment on every surface, the Document's preview, restore and naming

Status: **DONE_WITH_CONCERNS** (everything in the brief is built, merged with VB-1 and green except one gate, the
chat-route first-load baseline, which is +8,858 B over; details and a recommendation below).
Model: `claude-sonnet-5-5` (Sonnet 5.5). Branch `feat/versioning-history`, worktree `.claude/worktrees/art-vb2`.
Commit range: `edcc2d84..2f7b776f` (VB-2's own commits below; `048eeb83` is the merge of `feat/artifacts` at VB-1's `011513cd`).

| commit | what |
|---|---|
| `a343858f` | Part 1: the data layer and the latest moment on every surface (A1/Q2) |
| `d02083ed` | Part 2: History as a mode of the panel (rail, preview slot, three layouts, keyboard, live region) |
| `048eeb83` | merge `feat/artifacts` (VB-1's server) |
| `ebfc95a9` | Undo/Redo send `summaryVersion`; History's specs switched from fixtures to the real routes |
| `efe78928` | Part 3: the Document's block+word preview, restore with `expectVersion`, naming, "From the chat" |
| `fa1cf5aa` | older specs pointed at History / the latest moment instead of the Versions popover and version numbers |
| `ca14e14f` | Fallow: a type no one imports is private again |
| `2f7b776f` | the rail's sentences moved out of the chat route's first load (−1.6 KB gzip) |

## What was built

**Part 1 — one latest moment (A1).** `src/lib/client/artifact-versions.ts` keeps, per artifact, the highest version with
its time, author and kind (`observeArtifactMoment`, monotonic; a higher version replaces the whole moment, the same version
only fills in or refines). Every writer in `client/api/artifacts.ts` announces who and what (`momentOfSave`; restore →
`restore`/`undo_restore`, App rebuild → `app_rebuilt`, tick → `tick`, copy → `saved_as_copy`, `fetchArtifact` →
`lastAuthor ?? versions[0].author` + `lastKind`). The chat page keeps one `observedArtifactMoments` map instead of two and
reads every row, card and open item through it. The header's version trigger is now the history button
(`artifact-history-button`, with `artifact-version-pill` kept as the wrapper alias): "Changed by Alfy · 12 min ago",
headline truncates, time never, accessible name one sentence. List rows print the bare time; the in-chat card (Document and
Canvas) prints "edited 2 min ago"; the fixed "You and Alfy · edited …" header line is gone; **no surface prints a version
number except History's fine print**. `artifacts.history.*` is in EN and HU (parity-tested). AGENTS.md: the "One version
number" bullet is now A1's "One latest moment" bullet, plus a "History is a mode of the panel" bullet.

**Part 2 — History mode** (`src/lib/components/artifacts/history/`, one lazy entry `history-parts.ts`).
`DocumentWorkspace.svelte` lays History as a slot over the still-mounted, `inert` body (`.workspace-stage`); entering
History first awaits the body's registered `flush` (4 s budget, never waits for a connection), leaving after a restore calls
the body's `reload`. Done button in the actions; Comments and Download step aside. Layouts: wide (≥720 px, 300 px rail on the
right), narrow (rail alone, preview pushed, "‹ History" back + previous/next), phone (`DialogShell` full sheet, restore
in the bottom bar). The rail is a single-select listbox with roving tabindex (selection follows focus; ↑/↓/Home/End,
PageUp/PageDown by day), day groups, folded steps, the Named filter, "Show older" paging, one-sentence option names
(`entryA11yName`), a live region that announces a selection once, a dismissible keyboard help. Escape peels one layer
(restore question → pushed preview → History). `moment-text.ts` words every `MomentKind` (incl. Canvas/App rows) from the
server's facts, a `text` of null falls back to it. `history-previews.ts` is the per-kind registry (`document` only today).

**Part 3 — the Document's preview, restore, naming.** `DocumentVersionPreview.svelte` is a read-only Markdown render (no
Tiptap) with a block alignment by id (hash fallback for marker-less bodies) and a word diff (`document-diff.ts`: LCS over
`\p{L}`-aware tokens, 250k-cell cap, folds of ≥3 unchanged blocks); marks are `<mark>`/`<del>` rebuilt per text node with
screen-reader labels (`mark-html.ts`), Alfy's marks in the accent, the reader's and compare mode neutral. "This version's
changes / Compared with now" switch and a change stepper. Restore only from the preview, `expectVersion` = the page's
`newestVersion`; a stale restore (409 `version_conflict`) is answered inline ("It changed while you were looking. Here's the
latest.") and the page refreshes; the success toast's Undo is the restore of the row below with `{expectVersion:S,
undoOf:S}` so it folds with the restore. Naming: `PATCH` with the 60-char normalised label, Name/Rename/Remove name, the
Named filter, a named version closes the typing burst. "From the chat" scrolls to and flashes the message
(`handleShowChatMessage`; on a phone the panel closes first). The Document's review pill Undo/Redo save with
`summaryKind` + `summaryVersion` (the Alfy version a block's change belongs to), as VB-1 requires, so they fold.
`DocumentBody.svelte` lost its `VersionsSheet` mount and registers `{openDownload, toggleComments, flush, reload,
reviewPending}`.

## Tests

Red first on the History spec: before Part 2 the then-existing 7 tests failed (no mode), before Part 3's pieces 3 of 11
failed (naming focus, restore), each turned green by the code. Real input throughout (keyboard, tap, real routes, the fake
provider for real `edit_artifact` turns; the DB seeded through the artifact service).
- `tests/e2e/artifact-history.spec.ts` (11): open/Done and the body staying put, scroll, P10 flush, T9 a11y/keyboard,
  T3 paging, T8 Hungarian, marks/stepper/folds/compare, T2 naming, T5 restore with an unsaved step, the inline conflict,
  T4 phone.
- `tests/e2e/artifact-versions.spec.ts` (rewritten): T1 one latest moment walked across header, row, card, Review, From the
  chat, a folded Undo, a restore, the toast's Undo and a reload; the restore toast's exits.
- Vitest: `artifact-versions.test.ts` 28, `moment-text.test.ts` 25, `document-diff.test.ts` 16, `rail-model.test.ts` 15,
  `mark-html.test.ts` 8, plus additions in `artifacts.test.ts`, `DocumentBody.test.ts`, `document-autosave.test.ts`,
  `ArtifactCard/ArtifactPanelHeader/DocumentWorkspace/ToolActivityRow/card-view/page-runtime` tests.
- Older specs updated because the Versions popover and every printed version number are gone: `artifact-document.spec.ts`,
  `artifact-chat-card.spec.ts`, `artifact-card-narrow.spec.ts`, `artifact-panel-swap/popover-press/names.spec.ts`,
  `artifact-document-comments.spec.ts` (the stacking rules are proved on the Download popover and on History),
  `artifact-canvas.spec.ts`.

## Gates (final tree `2f7b776f`)

| gate | result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (= baseline) |
| `npx biome check src scripts tests` | clean (2,582 files) |
| `npm test` | 1,047 files passed (1 skipped), 17,643 tests passed (2 skipped) |
| `npm run build` | exit 0; 32 Unused-CSS + 2 ARIA-role warnings (= baseline); worker-assets OK |
| `npm run check:artifact-chunks` | **exit 1, chat route only**: 550,862 B gzip, +8,858 over the 542,004 baseline (2,048 allowed). CanvasEditor numbers pass (62.9 kB target, 70.9 kB on its own, ceilings 65,000 / 72,704; Chart.js, MapLibre, Mermaid absent) |
| Fallow | 124 issues, 4 circular (= baseline); my one new finding (an exported type) fixed |
| `npm run check:migrations` | OK |
| Playwright, the brief's set (16 files, 146 tests) | 144 passed, 2 failed (`artifact-panel-names` EN and HU asserted "v1"/"v2" in a row's name) → fixed, rerun 2/2 green |
| Playwright, wider Canvas/App/delete/library-delete/tours/api set (433 tests) | 410 passed, 23 skipped by the specs, 0 failed (this checks the new `.workspace-stage` wrapper and header against every other kind) |
| Final sanity after the last code change | history + versions + names + document specs: 39/39 |

### The chat-route number, and what I recommend
+8,858 B gzip is real and not the History code (nothing History-only is in the route's static closure; I checked chunk by
chunk). The parts: 3.2 KB (measured in the built chunk) are the 244 `artifacts.history.*` EN+HU strings in the
app's one static merged dictionary chunk (there is no lazy dictionary); estimated from each module minified and gzipped:
~0.5 KB the phrase module, ~0.3 KB the moment store, ~0.7 KB the API additions (announcements, history/name/restore); the
rest, about 4 KB, is the panel shell (DocumentWorkspace slot and state, header, page, card).
I already took 1.6 KB off by splitting `moment-phrase.ts` (header/rows/card) from `moment-text.ts` (lazy, History only).
The brief expected the Document body to shrink by losing its `VersionsSheet`; the Document body is a lazy chunk outside
this route's first load, so that never shows here. A lazy dictionary would save ~2.9 KB more but would still fail the
2 KiB tolerance and is a global i18n change, so I did not do it. **Recommendation: re-baseline `--chat-baseline` in
`package.json` to 550862 when this merges** (I did not touch `package.json`; AGENTS.md says a deliberate re-baseline needs a
recorded reason, this is it), or drop the byte baseline as the dev-speed work intends.

## Screenshots (looked at every one; `vb2-shots/`, 8 files)
Look first at `02` (a folded Undo: Alfy's change with "Undone" and its "You undid it" step, accent marks for the rewritten
and added blocks), `03` (the restore question over a compared preview) and `07` (the phone preview).
`01` 1440 light, newest moment; `02` 1440 folded Undo; `03` 1440 restore question; `04` 1440 Hungarian, dark, a named
version with the Named filter; `05` 1100 docked, pushed preview; `06` 390 list; `07` 390 preview; `08` 390 restore question.
(The orange "capabilities degraded" banner in the chat column is this machine's tool health, not the change.)

## Deviations and concerns
1. **Chat-route baseline** as above.
2. **"From the chat" needed a server change outside my boundary**: `create_artifact`/`edit_artifact` now put `versionId`
   (edit also `parentVersionId` when it has one) in the tool call's metadata (`normal-chat-tools/artifact-tools/create.ts`,
   `edit.ts`, tests updated). Messages written before this have no link; nothing else changes.
3. `DocumentWorkspaceItem` gained `lastAuthor`/`lastKind` (`services/knowledge/types.ts`), a one-line type for the panel item.
4. **The Knowledge → Documents table still prints a version badge** (`v7`) on artifact rows
   (`DocumentsList.svelte`, `documents-table.ts`): the design's surface list does not cover it, I left it. Say if it should
   read the latest moment too.
5. The Document body now registers `flush`, so the chat page (which already awaits a registered flush before a fresh turn,
   as for a board) also waits, bounded, for a pending Document autosave. Intended by T5, but it is a behaviour the Document
   did not have.
6. Phone: Name sits in the toolbar's title row, not behind a ⋯ menu; the keyboard tab order passes the help banner's
   "Got it" before the toolbar's Name; the first version of an item opens in "Compared with now" because it has no
   predecessor to diff against.
7. Hungarian was written from §8 and the brief's example; T8 proves it renders with no English leaking, not that it reads
   naturally everywhere. A native read before release is worth it.
8. The earlier "Reload first" conflict line is gone: a stale restore is refused by the server's guard and answered inline
   with the latest, which is what VB-1's `expectVersion` makes possible.

## Hand-off for VB-3
- Registry: `history/history-previews.ts` — `HISTORY_PREVIEWS` (document only), `HistoryPreviewProps`, `kindHasHistory`.
  Add a Canvas and an App entry; `HistoryMode` renders the entry for the item's kind.
- Until then the header button for those kinds falls back to `bodyPanelActions.openVersions` (`DocumentWorkspace`:
  `onHistory={kindHasHistory(kind) ? toggleHistory : bodyPanelActions?.openVersions}`). When the previews exist, `kindHasHistory`
  turns true by itself; then delete `document/VersionsSheet.svelte`, `document/version-summary.ts`, the Canvas sheet mount,
  the fallback and `ArtifactPanelBodyActions.openVersions`.
- A body that wants History to be safe registers `flush` (save what is typed first) and `reload` (load the stored item after a
  restore) in `ArtifactPanelBodyActions`; the Document's registration in `DocumentBody.svelte` is the model.
- `moment-text.ts` already words every `MomentKind` including the Canvas and App rows (`entryDetail`); `rail-model.ts`
  (`RailEntry`, `buildRailGroups`, `nextRailKey`, `mergeFirstPage`) is kind-neutral. `moment-phrase.ts` is the only History
  module the chat route loads; keep rail words out of it.
- e2e patterns to copy: `artifact-history.spec.ts` (seeding through the artifact service, real routes, the fake provider
  for a real edit turn, the phone `DialogShell` sheet queries).
