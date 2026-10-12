# RV-B: Opus review of the friction build's ownership, file serving, App sandbox and transactions (report only)

Model: Claude Opus 5.5 (`claude-opus-5-5`). Worktree `.claude/worktrees/rv-b`, detached at `03882bd00` (feat/artifacts,
FB-1 `fc385e1e^..d71d11d4`, FB-2 `7be9d42a..701898bf`, FB-8 `e239a217d^..a5005dd35` merged). Nothing was changed.

**Verdict: ready for `dev`.** Critical 0, Important 0, Minor 4, plus 1 note that needs no action.

I read the four areas by range, in the brief's order, and ran the seams' own tests once (`write-lock`,
`read-model.job-state`, `file-production/index`, the export and App-download route tests, `versions`, `app/regenerate`):
7 files, 148 tests, all passing.

## What holds (checked, no finding)

**1. Downloads and export jobs**
- **No path reaches another user's job or file.** The export key's unique index is on
  `(user_id, conversation_id, idempotency_key)` (`schema.ts:1723-1727`). Every lookup (`findIdempotentFileProductionJob`,
  `getFileProductionJobForUser`, the cancel and retry routes, `resolveGeneratedFileServing`) filters on the caller's
  `userId`. The job's files are read through its own conversation and filtered on `file.userId` again
  (`read-model.ts:612-619`). The export routes read the body on the server through the ownership scope
  (`getArtifact({userId, artifactId, conversationId})`) and make the job under `artifact.conversationId`, never under a
  conversation the client names.
- **A foreign id gets the same answer as a missing one.** The export routes give 404 `{ok:false,reason:"not_found"}`
  for a missing id, a foreign id, or another kind's id. The format check comes before the read but says nothing about
  the id. The job route gives a byte-identical 404 after one query in both cases, and so does cancel.
- **A client cannot set `origin` or `reuse`.** They are separate arguments of `submitFileProductionIntake`, set only by
  the two export routes. The produce route and `produce_file` pass neither (`produce/+server.ts:98`,
  `normal-chat-tools/index.ts:1470`), and `normalizeFileProductionIntake` never reads them from a body.
- **The end-of-turn stamp never puts an export on a reply.** The server assigns only jobs absent from the turn's start
  snapshot. Both lists come from `listConversationFileProductionJobs`, which drops `origin = artifact_export`
  (`read-model.ts:512`), and the assignment needs `assistant_message_id IS NULL` (`job-ledger.ts:1496-1501`). So an
  export pressed in the middle of a turn is in neither list.
  - The client stamp is optimistic and never persisted. It runs before the `finalize` list event (the placeholder is
    still streaming, so `createdSince` is set), and only while the turn's conversation is the open one
    (`normal-chat-client-turn-runtime.ts:786-799`). It only ever sees non-export jobs.
  - Export files are not given memory sync (no reply), not backfilled as legacy jobs (no `assistantMessageId`), and not
    listed or made durable (`artifactExport`). The storage adapter does receive `origin`: `currentJobRow` is the full row.
- **A reply-less export file is served only when a succeeded job of the same user and conversation made it.** The
  HTML `standard-report` CSP is for `document_source` jobs only, so the App's `.html` (a `program` job) gets the
  restricted CSP on `/preview`. Library HTML previews are `srcdoc` frames with no `allow-same-origin`.
- **A reused file cannot be another user's, and cannot be stale about the item's words.** The key is
  `artifact-export:<id>:<format>:<sha256(title \0 body)>` (`export.ts:282-296`). A coalesced save changes it.
  - Restoring identical words maps to identical output.
  - An App's downloaded `.html` carries no `artifact_kv` data, so "today's data" cannot go stale in it.
  - Deleting the chat file cascades the link (`foreign_keys = ON`), so `isUsableFileProductionJob` lets go of the key.
  - Two presses racing a release cannot fork: the second insert hits the unique index and is handed the winner
    (`job-ledger.ts:278-293`).
  - Pre-FB-8 exports used `randomUUID()` keys, so nothing old collides with the new key.

