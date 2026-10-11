# VB-1 report — versioning build, the server (ruling 76)

Model: Sonnet 5.5 (`claude-sonnet-5-5`). Branch `feat/versioning-server` (worktree `art-vb1`), commits `edcc2d84..HEAD` (12 commits, listed at the end). Nothing pushed, merged or rebased.

## Status

DONE_WITH_CONCERNS. Steps 0, 1 and 2 are built, tested and committed. Concerns are in the last section; none blocks VB-2/VB-3, and the old-App route needs the Opus security review before `dev`.

## Step 0 (shared type)

`src/lib/shared/artifacts/history.ts`, committed alone as `edcc2d84`; the orchestrator was messaged with the hash. Since then it changed additively only: `normalizeVersionLabel`, the `invalid_request` reason on the restore/history unions. Read its header comment first: it states which row a moment shows (`versionId`), what its changes are measured against (`parentVersionId`) and who credits what.

## Step 1 (vocabulary, migration, writers)

- `shared/artifacts/version-summaries.ts`: the whole §4.5 vocabulary with parsers (old forms still parsed): `alfyEdit`, `alfyCommentReply`, `keptFromChat`, `alfyRemade`, `madeAppSummary/parseMadeApp`, `regeneratedAppSummary/parseRegeneratedApp`, `undidAlfyChangeSummary(n?)/parseUndidAlfyChange`, `redidAlfyChangeSummary/parseRedidAlfyChange`, `undidRestoreSummary/parseUndidRestore`, `parseSummaryVersion`, `saveSummaryFor(kind, version)`, and `classifyVersionSummary({author, summary, versionNumber})` (author + version number decide, never the text: an Alfy row reading "Restored v3" is an Alfy edit; a first-draft summary on v5 is an edit).
- Writers moved onto it: `comments.ts`, `canvas-comments.ts`, `edit.ts` (both fallbacks), `keep-message.ts`, `app/create.ts`, `app/regenerate.ts`, and Regenerate's first version ("Alfy made it again": the create handlers and `createAppFromBrief` write it when handed an id, and only Regenerate hands one in). A grep over `src/lib/server` and `src/routes` finds no other summary literal.
- Body route: `summaryKind` gains `redid_alfy_change`, and Undo/Redo take `summaryVersion` (a positive integer no larger than the artifact's own newest number; anything else names nothing: an Undo falls back to the plain old form, a Redo to "Edited").
- Migration `drizzle/1777140000113_artifact_version_moments.sql` (`started_at integer`, `label text`, both nullable, no backfill), `_journal.json`, `schema.ts`, `scripts/prepare-db.ts` required columns, the account archive prints the name (`Name: …`). `npm run check:migrations` passes.
- `record.ts` `updateArtifactBody` (A2/Q4): `started_at` stamped on every insert and untouched by a coalesced update; coalescing only into the reader's own latest version with the same summary, no `label`, last saved under 10 minutes ago and a burst that began under 30 minutes ago (a row with no `started_at` is bound by the ten-minute rule alone).
- Q8: `edit_artifact`'s `summary` field now asks for "what you changed, in one short past-tense line with no subject (“Moved the museum to Thursday”); shown next to Keep/Undo and in History". See the first deviation about the ceiling.

## Step 2 (history, restore, naming, routes)

- `services/artifacts/moments/derive.ts` (pure `deriveMoments`), `detail.ts` (Document block diff incl. tick and tab, Canvas `diffBoards`, App line counts), `line-diff.ts` (Myers, capped), `history.ts` (`listHistory`, on the facade, loader + a `(version id, body hash)` detail cache of small facts only). A page reads the newest `limit` rows below `before` plus 12 rows of lookahead and the parent of the last; bodies over 256 KB are never read (size by `length(CAST(body AS BLOB))`, measured 3 ms for 62 × 2 MB rows against 407 ms to read them); then three body-free queries (Undo/Redo/restore rows from the page down, the rows the page names but does not hold, Alfy's comments near each reply edit).
- Fold rules F1–F4 run on the newest-down walk from a row and its older neighbour only, F4 capped at 12 rows, so a page boundary never cuts a moment and a paged read equals a whole read (tested both ways). Statuses come from `computePendingReviewBlocks` / `computeCanvasReview` (waiting), the Undo that names the change (undone; Document: partly kept when the Undo put back only some of its blocks), a later restore to a text from before it (no status), else kept.
- `versions.ts`: `listVersions` gains `before`; `restoreVersion` gains `expectVersion` (`version_conflict`) and `undoOf` (must be the newest row, the version restored must be its parent; the summary then names a restore or an Alfy change; any other row is `invalid_undo`); `nameVersion` (one line, ≤ 60 chars, mints no version). `read-model.ts` and `getArtifact` give `lastAuthor` / `lastKind` from the newest row alone.
- Routes: `GET /api/artifacts/[id]/history?before&limit`, `PATCH …/versions/[versionId]` `{ label }`, restore accepts `{ expectVersion, undoOf }` and answers `{ ok, version, versionId }`, `GET …/versions` takes `before`/`limit`; a malformed query/field is a 400 before any lookup; the shared `optionalPositiveIntegerParam` is in `lib/server/api/query-params.ts`.
- AGENTS.md: the A5 vocabulary sentence and one bullet for the history service.

## The old-App version route (for the Opus review)

`GET /api/artifacts/[id]/versions/[versionId]/app` — read these in order: `src/routes/api/artifacts/[id]/versions/[versionId]/app/+server.ts` (60 lines), its test `version-app.test.ts`, then `app/bootstrap.ts` (`buildBootstrapScript`, `APP_READONLY_BOOTSTRAP_SCRIPT`, `injectReadOnlyAppBootstrap`) and the `APP_SERVED_ROUTE_PATTERN` change in `src/hooks.server.ts`.

What it serves: the stored `artifact_versions.body` of one of the caller's App versions as `text/html`, with the read-only bridge spliced after `<head>`, and **exactly `APP_SANDBOX_HEADERS`** (the very object the App route sends; the test compares both routes' headers entry by entry): `sandbox allow-scripts allow-forms`, `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'self'`, `nosniff`, `no-store`. No other header, no CSP of its own.

Why it cannot leave the sandbox: it is the same document type under the same CSP, so a direct navigation is an opaque origin with no cookies, no network, no navigation of the top window, no popups, no modals (ruling 58 unchanged; no `allow-same-origin`). What is new is only where the body comes from and which bridge it gets.
- Scope: `getArtifact` (the scoped read) must return an App, and `getVersionBody` (scoped again) must find the version among that artifact's and that user's rows. A missing, foreign, other-artifact, Document, produced-file or incognito-from-outside id is one `404 {ok:false,reason:"not_found"}` with no sandbox headers. No query parameter varies the response.
- Bridge: `get` still asks the parent for today's value; `set` rejects locally and posts nothing. The two scripts are one template differing in one line (a test pins that).
- A version the current contract audit calls a **violation** (self-navigation, WebRTC; ruling 58) is not served (422 `not_runnable`): code written before those rules cannot run now, and the Code view still shows it.
- `hooks.server.ts`: an unauthenticated framed request to this route gets the localized notice, not the login form inside the sandbox (the existing pattern, extended; a `Sec-Fetch-Dest: iframe` request used to take the 303).
- **Residual the review should weigh:** a hostile old version can always `postMessage` a raw `alfy.storage` `set` to its parent whatever the bridge says. The parent (AppFrame in its preview mode, VB-3) must refuse `set`; if it does not, the old code can write today's data, which the current version can do anyway (so no escalation, only a broken "the preview changes nothing" promise). WebRTC/navigation not stopped by CSP stay as ruling 58 left them (audit refusal above plus the parent's tripwire).

