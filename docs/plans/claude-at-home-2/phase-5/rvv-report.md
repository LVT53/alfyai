# RV-V: Opus review of the versioning batch (VB-1, VB-2, VB-3)

Model: Opus 5.5 (`claude-opus-5-5`). Tree: `52868879` (worktree `rv-v`), batch `2e31b613..52868879`. Report only, nothing fixed or committed.

**Verdict: ready after fixes.** No Critical. The old-App version route holds: the scope is right, its headers equal the live App route's, the read-only bridge is in place and the parent refuses `set`. The six Important findings below are what one fix pass should take. Four of them are about History saying or doing something that is not true, and one is a gate.

What I ran: a production `npm run build` (32 Unused-CSS + 2 ARIA, the baseline) and `npm run check:artifact-chunks`; the targeted unit tests (10 files, 154 passed); `check:migrations`; a temporary walk spec with real pointer, keyboard and touch input against `node build` on :5490 with the e2e DB, in Hungarian at 1440 (light and dark) and 390 (dark, touch), plus one test on `vite dev` :5491 that needed the fake model provider (on the production build the turn fell back to `model1`); and a temporary `deriveMoments` probe. All temporary files are deleted and both servers are stopped.

---

## Critical

None.

## Important

### I-1. A change that lands in this tab while the restore question is open takes the guard's version with it, so Restore buries it
`src/lib/components/artifacts/history/HistoryMode.svelte:465` (`refresh()` sets `newestVersion = result.newestVersion`), `:502–512` (any announced newer version starts a `refresh` after 150 ms), and `:667–673` (`confirmRestore` sends `{ expectVersion: newestVersion }`, which it reads at the moment of confirming).
- **Repro (real input, `vite dev` and the fake provider):**
  1. Open a Document and type one step.
  2. Open History, select the first draft and press Restore. The question opens.
  3. In the same chat, send a message that makes Alfy edit the Document (a real `edit_artifact`). It lands and the rail refreshes.
  4. The question is still open. It only gained "Alfy's change waiting for you goes with it."
  5. Press Restore. The server writes `4:user:Restored v1` on top of `3:alfy:Scripted edit`. No "It changed while you were looking." line ever appears. Screenshot `01`.
- **Why it matters:** §5.5 says the question becomes "It changed while you were looking. Here's the latest." and the reader asks again. `versions.ts` promises that a restore "can never silently bury … a change that landed while History was open". The `expectVersion` guard only catches writes this tab did not hear about. The common race is an Alfy turn in the same chat, and that one this tab hears about, so the guard never sees it. The same path also defeats T5 when the flush takes longer than its 4 s budget.
- **Fix direction:** capture `expectVersion` when the question opens, or when the preview loads. Or have `refresh()` turn an open question into the `restoreMoved` state whenever `newestVersion` moved. Add a real-input e2e test for it.

### I-2. Restore makes an App version that History says "can't run any more" the live App, which then runs it unaudited with the writing bridge
`HistoryMode.svelte:248` (`canRestore` ignores `runnable`), `services/artifacts/versions.ts:121` (`restoreVersion` runs no audit), and `routes/api/artifacts/[id]/app/+server.ts:44` (the live route serves any body without auditing; only the version route at `versions/[versionId]/app/+server.ts:49–55` audits).
- **Repro (production build, Hungarian):**
  1. Seed an App: v1 clean, v2 a version that sets `window.location.href`, v3 clean.
  2. In History, select v2. It reads "Ez a változat már nem futtatható, ezért csak a kódja látható." and Preview is disabled. The Restore button is still there.
  3. Press Restore, confirm, then Done.
  4. The live route now serves the violating code (`liveRunsForbidden: true`). The live frame runs it, and the tripwire fires ("Ez az alkalmazás megpróbálta elhagyni a homokozóját…"). Screenshot `06`.
