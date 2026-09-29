# Security and data-integrity review: G2-A (Delete, deleted state, Regenerate)

Reviewer: adversarial seat (Opus). Code read at the merged head in `.claude/worktrees/rv-rd` (`924452a7`). This was a report-only review: no product code or test was changed. The four probe tests I wrote were temporary; they were run and then deleted, and the worktree is clean.

**Counts:** Critical 0 · High 0 · Medium 1 · Low 6 · Info 4.
**Verdict:** safe to ship to the dev environment. No cross-user or incognito-content leak was found. Fix M1 before prod, and make an owner decision on L1 and L2.

## What I checked and found sound

- **Cross-user access.**
  - `DELETE /api/artifacts/[id]` resolves the row through `readScopedArtifactRow`. That function applies the canonical ownership condition over the caller's own conversations.
  - `?conversationId=` can only add one of the caller's own incognito chats to the scope. A foreign conversation id is never added (`knowledge/store/core.ts:141-166`).
  - A foreign id, a missing id and an already-deleted id all answer the same `404 {ok:false, reason:"not_found"}`.
  - Artifact regenerate checks `getConversation(userId, id)` before the lock and before any read.
  - File-job regenerate filters on `file_production_jobs.user_id` inside the transaction (`job-ledger.ts:1082-1099`).
  - `listMissingArtifactIds` answers `[]` for a conversation that is not the caller's, and treats out-of-scope ids as missing. It reveals nothing about the rows.
- **The stored source cannot be forged.**
  - `messages.tool_calls` is written only by chat-turn finalize (`createMessage`) and by fork copying. The ChatGPT import writes only `role` and `content`. No route accepts tool calls from the client.
  - A `create_artifact` result's `artifactId` is always a server `randomUUID`, so a user cannot plant a call that names someone else's id.
  - `getStoredCreateArtifactCall` narrows with LIKE and then requires an exact id match on an assistant message of the named conversation.
  - `createArtifact({id})` is a plain insert on the primary key, so a race or a squat throws. It never overwrites.
  - `language` is constrained to en/hu.
- **Abort, timeout and the rulings.**
  - The App regenerate gets `AbortSignal.any([request.signal, timeout(120 s)])`. adapter-node (kit 2.70.3) aborts `request.signal` on client close.
  - `createAppFromBrief` checks the signal before its write (ruling 53) and uses the same generate → verify path (ruling 52).
  - The Document and File paths make no model call.
- **Orphans after a delete.**
  - Every FK to `artifacts` is `ON DELETE CASCADE` (versions, comments, kv, chunks, links, working set, task evidence, project links, extraction jobs).
  - `generated_output` rows carry no `storage_path`.
  - A generated-file readback writes no MinerU bundle (`extractors/mineru4.ts:116,650`).
  - `deleteChatFile` is scoped to the row's own conversation. Its `storage_path` cannot traverse, because the extension is split on dots.
- **Races that are harmless.**
  - Delete during an edit is safe: `updateArtifactBody` re-reads the row inside its transaction, and better-sqlite3 is synchronous, so no other request runs between a read and its transaction.
  - A double Regenerate is safe: Document and App use an in-process lock plus the primary key, and the File path uses a transactional `status='succeeded'` check.
  - Two DELETEs of the same item are safe: the second one gets the same 404.
- **CSRF.** Same posture as the ~20 existing DELETE routes; see I1.

## Findings, most severe first

### M1 (Medium): Regenerate for an item that still exists out of scope never succeeds, and the App path runs the model every time. Every fork of an incognito chat shows the parent's items as "deleted".

**Where:**
- `normal-chat-tools/artifact-tools/recreate.ts:65-89`: only a scoped `getArtifact` is done before the handler runs.
- `artifacts/app/create.ts:73-110`: generation and verification happen before the write.
- `artifacts/record.ts:310-317`: the global `id_taken` check sits inside the write, after all that work.
- `artifacts/read-model.ts:239-270`: out of scope is treated as "missing".
- `conversation-forks.ts:1099,1117`: a fork copies `toolCalls` verbatim and inherits the incognito flag.

