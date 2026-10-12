# FB-1 — files and downloads (F1, F23, F25, F27, F30)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-fb1`, branch `fix/friction-files`, from `feat/artifacts`
(`7be9d42a`). Commits `fc385e1e..d71d11d4` (11), 46 files. Status: **DONE_WITH_CONCERNS** (concerns below, none blocking).

## Gates (`scripts/gates.sh agent … --port 5400 --workers 4`, at `d71d11d4`, ALL GATES PASSED, 4m08s)

Specs in full: `artifact-downloads` (new), `pdf-preview-size` (new), `knowledge`, `project-files`, `artifact-document`,
`artifact-app`, `responsive-verification` (+ the `@smoke` set). Logs: `p5/fb1-gate/`.

```
check      0 errors, 17 warnings (the baseline 17)
biome      ok         migrations ok
vitest     files 1058 passed | 1 skipped; tests 17,855 passed | 2 skipped
build      unused-css=32 aria=2 (baseline 32/2)     chunks ok (editor closure 70.9 kB gzip)
fallow     total=124 circular=4 new_vs_baseline=0
playwright 119 passed, 0 skipped, 0 failed, 0 flaky on 4 workers
```

Not in the gate list on purpose: `everyday-redesign-screens.spec.ts` (I changed one URL in it). Its two `knowledge documents tab`
tests are the **quarantined** ones (`tests/e2e/quarantine.json`: the seeded `nextcloud-folder-audit.csv` row shows "Failed – added
before processing was tracked" where the spec expects a dash). I ran the file on the build: `knowledge memory profile` (light, dark)
pass, the two quarantined fail with exactly the recorded reason. Not mine.

## F1 — Downloads go nowhere (the main one)

**Cause (two parts, both reproduced with real input).**
1. `DownloadSheet.svelte` closed on the export route's 202 and nothing followed the job. The job ran to success, but a produced file
   that hangs from no reply is listed nowhere (`listConversationReadModelChatFiles` requires an `assistantMessageId`), so there was no
   `download` event, no card, no row, and the count stayed put. The App's Letöltés was the same: `AppBody` fired the job and showed
   nothing (a sandbox failure was invisible).
2. The "ghost cards": at the end of **every** turn the chat page's optimistic stamp
   (`attachUnassignedFileProductionJobsToAssistant`, `chat/[conversationId]/_helpers.ts`) stamps **every** unassigned job of the
   conversation onto the new reply (the server assigns only jobs made after the turn began). So each earlier export came back as a
   card of a reply that never made it, until a reload. Reproduced: two exports, a reload, a stubbed stream whose end names a reply
   (with a non-receipt-only metadata, as a real turn end has) → 2 cards. (Not what the audit's file:line hinted at:
   `MessageArea.svelte`'s streaming matcher is clock-bounded and never matched an earlier job.)

**What a Download does now.** The panel follows the job itself.
- `DownloadSheet.svelte` (one popover for both kinds: a Document's PDF / Word / Markdown, an App's one "HTML file"; the App's header
  button opens it instead of starting a download nobody could see) calls `downloadProducedFile` (`client/downloads.ts`): start the job
  (`exportArtifactDocument` / `downloadAppAsHtml`), wait (`waitForFileProductionJob`, `client/api/file-production.ts`, polling the new
  `GET /api/chat/files/jobs/[id]`; 250 ms, then 500, then 1 s; 60 s bound; a read that fails is retried; a wait that runs out
  **cancels** the job), then start the browser download of the **canonical** `/api/chat/files/[id]/download`, built from the file's id,
  through `startAuthenticatedDownload`.
- The popover says "Preparing your file…" (buttons disabled) until the download has started, then closes; a refused start, a failed
  job, a timeout or a session that ended says so with Try again (`download-failures.ts`, one vocabulary shared with Knowledge). A
  popover closed meanwhile does not stop the download (the reader asked for it); a failure after that is not shown anywhere (concern 4).
- **An export never attaches itself to a reply.** The routes make the job with `origin: "artifact_export"`
  (`ARTIFACT_EXPORT_JOB_ORIGIN`, `file-production/types.ts`; an `origin?` input of `submitFileProductionIntake` that only server
  callers set, never read from a body; the produce route passes none), and **no list of a conversation's jobs carries such a job**
  (`read-model.ts`: `listConversationFileProductionJobs` → the chat's cards, a turn's start snapshot, `finalize`'s reconciliation;
  `listConversationFileProductionJobStates` → the prompt's job states: a failed export is no claim the model made). The new
  `getFileProductionJobForUser` (user-scoped by id, then the existing single-job read) feeds the poll route.
- Follow-up commit `d71d11d4`: exports that already exist (before this change) and failed intakes still hang from no reply in users'
  conversations, so the page's stamp now takes only jobs made since the turn began (`createdSince` = the streaming placeholder's time
  − 30 s for the two clocks). Without it, the owner's old exports would still ghost onto the next reply.
- The App's idempotency key now carries a per-press nonce (`app-html:<id>:<version>:<uuid>`): the old key handed a job an earlier
  press had left failed (no sandbox) back to every press after it. The App's `.html` still runs the sandbox program (owner decision 7,
  ruling 42: `produce_file` stays the engine, served `attachment` through the canonical route, never previewed).

**Does a finished export also appear in "Made in this chat" as a File row? No — decided, and why.** A download is *delivery*, not
something the chat made: the reader asked for a file on their disk, and it is there. A row would (a) need either a reply to hang from
(the ruling and the brief forbid it) or a change to the list's rule that also lists board posters, (b) grow with every press and
duplicate the Document's own row under the same name (F9's complaint), and (c) is not what the rest of the panel does for reader
actions: the board's PNG is the one export that is a File of the chat, and that is ruling 18's deliberate exception, kept. What a
finished export still leaves is its file and `generated_output` row, which Knowledge lists as a "Generated" row (concern 2).