**2. The App edited from the chat**
- **Every App body writer is audited.** There are exactly four: `createAppFromBrief` and `regenerateApp` (both through
  `generateAndVerifyApp`), `restoreVersion`, and the body route (`appViolations`). `applyArtifactOps` has no App branch,
  and the patch and ops paths are dispatched by kind.
- **What the rebuild writes is always audited HTML.** `regenerateApp` writes only `outcome.value.html`, which is either
  the generation that passed `auditAppHtml` (a violation is retried once, then refused) or a repair that passed
  `appViolations` (`generate-and-verify.ts:97-101`). The stored HTML sent back as context, and the model-written
  `instruction`, can only influence text that goes through the same audit and then runs in the same sandbox. That is no
  new privilege.
- **The version summary cannot pose as a restore.** It is prefixed (`regeneratedAppSummary`) and authored `alfy`, so it
  can never parse as a restore for Undo or join an "Edited" burst.
- **Ownership follows the turn's conversation.** `runEditArtifactTool` refuses any `record.conversationId` other than
  the turn's (`edit.ts:730`). That refusal covers:
  - a fork naming its parent's App;
  - a normal chat naming an incognito App;
  - another user's id;
  - a project-linked App.

  An incognito chat edits its own App with its own `conversationId`.
- **The version guard is enough for Apps.** `expectVersion` is checked inside the write's transaction. App bodies never
  coalesce through the UI (the panel has no App body editor), so the number alone is a sufficient guard here.
- **The cap and the timeout hold.** The per-turn cap is one `{used}` object per tool pack, and the streaming fallback
  reuses the same pack (`streaming-normal-chat-model-run.ts:138,181,202`). The timeout row is 120 s
  (`shared.ts:244`). Abort is checked before generation and again before the write.

**3. The restore guard and the App restore**
- **The hash guard compares like with like.** It is checked inside the write's own transaction against the newest
  row's `bodyHash`, which is exactly what History sends as `newestHash` (`history.ts:194`, `record.ts:273-279`).
- **Every client restore sends a guard.** History sends `{expectVersion, expectHash}`. The toast's Undo and the App
  rebuild's Undo send `{expectVersion, undoOf}`. Undo's number-only guard is enough because neither an Alfy row nor a
  "Restored vN" row can be coalesced into.
- **The App restore writes what it audited.** `restoreVersion` audits the version body (`appViolations`) and writes that
  same string. The runnable probe (the saved-version route) uses the same `appViolations`, so the probe and the restore
  cannot disagree. `appMetadataAfterRestore` writes only `{glitchRuleIds, verification: null}`.

**4. The write lock and the key release**
- **`takeWriteLockAtBegin` is correct for this app:**
  - Drizzle's `client.transaction(fn)[behavior ?? "deferred"]` now begins `IMMEDIATE`, and `exclusive` is kept.
  - Nested calls are still savepoints: better-sqlite3 checks `inTransaction` before the variant matters.
  - Applying it twice (the e2e preload plus the app's own) composes.
- **There is no in-process deadlock or starvation.** The app has one connection (no other `new Database(` in `src`,
  no worker threads), and every transaction is synchronous, so nothing holds the lock across an `await`. The stream's
  writes could never interleave with a running transaction anyway.
- **What does change: read-only transactions now take the write lock.** The only effect is that another process's
  writer waits up to its own busy timeout. The deploy-time backup is a reader, and the production start is one
  `node build`.
- **The lock strengthens every check-then-write guard.** The guard's read happens after the lock is taken, and no
  write can skip its guard.
- **A released key cannot hand over an old job.** It is renamed `…#superseded:<jobId>` on that job's own row only, and
  the next press makes a fresh job.

## Findings

### Minor 1: the export key ignores the code that makes the file, so a reused file outlives a renderer fix
`src/lib/server/services/artifacts/export.ts:282-296`; `src/lib/server/services/file-production/job-ledger.ts:227-238`.

**What happens.**
- The key is the item's id, the format and a hash of its title and body.
- A `succeeded` job with a linked file is handed back for as long as that file exists, and nothing ages it out.
- After a deploy that changes how an export is built or rendered, every unchanged Document or App keeps downloading the
  file the old code made, indefinitely. Examples of such a change:
  - the report renderers' ASCII-slug file names (FB-1's concern 3), if they are ever fixed;
  - a PDF layout fix;
  - a change to the export route's Markdown assembly;
  - a change to the sandbox program.

