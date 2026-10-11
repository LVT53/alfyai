# Versioning: a history you can follow

Design pass for Feature 2 (Artifacts), Phase 5, 2026-10-11. Branch `design/artifacts-versioning`, based on
`eb03dc69` (`feat/artifacts`, the code running on ai.dev as `7cb27654` plus docs). No product code changes. The
owner's words after walking Feature 2: *"seems fine … a little clanky … versioning is still crazy and
unfollowable."* A person cannot tell from the history what happened to their Document, App or Canvas, in what
order, by whom, or which entry to go back to.

| File | What it is |
|---|---|
| `index.html` | The click-through mockup. Opens from `file://`, no network. The top bar switches kind (Document, App, Canvas), Today / New, width (1440 docked, 1100 docked, 390 phone), light / dark, HU / EN (HU first). The right column steps through the scenario; each step shows today beside the new design. |
| `versioning.md` | This spec: what is wrong and why, the principles, the model (moments over version rows), server vs presentation, every surface with its states, accessibility, Hungarian and motion, the rule amendments, the implementation map, tests, the build split and the owner's questions. |
| `current/` | Screenshots of today's version surfaces (1440 and 390, HU and EN), taken by the VC capture pass on a seeded history. |

The mockup uses the app's tokens (copied from `src/app.css`, all of which exist since the redesign was built), the
Nimbus Sans L / Libre Baskerville stacks and Lucide-shaped icons. It adds no token.

A word on words: **moment** is this spec's term for one thing that happened in the history. The UI never says
"moment"; it says **History** (*Előzmények*) for the whole and **version** (*változat*) for one state, always with a
time or a description, never a bare number.

---

## 1. The problems, with the evidence

Each problem names the code that causes it and, where the capture pass (VC) saw it, the screenshot in `current/`. VC
drove real pointer and keyboard input on a local build and seeded Alfy's writes through the same service functions
the tools call; its inventory found 24 moments that write (or do not write) a version.

**P1. Every write mints a number, so the number says nothing.** `artifact_versions.version_number` grows on every
Alfy edit (`edit_artifact`, `document-ops.ts` l. 387), every `@Alfy` reply that edits (`comments.ts` l. 652,
`canvas-comments.ts` l. 75), every App regenerate (`app/regenerate.ts` l. 116), every restore
(`versions.ts` `restoreVersion`), every Undo of Alfy's change (a user save with `summaryKind: "undid_alfy_change"`,
`DocumentBody.svelte` l. 1144, `review-controller.svelte.ts` l. 476), every Redo of that Undo (an ordinary
"Edited" save, l. 524), every tick in a chat card (`coalesce: false`, body route l. 79–89) and every board merge.
The header prints it (`ArtifactPanelHeader.svelte` l. 96–116: `v11 ▾`), the list row and the chat card print it
(`artifacts.card.version`). VC's Document reached v11 in thirteen ordinary moments, the board v7, the App v4
([doc-history-11-versions](current/doc-history-11-versions-1440-hu.png)); "v11" tells the reader nothing about what
v11 is. The review bar counts blocks ("Alfy 3 részt módosított") while the list counts writes (one row).

**P2. A newer version can be an older one.** A restore writes the old body as a new version: the toast says
"Visszaállítva: v3 mint v9" ([doc-restore-toast](current/doc-restore-toast-1440-hu.png)); its Undo is a second
restore, a row "Visszaállítva: v8", a number the reader never picked (`VersionsSheet.svelte` l. 128–145); an App
regenerate's Undo is a restore too (`AppBody.svelte` l. 352–362). So v9 equals v3 and v10 equals v8, and nothing on
screen says so, although every row carries the `body_hash` that would.

**P3. The reader's typing is one row whose time moves and whose start is lost.** Ruling 47 coalesces a burst into
the newest user version; `updateArtifactBody` (`record.ts` l. 574–596) overwrites `created_at` with every save, so
the window slides (VC's probe: saves nine minutes apart were still one row eighteen minutes after the first; a
burst can last all afternoon) and its first save time is gone. Two bursts are two rows that read the same,
`Te · v6 · Szerkesztve` and `Te · v3 · Szerkesztve`; nothing says what either changed. Merging is by summary text, so
two Undos within ten minutes merge into one row worded in the singular, while an Undo and the typing after it are
two rows.

**P4. The summaries are a thin vocabulary, and a third of them are English in a Hungarian UI.** The localized set
(`version-summaries.ts`, `version-summary.ts`) is: Edited, Undid Alfy's change, Restored vN, Alfy wrote the first
draft, Saved as a new document. Written by the server but **not** in that set, so shown in English to a Hungarian
reader: "Alfy's comment reply" (`comments.ts` l. 652, `canvas-comments.ts` l. 75; the v7 row in
[doc-history-11-versions](current/doc-history-11-versions-1440-hu.png)), "Alfy's edit" (`edit.ts` l. 333/395),
"Kept from a chat reply" (`keep-message.ts` l. 76, written as **Alfy's** version though the reader pressed "Open as
document"), "Alfy made the app: …" (`app/create.ts` l. 95), "Alfy regenerated the app: …" (`app/regenerate.ts`
l. 116). A board's first version says "Alfy wrote the first draft". Alfy's own summaries are free text in the turn's
language, often first person ("A múzeumot csütörtökre tettem át"), and stay Hungarian in an English UI
([doc-history-11-versions EN](current/doc-history-11-versions-1440-en.png)).

**P5. The header's meta line is a fixed string.** "You and Alfy · edited {when}" / "Te és Alfy · szerkesztve
{when}" (`artifacts.header.editedBy`) is shown whoever edited, including a Document only Alfy has touched.

**P6. Undos look like new things, and Keep leaves no trace.** Undo of Alfy's change is a new top row, "Te ·
Alfy módosításának visszavonása", directly over the change it undid, with no link between them, while the change's own
words ("A múzeumot csütörtökre tettem át") are no longer true of the text
([doc-history-after-undo](current/doc-history-after-undo-1440-hu.png),
[canvas-after-undo](current/canvas-after-undo-1440-hu.png)). The board pill's Redo writes Alfy's whole board back as
the reader's "Szerkesztve" (`review-controller.svelte.ts` l. 524); the Document's Redo is a plain autosave. Keep and
Keep all write nothing (only `metadata_json.review` moves), so the history cannot tell "kept" from "never looked at".
The reader sees four rows for two decisions they reversed, and none for the two they made.

**P7. Restore is blind.** The Versions popover (`VersionsSheet.svelte`) lists rows with a Restore button and an
inline "Restore v3? Your current text stays as a version." ([doc-restore-confirm](current/doc-restore-confirm-1440-hu.png);
on a board it still says *szöveged*, "your text"). There is no way to look at v3 first, so the only way
to find "the one before Alfy's section" is to restore, look, and restore again, which mints two more numbers.
The version-body route that a preview needs exists (`GET /api/artifacts/[id]/versions/[versionId]`) and is used
only by the board's Undo.

**P8. An App has no history at all, and its copy says it has.** `AppBody.svelte` registers only `openDownload`
(l. 71), so the header's `v4` is static text ([app-no-history](current/app-no-history-1440-hu.png)). The regenerate
popover promises "A v1 megmarad az Előzményekben" ("v1 stays in History",
[app-regenerate-promises-history](current/app-regenerate-promises-history-1440-hu.png)); its button, its building
line and its toast hard-code "v2" ("v2 elkészítése", "Mostantól a v2 látszik"), so the second regenerate shows the
toast "v2" beside the header's "v3" ([app-toast-v2-header-v3](current/app-toast-v2-header-v3-1440-hu.png)). After
the 5.2 s toast there is no way back to v1, though the row is there.

**P9. A pending Alfy change is invisible in the history, old times blur, and a long history is cut at 50.** A row
waiting for Keep or Undo looks like any other, even with the review bar under the popover
([doc-pending-review](current/doc-pending-review-1440-hu.png),
[canvas-pending-review](current/canvas-pending-review-1440-hu.png)). Times are relative: two rows 24 and 25 hours
old both read "Tegnap", and past two days a row shows a bare date with no time of day. `listVersions` returns the
newest 50 (`ARTIFACT_VERSIONS_DEFAULT_LIMIT`) with no paging, although ruling 47 says "History lists newest first,
paged".