**Tests (real input, red first).** `tests/e2e/artifact-downloads.spec.ts` (11 tests): a real click on each of PDF / Word / Markdown →
Playwright `download` event, the file's name, a non-empty body in the format (`%PDF-`, `PK`, the text); the popover is "Preparing…"
while the poll is held, then downloads and goes; a failed job says so with Try again; an incognito chat's Document downloads (the
export names `?conversationId=`); the reader's export hangs from no reply and the next reply is handed no card (2 cards before);
a job from an hour ago is not stamped on the next reply (1 card before); the App: the real click → download of the seeded job's
file (the sandbox job is the one stubbed thing: no Docker here), and a failed sandbox run says so. Red evidence: all four download
specs timed out waiting for the `download` event on the unfixed tree (jobs in the DB `succeeded`, `assistant_message_id` null).
Unit: `read-model.job-state.test.ts` (3 new, red against the old read model), `downloads.test.ts` (7 for `downloadProducedFile`),
`file-production.test.ts` (10 for the read and the wait), `DownloadSheet.test.ts`, `AppBody.test.ts`, `download-failures.test.ts`,
`_helpers.test.ts` (the stamp), the App route test (origin, per-press key) and the Document export route test (origin).
Docs: AGENTS.md (Artifacts) has a bullet on the delivery contract.

## F30 — the noisy probe
`confirmSessionForDownload` asked `/api/chat/stream/status` with no `conversationId` (a 400 on purpose). It now names one the handler
answers 200 for (it answers from memory), same one-sided contract (only a 401 stops a download). Red: the downloads spec collects
every response between the click and the `download` event; against the old probe it saw `400 /api/chat/stream/status`.

## F23 — Knowledge (3 commits)
1. **Opens on Dokumentumok.** The tab is the URL's state, so the default flipped: no `tab` = Documents (its own URL carries none),
   `?tab=memory` = Memory Profile (the home notice's link already used it; Settings' "Open Knowledge Base" now asks for it). Server
   loader's `initialTab` and the page agree. The memory profile is still fetched only when its tab is open (so its "needs review"
   badge on the tab appears once it has been opened, concern 5). Specs that exist for the memory view ask for it.