- **Why it matters:** this is ruling 58's line. Code the current audit calls a violation (self-navigation, WebRTC) is kept from running in the preview, and then goes back into live service one click later. Live, it gets the writing bridge and today's data. The tripwire acts only after the navigation has already happened. The App's verification line still describes the version that was there before the restore.
- **Fix direction:** refuse the restore on the server for an App whose version body fails the current audit (`not_runnable`, the same check the version route makes). Hide or disable Restore on a Code-only version, and say why.

### I-3. An Undo that takes back several Alfy versions names only the newest, so History calls the other versions "Kept"
- **Board:** `canvas/_lib/review-controller.svelte.ts:477–482` names `state.latestAlfyVersion`. But `shared/artifacts/canvas-review.ts:191–212` makes the Undo restore the version before the whole unbroken run of Alfy's versions.
- **Document:** `document/DocumentBody.svelte:1246–1250` ("Mindet visszavonom" / Undo all) loops `handleUndoChange`. Each pass overwrites the autosave's sticky `pendingSummaryVersion` (`document-autosave.ts:146`), so the single save names only the last change's version.
- **Probe:** `deriveMoments` on `v1 draft (h1) / v2 alfy / v3 alfy / v4 "Undid Alfy's change: v3" (body = h1)` gives `v3 undone` (folded with v4), `v2 status "kept"` and `v1 sameAsNow`. History says v2 was kept although the board is back to v1.
- **Why it matters:** the brief's area 4 is "What History says is true". A turn that calls `edit_artifact` twice (F4's own case), or an `@Alfy` reply right after a chat edit, makes a run of more than one version. That is a normal case, not an edge.
- **Fix direction:** have an Undo name the range it takes back, for example the run's first version, with `statusOfChange` treating every version in `[first, n]` as undone. Or let the derivation mark every Alfy version between the restored body's source and the Undo as undone.

### I-4. After the restore toast's Undo, History selects the undone restore under "Now", and naming then lands on that version
`HistoryMode.svelte:650–655`: `landOnTop()` selects `m:${moments[0].versionId}`. For an F3 fold that id is the restore row S, because a folded moment shows its oldest row (`moments/derive.ts`, `rep = oldest`). `MomentRail.svelte:265–266` puts "Most"/"Now" on any moment that contains the newest row.
- **Repro (production build, Hungarian):** restore Alfy's change, then press Undo on the toast.
  - The selected entry is "Visszaállítottad: ma 22:13 · Most". Its preview shows the text that was just undone.
  - Pressing Name ("A hívás előtt") names v4, the undone restore, and not the current v5.
  - Screenshot `04` shows the name on the undone restore and two "Most" markers. Screenshot `02` shows the same double "Most" on an F1 fold, where Alfy's undone change is marked "Most".
- **Why it matters:** to the reader, the Undo looks as if it did not happen, and the name goes on a version they had just taken back.
- **Fix direction:** after a write, select the entry that holds the newest row (the step). Put "Now" only on the step or moment whose own row is the newest.

### I-5. Lead (a) is confirmed: in History's App preview the sandbox bar says the App "keeps your data", right under "changes aren't saved"
`components/artifacts/app/AppFrame.svelte:500–503` always shows `artifacts.app.sandboxBar` ("Homokozóban fut · nincs internet · megőrzi az adataidat" / "Runs sandboxed · no internet · keeps your data"). In preview mode (`previewVersionId !== null`) every write is refused, so the third claim is false and contradicts the line above it (`artifacts.history.appRuns`). Screenshot `05`. The other claims are as true as on the live App: it is sandboxed, and "no internet" holds for fetches (`connect-src 'none'`), with self-navigation remaining ruling 58's accepted residual. Nothing else in the bar's logic differs in preview mode.
- **Fix:** give preview mode a bar of its own, e.g. "… · read-only" / "… · csak olvasható", in English and Hungarian.

