# FU-1 report: `@Alfy` on a board never overwrites newer words; every Delete takes a board's posters

Agent FU-1, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-fu1`, branch `fix/artifacts-w4-canvas-gaps` (from
`feat/artifacts` e03557be). Commits (oldest first, base `e03557be`):

| commit | what |
|---|---|
| `70efacc9` | N8: the board's `@Alfy` reply judges its ops against the body it showed the model (`stale`), tests, the Document's path pinned |
| `ec28b649` | the library's Delete takes a deleted board's poster files through the same function as the panel's, tests, Playwright, AGENTS.md |
| `ec550407` | the library's pre-read goes through the store's own visibility scope; one describe appended to the containment suite |

Step 3 (the live-check script) is outside the repo and has no commit; see below.

## Step 1 · N8: `@Alfy` on a board and the reader's newer words

**What was wrong.** `runCanvasAlfyReply` read the board, asked the model, and applied the ops through `applyArtifactOps` with
no read at all, so every op was judged against the board as it was seconds later and a note the reader had changed meanwhile
was overwritten.

**What changed.**
- `services/artifacts/ops.ts`: `OpsEnvelopeInput.readBody?: string` (in-process only, like `readVersionId`). When given it is
  the board as the author read it and it is judged exactly as the body of `readVersionId` is (`runOps`' `readDoc`, so
  `update_node`, `move` and `remove_node` on a block that differs since are refused `stale` and the rest of the batch lands).
  `readBody` wins over `readVersionId`.
- `services/artifacts/canvas-comments.ts`: `apply(ops, readBody)` passes `artifact.body`, the body of the very read the model
  was shown (each attempt reads afresh, so the one correction after a refusal shows the model the reader's words).
- The reply already named a skipped op in the reader's language (`withSkippedOps` marker, `CommentCard.svelte`, the
  `artifacts.canvas.refusal.stale` label exists in English and Hungarian): the skipped entry now carries `reason: "stale"`.
  A `CommentCard` test pins the line in both languages.
- When every op is stale the existing "one correction" path takes over: the model gets the tool's own `stale` text and the
  board it is now shown carries the reader's words (test: it answers without overwriting, or, having seen them, may change
  the note).

**Deviation from the brief, with the reason: the body, not the version id.** The brief says "pass the version it read". I did
that first in my head and then found it cannot work for the commonest case: `updateArtifactBody` **coalesces the reader's own
saves into their newest version** (ruling 47, `ARTIFACT_USER_VERSION_COALESCE_MS` = 10 minutes, the body route does it by
default), writing the new body INTO the existing `artifact_versions` row. If the version the model read is the reader's own
(the usual state of a board someone is editing), a later save of theirs keeps the id and changes the body; `applyArtifactOps`
then sees `readVersionId === newest.id`, loads nothing, and judges nothing. **I proved it with a scratch probe** (not
committed, removed): a board whose newest version is the reader's own, the model "reads" that version, the reader's autosave is
written into it (same id, newer words), then `applyArtifactOps({ readVersionId: <that id> })` with an `update_node` on the
note answers `applied 1, refused 0` and the reader's "Museum, 16:30" is overwritten. So the comment path passes the body it
read. Both the plain case and the coalesced one are tests, red on the unfixed tree, green now.

**Not fixed, flagged (decision for you): `edit_artifact` has the same hole.** The tool path's `lastKnownBoardVersion` /
`readVersionId` (ruling 67, RV-3 I6) names a version row, so a reader's save that coalesces into the version the model read is
not caught there either. The probe that proved I6 (RC-3) used a non-coalescing save. The fix is not mine to size: the tool's
read result carries only an id. A proper fix reuses the Document's mechanism (a per-node hash snapshot written at the read, in
`artifact_kv`, compared at the apply), which is immune to versions; or `read_artifact` could stop later saves from coalescing
into the version it read. Say if you want it as a follow-up.

**The Document's `@Alfy` path: it already had the protection, no change.** `runAlfyCommentReply` (Document branch) reads
through `readDocumentForAlfy`, which writes a per-block hash snapshot in the same transaction as the read; each op it sends
carries `baseHash: block.hash` from that read, and `applyDocumentPatch` refuses `block_changed` unless the snapshot hash, the
block's hash when the patch lands and the op's `baseHash` all agree (`shared/artifact-document/patch.ts`). Hashes belong to
blocks, not version rows, so coalescing does not matter. There was no test at the comment-reply level, so one is added
(`comments.test.ts`): the reader's own save is the newest version when Alfy reads, and a second save made while the model
answers is written into it; the reply is refused, the reader's words stay, Alfy writes no version. I mutation-checked it (with
the guard disabled in `patch.ts` the test fails; the file is restored).

**Tests added** (all three red-first where they could be):
- `canvas-comments.test.ts` +5 (describe "the reader's newer words"): a note changed while the model answers is left alone
  and named, the rest applies (red); the same when the reader's save is written into the version read (red); every op stale
  → a correction that re-reads the board (red); an op on the note once the model has seen the reader's words applies (red);
  a change to another block does not hold the edit up (green control).
- `ops.test.ts` +2: `readBody` refuses what changed even when the version read is still the newest; `readBody` beats
  `readVersionId`.
- `comments.test.ts` +1 (the Document, above). `CommentCard.test.ts` +1 (`stale` in English and Hungarian).

## Step 2 · every Delete takes a board's posters

**What was wrong.** Knowledge → Documents' Delete (`DELETE /api/knowledge/[id]` → `deleteArtifactForUser` →
`hardDeleteArtifactsForUser`) deleted the board's rows and left its poster files (chat files that hang from no reply) until
the chat went, while the panel's `deleteArtifact` took them.

**How the two Deletes now share one cascade.**
- `record.ts`: the inline poster block of `deleteArtifact` moved, unchanged in behaviour, into one exported function,
  `deleteFilesOfDeletedBoard(row)` (board with a conversation → `deleteBoardPosters`; a failure is a `[ARTIFACTS]` warning and
  never undoes the delete). `deleteArtifact` calls it. The rule itself is still only `canvas-posters.ts` /
  `shared/artifacts/poster-file.ts` (`isPosterOfBoard`): own chat, own user, hangs from no reply, named for this board.
- NEW `artifacts/library-delete.ts`, facade export `deleteLibraryArtifact(userId, artifactId)`: reads the family row (through
  the knowledge store's own visibility condition and ownership scope), calls the store's `deleteArtifactForUser` **unchanged**
  and returns its answer **unchanged** (so who may delete, the foreign keys, the source → normalized expansion, the 404 body and
  the wire are exactly as before), then calls `deleteFilesOfDeletedBoard(row)` only when the store's own answer says that board
  was deleted. Ownership stays the store's.
- The route calls `deleteLibraryArtifact`; its unit test mocks that instead.
- **Why in the artifacts facade and not in the store.** A store → chat-files call is a circular import (`chat-files.ts`
  dynamically imports the knowledge facade, and Fallow counts dynamic imports: a static check showed
  `canvas-posters → chat-files → knowledge → store → cleanup`). Fallow stays 124 issues / 4 cycles.

**Tests added.**
- Playwright `tests/e2e/artifact-library-delete.spec.ts` (real clicks: library row Delete → confirm dialog, no callbacks): a
  board is seeded with its posters sent through the app's own `POST /api/artifacts/[id]/exports/png`; after the click the row is
  gone and so are the poster rows, the bytes on disk and what `/api/chat/files/[id]/preview` serves (404); another board's
  poster is untouched. **Red on the unfixed tree** (the row left the list, the poster stayed), green after.
- `library-delete.test.ts` (6, real in-memory database): the posters of the board go and another board's, the exported
  picture on a reply, a file that hangs from a reply and a stranger's file of the same name stay; the library's answer equals
  the store's; **the panel's Delete and the library's leave exactly the same files**; another user's board and a missing id
  take nothing; a failing poster never fails the delete; a Document id has no posters taken; a stranded board (no chat) is
  still deleted by the library as before. Mutation-checked.
- Containment suite: one describe appended (`incognito-artifact-containment.test.ts`): an incognito chat's board is reached by
  the library's delete, its own posters go, a same-named file in another chat of the same user and another board's poster stay,
  a stranger's delete takes nothing.
- The panel path's own poster tests (`record.test.ts`) pass untouched.

**Not covered, said in AGENTS.md (decision for you).** Two more flows hard-delete board rows through the store's
`hardDeleteArtifactsForUser` while the chats stay, so they still leave posters until the chat goes: the Knowledge page's
"forget everything" (`resetKnowledgeBaseState`) and Clear Memory and Knowledge (`clearMemoryAndKnowledgeForUser`). The same
pattern covers them (a multi-id `hardDeleteLibraryArtifacts` beside `deleteLibraryArtifact`, two call sites, their mocked
tests updated); I did not, because the brief names the two Deletes and it widens a destructive flow. Both can import the
artifacts facade without a cycle (checked on the value-import graph). The library path also still leaves the board's semantic
embedding to the maintenance sweep (the panel deletes it at once): unchanged, out of the brief.

## Step 3 · the live-check script (`~/.cache/alfyai-artifacts/live-checks/`, not in the repo)

**The brief's diagnosis was close but not exact, and I did not follow it literally.** `GET /api/artifacts/[id]` does carry
`comments`: `{ ok, artifact, versions, comments }`, the same read the panel uses. What it carries is the board's **root threads
with each reply nested under `replies`** (`listComments`), not a flat list. There is **no `GET` on the comments route** (it only
has `POST`), so there is nothing to point the script at. The script filtered the "flat" list for `parentId === commentId`, which
never finds Alfy's nested reply: `alfyReplies.length >= 1` was false while the product did everything.

**Proved with the self-test, red first.** The self-test's fake server returned a flat list, so it had been blind to this. I made
the fake answer the real shape (`threadsOf`: roots with `replies`), and the **original script then failed `alfy-comment` in
`good` mode** (the live failure, reproduced offline: "HTTP 200 outcome=applied ... reply: ..." and FAIL). I then fixed
`scenarioAlfyComment` (`root = after.comments.find(...)`, `alfyReplies = root.replies.filter(author === "alfy")`). Result:
`good` 5/5; `noreply` still FAILs alfy-comment (a missing reply is still caught); `outside`, `versions`, `refusal`, `english`,
`leak` each FAIL their own scenario; `ONLY=sizes` `good` passes and `smallchart` fails. Backups of the originals are beside this
report (`fu1/verify-canvas-w3.mjs.orig`, `fu1/verify-canvas-w3.selftest.mjs.orig`). Not run live (no ssh to the box here).

## Gates (once, at the end)

| gate | result |
|---|---|
| `npm run check` | 8380 files, **0 errors, 17 warnings** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1: the baseline) |
| `npx biome check src scripts tests` | clean (2488 files) |
| `npm test` | **1017 files passed + 1 skipped; 16,657 tests passed, 2 skipped** |
| `npm run build` | exit 0; **32 `Unused CSS selector` + 2 `must have an ARIA role`** (the baseline); `check:worker-assets` OK |
| `npm run check:artifact-chunks` (own step) | **exit 1, and the same on the untouched base commit.** Editor closure 69.9 kB gzip (ceiling 71,680 B) fine; **chat route first load 541,774 B vs baseline 539,608 + 2,048 allowed = 541,656: 118 B over.** On `e03557be` built in this same worktree it is 541,775 B (119 B over), so it is not this change (server-only code); it is the baseline vs. this machine/worktree build, the thing ruling notes call environment drift. I did not touch the baseline. |
| Playwright (every artifact suite + knowledge + chat + conversation, port 5460) | E2E_PLACEHOLDER |
| `npx fallow ...` | **124 issues, 4 circular** (the baseline; no new finding, unused export or cycle) |
| `npm run check:migrations` | passes |

## Hand-off / what the next agent builds on

- `OpsEnvelopeInput.readBody` (`artifacts/ops.ts`): any in-process caller that holds the body its author read can get ruling 67
  without a version id. The tool path still uses `readVersionId` (see the coalescing hole above).
- `deleteFilesOfDeletedBoard(row)` (`artifacts/record.ts`): the one place "what a deleted board leaves outside the database" is
  taken; a new leftover goes there. `deleteLibraryArtifact` (`artifacts/library-delete.ts`, facade): the library's delete; a
  multi-id sibling would cover "forget everything" and Clear Memory and Knowledge.
- `tests/e2e/artifact-library-delete.spec.ts`: how to seed a board and its posters through the real route and read rows, bytes
  and the serving route; keep it.
- AGENTS.md, Artifacts: the Delete paragraph and the Canvas "Alfy never overwrites" paragraph say the above.