2. **Real sizes.** A generated row's own `size_bytes` was never the file's (a source-first document's row has none; a file's memory
   row holds the memory text's size). `applyGeneratedFileSizes` (`knowledge/store/documents.ts`) reads the size of the chat file the
   row's `sourceChatFileId` names (the chain the row's Download serves), the user's own files only, chunked at 400, before sorting.
   Rows with no size of their own (Document, Canvas, App: the store says so on purpose) show "—", not "0 B". Red: "0 B" vs "358.0 KB"
   with a real exported PDF; real-DB unit test (another user's file and a missing file keep the row's own size).
3. **Row actions.** Document, Canvas and App rows get **Open** by a button of its own (the row still opens on a click); Document
   and App get **Download**, the panel's own flow: a Document offers PDF / Word / Markdown in a small menu, an App its `.html` at
   once, a Canvas has none here (its picture is drawn by the open board, which Open reaches; shelved Slides rows stay delete-only).
   The button shows "preparing" and ignores a second press; a refusal or a failed job lands in the page's own error banner in the
   panel's words. **Found by looking at the screenshot, not by the first test:** the menu drawn inside the table was cut off by the last
   row's edge (a short list showed 2 of 3 items); it is now painted in `<body>` and placed from its button (opens above when there
   is no room, closes on scroll/resize, focuses its first item).

## F25 — PDF page jump
The canvases entered the document with no size (the 300×150 default box) and jumped when the first render began. The size is known
as soon as the document and its first page are (the region's width, the first page's viewport): `PdfPreview.svelte` now computes it
**before** the canvases mount and holds each page's CSS box in state (`pageBoxes`, bound to the canvas style; `renderPage` no longer
writes the element's style by hand), so every page is in the document at its final size. Red on the production build with a real
click on the file card's Open, sampling the first page's box every frame: `300x150 -> 897x1268`; after: one size. A unit test holds
the claim (canvas first seen at 500×375 for a 548 px region and a 640×480 page). Note: `vite dev` cannot show a PDF at all
(`Invalid workerSrc type`, pre-existing), so `pdf-preview-size.spec.ts` needs the build, as the gates have.

## F27 — Files dialog
The row's name is a button (same box and truncation, an underline on hover/focus, a link's focus ring) that does what the icon does
(`ProjectFilesDialog.svelte`). Red: a click on a Document row's name did nothing; now it opens the editor, and a board opens from its
name by Enter. Existing `project-file-name` test ids and measurements are unchanged.

## Screenshots (`p5/fb1-shots/`, each looked at)
1. `1-document-download-preparing-hu.png` — the popover at 1440×900 in Hungarian: title, PDF/Word/Markdown, "A fájl előkészítése…".
2. `2-document-download-failed-hu.png` — "Nem sikerült létrehozni ezt a fájlt." with "Újrapróbálom".
3. `3-app-download-popover-hu.png` — the App's popover: "Borravaló-kalkulátor letöltése", "HTML-fájl".
4. `4-knowledge-documents-hu.png` — opens on Dokumentumok; the generated row "358.2 KB", Document and App rows "—"; the Document
   row's Open / Download / Delete with the menu open and complete.
5. `5-knowledge-documents-phone-hu.png` — 390 px: the same rows as cards with their three buttons.
6. `6-project-files-dialog-name-en.png` — the Files dialog, a row's name underlined under the pointer (English: the helper that opens
   the dialog finds it by its English name).
"Done" has no picture of its own: on success the popover closes and the browser's download takes over (screenshot 2 shows the other
end state instead).