### I-6. Gate: `check:artifact-chunks` fails on the chat route
On this build the chat route's first load is 550,945 B gzip, which is 8,941 B over the 542,004 baseline (2,048 B allowed). A static-closure scan shows no heavy library and no History module code in the route. The only History content is the merged dictionary's strings. The editor's numbers pass, with 81 B of headroom per VB-3's measurement. This is not a code defect, but the gate is red. It needs a recorded re-baseline (VB-2's recommendation) or FG's replacement before it reaches `dev`.

## Minor

- **M-1. A newly landed moment shows a clock time while older moments say "just now"** (`history/moment-text.ts:66–75`, and `HistoryMode.svelte:161–167`, where the clock ticks every 30 s). A moment newer than the last tick has a negative age and gets the clock time. It is visible in screenshots `01`, `03` and `04` ("22:13" next to "épp most"). Treat a small negative age as "just now", or refresh the clock when the moments refresh.
- **M-2. A version number is still printed outside History:** the Canvas Insert menu's "From this chat" App rows show `v{n}` (even v1), and file rows show it above v1 (`canvas/chat-blocks/chat-block-data.ts:150–156, 175–181`, `artifacts.canvas.chat.version`). The dead `artifactTypeAndVersion` snippet (`DocumentWorkspace.svelte:2105–2110`) and its unused keys can go.
- **M-3. Items opened from the Knowledge library have no History button at all.** `knowledge/_helpers.ts:19–31` passes no `updatedAt`, `lastAuthor` or `lastKind`, so the phrase is null, and `ArtifactPanelHeader.svelte:97` (`{#if phrase}`) hides the button. Screenshot `08`. This was already missing before the batch (the old version pill had no number there either), but History is now the only way to versions. The library row already derives the moment (`deriveArtifactMoment`), so passing it through is cheap.
- **M-4. A restored Alfy change still reads "Visszavonva" (Undone)** next to "Ugyanaz, mint most" (Same as now) (`derive.ts:359` onward). A later restore *to* the change, or to a version after it, should end the "undone" status. Screenshot `03`.
- **M-5. A board's History preview runs its App blocks live, with the writing bridge** (`canvas/nodes/AppNode.svelte:124–129`, `CanvasBoard` `preview`). The reader can interact with the App inside the preview and change its saved data, which breaks "the preview changes nothing". It is not an escalation (it is today's App). Draw the block's poster in preview, or pass a read-only switch.
- **M-6. The read-only bridge rejects in English** ("alfy.storage is read-only in a saved version", `app/bootstrap.ts:79`), and an App that shows its error displays that to a Hungarian reader (screenshot `05`). Use a neutral code-like message, or localize it from the parent.
- **M-7. A live landing's `alfyVersionNumber` is the newest version the reload found, not the call's own** (`DocumentBody.svelte:993`). Parallel edit calls, or a reader save in between, make a pill Undo name the wrong version. The call's `versionId` is now in the stream's metadata.
- **M-8. An App rebuild's toast Undo is announced as `undo_restore`** (`client/api/artifacts.ts:1035–1038`), while the server writes "Undid Alfy's change: vN". The header says "Edited by you" until a later fetch refines it.
- **M-9. Phone sheet:** "Előzmények" appears twice (sheet title and back link). The board preview's zoom control covers part of the "Vasárnap" frame, and the "Áthelyezve" tag covers the moved note's text (screenshot `07`).
- **M-10. Costs:** History's `readReview` (`history.ts:343`) parses every version since the review marker, bodies included, on every page, every "Show older" and every refresh triggered by an announcement while History is open. The read-model already pays this per detail load. `GET …/versions?limit=` is not capped (`versions.ts:69`; the query allows 9 digits). The App preview's HEAD probe repeats the read and the audit before the frame's GET.
- **M-11. Lead (b), the detail cache, is acceptable.** An entry can only be reached by `(version id, body hash)` of a row that a scoped read returned. After a delete no row can produce those keys (version ids are fresh UUIDs, including after Regenerate). The cache lives in process memory, holds 2,000 entries at most in FIFO order, is lost on restart, and contains no bodies. The deletion cascade's promise is about stored state, and this is not stored state. Optional hardening: evict the deleted artifact's version ids in `deleteArtifact` and `hardDeleteArtifactsForUser`.
- **M-12. Hungarian.** Most of it reads naturally. Worth a native touch:
  - `artifacts.history.oneVersion` "Ide kerülnek a te és Alfy későbbi változtatásai." has awkward possessive agreement.
  - `artifacts.history.tooLarge` "…; visszaállítani még tudod" would read better as "…, de még visszaállíthatod".
  - The help line "Ctrl+Z: a saját legutóbbi lépéseid. Visszavonom: … Visszaállítás: …" is a verbless legend where the English has sentences. The Undo label itself matches the pill.