**How to see it.** Export a Document's PDF. Change the renderer, deploy, and press PDF again without editing: the
response is the old job and the old file (`reused`, same `/api/chat/files/<id>/download`).

**A related edge on the same key.** The intake's failure paths (`intake.ts:701,744` →
`createFailedFileProductionJob`, `job-ledger.ts:297-310`) ignore `reuse: "usable"`. They hand back whatever job holds the
key, never release it, and a static limit or schema rule that changes does not change the key. This only bites when
config or code changes, since unchanged content gives the same verdict.

**Fix.** Add a small `ARTIFACT_EXPORT_FORMAT_VERSION` (bumped with renderer or export-builder changes) to the key, or
reuse only jobs made since this build or within N hours.

### Minor 2: two presses that share a job can cancel each other
`src/lib/client/downloads.ts:227-230` with `job-ledger.ts:256-276`.

**What happens.**
- With `reuse: "usable"`, two presses of the same item and format within the wait are handed the same `queued` or
  `running` job id. That happens with two tabs, or with press → Escape (the download carries on) → press again.
- When the first press's 60 s wait runs out, `downloadProducedFile` cancels `started.job.id`.
- The second press, started later, then reads `cancelled` and reports `job_failed` (a toast since FB-8 (d)).
- Before FB-8 each press had its own job, so one press could not fail another.

**How likely.** Rare in practice, since a PDF renders in well under a second. The realistic case is an App `.html` on a
cold sandbox image.

**Fix.** Cancel only a job this press created. The Document route does not return `reused` today
(`export/+server.ts:133`); the App route does.

### Minor 3: an accepted repair ships with the generated draft's glitch hints
`src/lib/server/services/artifacts/app/generate-and-verify.ts:101-104`.

**What happens.**
- `finalHtml` is the verifier's repair when one was accepted, but `glitchRuleIds = glitchRuleIdsOf(generation.checks)`
  is the audit of the generated draft.
- So a created or rebuilt App whose repair is live can show card hints about code that is no longer there, and can
  miss a glitch (`alert`, `eval`) the repair introduced.
- This predates FB-8. But FB-8 made the other writer of the same field compute it from the live body
  (`appMetadataAfterRestore`, `versions.ts:156-161`), so the two writers now disagree.

**How to see it.** A verifier repair that adds or removes an `alert(` call. The stored `metadata.glitchRuleIds` still
reflects the draft.

**Fix.** `glitchRuleIdsOf(auditAppHtml(finalHtml))`.

### Minor 4: the new job route uses `requireAuth` (redirect) instead of the API helper
`src/routes/api/chat/files/jobs/[id]/+server.ts:13`.

**What happens.**
- `requireAuth(event)` is called uncaught: on a session-less call it throws a 302 to `/login`, so the `if (!user)` 401
  branch below it is dead code.
- Its siblings (download, preview) catch the redirect, and ruling 39's helper for JSON routes is `requireApiUser`.

**Why it does nothing today.** `hooks.server.ts` answers every session-less `/api/` request with a 401 before any
handler runs.

**Fix.** Use `requireApiUser`, or match the siblings' try/catch.

### Note (no action needed): an incognito chat's export job and file open by id without naming the conversation
**What happens.** `GET /api/chat/files/jobs/[id]` and the canonical download/preview answer the owner for an incognito
chat's export job or file without `?conversationId=`. The artifact routes require it (ruling 51).

**Why it is not a leak.**
- The ids are unguessable.
- They are handed only to the press that started the job.
- The caller is the same user.
- No list reaches them: exports are excluded from the chat's jobs, the prompt's job states, the Knowledge library and
  memory.

This matches the chat-files family's existing contract. Record it only if the owner wants ruling 51 to cover files as
well.

## The one thing to know
The new paths have no ownership, sandbox or transaction hole. Everything I found is Minor. The one with a product
consequence is Minor 1: a reused export is keyed only by the item's words, so after a deploy that fixes a renderer, an
unchanged Document or App keeps handing out the old file until its words change. One version constant in
`artifactExportIdempotencyKey` closes it.