## Gates

All on the final tree (`07cf73c6`), this Mac, port 5400.

| Gate | Result |
|---|---|
| `npm run check` | 0 errors / 17 warnings (the known 17) |
| `npx biome check src scripts tests` | clean (2,565 files) |
| `npm test` | 1,043 files passed + 1 skipped; **17,549 tests passed** + 2 skipped (baseline 17,408 in 1,035 files: +138 tests, +8 files) |
| `npm run build` | 32 `Unused CSS selector` + 2 `must have an ARIA role`, nothing else |
| `npm run check:artifact-chunks` (own step) | exit 0: editor closure 70.9 kB gzip (ceiling 72,704 B); chat route +1,854 of 2,048 B (dev gate: +1,851) |
| Fallow (`check` section) | 124 issues / 4 circular, identical set to `fallow-baseline-00ef6d2a.json`: 0 new (it first reported 4 unused types, the request/response shapes of `shared/artifacts/history.ts`; the name and restore routes now answer `satisfies` them) |
| `npm run check:migrations` | passes; `prepare-db.test.ts` passes with the two new required columns |
| Playwright (brief scope): `artifact-versions`, `artifacts-api`, `artifact-canvas-selection`, `artifact-canvas-review`, `artifact-canvas-comments` | 56 tests, 55 passed + 1 load flake (`artifact-canvas-review.spec.ts:225`, a transient "Alfy is arranging" label that was not found under CPU load from other agents' builds) that passes alone (14.9 s). No spec asserted a changed summary or restore text. |

Test files added or extended: `version-summaries.test.ts` (+11), `shared/artifacts/history.test.ts` (4), `moments/line-diff.test.ts` (7), `moments/detail.test.ts` (12), `moments/derive.test.ts` (32: every fold rule with its counter-case, page boundaries, paged = whole read, markers, statuses, partly kept, tick, large, the cache, the comment link; mutation-checked), `history.test.ts` (10, real database), `versions.test.ts` service (+12), `record.test.ts` (+6), `read-model.test.ts` (+2), `bootstrap.test.ts` (+5), `body.test.ts` (+3), `restore.test.ts` (+4), `versions.test.ts` route (+2), `versioning.routes.test.ts` (13: real database, two users, incognito, 404 parity), `version-app.test.ts` (6), `hooks.server.test.ts` (+9), `query-params.test.ts`, `limits.test.ts`, `app/create.test.ts` and `recreate.test.ts` (made again), the archive test (name exported).

## Deviations and decisions

1. **`CATALOGUE_TOKEN_CEILING` did not move.** It counts the tools' top-level descriptions only; the new `summary` text is a schema field description. Measured before and after: 5,110 en / 8,256 hu, unchanged, under 5,136 / 8,283. The frozen snapshots did move (+101 B each: en 72,845 to 72,946, hu 78,118 to 78,219); the message of commit `171b942d` says so. Moving a tripwire that was not touched would have been wrong.
2. **Journal index 126, not 127.** The brief and the design say 127; the journal has 126 entries (idx 0–125), so the new one is idx 126 (the numbers in the docs count entries from 1).
3. `deriveMoments` takes one input object, not `(rows, review, kind)`: it also needs the newest row, the off-page markers, the tabs and the cache.
4. A moment shows its **oldest** row when it folds an Undo/Redo/restore pair (Alfy's change, the restore) and its **newest** row for a turn of Alfy's (F4: what the turn left; its changes are measured from the first row's parent). Documented in the shared type.
5. `kept_from_chat` credits the reader (`author: "user"`) though the row says `alfy`; the stored author is untouched.
6. An App rebuild folds with the Undo that took it back (the toast Undo is a restore with `undoOf`, written as `Undid Alfy's change: v{n}`); it has no status.
7. A change with no review marker reads `kept`, never `waiting`.
8. Extras beyond the brief, all small: the restore response carries `versionId`; `getArtifact` (the panel's open) carries `lastAuthor/lastKind` too; `GET …/versions` takes `before`/`limit`; the old-App route's audit refusal; `invalid_request` for malformed fields.
9. `sameAs` / `restoredHere` look at the loaded rows plus the off-page Undo/Redo/restore rows only; a version equal to one far below the page shows no `sameAs` (its `restoredFrom` still names its source).

## Hand-off (VB-2, VB-3)

- Types: everything in `shared/artifacts/history.ts` (read its header). `ArtifactMoment.versionId` is the state to preview, `parentVersionId` the base of "this version's changes"; a step is selectable and previewable; Restore brings back whatever is selected.
- Calls: history page `GET …/history?before=<nextBefore>&limit=` (first page includes `newestVersion`: pass it as `expectVersion` on restore); name `PATCH …/versions/[versionId]` `{label}` (normalize with `normalizeVersionLabel`); restore `POST …/versions/[versionId]/restore` `{expectVersion, undoOf?}` → `{version, versionId}`; the restore toast's Undo restores the **parent of the restore** (`versionId` of the row below it) with `{expectVersion: S, undoOf: S}`; an App rebuild's Undo the same with the rebuild's number.
- Body route: send `summaryKind: "undid_alfy_change" | "redid_alfy_change"` **with `summaryVersion`** = the Alfy version number the Undo/Redo is about (a Document block's `alfyVersionNumber`, a board's `latestAlfyVersion`/the change's `versionNumber`), else the old plain Undo is written and nothing can fold.
- App preview (VB-3): frame `src` = the version route (add `?conversationId=` when incognito), the same `sandbox="allow-scripts allow-forms"`, **refuse `alfy.storage` `set` messages in preview mode**, treat 422 `not_runnable` as "Code only".
- Header/list/card: `ArtifactCardSummary` and `ArtifactDetail` now carry `lastAuthor` and `lastKind` (card-level kind: a lone tick reads `user_edit` there; History says `tick`).
- Not done on purpose (client work): `document/version-summary.ts` still localizes the old set; `moment-text.ts` must handle every `MomentKind` (a `text` of null means "use your own fallback").

## Concerns

- The old-App route's safety depends on the preview AppFrame refusing `set` (above).
- `listHistory` computes a Document's pending set with `computePendingReviewBlocks` over every version from the marker up: the review route's cost, now paid on every History open when a change waits.
- The detail cache holds block labels (small user text) in process memory, keyed by version id, bounded at 2,000 entries; it survives an artifact's deletion until evicted.

## Commits

```
edcc2d84 Define the shared ArtifactMoment type the history server and the History UI build against
3957b9af Record when a typing burst began and let the reader name a version
171b942d Put every summary the server writes in one vocabulary, and name what an Undo or Redo acts on
3b924378 Derive an artifact's history as moments from its version rows
a60e38ee Guard a restore, let an Undo name what it undid, and let the reader name a version
55acc835 Serve the history, name a version and guard a restore over HTTP
be211534 Run a saved App version in History's preview, in the App's own sandbox
2fc54a1e Record in AGENTS.md that History is derived and every summary is in one vocabulary
7b727e02 Give mapBlocksToTabs the mutable array it asks for
5a693da0 Fold an App rebuild with the Undo that took it back
30e0a67d Say what the latest moment was when an item is opened, and page the versions route
07cf73c6 Tie the name and restore routes to the shared request and response types
```
