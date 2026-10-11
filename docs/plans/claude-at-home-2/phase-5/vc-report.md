# VC report: how versions behave today (Document, App, Canvas)

Model: Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `.claude/worktrees/art-vc` at `eb03dc69` (feat/artifacts). No product code changed.
Screenshots: `vc-shots/*.png` (14). Raw per-step logs: `vc-steps-doc.json`, `vc-steps-app.json`, `vc-steps-canvas.json`.
Probe output: `vc-probe-coalesce.txt`. Scripts: `vc-scripts/`.

## 0. The short version for the designer

Today a "version" is one row per *write*, and the writes come from 22 different moments (section 1) that all go through the same
two functions. The row carries only an author (`user`/`alfy`), a one-line summary and a time. What a person sees:

1. **The App has no version surface at all.** The header's `v4` is plain text (not a button, no chevron), no list, no restore, and the
   regenerate popover promises "v1 stays in History" (HU "A v1 megmarad az Előzményekben"). The popover button, the toast and the
   in-progress line hard-code "v2" ("Make v2", "Now showing v2") whatever the real number is: on the second regenerate the header
   says v3 while the toast says v2. The only way to go back is the toast's Undo, which lives 5.2 s.
2. **Undo, Redo, Restore and Keep write rows whose words do not say what they cancel, or write nothing.** After an Undo the list shows
   Alfy's "A múzeumot csütörtökre tettem át" (v4) directly under "Alfy módosításának visszavonása" (v5) with no link between them, though
   v4's description is no longer true of the text. Keep writes no version at all. A second Undo within 10 minutes silently merges into
   the first row. The Canvas pill's Redo is saved as the reader's "Szerkesztve" (Edited). The restore toast's Undo is another
   "Visszaállítva: v8" (a number the reader never picked). Restore has no preview.
3. **The header and rows say less than they seem to.** The line `Te és Alfy · szerkesztve 5 perce` is a constant ("You and Alfy · edited …")
   whoever edited. Rows are a flat list: nothing marks the version that is waiting for review, kept, undone, or the same text as an
   older one. Two typing bursts an hour apart are two rows reading just "Szerkesztve". Several summaries are English literals in a
   Hungarian list (`Alfy's comment reply`, `Kept from a chat reply`, `Alfy made the app: …`) beside Hungarian model-written labels.

## 0.1 Method: what is real and what was seeded

- **Real input (Playwright, real pointer and keyboard):** typing in the Document editor; on the Canvas a drag of a note, Insert → note → typing;
  the pill's Undo / Keep / Redo, the review bar's Keep all; the header's version button, hover → Restore → inline confirm → Restore in the popover;
  the toasts' Undo; the App's "Módosítás…" popover (typing the prompt, pressing "v2 elkészítése").
- **Seeded through the service functions the tools call** (the model is not in the loop): Alfy's first drafts (`createDocumentArtifact`, `createArtifact`);
  Alfy's Document edits (`readDocumentForAlfy` + `applyDocumentPatch`, the function `edit_artifact` and the `@Alfy` reply both use; the
  `@Alfy` row was written with the literal label `comments.ts:652` writes, `Alfy's comment reply`, no comment thread exists);
  Alfy's Canvas edits (`applyArtifactOps`); the App's creation (`createArtifact` with the summary `createAppFromBrief` writes); the App's
  regenerate: the `/app/regenerate` model call is replaced by a `page.route` handler that writes the exact row `regenerateApp` writes
  (author `alfy`, `Alfy regenerated the app: <prompt>`, same metadata patch) through `updateArtifactBody`, so the number really bumps.
  After each server-side Alfy write the page was reloaded (the panel restores itself); the pending change came back under the review bar.
- **Time travel in the DB (`created_at` of version rows, plus `artifacts.updated_at`):** (a) to end a typing burst: the Document's v2 was made 75 min old before
  the second typing burst (the only backdate that changed what the app did); (b) to give the lists realistic relative times: Document final ages v1 25 h, v2 24 h, v3 190 min,
  v4 120, v5 118, v6 75, v7 55, v8 50, v9 8, v10 6, v11 1 min; Canvas v1 4 h, v2 200 min, v3 130, v4 70, v5 5, v6 4, v7 1 min; App v1 200 min, v2 150, v3 90. The step logs (`vc-steps-*.json`) record
  the DB's own ages next to what the UI showed. One artefact of this: at D4 the header said "szerkesztve épp most" while the top row said
  "38 perce"; the header keeps the newest time it has ever heard (the snapshot taken at D3), and I moved the server's time to the past. Not a product finding.