**P10. Restore takes no guard.** `restoreVersion` calls `updateArtifactBody` with neither `expectVersion` nor
`baseHash`. A restore made while the open editor still holds an unsaved step leaves that step to be refused as a
conflict, or (when the open editor's autosave lands first) restores over it. Not seen in the capture; flagged for
the build to test (§11, T5).

---

## 2. Principles

1. **Say what happened, not what number it got.** Every entry is a sentence with a who, a what and a when:
   "You edited · changed “Saturday” and 2 more · 10:09". The number orders and guards; it is not shown.
2. **One entry, one thing that happened.** Things that cancel out are told as one story ("Alfy added the
   rainy-day plan — you undid it"), never hidden: every row stays reachable, nothing is deleted.
3. **Look before you go back.** Restore lives only in a preview that shows that version with its changes
   highlighted. A version equal to now, or to another version, says so.
4. **Order is time.** Newest first, grouped by day. The one exception is an undo folded onto the change it undid
   when it immediately follows it.
5. **One place to decide on Alfy's change.** The pill and the review bar decide (rulings 61, 63); History shows the
   decision ("Waiting for you", "Kept", "Undone") and links to the review, never a second Keep/Undo.
6. **Three undos, three names.** ⌘/Ctrl+Z undoes your recent steps in this session; **Undo** on Alfy's change
   undoes that change; **Restore** in History brings back a whole earlier version (ruling 16).
7. **Derive from the rows; store only what cannot be derived.** A reader's name for a version and a burst's start
   are the only new facts (§4.4), and each has a no-migration fallback.
8. **The same latest moment on every surface,** from the one source that today keeps the version number
   (`subscribeArtifactChanges` + `artifact-versions.ts`).

---

## 3. The model: moments over version rows

### 3.1 What a moment is, per kind

A moment is one `artifact_versions` row as the reader would tell it, with a headline (who did what), a detail line
(what changed, derived by diffing the row against its parent), a time, and, for Alfy's changes, a review status.

| Kind | A moment is | "What changed" comes from | The preview shows |
|---|---|---|---|
| Document | a version: Alfy's draft, a burst of typing, one Alfy edit, an Undo, a restore, a tick | block diff of the row and its parent (`parseDocument` in `shared/artifact-document/blocks.ts`: block ids, hashes, labels); a task whose checked state alone flipped is a tick | the document at that version, read-only, with added words marked and removed words struck through, block by block |
| App | Alfy built it, Alfy rebuilt it ("Change this app…", the prompt quoted), a restore | line diff of the HTML source (counts only in the list) | Preview: the app at that version running in the sandbox, read-only storage; Code: the source with added and removed lines |
| Canvas | Alfy made the board, a burst of the reader's steps, one Alfy diff, an Undo, a restore | `diffBoards` (`shared/artifacts/board-diff.ts`): added, removed, changed, moved, re-parented blocks and arrows | the board at that version, read-only, changed blocks ringed, added ones tagged New, removed ones as dashed ghosts, moved ones with a faint trail |
| File | none: a produced file has no versions | | |

### 3.2 The moment vocabulary

Headlines are chosen from the row's author and summary (the fixed vocabulary, extended in §4.5); the detail line
is derived. Headlines are author-specific; detail lines are author-neutral noun phrases, so one set of strings
serves both authors in both languages.

| Moment | Row it reads | Headline EN | Headline HU |
|---|---|---|---|
| Alfy's first draft | v1, alfy, "Alfy wrote the first draft" (a board writes it too) | Alfy wrote the first draft · *Canvas:* Alfy made the board | Alfy megírta az első vázlatot · Alfy elkészítette a táblát |
| App made | v1, alfy, "Alfy made the app: {brief}" | Alfy built the app | Alfy elkészítette az alkalmazást |
| Kept from a chat reply | v1, alfy (the reader pressed the button), "Kept from a chat reply" | You kept Alfy's reply as a document (the reader's avatar) | Megtartottad Alfy válaszát dokumentumként |
| Saved as a copy | v1, user, "Saved as a new document" | You saved it as a new document | Új dokumentumként mentetted |
| Made again | v1 after a delete, alfy, new "Alfy made it again" | Alfy made it again | Alfy újra elkészítette |
| Your edits | user, "Edited" | You edited · *Canvas:* You changed the board | Szerkesztetted · Módosítottad a táblát |
| A tick | user, "Edited", only a task's checked state changed | You ticked “Renew passport” · You unticked … | Kipipáltad: „Útlevél megújítása” · Visszavontad a pipát: … |
| Alfy's edit | alfy, free text | Alfy: *its own summary, verbatim* (fallback "Alfy changed it") | Alfy: *saját összefoglalója* (tartalék: „Alfy módosította”) |
| Alfy's reply edit | alfy, "Alfy's comment reply" | Alfy changed it, answering your comment | Alfy módosította, válaszul a megjegyzésedre |
| App rebuilt | alfy, "Alfy regenerated the app: {prompt}" | Alfy rebuilt the app: “{prompt}” | Alfy újraépítette: „{prompt}” |
| Undo of Alfy's change | user, "Undid Alfy's change" | You undid it *(folded)* · You undid Alfy's change “{its summary}” *(not folded)* | Visszavontad · Visszavontad Alfy módosítását: „…” |
| Redo of that Undo | user, new "Redid Alfy's change" | You brought it back | Visszahoztad |
| Restore | user, "Restored v{n}" | You restored {day} {time} | Visszaállítottad: {nap} {idő} |
| Undo of a restore | user, new "Undid restoring v{n}" | … then undid it *(folded)* | …, majd visszavontad |

Detail lines (author-neutral): "Changed “Saturday” and 2 more paragraphs" / „Módosult: „Szombat” és még 2
bekezdés"; "New: “Museum tickets”" / „Új: „Múzeumjegyek”"; "Removed: 1 paragraph" / „Törölve: 1 bekezdés";
"in Budget" (the tab, when not the first) / „a Költségvetés lapon"; Canvas "3 blocks moved, 1 note added" /
„3 blokk áthelyezve, 1 jegyzet hozzáadva"; App "42 lines changed" / „42 sor módosult"; "Large change" /
„Nagy változás" when a body is over 256 KB (the derivation skips it).

Markers on a moment (each derived, §4.2): **Now** / *Most* (the newest); **Same as now** / *Ugyanaz, mint most*
(its `body_hash` equals the newest's); **Same as Mon 10:09** / *Ugyanaz, mint hétfő 10:09*; **Restored from here ·
today 10:20** / *Ide állítottad vissza · ma 10:20*; a reader's **name** (bookmark icon) above the headline; for
Alfy's changes a status pill: **Waiting for you** / *Rád vár* (accent), **Kept** / *Megtartva* (success tint),
**Undone** / *Visszavonva* (neutral), **Partly kept** / *Részben megtartva* (neutral, Document only).

Times: under an hour, relative ("just now", "12 min ago" / *épp most*, *12 perce*); otherwise the clock time inside
its day group ("10:09"), so two entries of yesterday never read the same; a burst with a known start shows a span
("10:03–10:09"). Day groups: Today / *Ma*,
Yesterday / *Tegnap*, then the weekday and date in the reader's locale ("Tuesday 7 October" / *október 7., kedd*).

### 3.3 Folding: when two rows are one story

Rows are never removed; adjacent rows that cancel or complete each other are drawn as one moment with its steps
inside it. Each step stays selectable (it is a real state) and previewable.

| Rule | Rows | Drawn as | Why it survives the scenario |
|---|---|---|---|
| F1 Undo folds onto its change | Alfy row A, then immediately the Undo U that undid A | A's moment, status Undone, with the step "↳ You undid it · 10:13" | "Alfy adds a section → you undo it" reads as one decision; the top row is not a new thing |
| F2 Redo completes it | A, U, then the Redo R | A's moment, status Kept, steps "↳ You undid it, then brought it back" | the reader changed their mind within five seconds; two rows of noise become one line |
| F3 A restore and its undo | restore S, then immediately the undo of S | one quiet line "You restored Mon 10:09, then undid it", no Restore (its states equal its neighbours) | the toast's Undo is a correction, not an event |
| F4 One turn of Alfy's | consecutive Alfy rows less than 2 min apart, nothing else between | one moment "Alfy made 3 changes", the three summaries as steps; status aggregated (Waiting if any waits) | a turn that calls `edit_artifact` three times is one request in the chat |
| — Undo that does not follow its change | A, then the reader's edit E, then U | chronological: U as its own line "You undid Alfy's change “Rainy-day plan” · See the change", and A's status "Undone later · 10:20" | moving U onto A would put a row out of time order and make E's row the top while it is not "now" |

The rules run on the server over the page being returned (§4.2), so the list, the header and the tests agree.

### 3.4 The starting points, tested

| Starting point | Verdict | Scenario that decided it |
|---|---|---|
| A timeline of named moments | **Kept**, as headline + derived detail | "You edited" twice is followable only with *what* changed under it |
| The reader's typing as one entry with its span | **Kept, partly**: one entry per burst exists; the span needs the burst's start (§4.4); without it the entry shows its last save time | two bursts on two days are told apart by their detail lines and day groups even without a span |
| An undo shown on the change it undid | **Kept when it immediately follows** (F1); **rejected as a general rule** | Alfy adds → you type elsewhere → you undo: folding would reorder time |
| No bare version number in the header | **Kept**: the header names the latest moment ("Edited by you · 2 min ago") | the number survives only in the preview's fine print ("Version 7") and in test ids |
| Named versions the reader saves | **Kept**, and naming closes the burst | name the current version, keep typing: without the rule the named version's words would change under its name (ruling 47 coalesces into it) |
| Preview before restore, changes highlighted | **Kept**, and Restore exists only in the preview | P7: restore-to-look minted two numbers per look |
| Grouping by day | **Kept**; grouping by "session" **rejected** | rows hold no session boundary; a day is what a person remembers ("before yesterday's changes") |
| A pending Alfy change in the history | **Kept as a status with Review**; a History Keep/Undo **rejected** | a second place to decide could disagree with the pill; ruling 61 has one marker |
| Deleting undo/redo noise rows | **Rejected** | breaks "nothing is lost", and `computePendingReviewBlocks` relies on contiguous numbers (`versionNumber - 1` is the parent) |
| "Undo just this change" on an old Alfy moment | **Rejected for v1** | later edits to the same blocks make it a merge; Restore is the honest whole-state tool (ruling 16) |
| Keeping History in the 340 px popover | **Rejected** | a document diff or a board does not fit in it; History becomes a mode of the panel (§5.2) |

---

## 4. Server vs presentation

### 4.1 What a row keeps today

`artifact_versions` (`src/lib/server/db/schema.ts` l. 453–482): `id`, `artifact_id`, `user_id`, `version_number`
(the ordering authority, unique per artifact, contiguous), `author` (`user` | `alfy`), `summary` (≤ 500 chars),
`body` (the whole serialized artifact, ≤ 2 MiB), `body_hash`, `created_at` (second resolution; for a coalesced
burst, the last save). No parent, no event kind, no label, no burst start, no link to a comment or a chat message.
Beside it: the review marker `metadata_json.review = { throughVersion, keptBlockIds }` on the artifact row
(rulings 61, 63), comments in `artifact_comments`, the tool calls on the chat's messages.

### 4.2 What each moment fact is derived from

| Fact | Derived from | Where |
|---|---|---|
| Who | `author` | row |
| When | `created_at` (a burst: its last save) | row |
| Order | `version_number` | row |
| Parent | `version_number − 1` (contiguous) | rows |
| Kind | `author` + `summary` against the fixed vocabulary; any other Alfy summary is an Alfy edit | `version-summaries.ts` |
| What changed | the row's body diffed against its parent's: blocks (Document), `diffBoards` (Canvas), lines (App) | server, per page |
| A tick | the diff is exactly one task item's checked state | server |
| Equal to now / to another version | `body_hash` equality | rows |
| Restored from | `summary` "Restored v{n}" (`parseRestoredVersion`) | row |
| Which change an Undo undid | Canvas: the row before it (Undo writes that Alfy version's parent, refused once the reader edited); Document: the Alfy row that last changed the blocks the Undo put back; exact with the new summary "Undid Alfy's change: v{n}" (§4.5) | rows |
| Redo | the new summary "Redid Alfy's change: v{n}"; for old rows a `body_hash` match with the undone Alfy row (Canvas) | rows |
| Review status | the existing computations: `computePendingReviewBlocks` (`document-ops.ts` l. 695) and `computeCanvasReview` (`shared/artifacts/canvas-review.ts` l. 95) against the review marker; Undone from F1/the Undo's summary; otherwise Kept | server |
| The chat message behind an Alfy moment | the message's `create_artifact`/`edit_artifact` tool call result carries `versionId` (`edit.ts` l. 460) | browser, from the chat it already holds |
| The comment behind an `@Alfy` edit | Alfy's reply comment written in the same request (its `created_at` within a few seconds of the row) | server, best effort; omitted when no single match |
| Folding (§3.3) | adjacency + the facts above | server |

The derivation is a pure function of the page of rows plus one parent row, so it is unit-testable without a
database. Cost: one body parse per row (bounded: the page is 50 rows, a body over 256 KB is not diffed and reads
"Large change"); the result is cached per `(version id, body_hash)`, which is exact because only the newest row
can change and its hash changes with it.

### 4.3 What cannot be derived

| Fact | Why not | Without a migration |
|---|---|---|
| A reader's name for a version | nothing records it | store it in the artifact's `metadata_json.versionNames` (§4.4 fallback) |
| A burst's first save | `created_at` is overwritten on every coalesced save | show the last save; the moment's start is bracketed by the previous moment ("after 10:00") in the accessible description only |
| Tabs, App verification as they were at an old version | both live on the artifact row's metadata, latest only | a restore keeps the current tab strip and verification line; say so in the restore question for a Document with tabs ("Tabs keep their current names") |
| Who was reading which chat when Alfy edited from a forked chat | tool calls of another chat are not loaded | the "From the chat" link appears only for this chat's messages |

### 4.4 The proposed migration, and its fallback

Recommended: **one migration, two nullable columns** on `artifact_versions` (`1777140000113_artifact_version_moments`,
journal entry 127):

```sql
ALTER TABLE `artifact_versions` ADD `started_at` integer;  -- a burst's first save (unix seconds); NULL when unknown
ALTER TABLE `artifact_versions` ADD `label` text;          -- the reader's name for this version (≤ 60 chars); NULL when unnamed
```

- `updateArtifactBody` sets `started_at = now` on every insert and leaves it alone on a coalesced update (which
  still moves `created_at` to the last save). The coalescing check gains two conditions: the latest version has no
  `label`, and (owner question Q4) `now − started_at < 30 min`, so a burst is a restore point at least every half
  hour of continuous typing.
- Backfill: none. Old rows read `started_at = NULL` (show the last save only) and `label = NULL`.
- Naming: `PATCH /api/artifacts/[id]/versions/[versionId]` `{ label: string | null }`, scoped like every artifact
  route, 404 for a foreign id, `{ ok: true }` (ruling 49). Naming never changes a body, so it mints no version.
- The account data archive (`account-data-archive/index.ts`) exports the label with the row; the delete cascade
  and Clear Memory need nothing (the row goes).
- Cost: `schema.ts`, the migration and its journal entry, `npm run check:migrations`, `record.ts`, one thin route,
  the archive, and their tests: about half a build agent's day. Old histories look like today's for span only.

**Fallback without a migration** (if the owner says no): names live in `metadata_json.versionNames`
(`{ [versionId]: label }`, at most 30 names of 60 chars, written through the same transaction pattern as the review
marker); the coalescing check reads that map (it already reads `metadata_json` in the transaction) and does not
coalesce into a named version; no span, no half-hour cap. Every surface in §5 works; only "10:03–10:09" becomes
"10:09".

### 4.5 Vocabulary and route changes that need no migration

- `version-summaries.ts` becomes the home of **every** summary the server writes: add `alfyEdit` ("Alfy's edit"),
  `alfyCommentReply` ("Alfy's comment reply"), `keptFromChat` ("Kept from a chat reply"),
  `madeApp(brief)` / `parseMadeApp` ("Alfy made the app: …", `app/create.ts`),
  `regeneratedApp(prompt)` / `parseRegeneratedApp`, `alfyRemade` ("Alfy made it again", written by `recreate.ts`),
  `undidAlfyChange(n)` ("Undid Alfy's change: v{n}") with the old plain string still read, `redidAlfyChange(n)`,
  `undidRestore(n)` ("Undid restoring v{n}"). The literals in `comments.ts`, `canvas-comments.ts`, `edit.ts`,
  `keep-message.ts`, `app/regenerate.ts` import from it; `version-summary.ts` (moved to `artifacts/history/`)
  localizes all of them. This alone fixes P4's English.
- The body route's `summaryKind` gains `redid_alfy_change`, and both Undo kinds take the version they act on
  (`summaryVersion: n`, a positive integer the route checks against the artifact's own numbers).
- The App's regenerate copy stops naming numbers: "v2 elkészítése" / "Make v2" becomes "Újraépítés" / "Rebuild",
  "Mostantól a v2 látszik" / "Now showing v2" becomes "Alfy újraépítette · Visszavonás" / "Alfy rebuilt it · Undo",
  and "A v1 megmarad az Előzményekben" becomes true and number-free: "Az előző változat megmarad az előzményekben" /
  "The previous version stays in History". The App's delete question names its versions like the other kinds'.
- The restore route takes `{ expectVersion, undoOf? }`: it refuses `version_conflict` when the artifact moved past
  what the History showed (P10), and `undoOf` (the restore it reverses) writes `undidRestore(n)`.
- `GET /api/artifacts/[id]/history?before=<versionNumber>` returns `{ ok: true, moments, older: boolean }` (the
  derived moments for the next 50 rows); `listVersions` keeps its shape for the board's Undo.
- `GET /api/artifacts/[id]/versions/[versionId]/app` serves an old App version with the App route's own sandbox
  headers and a bootstrap whose storage is read-only (reads today's values, refuses writes). Security review: it
  is the same CSP and the same frame, one more body source (ruling 58).

---

## 5. Surfaces

### 5.1 The header: the latest moment instead of the number

Today: `✎ Dokumentum · [v7 ▾] · Te és Alfy · szerkesztve épp most`. New:

```
‹ EZ A BESZÉLGETÉS  3                               [💬 2] [⤓] │ [⤢] [✕]
Bécsi út terve
✎ Dokumentum · [🕘 Alfy módosította · 12 perce ▾]
```

- The kind stays plain text. The **history button** carries the latest moment's short headline and its time:
  "Edited by you · 2 min ago" / *Szerkesztetted · 2 perce*; "Changed by Alfy · just now" / *Alfy módosította · épp
  most*; "Written by Alfy · 3 h ago" / *Alfy írta · 3 órája*; "Built by Alfy" / *Alfy készítette* (App, Canvas);
  "Restored by you" / *Visszaállítottad*. The fixed "You and Alfy" line goes (P5).
- In History mode the button is pressed and a **Done** / *Kész* button (`btn-secondary btn-sm`) joins the actions;
  Comments and Download hide while History is open.
- File: no history button (no versions). App: the same button (P8).
- **States:** latest moment by the reader / by Alfy / created / restored; a change waiting (the phrase stays; the
  review bar carries the waiting state, and the chat's count button its dot, as today); History open (pressed);
  offline (the button works on what is loaded, Restore is disabled with "You're offline" / *Nem vagy online*);
  deleted (no button).
- **Accessibility:** a `button` with `aria-haspopup="true"`, `aria-pressed` in History mode, accessible name
  "History. Last change: edited by you 2 minutes ago" / *Előzmények. Utolsó változás: szerkesztetted, 2 perce*;
  the phrase is `aria-hidden` inside it so it is not read twice. 32 px tall on desktop, 44 px on phones.
- **Hungarian:** the phrase is up to ~30 characters (*Alfy módosította · 12 perce*); it truncates with an
  ellipsis before the time, never the time; on a 390 px phone the kind and the button share one line down to
  *Alkalmazás · Alfy készítette · 5 perce* (about 270 px).
- **Motion:** a new latest moment cross-fades the phrase with a 6 px rise (#15 of the redesign's §7.2, which
  animated the number); reduced motion: instant.

### 5.2 History mode (desktop)

Pressing the history button turns the panel into History. The body is replaced by a read-only **preview** of the
selected version; the moments are a **rail** beside it. Done, Escape or the history button again returns to
editing with the scroll and selection the editor had. Entering History first flushes the editor's pending save
(the board already does this before a review write, `saveNow`), so History starts from what is stored.

```
‹ EZ A BESZÉLGETÉS 3                                                        [Kész] │ [⤢] [✕]
Bécsi út terve
✎ Dokumentum · [🕘 Alfy módosította · 12 perce ▴]
┌─ preview ─────────────────────────────────────────────┬─ rail (300 px) ───────────────┐
│ Hétfő 10:09 · Szerkesztetted        [🔖 Elnevezés] [↺ Visszaállítás] │ [Mind] [Elnevezettek]          │
│ Módosult: „Szombat” és még 2 bekezdés                             │ MA                             │
│ [Ebben a változatban | A mostanihoz képest]          ‹ 1 / 3 ›     │ ✦ Alfy módosította, válaszul…  │
│                                                                   │   „Szombat” · 10:31 [Rád vár]  │
│  Szombat                                                          │ ↺ Visszaállítottad: hétfő 10:09│
│  Reggel ̶B̶e̶l̶v̶e̶d̶e̶r̶e̶ Albertina, délután kávéház…                  │ 🔖 Az ügyfélhívás előtt        │
│  …                                                                │   Szerkesztetted · 09:30–09:41 │
│                                                                   │ TEGNAP                         │
│                                                                   │ ✦ Alfy: Esős napi terv [Vissza…]│
│                                                                   │   ↳ Visszavontad · 10:13       │
│                                                                   │ ● Szerkesztetted · 10:03–10:09 │
│                                                                   │ ✦ Alfy megírta az első vázlatot│
└───────────────────────────────────────────────────────────────────┴────────────────────────────────┘
```

- **Layouts:** panel at least 720 px wide (1440 docked, expanded): preview and rail side by side, rail on the
  right (where the comment column lives). Narrower panel (1100 docked): the rail fills the panel; choosing a
  moment pushes the preview over it with "‹ History" / *‹ Előzmények* and a ‹ › stepper, so moving through moments
  never needs the list. Phone: §5.8.
- **Opening state:** the newest moment is selected and its own changes are highlighted, so opening History answers
  "what just happened?" at once.
- **Filter:** All / Named (*Mind* / *Elnevezettek*), chips, shown once any version is named.
- **Live:** a version written while History is open (a chat turn, another tab) rises in at the top of the rail
  (#20) and is announced; the selection and the preview stay where the reader is.
- **States:** loading (three skeleton moments, preview skeleton lines); loaded; load failed ("Couldn't load the
  history. Try again" / *Nem sikerült betölteni az előzményeket. Újra*); one version (§5.9); offline; conflict
  (§5.10).
- **Accessibility:** History is a `region` named "History of Vienna trip plan" / *Bécsi út terve – előzmények*.
  The rail is a `listbox` (single selection; selection follows focus) named "Versions" / *Változatok*; each day is
  a `group` labelled by its heading; each moment and each step is an `option` whose name is its headline, detail,
  time and status read in one sentence ("Yesterday 10:12, Alfy: Rainy-day plan. Undone."). ↑/↓ move, Home/End jump,
  PageUp/PageDown move a day; the preview follows. Tab order: rail → preview toolbar (Name, Restore, the
  comparison switch, the change stepper) → preview text. Escape: closes the restore question if open, else leaves
  History (focus returns to the history button). A polite live region (`artifact-history-live`) says the selected
  moment and its change count once the preview has loaded ("Monday 10:09, you edited. 3 changes.").
- **Motion:** entering History: the body cross-fades to the preview (standard · ease-out) and the rail slides in
  24 px from the right (emphasis · ease-emphasis, #1/#3's vocabulary); leaving is the mirror (standard · ease-in).
  Selecting a moment cross-fades the preview (standard). Reduced motion: instant.

### 5.3 Moment rows

```
[avatar]  Alfy módosította, válaszul a megjegyzésedre        10:31
          „Szombat” · „legyen esőbiztos”
          [Rád vár]                                    [Átnézés ›]
```

- Avatar (the reader's own `AvatarCircle`, Alfy's sparkle tile), headline (13 px, 600), time right-aligned and
  tabular, detail (12.5 px muted, one line, ellipsis), then markers: name (bookmark icon, bold, above the
  headline), status pill, Now, Same as …, Restored from here.
- **Steps** (folded rows, §3.3) sit under their moment, indented 34 px with `CornerDownRight`, 12.5 px, their own
  time; they are options too.
- **Waiting for you** carries a **Review** / *Átnézés* link (accent text) that leaves History and steps the review
  bar to that change (the pill flashes, #17). It is the only action on a row; Restore and Name live in the preview.
- "From the chat ›" / *A beszélgetésből ›* on an Alfy moment whose `versionId` a loaded message names: scrolls the
  chat to that message and flashes it (on a phone: closes the panel first).
- **States:** default, hover (`--surface-elevated`), selected (accent tint, 2 px accent rule at the start),
  focused (2 px focus ring), Now, named, waiting, kept, undone, partly kept, same-as, restored-from, large change,
  step.
- **Accessibility:** status and markers are words, never colour alone; the Review link is outside the option
  (a button after the listbox item, reached with Tab from it; on a phone it is in the preview's bottom bar), so an
  option holds no interactive content.
- **Hungarian:** the headline wraps to two lines before the detail truncates; the time column is 44 px wide;
  *Részben megtartva* is the longest pill (about 112 px).

### 5.4 The preview

The selected version, read-only, in the panel's own body styles (the Document in Libre Baskerville, the board on
its own canvas, the App in its frame), with a toolbar:

```
Hétfő 10:09 · Szerkesztetted                    [🔖 Elnevezés]  [↺ Visszaállítás]
Módosult: „Szombat” és még 2 bekezdés · 2. változat (fine print)
[ Ebben a változatban | A mostanihoz képest ]                    ‹ 1 / 3 ›
```

- **This version's changes** (default): what this moment did to its parent. **Compared with now**: how this
  version differs from the current one, i.e. what Restore would change. The newest moment shows only the first.
- **Document:** added words marked (Alfy's in `--alfy-mark` with the accent underline, the reader's in a neutral
  ink tint, `color-mix(in srgb, var(--text-primary) 8%, transparent)` with a `--text-muted` underline), removed
  words struck through in `--text-muted` on a faint `--danger` tint, a removed block as a struck block with its
  label; blocks are matched by id, words inside a changed block by a word diff. Unchanged long stretches fold to
  "12 unchanged paragraphs" / *12 változatlan bekezdés* (expandable). Tabs show as section headings.
- **Canvas:** the board at that version with the camera fitted to the changed blocks; added blocks ringed with a
  "New" / *Új* tag, changed ones ringed, removed ones as dashed ghost outlines tagged "Removed" / *Törölve*, moved
  ones with a faint dashed trail from their old place. The ring is the author's colour (Alfy terracotta, the
  reader neutral ink), as on the document.
- **App:** a segmented Preview / Code (*Előnézet* / *Kód*), as in the App body. Preview runs that version in the
  sandbox with read-only storage, under a one-line note "Runs with today's saved data; changes aren't saved" /
  *A mostani mentett adatokkal fut; a változtatások nem mentődnek*. Code shows the source with added and removed
  lines, unchanged runs folded.
- **Change stepper:** ‹ › and "1 / 3" move the view to each change (scroll for a Document, camera for a board) and
  flash it (#17). ⌥/Alt+↓ and ⌥/Alt+↑ step from anywhere in the preview.
- **Fine print:** "Version 7" / *7. változat* in muted 11 px at the end of the detail line, the only place the
  number is printed (support and debugging).
- **States:** loading (skeleton), loaded, no changes ("Nothing changed in this version" / *Ebben a változatban nem
  változott semmi*: a save that only reformatted), large ("Too large to compare; you can still restore it" /
  *Túl nagy az összehasonlításhoz; visszaállítani még tudod*), failed to load (Retry).
- **Accessibility:** the preview is a `document` region named for the version; each change is a `mark` (added) or
  `del` (removed) with a visually hidden "Added:" / *Hozzáadva:* or "Removed:" / *Törölve:* before it; the
  stepper's buttons are "Previous change" / *Előző változás* and "Next change" / *Következő változás*, and the
  count is in their description. The board preview lists its changes as a list of buttons under the toolbar for
  screen readers ("Rainy day frame, added") that centre the camera.
- **Motion:** highlights arrive at the arrive tint and settle to the resting tint (#11); the stepper flash is #17;
  reduced motion: resting tint, static ring for 900 ms.

### 5.5 Restore, and undoing a restore

- Restore is offered only in the preview, never on a row. The newest moment has none ("This is how it looks now" /
  *Így néz ki most*); a version equal to now shows "Same as now" / *Ugyanaz, mint most* instead of the button.
- Pressing Restore turns the toolbar's actions into the question, inline (no modal, as today):
  "Bring back Monday 10:09? What you have now stays in History." / *Visszaállítod a hétfő 10:09-es változatot?
  A mostani megmarad az előzményekben.* `[Cancel] [↺ Restore]` (`Mégse` / `Visszaállítás`). Extra lines when they
  apply: "Tabs keep their current names." / *A lapok neve a mostani marad.*; for an item made in another chat
  (§5.10) "It changes in “Trip planning” too, where it was made." / *A „Tervezés” beszélgetésben is megváltozik,
  ahol készült.*; when the version being restored predates a change of Alfy's that still waits (the restore puts
  those blocks back, so ruling 61 acknowledges them): "Alfy's change waiting for you goes with it." / *Alfy rád váró
  módosítása is eltűnik vele.* The question never says "text" on a board or an App: it names the version by its
  time.
- After Restore, History stays open: a new top moment "You restored Monday 10:09" rises in and is selected, its
  preview shows the restored text with "This version's changes" (what the restore changed), the source moment gets
  "Restored from here · today 10:20", and a toast says "Restored Monday 10:09" / *Visszaállítva: hétfő 10:09* with
  **Undo** / *Visszavonás* for 5.2 s. Undo writes "Undid restoring v{n}" and the two fold into one quiet line (F3).
- The restore is guarded (`expectVersion`, §4.5): if something wrote a version since History loaded, the question
  becomes "It changed while you were looking. Here's the latest." / *Közben megváltozott. Itt a legfrissebb.*, the
  rail refreshes, and the reader asks again.
- **Accessibility:** focus moves to the confirming button; Cancel returns it to Restore; after the restore the live
  region says "Restored Monday 10:09. The version before it is in History." / *Visszaállítva: hétfő 10:09. Az előző
  változat megmaradt az előzményekben.*
- **Motion:** the question grows in place (#19); the new top row rises (#20); the restored preview cross-fades
  (#14); the toast is #33; reduced motion: instant.

### 5.6 Naming a version

- **Name** / *Elnevezés* in the preview toolbar opens an inline field (60 characters, placeholder "e.g. Before the
  client call" / *pl. Az ügyfélhívás előtt*); Enter saves, Escape cancels. A named version shows the name in bold
  above its headline with a bookmark icon, everywhere it appears (rail, preview title, restore question). Rename /
  Remove name (*Átnevezés* / *Név törlése*) replace Name once it has one.
- Naming the newest version while the reader is still typing closes the burst (§4.4): the toolbar says "Your next
  edits start a new version." / *A következő szerkesztéseid új változatba kerülnek.*
- A name is not part of the body (ruling 1's spirit): restoring a named version does not copy the name; the
  restore moment says "You restored “Before the client call”".
- **Accessibility:** the field is labelled "Name this version" / *Változat elnevezése*; saving announces "Named
  “Before the client call”" / *Elnevezve: „Az ügyfélhívás előtt”*.

### 5.7 The review bar, the pill and History

- A pending Alfy change is a moment with **Waiting for you** and **Review** (§5.3). History never decides it.
- Keep, Undo, Keep all and Undo all change the status on the moment live (#13's swap): Waiting → Kept, or the Undo
  folds onto it (F1). The header phrase does not change for Keep (Keep writes no version).
- The pill's Undo and the history's Restore are told apart by place and verb: the pill says Undo / *Visszavonom* and
  acts on Alfy's change only; History says Restore / *Visszaállítás* and acts on the whole version. A one-line help
  at the foot of the rail, shown until the reader dismisses it: "⌘Z undoes your last steps. Undo on Alfy's change
  undoes just that change. Restore brings back a whole version." / *⌘Z: a saját legutóbbi lépéseid. Visszavonom:
  csak Alfy módosítása. Visszaállítás: egy teljes korábbi változat.* (Ctrl on Windows and Linux, from
  `keyboard-shortcuts.ts`.)
- A version restored over a waiting change takes that change with it (the question says so, §5.5); the marker moves
  past it as Undo would (ruling 61's "a user's own edit to such a block acknowledges it"), and the change's moment
  shows no status pill: neither Kept nor Undone is true of it.

### 5.8 The phone sheet

- The history button opens a full-height sheet (`DialogShell` `phonePresentation="sheet"`): title "History" /
  *Előzmények*, close ×, the filter chips, the day groups, moments at least 56 px tall.
- Tapping a moment pushes the preview inside the sheet: top bar "‹ History" and the moment's time; the preview;
  a bottom bar `[‹] [›]  [↺ Restore]` (44 px targets, the stepper moves between moments; the change stepper is a
  small floating ‹ 1/3 › above the bar); Name is in the top bar's `⋯`.
- The restore question replaces the bottom bar. Review on a waiting moment closes the sheet and lifts the review
  bar.
- **Accessibility:** the sheet is a modal dialog named "History"; focus starts on the newest moment; the system back
  gesture leaves the preview first, then the sheet.
- **Hungarian:** the bottom bar fits *Visszaállítás* (about 120 px) beside two 44 px arrows at 390 px.
- **Motion:** sheet #24; the push is #3 (28 px, from the right); reduced motion: instant.

### 5.9 Empty, one, long

- **One version** (just made): one moment, "Alfy wrote the first draft · Now", and under it "Changes you and Alfy
  make will appear here." / *Ide kerülnek a te és Alfy későbbi változtatásai.* No Restore, no filter.
- **Empty:** not possible for an artifact (creation writes v1); a load that returns nothing shows the load-failed
  state.
- **Long:** the first page is the newest 50 rows, folded; "Show older" / *Korábbiak* at the end of the rail loads
  the next 50 (`before=`), keeping day groups continuous. The Named filter is how a long history is searched in v1.
  Ruling 47's "revisit at ~200 versions" stands.

### 5.10 Deleted, incognito, another chat, a read-only fork, a conflict

- **Deleted while History is open:** the preview and rail are replaced by "This document was deleted." /
  *Ezt a dokumentumot törölték.* (the panel's deleted state); Done closes History. **Regenerated** under the same id:
  the history starts again at "Alfy made it again" (the old rows went with the delete cascade).
- **Incognito chat:** History works the same, scoped by `?conversationId=` (ruling 51); names are stored with the
  item and go with the chat; "From the chat" links never point outside it.
- **Made in another chat** (a fork's card naming its parent's item): History is readable; Restore asks with the extra
  line in §5.5; "From the chat" links appear only for this chat's messages.
- **Read-only fork** (an incognito fork, whose parent's items are out of reach: `unreachableArtifactIds`): the card
  says "Made in the original chat" and offers no Open, so there is no History to show. Nothing changes.
- **Save conflict or a board refused as read-only** (`saveState` conflict): History opens for reading; Restore is
  disabled with "Reload first: it changed elsewhere." / *Előbb töltsd újra: máshol megváltozott.*

### 5.11 The list row and the chat card

- The list row drops the number: "Document · 3 tabs" (*Dokumentum · 3 lap*), the time on the right as today, and a
  waiting change as the "1 change to review" pill.
- The chat card drops the number: "Document · 3 tabs · edited 2 min ago" (*Dokumentum · 3 lap · szerkesztve
  2 perce*); after an edit, "1 change to review" as today.
- Both read the latest moment through the same observed state as the header (§9, amendment A1).

---

## 6. Per kind, in one place

| | Document | App | Canvas |
|---|---|---|---|
| Moments | draft, bursts, ticks, Alfy edits, `@Alfy` edits, Undo/Redo, restores | built, rebuilt (prompt quoted), restores | made, bursts of the reader's steps, Alfy diffs, `@Alfy` edits, Undo/Redo, restores |
| Detail line | blocks changed by label, tab, ticks | lines changed | blocks added/changed/moved/removed by label |
| Preview | read-only text, word-level marks | Preview (running, read-only storage) / Code diff | read-only board, rings, ghosts, trails |
| Review status | per block, Partly kept possible | none (no review) | one change (ruling 63) |
| Undo of Alfy's change | blocks put back, may follow other edits (F1 or chronological) | n/a (its toast Undo is a restore, F3) | the parent body, only while Alfy's change is the last thing (always F1) |
| Restore extra line | tabs keep their names | storage is not rolled back: "Saved data stays as it is now." / *A mentett adatok maradnak a mostaniak.* | none |

---

## 7. Motion

Reuses the redesign's tokens and numbers (§7 there); nothing new animates by itself.

| What | Motion | Duration · easing | Reduced motion |
|---|---|---|---|
| Header phrase changes | cross-fade, 6 px rise (as #15) | emphasis · ease-emphasis | instant |
| Enter / leave History | body ↔ preview cross-fade; rail slides 24 px from the right | in emphasis · ease-emphasis; out standard · ease-in | instant |
| Select a moment | preview cross-fade | standard · ease-out | instant |
| Narrow: list → preview | push 28 px (as #3) | as #3 | instant |
| Highlights arrive | arrive tint → resting tint (as #11) | settle · ease-out | resting tint |
| Step to a change | 3 px ring + deeper tint (as #17) | 900 ms | static ring 900 ms |
| New moment while open | rises 4 px, fades in (as #20) | emphasis · ease-emphasis | instant |
| Status swap (Kept / Undone) | as #13 | standard | instant |
| Restore question | height (as #19) | standard · ease-emphasis | instant |
| Toast | as #33 | | instant |
| Phone sheet | as #24 | | instant |

---

## 8. Strings (EN · HU)

Every new string, in the `artifacts.history.*` family (the old `artifacts.document.versions.*` keys are kept until
the build removes their last reader).

| Key (suffix) | EN | HU |
|---|---|---|
| title | History | Előzmények |
| regionA11y | History of {title} | {title} – előzmények |
| buttonA11y | History. Last change: {phrase} | Előzmények. Utolsó változás: {phrase} |
| done | Done | Kész |
| listA11y | Versions | Változatok |
| filterAll / filterNamed | All / Named | Mind / Elnevezettek |
| today / yesterday | Today / Yesterday | Ma / Tegnap |
| now | Now | Most |
| nowLine | This is how it looks now | Így néz ki most |
| sameAsNow | Same as now | Ugyanaz, mint most |
| sameAs | Same as {when} | Ugyanaz, mint {when} |
| restoredFromHere | Restored from here · {when} | Ide állítottad vissza · {when} |
| status.waiting / kept / undone / partly | Waiting for you / Kept / Undone / Partly kept | Rád vár / Megtartva / Visszavonva / Részben megtartva |
| review | Review | Átnézés |
| fromChat | From the chat | A beszélgetésből |
| phrase.youEdited / alfyChanged / alfyWrote / alfyBuilt / youRestored | Edited by you / Changed by Alfy / Written by Alfy / Built by Alfy / Restored by you | Szerkesztetted / Alfy módosította / Alfy írta / Alfy készítette / Visszaállítottad |
| moment.* | the headlines in §3.2 | §3.2 |
| detail.changed | Changed “{label}” | Módosult: „{label}” |
| detail.changedMore | Changed “{label}” and {n} more | Módosult: „{label}” és még {n} |
| detail.added / removed | New: “{label}” / Removed: {n} paragraph(s) | Új: „{label}” / Törölve: {n} bekezdés |
| detail.inTab | in {tab} | a(z) {tab} lapon |
| detail.board | {moved} moved, {added} added, {removed} removed | {moved} áthelyezve, {added} hozzáadva, {removed} törölve |
| detail.lines | {n} lines changed | {n} sor módosult |
| detail.large | Large change | Nagy változás |
| compare.step / compare.now | This version's changes / Compared with now | Ebben a változatban / A mostanihoz képest |
| change.prev / change.next | Previous change / Next change | Előző változás / Következő változás |
| change.count | {i} of {n} | {i} / {n} |
| added / removed (sr) | Added: / Removed: | Hozzáadva: / Törölve: |
| unchanged | {n} unchanged paragraphs | {n} változatlan bekezdés |
| noChanges | Nothing changed in this version | Ebben a változatban nem változott semmi |
| tooLarge | Too large to compare; you can still restore it | Túl nagy az összehasonlításhoz; visszaállítani még tudod |
| restore | Restore | Visszaállítás |
| restoreQ | Bring back {when}? What you have now stays in History. | Visszaállítod a(z) {when} változatot? A mostani megmarad az előzményekben. |
| restoreTabs | Tabs keep their current names. | A lapok neve a mostani marad. |
| restoreElsewhere | It changes in “{chat}” too, where it was made. | A(z) „{chat}” beszélgetésben is megváltozik, ahol készült. |
| restoreWaiting | Alfy's change waiting for you goes with it. | Alfy rád váró módosítása is eltűnik vele. |
| restoreAppData | Saved data stays as it is now. | A mentett adatok maradnak a mostaniak. |
| restored | Restored {when} | Visszaállítva: {when} |
| restoredA11y | Restored {when}. The version before it is in History. | Visszaállítva: {when}. Az előző változat megmaradt az előzményekben. |
| restoreMoved | It changed while you were looking. Here's the latest. | Közben megváltozott. Itt a legfrissebb. |
| restoreConflict | Reload first: it changed elsewhere. | Előbb töltsd újra: máshol megváltozott. |
| name / rename / removeName | Name / Rename / Remove name | Elnevezés / Átnevezés / Név törlése |
| nameField / namePlaceholder | Name this version / e.g. Before the client call | Változat elnevezése / pl. Az ügyfélhívás előtt |
| named | Named “{name}” | Elnevezve: „{name}” |
| nextEditsNew | Your next edits start a new version. | A következő szerkesztéseid új változatba kerülnek. |
| oneVersion | Changes you and Alfy make will appear here. | Ide kerülnek a te és Alfy későbbi változtatásai. |
| older | Show older | Korábbiak |
| loadError | Couldn't load the history. | Nem sikerült betölteni az előzményeket. |
| deleted | This {kind} was deleted. | Ez a(z) {kind} törölve lett. |
| appRuns | Runs with today's saved data; changes aren't saved. | A mostani mentett adatokkal fut; a változtatások nem mentődnek. |
| versionFine | Version {n} | {n}. változat |
| help | ⌘Z undoes your last steps. Undo on Alfy's change undoes just that change. Restore brings back a whole version. | ⌘Z: a saját legutóbbi lépéseid. Visszavonom: csak Alfy módosítása. Visszaállítás: egy teljes korábbi változat. |

Hungarian notes: the article before a variable word (`a(z)`) is resolved by the existing helper the dictionary
uses for kind names, never printed as "a(z)"; times are written the Hungarian way (*hétfő 10:09*, *október 7.,
kedd*); every user-facing verb is second person informal, as the rest of the app (*Szerkesztetted*,
*Visszaállítottad*); the review pill keeps its first-person verbs (*Megtartom*, *Visszavonom*, redesign §4.5).

---

## 9. Rulings and rules: proposed amendments

**A1. AGENTS.md, "One version number on every surface".**
- Old: "**One version number** on every surface (list row, in-chat card, panel header's version button, Versions
  popover): `src/lib/client/api/artifacts.ts` announces every version, edit time and deletion the server reports
  (`subscribeArtifactChanges`); the chat page keeps the highest version and latest time per artifact … Never print
  a version or an "edited …" time from an open-item snapshot or a list refresh directly."
- New: "**One latest moment** on every surface (list row, in-chat card, panel header's history button, History's top
  moment): `src/lib/client/api/artifacts.ts` announces every version the server reports with its number, time,
  author and kind (`subscribeArtifactChanges`); the chat page keeps, per artifact, the highest version and that
  version's time, author and kind, and reads its rows, cards and open items through
  `src/lib/client/artifact-versions.ts`. The number orders and guards (`expectVersion`) and is printed only in
  History's fine print. Never print a latest moment from an open-item snapshot or a list refresh directly."
- Cost: `artifact-versions.ts` keeps `{ version, at, author, kind }` instead of two maps; `ArtifactCardSummary`
  gains `lastAuthor` and `lastKind` (read-model, from the newest row); `artifact-versions.spec.ts`'s one-number test
  becomes a one-moment test.

**A2. Ruling 47 (coalescing).**
- Old: "**Coalesced:** a save authored by the user **updates the latest version in place** (body, body_hash, its
  timestamp; the version number is unchanged) when that latest version is also the user's and was created less than
  **10 minutes** earlier. Otherwise it appends a new version."
- New: "**Coalesced:** a save authored by the user updates the latest version in place (body, body_hash and its
  last-save time; the version number and its first-save time are unchanged) when that latest version is also the
  user's, carries the same summary, **has no name the reader gave it**, was last saved less than **10 minutes**
  earlier, **and its burst started less than 30 minutes earlier**. Otherwise it appends a new version."
- Cost: the first two added conditions are cheap (the summary check exists, RV-1A); the name check needs §4.4's
  column or map; the 30-minute cap needs `started_at` (without it, drop that clause). More rows per long session
  (at most two an hour of continuous typing), all of which ruling 47's storage concern tolerates.

**A3. Ruling 16 (two undos), wording added, substance unchanged.** Add: "The in-session undo is ⌘/Ctrl+Z; undoing
Alfy's change is **Undo** on the pill or the review bar; going back to an earlier version is **Restore** in History.
History never offers Undo except the restore toast's own, which reverts the restore it just made and is drawn folded
with it." Cost: none in code; the help line in §5.7.

**A4. Rulings 61 and 63 (review), one sentence added.** "History shows each Alfy change's review status (waiting,
kept, undone, partly kept) derived from the same marker and computations, and sends the reader to the review to
decide; it has no Keep or Undo of its own." Cost: none beyond §10's derivation.

**A5. The summary vocabulary rule (AGENTS.md's Artifacts section, "The version summaries the server writes itself
are one vocabulary").** Add: "every summary the server writes, Alfy's fallbacks and the App's regenerate included,
and an Undo or Redo names the version it acts on (`Undid Alfy's change: v7`); the old forms stay readable." Cost:
§4.5's list.

Rulings 1, 13, 14 and 67 need no change: a version name is never part of a body (1); the body route keeps `body`
and `expectVersion` and gains only vocabulary (13); ops still land only through `applyArtifactOps` (14); a restore
is the reader's version, so Alfy's next edit after one is judged against it (67).

What stays protected, explicitly: one source for every surface (A1); `expectVersion` on every body save, now on
restore too; the review marker and Keep/Undo (A4); Regenerate under the same id (its history restarts honestly,
§5.10); the deletion cascade (names and spans are row columns or metadata, both go with the artifact); the
incognito scope (every new route reads through `readScopedArtifactRow`).

---

## 10. Implementation map

**Server** (`src/lib/server/services/artifacts/`, facade-only, ruling 39 routes):

| Module | Change |
|---|---|
| `history.ts` (new) | `listHistory({ userId, artifactId, before?, limit } & scope)` → `ArtifactMoment[]`: reads a page of rows plus the parent of the oldest, derives kind, detail, markers, status and folds (§3.3, §4.2); pure `deriveMoments(rows, review, kind)` for tests; per-row cache keyed by `(id, body_hash)` |
| `shared/artifacts/history.ts` (new) | the browser-safe `ArtifactMoment` type and the fold rules' vocabulary (kinds, statuses, markers), shared by server and client |
| `versions.ts` | `listVersions` gains `before`; `restoreVersion` gains `expectVersion` and `undoOf`; `nameVersion` (column or metadata map) |
| `record.ts` `updateArtifactBody` | coalescing: refuse into a named version; keep `started_at`; the 30-minute cap (owner Q4) |
| `shared/artifacts/version-summaries.ts` | the whole vocabulary (§4.5) and its parsers |
| `comments.ts`, `canvas-comments.ts`, `normal-chat-tools/artifact-tools/edit.ts`, `keep-message.ts`, `app/regenerate.ts`, `normal-chat-tools/artifact-tools/recreate.ts` | write summaries from the vocabulary |
| `read-model.ts` | `ArtifactCardSummary.lastAuthor`, `lastKind` |
| routes | `GET /api/artifacts/[id]/history`; `PATCH /api/artifacts/[id]/versions/[versionId]` (name); restore accepts `{ expectVersion, undoOf }`; body route's `summaryKind: redid_alfy_change` and `summaryVersion`; `GET /api/artifacts/[id]/versions/[versionId]/app` (sandbox headers from `sandbox-response.ts`, read-only storage bootstrap) |
| migration (if Q3 = yes) | `drizzle/1777140000113_artifact_version_moments.sql`, journal 127, `schema.ts`, `account-data-archive/index.ts` |

**Browser:**

| Module | Change |
|---|---|
| `components/artifacts/history/` (new, one lazy entry `history-parts.ts`) | `HistoryMode.svelte` (rail + preview shell, layouts, phone sheet through `DialogShell`), `MomentRail.svelte` (listbox, groups, steps, filter, paging), `MomentPreviewToolbar.svelte` (Name, Restore question, compare switch, change stepper), `moment-text.ts` (headline/detail/marker localisation, replacing `document/version-summary.ts`), `DocumentVersionPreview.svelte` (block + word diff rendering, read-only, no Tiptap: a Markdown renderer with marks) |
| `canvas/history-parts.ts` (new lazy entry) | `CanvasVersionPreview.svelte`: a read-only `CanvasBoard` with the diff layer (rings, ghosts, trails) reusing `diffBoards` and the review landing's ring styles; must import no `@xyflow/*` statically outside the board (ruling 68's chunk gate) |
| `app/AppVersionPreview.svelte` (new) | Preview (an `AppFrame` pointed at the version route) and Code (line diff) |
| `ArtifactPanelHeader.svelte` | the version button becomes the history button (phrase, pressed state); keep `data-testid="artifact-version-pill"` as an alias for one release, add `artifact-history-button` |
| `document-workspace/DocumentWorkspace.svelte` | History mode slot: hide the body, show `HistoryMode`, Done in the actions, flush the body's pending save first (the flush the chat page already gets, `registerPanelActions`); App gets `openVersions` |
| `document/DocumentBody.svelte`, `canvas/CanvasEditor.svelte` | drop their own `VersionsSheet` mounts (the Document's is a static import today: moving it to the lazy entry shrinks the Document body); expose `flush` and `reload` to the panel |
| `document/VersionsSheet.svelte`, `document/version-summary.ts` | removed once `HistoryMode` lands |
| `client/api/artifacts.ts` | `fetchArtifactHistory`, `nameArtifactVersion`, `restoreArtifactVersion(…, { expectVersion, undoOf })`; announcements carry author and kind |
| `client/artifact-versions.ts` | the observed latest moment (A1) |
| chat page | "From the chat" scroll-and-flash; card and list read the latest moment |
| `src/lib/i18n/artifacts.ts` | the `artifacts.history.*` block, EN and HU together (§8) |

---

## 11. Tests (red first, real input)

Playwright, real pointer and keyboard, each seen failing on today's tree:

- **T1 Document scenario** (`artifact-history.spec.ts`): seed draft → type with `page.keyboard` → an Alfy edit
  through the real edit route → Undo on the pill with a click → open History with a click → the rail reads the
  folded moment ("Alfy: … · Undone", "↳ You undid it") and no "v4" → ↓ moves the selection and the preview's
  highlight count changes → Restore with a click, confirm with Enter → the new top moment, "Restored from here" on
  the source, toast Undo folds the pair → a reload shows the same rail.
- **T2 Naming closes a burst:** type, name the newest version by keyboard, type again → two "You edited" moments,
  the first named.
- **T3 Paging:** seed 120 versions → "Show older" twice → day groups continuous, focus stays on the button's
  replacement.
- **T4 Phone** (390×844, touch): sheet, tap a moment, preview, ‹ ›, Restore with 44 px targets, back gesture order.
- **T5 Restore guard:** type, open History before the autosave fires, restore → no conflict banner, the typed step
  is the moment before the restore (P10).
- **T6 App:** regenerate → History → the v1 preview runs (frame loads) with storage read-only (a write in the frame
  is refused) → Code shows the diff → Restore.
- **T7 Canvas:** an Alfy diff → Undo on the review bar → History folds it → the preview rings the changed blocks →
  Restore.
- **T8 Hungarian:** in HU, no English summary appears for a comment-reply edit, an App rebuild, a kept reply, or
  Alfy's fallback (P4).
- **T9 Accessibility:** the listbox and its options' names, the live announcements, focus return on Escape.

Unit (Vitest): `deriveMoments` for each fold rule and its counter-case (§3.3), hash equality, `restoredFrom`,
statuses from the review computations, the vocabulary parsers (old and new forms), coalescing refuses a named
version and (Q4) a burst over 30 minutes, the restore guard, the history route's 404 parity and incognito scope.
Gates: `check:artifact-chunks` must stay inside the ceiling (History is lazy in both editors).

## 12. Build split

Three agents on disjoint files, after one shared first commit of `shared/artifacts/history.ts` (the type) by agent 1:

1. **Server (Sonnet):** `history.ts`, the vocabulary, `versions.ts`, `record.ts`, routes, read model, the migration
   if approved, every unit test above. Owns `src/lib/server/**`, `src/routes/api/artifacts/**`,
   `src/lib/shared/artifacts/{history,version-summaries}.ts`, `drizzle/`.
2. **History shell + Document (Sonnet):** `components/artifacts/history/**`, `ArtifactPanelHeader.svelte`,
   `DocumentWorkspace.svelte`'s History slot, `DocumentBody.svelte`'s removal of `VersionsSheet`, the client API and
   `artifact-versions.ts`, the `artifacts.history.*` i18n block, T1–T5, T8, T9.
3. **Canvas + App previews (Sonnet):** `canvas/history-parts.ts` and its preview, `app/AppVersionPreview.svelte`,
   `CanvasEditor.svelte`'s removal of `VersionsSheet`, their i18n lines in their own block, T6, T7, the chunk gate.

Agents 2 and 3 build against fixtures of `ArtifactMoment[]` until agent 1's route lands; an Opus review after all
three (the owner's rule for agent batches).

## 13. Open questions for the owner

Reply in one message, e.g. "Q1 yes, Q3 no, rest as recommended".

1. **History becomes a mode of the panel** (preview beside the list) instead of the small popover. *Recommend: yes*
   — a preview does not fit in 340 px, and scrolling through versions with the content visible is what makes it
   followable.
2. **No version number** on the header, the list row or the chat card (only "Version 7" in History's fine print).
   *Recommend: yes.*
3. **One migration** (`started_at`, `label` on `artifact_versions`) for burst spans and names. *Recommend: yes*;
   without it names still work (metadata map) and spans are dropped.
4. **A typing burst closes after 30 minutes** (more restore points in a long session). *Recommend: yes* (needs Q3).
5. **An Undo folds onto the change it undid when it follows it at once**; otherwise it stays in time order.
   *Recommend: yes.*
6. **Restore of an item made in another chat** is allowed, with a line saying it changes there too. *Recommend:
   yes.*
7. **An old App version runs in the preview** through one new read-only route (security review needed).
   *Recommend: yes*; the fallback is Code only.
8. **Alfy's edit summaries are asked for as a subjectless past-tense line** ("Moved the museum to Thursday", not
   "I moved…"): a tool-text change that moves the catalogue budget and its snapshots (ruling 23). *Recommend: yes,
   in the server agent's batch.*

---

## Appendix: the screenshots and the mockup

`current/` holds the capture pass's screenshots of today (VC, 2026-10-11): a local build of `feat/artifacts`, HU
unless the name says EN, light unless it says dark. The 947-pixel ones are the panel only, which is the panel's real
width at 1440.

| File | Shows |
|---|---|
| `doc-history-11-versions-1440-hu.png` (`-en`, `-dark-hu`) | the Versions popover over an 11-version Document: v10 "Visszaállítva: v8", v9 "Visszaállítva: v3", v7 "Alfy's comment reply" in English, a pending review bar under it |
| `doc-pending-review-1440-hu.png` | the header `Dokumentum · v11 ▾ · Te és Alfy · szerkesztve 1 perce`, two pending pills, the review bar |
| `doc-history-after-undo-1440-hu.png` | "Alfy módosításának visszavonása" (v5) directly over Alfy's v4, nothing linking them |
| `doc-restore-confirm-1440-hu.png` | the inline restore question inside the v3 row, no preview |
| `doc-restore-toast-1440-hu.png` | after Restore: the popover gone, the toast "Visszaállítva: v3 mint v9 · Visszavonás" |
| `doc-history-phone-390-hu.png` | the same history as a bottom sheet at 390 px |
| `canvas-pending-review-1440-hu.png` | a board with Alfy's pending change: the pill and the review bar; the history adds only a number |
| `canvas-after-undo-1440-hu.png` | the board after the pill's Undo: "Visszavonva · Újra" |
| `canvas-history-1440-hu.png` | the board's Versions popover (the Document's sheet) |
| `app-regenerate-promises-history-1440-hu.png` | the App's regenerate popover: "v2 elkészítése" at header v2, "A v1 megmarad az Előzményekben" |
| `app-toast-v2-header-v3-1440-hu.png` | the toast "Mostantól a v2 látszik" beside the header's static "v3" |
| `app-no-history-1440-hu.png` | the App after four versions: "v4" as plain text, nothing else |

Not captured, so designed from the code: a live Alfy edit landing while the panel is open (§5.2 "Live"), the `@Alfy`
flow itself (§3.2, the mockup's step 8), a restore while a change waits (§5.5, §5.7).

The mockup's Today column shows, at each step, a drawing of today's popover and header made from the same version
rows by today's rules (labelled "Drawing from today's code"), and the real screenshot where VC captured the same
surface in the same state (a toggle switches between them); its New column derives the moments from those same rows
by §3.3's rules. The mockup was captured at its key states with Playwright against `file://…/index.html`.