**Scenario:**
1. The user forks an incognito chat that made a Document or App. The fork is incognito too, so the parent is outside the fork's scope. The same happens if the user makes the parent of a normal fork incognito later, or when conversation cleanup keeps a family row with a cleared conversation link (`cleanup/conversation-cleanup.ts:86-97` together with `core.ts:219-227`).
2. The fork's detail lists the parent's items in `deletedArtifactIds`. The card says "This document was deleted", which is false.
3. Pressing Regenerate:
   - For a Document, it answers 422 "Could not create the document." every time.
   - For an App, it runs a full generate and verify (up to 120 s of the model, plus `research_web` calls) and then fails with `not_saved` (`id_taken`), which is a 422.
4. The button stays, and the loop has no limit. Before G2-A these cards simply failed to open. G2-A adds the false label and the futile regeneration.

**Evidence** (temporary vitest probes on real migrated SQLite, run and then removed):
- **P1:** the parent is incognito and owns `app-x`; the fork holds the copied call. `listMissingArtifactIds(fork)` returned `["app-x"]`, and the mocked `createAppFromBrief` was called once with `artifactId:"app-x"`.
- **P2:** the same setup for a Document returned `{ok:false, reason:"failed"}`.
- **P4:** in an incognito fork of an incognito chat, `listMissingArtifactIds` returned `["doc-i"]` while the row exists.

No content leaks. Only existence is revealed, and only to the same user.

**Fix direction:**
- In `recreateArtifactFromStoredCall`, after the scoped `getArtifact` misses, check the id globally (`select id from artifacts where id=?`) **before** calling the handler. Answer a distinct refusal (for example 409 `unavailable`) that the card renders like `no_stored_input` ("can't be regenerated here"), never `failed`.
- Preferably, do not offer the deleted state or Regenerate for ids whose create call sits on a fork-copied message (`isAssistantMessageForkCopy` already exists). Label those cards "made in the original chat" instead.
- Add tests for P1, P2 and P4.

### L1 (Low): A fork's panel Delete removes the parent chat's item

**Where:** `artifacts/record.ts:658-672` via `readScopedArtifactRow`. The scope is every non-incognito chat of the user plus the served one.

**Scenario:** a normal fork's card names the parent's Document, because tool calls are copied and family rows are not. The user opens it in the fork's panel and deletes it. The parent conversation's item is gone, and the parent's own card now says "deleted". The tools are pinned to `artifacts.conversationId` (ruling 53), but the panel is not. Produced files, by contrast, are copied per fork, so their deletes stay isolated. Probe P3: `deleteArtifact({conversationId: fork})` returned `true` for a row whose `conversation_id` is the parent.

**Fix direction:** when the delete comes from a chat panel, require `row.conversationId === conversationId` in the service (an option on `deleteArtifact`), and answer the same 404 otherwise. Or keep the behaviour, but say in the confirm that the item belongs to the original chat. Either way, pin the choice in a test.

### L2 (Low, owner decision): "This can't be undone" is contradicted by Regenerate, and the content is retained

**Where:** `i18n/artifacts.ts:111-119` (the confirm copy), `file-production/job-ledger.ts:1082-1099`, `file-production/read-model.ts:563`.

**Scenario:**
- Deleting a File keeps the job's `request_json`, which holds the full document source or the full program. Deleting a Document or App leaves the full body in the chat's stored `create_artifact` input. One click brings either back. So "Delete" removes the item from the panel, but it does not erase the content. A user deleting for privacy is misled by "can't be undone".
- After Clear Memory, which deletes every family row (ruling 42), every Document and App card in every chat becomes a Regenerate offer.

**Fix direction:**
- Change the copy (for example "You can make it again from the chat").
- Optionally offer "delete and forget the request": null the job's `request_json` and mark the call as not regenerable.
- Confirm with the owner that Clear Memory followed by Regenerate is intended.

### L3 (Low): The File-job regenerate route is reachable by job id alone, with no conversation

**Where:** `routes/api/chat/files/jobs/[id]/regenerate/+server.ts:21`.