## Checked and sound

- **Old-App route, scope:** the 404 is byte-identical, JSON and without sandbox headers for a missing version, another artifact's version, another user's, a Document, a produced file, an incognito item without `?conversationId=` and one under another chat's id (unit tests). On the production build an unknown version also gives the same 404 JSON.
- **Old-App route, headers:** the version route's headers equal the live route's entry by entry, both on GET and on HEAD (cache-control, the same CSP string, content-type, referrer-policy, nosniff). The hook's processing is identical for both, since both are under `/api/` and CSP_MODE does not touch API responses.
- **Old-App route, the bridge:** the parent refuses every `set` while `previewVersionId` is set (`AppFrame.svelte` `handleMessage`, plus a second check in `serveStorageCall`). The message source check is per frame, so a preview frame's message cannot reach the live frame's listener.
- **Old-App route, the walk:** no kv write left the preview, including a button that calls `set`, and kv was unchanged. The `APP_SERVED_ROUTE_PATTERN` change only widens the session-expired notice and makes no auth optional.
- **Routes:** History, name (PATCH), restore and the version app route all use `requireApiUser`, the scoped read, a 400 for malformed input before any lookup, and incognito scope through `?conversationId=`.
- **Facade rule:** held. The only readers outside the service are the archive, which is the named exception, and the knowledge store's existing version lookup, extended in the same query.
- **Migration and prepare-db:** migration `…113` is fine and `check:migrations` is OK. prepare-db checks the new columns after migrating, so an existing database is not refused.
- **Coalescing:** A2 is implemented as written (same summary, no name, under 10 minutes, burst under 30 minutes, `started_at` left untouched on coalesce).
- **Restore guard and `undoOf`:** atomic in the write. The toast's Undo is guarded by the restore's own number.
- **F1–F4:** no row hidden, time order kept, paging continuous.
- **"From the chat":** links only to messages this page holds. A fork's link points at its own copied message, and nothing is fetched across chats.
- **Flush before a turn:** the Document's flush makes a turn wait at most 2 s, and History's open waits at most 4 s.
- **Lazy entries:** History code is only imported dynamically, and no heavy library is in the chat route.

## Screenshots (`p5/rvv-shots/`, all looked at)

- `01-guard-question-after-alfy-1440.png`: I-1, the question still open after Alfy's change landed.
- `02-doc-folded-undo-hu-1440.png`: the F1 fold in Hungarian, with "Most" on Alfy's undone change (I-4).
- `03-doc-restore-toast-hu-1440.png`: restore and toast at the panel's foot. M-1 (22:13 next to "épp most") and M-4.
- `04-doc-after-toast-undo-named-hu-dark-1440.png`: I-4, the name on the undone restore, dark.
- `05-app-preview-banner-hu-1440.png`: I-5, the bar under "a változtatások nem mentődnek", plus M-6.
- `06-app-restored-forbidden-version-live-hu-1440.png`: I-2, the tripwire after the restore.
- `07-board-history-phone-hu-dark-390.png`: the board preview on a phone with touch, M-9.
- `08-knowledge-panel-header-hu-1440.png`: M-3, no History button on the Knowledge panel.