## Deviations and decisions
- Download popover for the App (not in the brief's text; the brief says "the App's download popover", which did not exist): one
  popover for both kinds, one extra click for the App compared with the old silent one-click, in return for a visible state.
- The brief put the ghost cards at `MessageArea.svelte`; the mechanism is the chat page's stamp (above). I fixed it at the source
  (the list the page and the server read) and in the stamp; `MessageArea.svelte` is untouched.
- No migration. `origin` is plain text; `getFileProductionJobForUser` and the job route are new but small.

## Concerns / for the owner or the next agents
1. **Opus look (ownership / file serving / sandbox):** see the path in the hand-off; the points to read are the new GET job route's
   scoping, that `origin` cannot be set by a client, that the download URL is built from the file id on the canonical route, and
   that an App's HTML still leaves only as `attachment` (ruling 42).
2. **Exports still persist in Knowledge as "Generated" rows** (a file + a `generated_output` row each, one per press), duplicating
   the Document's name (F9). Untouched (not in the brief); options: hide `artifact_export` rows from the library, dedupe by content, or
   delete the file once delivered. Owner's call.
3. **Found, not fixed:** a generated source-first row in Knowledge opens as "Preview not available for this file type" (the workspace
   item carries the source's mime, not the rendered file's); `applyGeneratedFileSizes` already reads the chat file, so adding its
   name/mime to the item is a small follow-up. Also: PDF / Word are named by the report renderers as an ASCII slug
   (`becsi-hetvegi-utiterv.pdf`) while Markdown keeps the title (`Bécsi hétvégi útiterv.md`).
4. A download whose popover was closed and then fails is silent; there is no toast. The App export needs Docker in production
   (`program` job), and fails visibly (popover) where it is missing.
5. Page opens on Documents, so the Memory tab's review badge shows after the tab has loaded (same as every `?tab=documents` visit
   before). The memory notice on Home carries `?tab=memory` already.
6. The old-export stamp fix reads the browser's clock (placeholder) against the server's (job): 30 s of slack; with a larger skew a
   job made this turn is simply attached after the next load, as before.

## Hand-off (what the next agents build on)
- `client/downloads.ts`: `downloadProducedFile(start, deps?)` → `{ ok: true, filename } | { ok: false, reason }`; reasons: the server's
  own (`source_too_large`, `no_conversation`, `conversation_required`, …) or `job_failed`, `timeout`, `no_file`, `session_ended`, `failed`.
- `client/api/file-production.ts`: `fetchFileProductionJob`, `waitForFileProductionJob`; `client/api/artifacts.ts`:
  `EXPORT_ARTIFACT_DOCUMENT_FORMATS` (+ the type), `exportArtifactDocument`, `downloadAppAsHtml` (now typed with the job DTO).
- `components/artifacts/document/download-failures.ts`: `exportFailureOf`, `exportFailureKey`; `DownloadSheet.svelte` takes
  `kind: "document" | "app"` (test ids `document-download-popover` / `app-download-popover`).
- Server: `ARTIFACT_EXPORT_JOB_ORIGIN`, `submitFileProductionIntake({ origin })`, `getFileProductionJobForUser`,
  `GET /api/chat/files/jobs/[id]`.
- Knowledge: `DocumentsList.svelte` prop `onDownloadArtifact(document, format)`; the page's `handleArtifactDownload`;
  `knowledge/store/documents.ts` `applyGeneratedFileSizes`.
- Tests: `tests/e2e/artifact-download-helpers.ts` (seeds a Document / App / the App's succeeded job, `cleanUpConversation`).
- Panel owners (FB-3/FB-5): nothing of `DocumentWorkspace.svelte`'s shell or header was touched; the header's Download button still
  calls `bodyPanelActions.openDownload`, which AppBody now points at the popover.

### The download path for the Opus look
`src/routes/api/artifacts/[id]/export/+server.ts` and `…/app/download/+server.ts` (scope: `getArtifact({ userId, artifactId,
conversationId })`, the server reads the body, `origin` set here) → `src/lib/server/services/file-production/intake.ts` (`origin`) →
`read-model.ts` (`getFileProductionJobForUser`, the `ne(origin, …)` filters) → `src/routes/api/chat/files/jobs/[id]/+server.ts`
(new, `requireAuth`, user-scoped, 404 for a foreign id) → the unchanged canonical `src/routes/api/chat/files/[id]/download/+server.ts`
→ `services/generated-file-serving.ts` (`resolveGeneratedFileServing`: user-scoped; a reply-less file is served only if a succeeded job
made it). Client: `client/downloads.ts`, `client/api/file-production.ts`, `DownloadSheet.svelte`.