**Scenario:** an incognito chat's job can be re-queued without naming that chat. AGENTS.md's rule is that incognito items are reachable only with their own `?conversationId=`. This route mirrors its retry, cancel and dismiss siblings, which have the same gap. Job ids are UUIDs that appear only in that chat's detail payload, so practical risk is low.

**Fix direction:** accept (later require) `?conversationId=` and scope the ledger query with it. Do the same for the three siblings in one follow-up.

### L4 (Low): An embedding refresh racing a delete leaves an orphan vector, which Regenerate can re-attach

**Where:** `semantic-embedding-refresh.ts:182-198` and `record.ts` `deleteArtifact`, which deletes embeddings exactly once.

**Scenario:** a save or readback queues a refresh. The refresh awaits a TEI HTTP call (real I/O). A delete lands during that await and removes the row and its vector. The refresh then writes a vector for the deleted id. Because Regenerate reuses the same id, that stale vector attaches to the new item until the next refresh. The maintenance sweep does collect orphans.

**Fix direction:** after the embed call, re-check that the subject row exists and skip the write (or delete the vector) if it does not.

### L5 (Low, pre-existing, now a Regenerate path): "Open as document" is not idempotent under concurrency

**Where:** `routes/api/conversations/[id]/messages/[messageId]/document/+server.ts:57-84`.

**Scenario:** two POSTs arrive (for example from two tabs) after the kept Document was deleted. Both fall through the stale link, and both create a Document. The message links to the last one, and the other is left behind in the panel. The probe produced 2 rows from one message. `MessageBubble.svelte:650-664` guards a double-press within one tab only.

**Fix direction:** add an in-process per-message lock (like `regenerating` in `recreate.ts`), or use a conditional link update and delete the losing Document.

### L6 (Low): App regeneration has no capacity, drain or stop gate

**Where:** `recreate.ts`. The pre-existing `/api/artifacts/[id]/app/regenerate` has the same gap.

**Scenario:**
- App generation outside a turn bypasses `checkStreamCapacity` (the per-user and global limits).
- It also bypasses drain mode (a deploy), so a regeneration can start just before a restart kills it.
- `requestActiveChatStreamsStopForUser` does not stop it.
- The lock is per (conversation, artifact), so N deleted Apps can run N generations and their `research_web` calls in parallel on the shared GPU.

**Fix direction:** add one small per-user in-flight cap for App generation outside turns, shared by both routes, and refuse while draining.

### I1 (Info): CSRF posture unchanged

`svelte.config.js:7` sets `csrf.trustedOrigins: ['*']`, which turns SvelteKit's origin check off app-wide. The session cookie is `SameSite=Lax` (`services/auth.ts:91`), and the app sends no CORS headers.
- The new DELETE needs a CORS preflight, so it cannot be forged cross-site.
- The two POST regenerate routes are "simple" requests. Like every sibling, they rely on Lax cookies and ids an attacker cannot guess.

Nothing new is exposed. Re-enabling the origin check is an app-wide hardening item.

### I2 (Info): Two delete semantics for one item

Deleting a produced File from the panel deletes one `generated_output` version. Deleting the same row from Knowledge deletes the whole `documentFamilyId` family (`knowledge/store/cleanup.ts:268-311`). After a panel delete, an older family version remains and can be resolved as the "current generated document". Align the two or document the difference.

### I3 (Info): Layering

`artifacts/record.ts` imports from `file-production/source-persistence` internals and from `chat-files`. This is not a security issue. Consider routing it through the file-production facade.

### I4 (Info): Legacy Knowledge path

The report's own hand-off note (a): Knowledge's delete of a produced file still leaves the chat-file row. As a result the chat shows the file as deleted only after the next Open probe.

## Test gaps worth adding

- Regenerate for an id that exists out of scope, for both App and Document (M1: P1/P2), and the incognito-fork deleted state (P4).
- Panel Delete from a fork of the parent's item (L1), pinned whichever way it is decided.
- Two concurrent Open-as-document presses (L5).
- File-job regenerate for an incognito chat's job (L3), pinned whichever rule is chosen.