- **UI language Hungarian** (the e2e admin's `uiLanguage = hu`), light, 1440×900 unless a file name says otherwise. Alfy's own labels were written
  in Hungarian (what a Hungarian chat's model writes); server literals follow the UI language except the ones listed in section 1.
- **Not captured** (needs the model or a second actor): a live Alfy edit landing while the panel is open; the `@Alfy` comment flow itself; the
  in-chat card and the list row (they print the same `v{n}`); a restore while an Alfy change is still pending; the Canvas "unsaved step meets a
  landing change" merge (covered by `artifact-canvas-unsaved-step.spec.ts`; from code it writes an ordinary "Edited"). The phone shot was taken
  with a mouse pointer, so the touch-only always-visible Restore buttons are not drawn in it.

## 1. Inventory: what writes `artifact_versions`

Only two functions touch the table. `createArtifact` (`services/artifacts/record.ts:286`) inserts v1 through `insertVersionRow`.
`updateArtifactBody` (`record.ts:442`) either appends `max+1` or, when `coalesceUserEdits` is on, rewrites the newest row in place.
Every row below is one of those two. Version rows keep the whole body (up to 2 MiB), the author (`user` | `alfy`) and a
`summary` (clamped to 500 chars). The history list is `listVersions` (`versions.ts`), newest first, **capped at 50 rows with no
paging** (`ARTIFACT_VERSIONS_DEFAULT_LIMIT`; `VersionsSheet` has no "load more").

Coalescing, exactly (`record.ts:565-583`): a save is merged into the newest row only when `coalesceUserEdits` is true (the body
route's default), `author === "user"`, the newest row is the user's, **its summary equals this save's summary**, and
`now - row.createdAt < 10 min`. A merge rewrites body, hash, summary AND `createdAt = now`, so the window is **sliding**: a burst
lasts as long as no gap reaches 10 minutes (probe in section 4). Alfy writes, restores and creations never merge.

| # | Moment | Function / file | author | `summary` written | Number bumps? | What the history row says (EN / HU) |
|---|---|---|---|---|---|---|
| 1 | Alfy creates a Document (`create_artifact`) | `CREATE_ARTIFACT_HANDLERS.document` → `createDocumentArtifact` → `createArtifact`, `normal-chat-tools/artifact-tools/create.ts:132` | alfy | `Alfy wrote the first draft` (`VERSION_SUMMARY.alfyFirstDraft`) | v1 | "Alfy wrote the first draft" / "Alfy megírta az első vázlatot" |
| 2 | Alfy creates a Canvas | `CREATE_ARTIFACT_HANDLERS.canvas`, `create.ts:207` | alfy | the same `Alfy wrote the first draft` (it is a board, not a draft) | v1 | same strings |
| 3 | Alfy creates an App | `createAppFromBrief`, `artifacts/app/create.ts:95` | alfy | `Alfy made the app: <the brief>` (English literal + the model-supplied brief, not in the vocabulary) | v1 | verbatim, **English prefix in HU**; one line, ellipsised on desktop. The App has no list to show it in (section 3) |
| 4 | "Open as document" on a chat reply | `keepMessageAsDocument` → `createDocumentArtifact`, `artifacts/keep-message.ts:70` | **alfy** (the reader pressed the button) | `Kept from a chat reply` (English literal, not in the vocabulary) | v1 | verbatim, **English in HU**, under Alfy's name |
| 5 | Regenerate a deleted Document / App / Canvas under the same id | `recreate.ts` → the same create handlers (`artifactId` honoured) | alfy | as 1-3 | v1 of the new row (the old history went with the delete) | as 1-3 |
| 6 | "Save as a new document" after the open one was deleted | `POST /api/artifacts/document` → `createDocumentArtifact`, `routes/api/artifacts/document/+server.ts:44` | user | `Saved as a new document` | v1 of a new row | "Saved as a new document" / "Mentve új dokumentumként" |
| 7 | The reader types in a Document (autosave, 800 ms debounce) | `PATCH /api/artifacts/[id]/body` → `saveDocumentBody` (`document-ops.ts:494`) → `updateArtifactBody` | user | `Edited` | **merges** into the newest row if that row is the reader's "Edited" and < 10 min old (sliding), else v+1 | "Edited" / "Szerkesztve" |
| 8 | The reader edits a Canvas (move, add, type, draw: one settled step) | same route → `saveCanvasBoard` (`canvas-ops.ts:74`) → `updateArtifactBody` | user | `Edited` | same merge rule as 7 | "Edited" / "Szerkesztve" |
| 9 | Document tab add / rename / delete | `saveDocumentTabs` (`client/api/artifacts.ts:789`) → same route with `tabs` | user | `Edited` | same merge rule | "Edited" |
| 10 | A task ticked on the in-chat card | `toggleDocumentTask` (`client/api/artifacts.ts:731`) → body route with `coalesce: false` + `baseHash` | user | `Edited` | **always a new row** (every tick is a version; a later typing burst still opens another "Edited") | "Edited" |
| 11 | The reader Undoes Alfy's change in a Document (pill, or Undo all) | `DocumentBody.handleUndoChange` → `autosave.schedule(.., {summaryKind: "undid_alfy_change"})` (`DocumentBody.svelte:1144`) → body route | user | `Undid Alfy's change` | v+1 (summary differs from "Edited"); **a second Undo within 10 min merges into the same row** (same summary), so two undos can be one row | "Undid Alfy's change" / "Alfy módosításának visszavonása" |
| 12 | The reader Redoes (Document pill) | `handleRedoChange` → `autosave.schedule(canonical)` (`DocumentBody.svelte:1159-1186`) | user | `Edited` (a Redo is a plain save) | merges or opens a row like any "Edited" | "Edited" |
| 13 | The reader Undoes Alfy's change on a Canvas (pill) | `review-controller.undo` → `#write(parentBody, "undid_alfy_change")` (`canvas/_lib/review-controller.svelte.ts:476`), `coalesce: false` | user | `Undid Alfy's change` | **always** v+1 (never merges) | same strings as 11 |
| 14 | The reader Redoes on a Canvas (pill's 5 s window) | `review-controller.redo` → `#write(alfyBody)` (`:520`), `coalesce: false` | user | `Edited` (no `summaryKind`) | always v+1 | "Edited": Alfy's board written back under the reader's name, nothing says "redo" |
| 15 | Alfy edits a Document (`edit_artifact`) | `EDIT_ARTIFACT_HANDLERS.document` → `applyDocumentPatch` (`document-ops.ts:381`); bootstraps the review marker in the same write | alfy | the model's own patch label (free text, in the turn's language) | v+1; a patch whose ops all refuse writes nothing | as stored |
| 16 | An `@Alfy` comment reply that edits a Document | `comments.ts:652` → `applyDocumentPatch` | alfy | `Alfy's comment reply` (English literal, not in the vocabulary) | v+1 | verbatim, **English in HU** |
| 17 | Alfy edits a Canvas (`edit_artifact`) | `EDIT_ARTIFACT_HANDLERS.canvas` → `applyArtifactOps` (`ops.ts:290`) | alfy | the model's `summary` field (≤ 200 chars) | v+1; a diff that changes nothing writes nothing | as stored |
| 18 | An `@Alfy` reply on a Canvas | `canvas-comments.ts:75,352` → `applyArtifactOps` | alfy | `Alfy's comment reply` (same literal) | v+1 | verbatim, English in HU |
| 19 | The panel's `POST /api/artifacts/[id]/ops` | `applyArtifactOps`, author `user` (`ops.ts:294`) | user | `Edited` | v+1 | no UI caller exists today (grep: only the client wrapper) |
| 20 | Alfy edits an App | **not possible**: `EDIT_ARTIFACT_HANDLERS` has no `app`; the tool answers "Apps are not edited in place — create a new App" (`edit.ts:540`) | n/a | n/a | n/a | the only Alfy write to an existing App is row 21 |
| 21 | App regenerate ("Change this app…") | `regenerateApp`, `artifacts/app/regenerate.ts:109` | alfy | `Alfy regenerated the app: <the prompt>` (English literal + the reader's prompt) | v+1 | verbatim, English prefix in HU, **but no list shows it** |
| 22 | Restore a version (Versions popover; the restore toast's "Undo"; the App regenerate toast's "Undo") | `restoreVersion`, `versions.ts:101` → `updateArtifactBody` (coalescing off) | user | `Restored v<n>` (n = the version whose body was copied) | always v+1 | "Restored v3" / "Visszaállítva: v3" (older rows `restored <summary>` still parsed) |
| 23 | **Keep** (pill; Keep all; Canvas pill/bar) | `POST /api/artifacts/[id]/review` → `acknowledgeArtifactReview` → `acknowledgeDocumentReviewBlocks` / `acknowledgeCanvasReview` | none | **no version**: only `metadata_json.review.throughVersion` moves (Canvas: `updatedAt` deliberately untouched) | no | nothing in the history, header and list unchanged |
| 24 | A Canvas merge of the reader's unsaved step with a landing change (and `recoverFromRefusal`) | `CanvasEditor.adoptBoard` / `recoverFromRefusal` → `autosave.schedule(latestJson)` (`CanvasEditor.svelte:~500`) → body route | user | `Edited` | v+1 (newest is Alfy's, so no merge); a dismissible notice counts the blocks | "Edited": nothing says it carries the reader's step over Alfy's change |

Things that write **no** version: Keep, comments (own table), App kv state, Canvas PNG export / posters, a review-marker bootstrap (it rides on
the Alfy write), a Document patch that applies nothing, a Canvas diff that changes nothing.

### The summaries, as one vocabulary

Fixed server literals the browser translates (`shared/artifacts/version-summaries.ts`, `document/version-summary.ts`):
`Edited`, `Undid Alfy's change`, `Alfy wrote the first draft`, `Saved as a new document`, `Restored v<n>` (and the legacy `restored …`).
**Written by the server but not in that vocabulary, so never translated**: `Kept from a chat reply`, `Alfy's comment reply`,
`Alfy made the app: …`, `Alfy regenerated the app: …`. Free text the model writes (a patch label, a board summary) is shown as stored,
in whatever language the model wrote it.

### Header, lists and Ctrl/Cmd+Z

- **Header** (`ArtifactPanelHeader.svelte:90-118`, fed by `DocumentWorkspace.svelte:2071`): `<kind> · v7 ▾ · Te és Alfy · szerkesztve 5 perce`.
  The `v7` is the highest version any surface has heard of (`artifact-versions.ts`: every save, restore, Alfy edit or list fetch announces its number;
  it only grows). It is a button (opens the Versions popover) only when the open body registered `openVersions`: **Document and Canvas do, the App does
  not, so on an App `v4` is plain text**. The rest of the line is the constant `artifacts.header.editedBy` ("You and Alfy · edited {when}") whatever
  who edited; `{when}` is the last announced change time (`Date.now()` at the save, or the server's `updatedAt` after a load).
- **Where history lives**: Document: the Versions popover. Canvas: the same `VersionsSheet.svelte` (the Document's own, loaded lazily), plus the review bar's
  refusal card "Open Versions". **App: nowhere**. `fetchArtifactVersionBody` ("the History sheet's preview") exists but is called only by the Canvas Undo;
  the sheet itself has no preview, no diff, no way to see what a version holds before restoring it.
- **Restore** (`VersionsSheet.svelte`): a hover/focus "Restore" on every row but the newest → inline question "Restore v3? Your current text stays as a version."
  (HU "Visszaállítod a v3 változatot? A jelenlegi szöveged megmarad változatként.": the word is *text* / *szöveg* on a board, too) → success closes the
  popover and shows a toast "Restored v3 as v9" with **Undo**, which is itself a restore (a further row `Restored v8`).
- **Time on a row**: `formatRelativeTime`: "just now" (< 30 s), "N min", "N h", "yesterday", then a bare date ("Oct 9", no time of day, no year).
- **What "Undo" means on screen**: (1) toolbar Undo/Redo, ⌘/Ctrl+Z: the reader's own text history (Document; `artifacts.document.toolbar.undo`, HU "Visszavonás");
  on a Canvas the same keys, labelled "Undo your last step" / "Saját lépés visszavonása" (ruling 16). (2) the pill's "Undo" (HU "Visszavonom"; tooltip "Undo Alfy's
  change (⌘⌥Z)"): writes a version. (3) the review bar's "Undo all" (HU "Mindet visszavonom"): the same, for every pending block. (4) the restore toast's "Undo"
  (HU "Visszavonás"): a second restore. (5) the App regenerate toast's "Undo": a restore of the previous version. Rulings 16/63 say Alfy's change and anything from an
  earlier session is a version restore; the button labels do not say which Undo is which.

## 2. The confusion log

"Header" = the panel header's meta line. "List" = the Versions popover rows (avatar initial dropped; `Te` = You, rendered "A Te" in the raw text because of the
avatar). Everything here is from `vc-steps-*.json`; "expected" is what a person would reasonably have looked for, not a design.

### 2.1 Document: a dozen moments (HU UI, 11 versions at the end)

| Step | What happened | Header | List (top rows, then what to notice) | A person would reasonably expect |
|---|---|---|---|---|
| D1 | Alfy's first draft (`create_artifact`) | `Dokumentum · v1 · Te és Alfy · szerkesztve épp most` | `Alfy v1 · épp most · Jelenlegi · Alfy megírta az első vázlatot` (newest row: no Restore) | the header to name only Alfy: "You and Alfy" is a constant, the reader has written nothing |
| D2 | the reader types twice, 2.5 s apart (real typing) | v1 → v2 | `Te v2 · épp most · Jelenlegi · Szerkesztve` over `Alfy v1 … Visszaállítás`. Two typings are one row; the server confirmed v2 stayed v2 between them | fine, but note v2's body and time keep changing under the same number while the reader types |
| D3 | 75 min later the reader types again | v2 → v3 | `Te v3 · épp most · Szerkesztve`, `Te v2 · 1 órája · Szerkesztve`, `Alfy v1 · 3 órája` | the two bursts to differ in words; both rows read just "Szerkesztve" (Edited), nothing says what or how much changed |
| D4 | Alfy edits 3 blocks in one patch; reload; the review bar and 3 pills come back | v3 → v4 | `Alfy v4 · 38 perce · Jelenlegi · A múzeumot csütörtökre tettem át`. The bar says "Alfy 3 részt módosított." (3 parts) while the list has one row | v4 to show it is unreviewed: the "waiting for review" state lives only in `metadata_json.review`, no row shows it; the bar counts blocks, the list counts writes |
| D5 | the reader presses Undo on one of the 3 changes (the pill) | v4 → v5 once the autosave ran (800 ms debounce per the code, then the save's round trip) | `Te v5 · épp most · Jelenlegi · Alfy módosításának visszavonása` directly over `Alfy v4 · A múzeumot csütörtökre tettem át · Visszaállítás`. The bar still says "Alfy 2 részt módosított." (`doc-history-after-undo-1440-hu.png`) | v5 to say which change it undid; v4's description is no longer true (the museum move was undone), yet it is the newest Alfy row; nothing links v5 to v4 |
| D5b | a second Undo, seconds later (another block) | v5 stays v5 | list identical: the second Undo merged into the v5 row (same summary, user, < 10 min) | a second row, or a count: one row stands for two undone changes, in the singular |
| D6 | the reader presses Keep on the last pending change | v5 stays v5 | list identical: **Keep writes no version** | some trace that Alfy's v4 was partly kept, partly undone; nothing distinguishes "kept" from "never looked at" |
| D7 | the reader types in the checklist | v5 → v6 | `Te v6 · Szerkesztve` over `Te v5 · Alfy módosításának visszavonása`: a new row, because the newest row's summary was the Undo's, not "Edited" | an Undo then typing = two rows, two Undos = one row: the merge rule is "same summary text", not "same activity" |
| D8-9 | an `@Alfy` reply that edits (v7), then a second Alfy edit (v8), reload | v6 → v8 | `Alfy v8 · Vasárnapra beírtam a reggelit`, `Alfy v7 · Alfy's comment reply`. The v7 row is English in a Hungarian list and says neither which comment nor which paragraph. Two Alfy versions are pending, the bar counts blocks | the v7 row in HU and naming what it changed |
| D10 | the reader presses Keep all (review bar) | v8 stays | list identical (Keep writes nothing) | as D6 |
| D11 | the reader restores v3: hover → Restore → inline question → Restore (`doc-restore-confirm-1440-hu.png`, `doc-restore-toast-1440-hu.png`) | v8 → v9 at once | the popover closes itself; a top-right toast `Visszaállítva: v3 mint v9 · Visszavonás` (4 s) sits over the panel's action buttons; the text switches to v3's; list gains `Te v9 · Visszaállítva: v3`. The question reads "Visszaállítod a v3 változatot? A jelenlegi szöveged megmarad változatként." | a look at what v3 holds before confirming (there is no preview); to know what leaves the text (v4-v8: both Alfy rounds, an Undo, the reader's checklist edit); v9's row to say it is the same text as v3 (only the "v3" in its summary says so) |
| D12 | the reader presses the toast's Undo | v9 → v10 | `Te v10 · Visszaállítva: v8` over `Te v9 · Visszaállítva: v3`. The reader pressed "Visszavonás"; the row says "Restored v8", a number the reader never picked | the row to say it undid the restore; two adjacent restore rows whose texts are v8's and v3's |
| D13 | Alfy edits 2 blocks again (pending under the review bar) with the whole history behind it (`doc-history-1440-hu.png`) | v10 → v11, `szerkesztve 1 perce` | 11 rows; the popover scrolls inside itself (8 rows visible at 1440×900); the newest row `Jelenlegi` looks like any settled row; times run `1 perce … 3 órája`, then `Tegnap` twice (24-25 h; a bare date past 48 h, never a time of day) | the pending version to look different from settled ones; to tell the two "Tegnap" rows apart |
| EN | the same history, English UI (`doc-history-1440-en.png`) | `Document · v11 · You and Alfy · edited 1 min ago` | server strings are English (`Restored v8`, `Undid Alfy's change`, `Edited`), model labels stay Hungarian (`Rövidítettem a pénteki tervet`), `Alfy's comment reply` is the same in both languages | one language per list |

Phone (`doc-history-phone-390-hu.png`): the same 11 rows in a bottom sheet (no internal scroll at 844 px). The Restore buttons are not drawn here because the session has a mouse
(on touch they are always shown).

### 2.2 Canvas (HU UI, 7 versions at the end; the Versions popover is the Document's own sheet)

| Step | What happened | Header | List | A person would reasonably expect |
|---|---|---|---|---|
| C2 | Alfy added a diagram and two notes (`applyArtifactOps`), reload; pill + review bar (`canvas-pending-pill-1440-hu.png`) | `Tábla · v2 · Te és Alfy · szerkesztve 3 órája` | `Alfy v2 · Hozzáadtam a reptéri útvonalat és két jegyzetet`, `Alfy v1 · Alfy megírta az első vázlatot` (a board has a "first draft"). The bar says "Alfy 3 blokkot módosított." | the first row to say what the board is; the bar counts blocks, the list counts writes |
| C3 | the reader presses Keep on the pill | v2 stays | list identical | as D6 |
| C4 | the reader drags a note (real drag), then Insert → note → types (two steps) | v2 → v3 | ONE row `Te v3 · Szerkesztve` (both steps merged) | nothing says "moved a note, added a note" |
| C5 | Alfy changes the board again (move, update, add), reload | v3 → v4 | `Alfy v4 · Átrendeztem a szombatot és hozzáadtam a költségeket` | as D4 |
| C6 | the reader presses Undo on the pill | v4 → v5 | `Te v5 · Alfy módosításának visszavonása` over `Alfy v4 …`. On a board the Undo is **always** its own row (it is written with coalescing off) and saves the parent board's JSON as the reader's | as D5 |
| C7 | the reader presses the pill's Redo (it replaces Undo in the same spot, 5 s window) | v5 → v6 | `Te v6 · Szerkesztve` over `Te v5 · Alfy módosításának visszavonása`: **Alfy's whole board is written back under the reader's name as "Edited"**; the pill then says Kept (from code: `redo` sets `status = "kept"`) | a row that says Redo / Alfy's change again; the board's content equals v4's but the history never mentions Alfy |
| C8 | the reader restores v2 | v6 → v7 | toast `Visszaállítva: v2 mint v7 · Visszavonás`; row `Te v7 · Visszaállítva: v2`. The confirm question says "A jelenlegi **szöveged** megmarad változatként" (your *text*) on a board | wording for a board; to know that the reader's own v3 note and moves go away with the restore |
| C9 | the final state (`canvas-history-1440-hu.png`) | `Tábla · v7 · … szerkesztve épp most` | seven rows; Alfy's summaries (up to 200 characters) are ellipsised on one line at this width | |

### 2.3 App (HU UI, 4 versions at the end; no list exists)

| Step | What happened | Header | List | A person would reasonably expect |
|---|---|---|---|---|
| A1 | created (`create_artifact`'s App handler) | `Alkalmazás · v1 · Te és Alfy · szerkesztve 3 órája`; `v1` is plain text | none. Server row: `alfy · "Alfy made the app: Készíts egy költségvetés-kalkulátort a bécsi hétvégéhez"` | a version control; the row's text is an English literal plus the whole brief |
| A2 | the reader regenerates through "Módosítás…" (real popover, real submit) | v1 → v2 | toast `Mostantól a v2 látszik · Visszavonás` (5.2 s). The popover said "Alfy megírja az új változatot… **A v1 megmarad az Előzményekben.**" | an Előzmények to exist |
| A3 | a second regenerate (`app-regenerate-popover-second-1440-hu.png`, `app-second-regenerate-toast-1440-hu.png`) | v2 → v3 | the popover button still reads `v2 elkészítése` (it will make v3); the toast says `Mostantól a v2 látszik` while the header says `v3` | the real number |
| A4 | the reader presses the toast's Undo (`app-after-history-1440-hu.png`) | v3 → v4 | server: `v4 · user · "Restored v2"` (v2's HTML written as a new version); no UI shows v1-v4 | the way back to v1 or v3 once the toast is gone: there is none in the UI |
| A5 | reload | `v4`, plain text | nothing | |

### 2.4 What the header and the lists do over time (all three kinds)

- The header's number moves when the server answers a write: a save (autosave response), an Undo (after the autosave debounce), a Restore (at once), a regenerate (at once); after an Alfy write it moves on the next
  read of the artifact (a reload, the chat turn's refresh). It only ever grows. The time on the line is the newest time the browser has heard.
- The list shows a version's own `created_at`, which a merged row **rewrites on every save**: a burst's row says when the burst *ended*, not when it began.
- Relative times: `épp most` / `N perce` / `N órája` / `Tegnap` / a bare date. Two rows from 24 h and 25 h ago read the same.

## 3. Screenshots (14 files in `vc-shots/`)

| File | Shows |
|---|---|
| `doc-header-trigger-1440-hu.png` | the header `Dokumentum · v11 ▾ · Te és Alfy · szerkesztve 1 perce`, two pending pills, the review bar at the foot, the toolbar's own ↶ ↷ (text history) |
| `doc-history-1440-hu.png` | the Versions popover on the 11-version history over a pending review bar (also serves as "the history next to a pending bar") |
| `doc-history-1440-en.png` | the same in English |
| `doc-history-phone-390-hu.png` | the same as a bottom sheet at 390 px |
| `doc-history-1440-dark-hu.png` | dark |
| `doc-history-after-undo-1440-hu.png` | the history right after Undoing one of Alfy's three changes: v5 "Alfy módosításának visszavonása" over v4; two changes still pending in the bar |
| `doc-restore-confirm-1440-hu.png` | the inline restore question inside the v3 row |
| `doc-restore-toast-1440-hu.png` | what Restore shows: the popover gone, text swapped to v3's, the top-right toast `Visszaállítva: v3 mint v9 · Visszavonás` |
| `canvas-pending-pill-1440-hu.png` | a Canvas with Alfy's pending change: pill "Alfy · Megtartom · Visszavonom", the review bar, the toolbar's disabled own ↶ ↷ |
| `canvas-after-undo-1440-hu.png` | the Canvas after the pill's Undo: "Visszavonva · Újra" in the pill, header v5 |
| `canvas-history-1440-hu.png` | the Canvas's Versions popover (the Document's sheet) after its history, `Visszaállítva: v2` on top |
| `app-regenerate-popover-second-1440-hu.png` | the App's popover on its second regenerate: button `v2 elkészítése` at header v2, "A v1 megmarad az Előzményekben" |
| `app-second-regenerate-toast-1440-hu.png` | the toast `Mostantól a v2 látszik · Visszavonás` beside header `v3`; the header's `v3` is not a button |
| `app-after-history-1440-hu.png` | the App after four versions: header `v4`, plain text, nothing else |

## 4. Probe: where the burst rule's edges are (`vc-probe-coalesce.txt`, no browser; same function and arguments as the body route)

```
save 1 (after a seeded v1) -> v2
save 2, the newest row 9 min old -> v2        (merged; its created_at is rewritten to now)
save 3, 9 min after save 2 (18 min after save 1) -> v2   (still merged: the window slides)
save 4, the newest row 11 min old -> v3
Undo #1 -> v4        ("Undid Alfy's change")
Undo #2 a moment later -> v4   (merged: two Undos, one row)
Edited after the Undo -> v5
```
So a burst is "no gap of 10 minutes", can last hours, and rewrites its own timestamp; two Undos merge; an Undo and the typing after it do not.

## 5. Scripts (copied to `vc-scripts/`; uncommitted in the worktree under `tests/e2e/`)

`vc-capture.helpers.ts` (step log, DB time travel, popover reader, screenshot helper), `vc-capture-document.spec.ts`, `vc-capture-app.spec.ts`,
`vc-capture-canvas.spec.ts`, `vc-probe-coalesce.spec.ts`. They write to `<scratchpad>/p5/` (paths at the top of the helpers).
**Run them one Playwright invocation at a time:** `tests/e2e/global-setup.ts` deletes every user-data row at the start of each invocation, so a second invocation
against the same server/DB wipes the first one's conversation and artifacts mid-run (it cost me two runs). With the e2e DB prepared: start the server yourself
(`PLAYWRIGHT_TEST=1 HOME_SUMMARY_CACHE_TTL_MS=0 DATABASE_PATH=… E2E_DATABASE_PATH=… SESSION_SECRET=… node -r dotenv/config ./node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port 5410`)
and `PLAYWRIGHT_REUSE_EXISTING_SERVER=true E2E_PORT=5410 npx playwright test tests/e2e/vc-capture-document.spec.ts tests/e2e/vc-capture-app.spec.ts tests/e2e/vc-capture-canvas.spec.ts tests/e2e/vc-probe-coalesce.spec.ts --workers=1`
(~3 min with a warm server; the Document test alone ~40 s).
Selector gotchas found on the way: `getByText("Töltő")` resolves to a visually hidden checkbox label (use `locator("p").filter(...)`); a Document block's `text` includes the task marker, so match with
`includes`; the Canvas note tones are `yellow | mint | blue | plain`; the pill's Redo has the same class as its Undo (`.alfy-change-bar-undo`).

## 6. Surprising things

1. **The App has no history UI, and its copy says it has** ("v1 stays in History"); every "v1/v2" in its regenerate flow is a literal (popover button, building line, failure line, toast).
2. **"Open as document" is written as Alfy's version** (`author: alfy`, summary `Kept from a chat reply`, an English literal) though the reader pressed the button (`keep-message.ts:70`).
3. **Four server-written summaries are outside the translated vocabulary** and appear verbatim in HU: `Alfy's comment reply` (Document and Canvas `@Alfy`), `Kept from a chat reply`, `Alfy made the app: …`, `Alfy regenerated the app: …`.
4. **Redo on a Canvas is saved as "Edited" by the reader**; on a Document, Redo is a plain autosave ("Edited", which can merge with a neighbouring "Edited").
5. **Merging is by summary text, and the window slides**: Undo + Undo = one row; Undo + typing = two; a burst can last all afternoon; the card's checkbox tick (`coalesce: false`) is always its own "Edited" row.
6. **Keep (and Keep all) write nothing**: no version, no `updatedAt` change on a board; the only record is `metadata_json.review.throughVersion`, read by nothing in the history.
7. **The header line `Te és Alfy · szerkesztve …` is one fixed string**; its time is "the newest time heard", not the last writer's.
8. **The Versions list is capped at 50 rows with no paging** (`ARTIFACT_VERSIONS_DEFAULT_LIMIT`; ruling 47 says "paged"); the sheet has no preview or diff, and `fetchArtifactVersionBody` ("for the History sheet's preview") is called only by the Canvas Undo.
9. **The restore question says "text"** ("A jelenlegi szöveged megmarad változatként") on a board too: the Canvas reuses the Document's sheet and strings.
10. **The delete confirmation for an App omits "versions"** (`artifacts.delete.body.app`: "and its saved data will be deleted"), while Document/Canvas say "and its versions and comments".
11. A Document patch's `replaceBlock` on a checklist item turned it into a plain paragraph in my seed ("Esernyő vagy esőkabát" lost its checkbox): my seed passed the text without the task marker; not a versioning finding, but it is visible in `doc-header-trigger-1440-hu.png`.
12. The panel's `POST /api/artifacts/[id]/ops` (author `user`, summary "Edited") has a client wrapper (`applyArtifactOps`) but no UI caller.
