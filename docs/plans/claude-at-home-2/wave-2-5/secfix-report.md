# Fix agent S report — the Opus security review's findings on Delete / deleted state / Regenerate

Model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-secfix`, branch `fix/artifacts-delete-review`, base `0f1373f0`.
Status: DONE (all five items fixed test-first; L3 and L6 left as recorded in the brief).
Range `3aa429b1` .. `8f696c05` (5 commits, one per finding, ~49 files, +2.6k/-0.2k; nothing pushed, merged or rebased).

## Per finding

### M1 — an item that exists out of reach is not "deleted", and is never regenerated (`3aa429b1`)
- `services/artifacts/read-model.ts` `listMissingArtifactIds` now returns `{ deleted, unreachable }`. `unreachable` = the CALLER'S OWN
  family row that exists but is outside the served conversation's scope (parent of a forked incognito chat; a row whose chat link was
  cleared). Another user's row still reads exactly like a missing one (`deleted`), so nothing about it is revealed. Containment unchanged.
- `conversation-detail/read-model.ts` (+ `types.ts`): `ConversationDetail.unreachableArtifactIds` and the same field on the older-messages
  page. `+page.ts` passes it through (the review found last time that `+page.ts` is where such fields get lost).
- `recreate.ts`: after the stored-call check and BEFORE any model call, `artifactIdInUse(id)` (new, `record.ts`, facade; `createArtifact`'s own
  `id_taken` check now uses it) -> `{ ok:false, reason:"unreachable" }`, route answers 409. The one-at-a-time lock is now keyed by artifact id
  alone (a fork's card and its parent's can offer Regenerate for the same id).
- Client: `ArtifactCard.svelte` gets `view.unreachable` (dashed/muted like the deleted head, "Made in the original chat" / "Az eredeti
  beszélgetésben készült", no Open, no Regenerate, `data-state="unreachable"`, wins over `deleted`). `DeletedArtifacts.unreachableIds`
  travels the same single prop. Page: state hydrated at the three sites (initial data, `applyConversationDetailMetadata`, `hydrateConversationDetail`);
  a Regenerate refused as `unreachable` moves the card from deleted to unreachable; a 404 on Open now asks the server (detail read) whether the
  item is gone or only out of reach before calling it deleted.
- Tests: `artifacts/read-model.test.ts` (new shape, incognito from another chat, P4 forked-incognito, cleared link, stranger reads as deleted),
  `recreate.test.ts` (P1 App: generator never called; P2 Document: `unreachable`, parent's row untouched; someone else's row now `unreachable`;
  lock across two chats), `regenerate.test.ts` (409), conversation-detail read-model tests, `ArtifactCard.test.ts` (EN/HU, wins over deleted),
  `page-runtime.test.ts` (server-marked card; 404-on-Open that turns out unreachable; Regenerate refused as unreachable), `page-load.test.ts`,
  client `artifacts.test.ts`, **`tests/integration/artifact-fork-unreachable.test.ts`** (real migrated SQLite, REAL `createConversationFork` of an
  incognito chat, real `getConversationDetail`, real `recreateArtifactFromStoredCall`: P1, P2, P4 and the "really deleted then it reads deleted and
  Regenerate works" control; mutation-checked: fails without the up-front refusal), and e2e `artifact-delete.spec.ts` "A fork of an incognito chat".

### L1 — Delete only acts on items this conversation made (`a95077d9`)
- `record.ts` `deleteArtifact` returns `{ ok:true } | { ok:false, reason:"not_found" | "not_made_here" }`. A delete that names the served
  conversation acts only on rows whose `conversationId` is that conversation; the check comes AFTER the scoped read, so a stranger's row or another
  chat's incognito item still answers the one `not_found`. Route: `409 { ok:false, reason:"not_made_here" }`; no `conversationId` = unchanged.
- Panel: `DocumentWorkspace.svelte` `canDeleteItem` hides the header Delete and the row overflow for an item whose `conversationId` is known and
  differs from the panel's. Items now carry their true origin: list items from `summary.conversationId`; a card's item from the read that finds the
  item still there (`openArtifactFromChat` uses `fetchArtifact`'s `artifact.conversationId`). An item that does not say where it was made has
  nothing to contradict (Delete stays; the server would refuse).
- Tests: `record.test.ts` (P3 Document and produced file from another chat; stranger/incognito still `not_found`; no conversation unchanged), route
  ownership tests (409 for another chat's item; a stranger naming their own chat gets the plain 404), `DocumentWorkspace.test.ts` (header and row),
  `page-runtime.test.ts` (parent's Document opened from a fork's card has no Delete; own item has). The ~13 existing `deleteArtifact` assertions in
  `record.test.ts`/`document.test.ts`/`tests/integration/artifact-app.test.ts` were converted mechanically to the new result shape (same meaning).

### L2 — honest confirm copy (`902e1f94`)
- i18n `artifacts.delete.bodyRegenerable.<kind>` EN+HU (5 kinds): "... You can regenerate it from the chat." / "... A beszélgetésből újra létrehozhatod."; the old
  `artifacts.delete.body.<kind>` ("This can't be undone" / "Ez nem vonható vissza") stays for items with no kept source. `ArtifactDeletePopover` takes `regenerable`.
- Which items: the server's word, `ArtifactCardSummary.regenerable` (set to `true` only), assembled in `conversation-detail/read-model.ts`
  (`markRegenerableArtifacts`): Documents/Apps a loaded message created (successful `create_artifact`) or was kept as (`ChatMessage.documentArtifactId`,
  new projection; `messages.ts` `regenerableArtifactIdsFromMessages`), and a produced file whose finished job kept its request (`FileProductionJob.canRegenerate`,
  new) AND made no other artifact (deleting one of two leaves the job a file, and a job with a file left cannot be regenerated). The panel reads it off its
  live list (`canRegenerateItem`) for the header confirm and each row's.
- Tests: popover (EN/HU, per kind, menu path, plain warning kept), `DocumentWorkspace.test.ts`, `page-runtime.test.ts`, detail read-model (Doc/App, file single vs shared job,
  list untouched when nothing is regenerable), `messages.artifact-calls.test.ts`, `deleted-files.test.ts`, e2e (create_artifact Document and produced file say the way back; a
  Document with no kept source keeps "can't be undone").

### L4 — no orphan vector after a delete race (`3bd58158`)
- `semantic-embedding-refresh.ts`: after `embedTexts` and right before the write (microtasks only in between) it checks which subjects still exist and
  writes only for those (artifacts and task states); a gone subject is not counted as refreshed.
- New `semantic-embedding-refresh.delete-race.test.ts` (real SQLite, the TEI call held open, so the race is deterministic): artifact deleted mid-refresh via the backfill path and via
  the queued path, one survivor of a batch, a task state whose conversation was deleted, and a control that still writes. Red before the fix (4 orphan vectors).
  The old mocked unit test got `inArray` in its drizzle mock and its artifact row.

### L5 — one Document per "Open as document" (`8f696c05`)
- The get-or-create moved out of the route into `artifacts/keep-message.ts` `keepMessageAsDocument` (facade export): one press per message runs at a time; a press arriving
  meanwhile is handed the same Document (`created:false`); a failed press frees the message. The route only checks the conversation and maps the answer.
- Tests: route tests with two presses at once (same id, exactly one row, one `created:true`), again after the kept Document was deleted, two different messages stay independent
  (red before the fix); `keep-message.test.ts` (a failing press does not wedge the message); `MessageBubble.test.ts` (a double press asks once; the button was already disabled while its request runs).
- AGENTS.md Artifacts bullets updated for this round's boundaries.

## Gates (final HEAD `8f696c05`)
- `npm run check`: 0 errors, 17 warnings (the pre-existing 17). `npm run check:migrations`: ok (no schema change).
- `npx biome check src scripts tests`: clean (2175 files).
- `npm test` (full): 912 files passed | 1 skipped; 14128 tests passed | 2 skipped (G2-A's run: 909 / 14055).
- Playwright on :5525, all `artifact-*.spec.ts` + `artifacts-api` + `artifacts-panel` + `knowledge` + `chat` + `conversation`: 143 passed.
- Fallow: 124 issues / 4 circular = the baseline; nothing in any file I touched.
- `npm run build`: exit 0; 32 unused-CSS + 2 a11y warnings = the baseline, none new.
- Ownership, incognito-containment (`tests/cross-cutting`) and shared-404 tests: green, including the structural scoped-reader guard (no new exemption; `semantic-embedding-refresh.ts` was already on the list).

## Screenshots (Hungarian, light, 1440x900, looked at; not committed)
`scratchpad/rd/shots/secfix/secfix-unreachable-card-hu-light-1440.png` (fork of an incognito chat: dashed muted card "Bécsi hétvége / Az eredeti beszélgetésben készült", no Open, no Regenerate),
`secfix-confirm-regenerable-hu-light-1440.png` ("Törlöd ezt a dokumentumot? ... A beszélgetésből újra létrehozhatod."). The throwaway capture spec was deleted.

## Deviations, limits, things to know
- `deleteArtifact` changed from `boolean` to a result object (the local `{ok,reason}` idiom); the `not_made_here` reason needs it. Existing assertions were converted, not weakened.
- Existing tests whose expectation changed by design: `recreate.test.ts` "never overwrites someone else's row" now expects `unreachable` (was `failed`; the row is still asserted untouched);
  the incognito-from-another-chat case in `read-model.test.ts` is now `unreachable` (was "missing").
- `regenerable` is window-limited like the deleted state itself (it reads the loaded message window, keeping the "exactly one `messages` query" pin): an item made only by messages outside the window
  gets the plain "can't be undone" copy (understates, the safe direction). A create call whose stored arguments no longer validate would still get the promise; its deleted card then says the
  request wasn't kept.
- Regenerating in a fork an item the parent deleted makes it in the fork under the same id (same design as before); the parent's card then reads it as made elsewhere. Not in scope.
- Not changed, as recorded in the brief: L3 (file-job regenerate needs only the job id, like its retry/cancel/dismiss siblings) and L6 (no capacity gate on App regeneration).

## Hand-off
- Merge notes for G3's parallel work: my edits in shared files are `DocumentWorkspace.svelte` (`canDeleteItem`, new `canRegenerateItem`, two `regenerable=` props on the popovers; row/name markup untouched),
  `ArtifactCard.svelte` (the deleted head branch + `unreachable` in the view type; `chrome="row"` untouched), `+page.svelte`, and new test blocks appended in `DocumentWorkspace.test.ts` and `page-runtime.test.ts`.
- Reusable: `listMissingArtifactIds` -> `{deleted, unreachable}`; `artifactIdInUse`; `ArtifactCardView.unreachable`; `DeletedArtifacts.unreachableIds`; `artifacts.madeInOriginalChat`;
  `ArtifactCardSummary.regenerable` / `DocumentWorkspaceItem.canRegenerate` / `FileProductionJob.canRegenerate`; `ChatMessage.documentArtifactId`; `keepMessageAsDocument`.
