# Workspace Search revival (2026-11-23)

Status: design. The owner asked for it on 23 November 2026 as an extension of the Memory redesign (`2026-11-22-memory-redesign-design.md`), skipped the questions ("just propose it") and approved the mockups in `docs/design/workspace-search/`. Not built. Everything not quoted from the owner is marked as my call in "Calls I made".

## Why

The owner: "The Workspace Search has been falling behind a bit functionally. I'd like it brought back to life, so Memories are searchable, making sure it can search ALL types of artifacts and files we create on AlfyAI, and the 'Connections' pill removed because we will probably never index any of the connections."

What a read of the code found (23 November 2026, `workspace-search.ts`, `SearchModal.svelte`, `search-scopes.ts`):

- **Memory is not searchable at all.** Native Memory entries exist only on the Memory page, which has no link to a single entry.
- **Pictures, videos and apps are found by title only.** A picture's prompt, a video's prompt and the text on a canvas are never searched. Video and canvas bodies are matched as raw JSON instead, so "nodes" or "fileid" finds them, with a JSON snippet. Uploaded pictures' descriptions are not searched. Videos have no icon.
- **The chips count only what was loaded,** at most six chats and six documents, so a chip can read 0 while matches exist. "Reports" holds every generated file, not research reports. "Documents" holds pictures, videos and apps. "Connections" is a permanently greyed placeholder.
- **The query is one literal phrase.** "kitchen plan" does not find "plan for the kitchen".
- **Hungarian capitals do not fold.** SQLite's `lower()` and `LIKE` fold ASCII only, so "árvíz" probably misses "Árvíztűrő". Typing without accents finds nothing accented.
- **Slow paths:** every keystroke scans all of the person's message bodies without a limit and returns them in full; documents load one by one; the empty-query view reads the whole library.
- **A broken link:** "View all documents in Knowledge" writes `?query=`, while the Knowledge page reads `?q=`.

## What the owner decided

- Memory entries are searchable.
- Every kind of artifact and file AlfyAI creates is searchable.
- The "Connections" chip is removed; connections will not be indexed.
- The approved look is the four mockups in `docs/design/workspace-search/`: chips All, Chats, Memory, Documents, Pictures & videos and Apps with real counts; up to three results per kind under "All", with a "Show all" link; memory rows with their scope and when they were last said; picture and video rows with thumbnails; badges for each kind of thing.

## Goals

- A person finds anything they made or kept in AlfyAI by words they remember from it, in English or Hungarian, typed with or without accents, in any order.
- Every result opens where the thing lives, a memory entry included.
- Chip counts are true.
- Search stays quick while the person types, however large their history grows.

## Non-goals

- Searching connections (mail, calendar, photos), the web, settings or admin records.
- Searching by meaning (embeddings, a reranker). Search stays lexical: it finds words that are there (`CONTEXT.md`, "Lexical Workspace Search").
- Raw memory internals: facts, sources, earlier-state notes and older versions are not searched, only the entries the Memory page shows.

## Anti-goals

- Anything that a person cannot open showing up: a deleted chat, another person's material, an incognito chat's artifacts, a memory entry the Memory page hides, a project they do not own.
- A memory result for someone whose Memory is switched off.
- A search that blocks typing, or one that reads every message on each keystroke.
- An index that can fall out of step with what it indexes without anyone noticing.

## Constraints

- Search stays server-backed (ADR-0034): the route is an adapter, `services/workspace-search.ts` owns matching, ranking, limits and snippets.
- Memory is read through native Memory's UI read contract (`memory-profile/native-read.ts`) and its visibility rules, never through recall.
- All UI words in English and Hungarian; the Feature Guide entry for search and `CONTEXT.md` change in the same change (root `AGENTS.md`).
- The database changes only through migrations (`npm run db:prepare`); no runtime schema mutation. Production steps need the owner's word.
- Synthetic data only in tests.

## The design

### 1. What can be found, and where it opens

| Kind | Chip | Badge | Matched on | Opens |
|---|---|---|---|---|
| Chat (imported ones included) | Chats | none | title, project name, message text (both roles) | the chat, at the matching message |
| Memory entry (native accounts) | Memory | none | the entry's text as the Memory page shows it | the entry in Knowledge > Memory |
| Document, Slides, Canvas | Documents | Document, Slides, Canvas | name; a Document's and a Slides' text; a canvas's block text | as today (Knowledge hand-off) |
| Uploaded file (not a picture or video) | Documents | Uploaded | name, extracted text | as today |
| Generated file | Documents | Generated | name, label, its text | as today, with the source-chat button |
| Research report (Atlas) | Documents | Report | name, its text | as today |
| Skill Note | Documents | Skill Note | name, text | as today |
| Picture (made or uploaded) | Pictures & videos | Image | title, the prompt it was made from, what Alfy saw in an uploaded one (`image_descriptions`) | as today |
| Video | Pictures & videos | Video | title, the prompt (kept on the job that made it) | as today |
| App | Apps | App | name, summary (never its code) | as today |

### 2. Chips, counts and paging

- Chips: All, Chats, Memory, Documents, Pictures & videos, Apps; "Connections" and "Reports" are gone (a report is a badge under Documents).
- Every chip shows the true number of matches of its kind, counted up to 100 and shown as "99+" above that.
- "All" shows up to three results per kind, in the order Chats, Memory, Documents, Pictures & videos, Apps, each section ending in "Show all N" when there are more. A chip shows up to 20 results of its kind, with "Load more".
- On a phone the chip row scrolls sideways and the chosen chip scrolls into view.
- The empty-query view (fewer than two characters) keeps today's three recent chats and three recent documents.

### 3. Rows

- A chat row, a document row and the keyboard behaviour stay as today.
- A memory row shows the entry's text (two lines), then its scope ("Personal" or the project's name) and when it was last said, from its newest source date (the rule of Memory redesign part 1).
- A picture row shows its thumbnail (`imagePreview`, as the Knowledge list does). A video row shows the still it was made from when it has one, otherwise a film tile.
- Every row's matched words are highlighted, whichever order they were typed in.

### 4. Matching

- The query is split into words; a result must contain every word, in any order, inside longer words too ("ajánlat" finds "szállásajánlatok"). Different words may sit in different matched fields of the same item, and, for a chat, in its title, its project's name or different messages.
- Case and accents are folded on both sides, so "arviz", "árvíz" and "ÁRVÍZ" find "Árvíztűrő" (long text gets full accent folding in Stage B; see 6).
- The query needs at least two characters, as today; at most eight words count; a query with no words once punctuation is trimmed shows the empty-query view.
- Kind badges reuse the app's own words (`artifacts.type.*`: Image, Video, Slides, Canvas, which is "Tábla" in Hungarian; the search's own Uploaded, Generated and Skill note), and a report's job id is never matched.
- A JSON body is read through its own reader (picture and video prompts, canvas block text) and never matched as raw JSON; an App's code is never searched.
- Ranking keeps today's field weights (a title or name above a summary above body text) and breaks ties by recency.

### 5. Memory results

- Only for an account on native Memory with Memory switched on; searched across the personal bank and every project bank the person owns, using the same visibility rules as the Memory page (an entry shows only when the page would show it).
- A memory result opens `/knowledge?tab=memory&memoryScope=<personal|project:id>&memoryEntry=<rowId>&memoryQuery=<query>` (the page's `q` would turn it to Documents). The Memory view opens that entry's detail, finding it past the first page of 50; if the entry has changed since (a new generation without that row), it opens the scope's list with the search filled in. The address is then replaced with `?tab=memory`.
- A bank that cannot be read (retired, blocked, a stale generation) is skipped, so one bad bank never hides the rest. The Memory page's own search uses the same matcher, so the filled-in list finds what search found.
- Legacy-authority accounts get no memory results (after the Memory redesign's part 5 there are none).

### 6. The engine, in two stages

**Stage A (no database change).** Short fields (chat titles, project names, document names, labels and summaries, memory entries, picture descriptions, prompts and canvas text) are matched in the server with the folding above. Message and document bodies keep SQL `LIKE` candidate selection with a hard cap, one clause per word with its typed, lower-case, capitalised and upper-case spellings, so accented capitals match; the candidates are then checked with the folding above. In Stage A, typing without accents finds titles, names and memory but not body text.

**Stage B (a full-text index), in its own plan.** SQLite FTS5 tables with the trigram tokenizer and diacritics removed (`tokenize="trigram remove_diacritics 1"`), over messages and over the artifacts that hold text, kept in step by triggers so no writer changes. Trigram keeps today's anywhere-in-the-word matching, which Hungarian compounds need; the word tokenizer (`unicode61 remove_diacritics 2`) is smaller but cannot find "ajánlat" inside "szállásajánlatok". Checked on the bundled SQLite 3.53.2: both tokenizers exist, trigram finds every case above, and the app runs no `VACUUM` while its backups use SQLite's online backup API, which keeps row ids.

Stage B goes ahead only after a count-only measurement of exactly the text it would index on production (owner-approved; a trigram index is roughly three times that text). The owner then chooses trigram, the smaller word tokenizer, or staying on Stage A. The independent review of 23 November found what its plan must handle:

- An external-content table's `'delete'` with values that differ from what was indexed throws `SQLITE_CORRUPT_VTAB`, which would break message edits, chat deletes and account erasure, not only search. Prefer `contentless_delete=1` tables keyed by row id, which delete by row id alone, and repair by refilling from the base tables.
- Index only rows that hold text (never App code or picture, video and canvas JSON), with the same condition on every trigger.
- `INSERT OR REPLACE` skips delete triggers: none on `messages` or `artifacts`. A `"` inside a `MATCH` phrase is doubled. `'optimize'` runs after an account erasure.
- The containment test's table list (`incognito-artifact-containment.test.ts:1960-1976`) and the e2e `wipeUserData` (`e2e-servers.ts:172`) must know the new tables and leave the shadow tables alone; drizzle-kit gets a `tablesFilter`.
- The deploy's `PRAGMA integrity_check` (`deploy-lib.sh:185`) opens FTS5 tables on SQLite 3.44 and later: confirm the box's `sqlite3` has FTS5 and is 3.45 or newer first.
- Migrations here are written by hand (`1777140000139_…`, `when` equal to that number); a generated one would be skipped. Every statement ends with `--> statement-breakpoint`, and the number is agreed with the Memory redesign's own migrations.
- Its speed check uses several users and newest-first ordering by row id.

### 7. Fixes along the way

- The "View all documents in Knowledge" row goes; "Show all" and the chips replace it, and with it the `?query=` link bug.
- Body reads are capped, snippets are cut in the database, documents are loaded in one pass, and the empty-query view no longer reads the whole library.
- Dead strings (`searchModal.currentConversation`, the Connections and Reports keys) go.

## Testing and acceptance

- Matching: the folding, word order, compounds and the two-character rule, in English and Hungarian, as unit tests of the shared matcher.
- Each kind: a synthetic item of every row in the table above is found by its matched fields and not by raw JSON, and opens where the table says.
- Visibility: another person's material, a deleted chat, an incognito chat's artifacts, a hidden memory entry, a project the person does not own and an account with Memory off never show (extend `tests/cross-cutting/incognito-artifact-containment.test.ts` for the new kinds).
- Counts: a chip's number equals the matches of its kind, up to 99+.
- The memory link opens the entry, and the changed-entry fallback opens the filled-in list.
- End to end (`tests/e2e/search-modal.spec.ts`): the chips with no Connections, a memory result opening its entry, a picture row with its thumbnail, on a phone and a desktop, in both languages.
- Stage B: the index follows inserts, edits and deletes after every migration; a search over 50,000 synthetic messages answers within 200 ms on this Mac.

## Calls I made (the owner may change any of them)

1. Chips: All, Chats, Memory, Documents, Pictures & videos, Apps. "Chats" replaces "Conversations" in English (Hungarian keeps "Beszélgetések"). Canvases and Slides sit under Documents; Apps get their own chip; Memory comes second.
2. Reports become a badge under Documents and mean research reports only; badges reuse the app's existing words ("Image", "Generated", "Tábla" for a canvas in Hungarian) rather than new ones.
3. Counts stop at 100 ("99+"); "All" shows three per kind; a chip shows 20 per page.
4. Matching folds case and accents, takes words in any order and finds them inside longer words.
5. Two stages: Stage A ships first; Stage B gets its own plan after the size measurement, trigram as the default tokenizer.
6. Memory results only for native accounts; the link has its own parameter names and leaves the address at `?tab=memory`; a changed entry falls back to the filled-in list; the Memory page's own search adopts the same matcher.
7. The Knowledge overflow row is removed.
8. An uploaded picture sits under Pictures & videos, not Documents.
9. Different words of a query may sit in different fields of one item, and in different messages of one chat.

## Left to the builder

- The exact SQL of the Stage A candidate queries and of the Stage B migration, within the rules above.
- The order of sections within the limits above, and the visual details within the mockups and the app's tokens.
- How the modal's code is split while it changes, within the existing component boundaries.

## Evidence

- Mockups: `docs/design/workspace-search/` (1 desktop All, 2 phone All, 3 phone Memory, 4 phone Pictures & videos).
- Today's code: `src/lib/server/services/workspace-search.ts`, `src/routes/api/workspace-search/+server.ts`, `src/lib/client/api/workspace-search.ts`, `src/lib/components/search/SearchModal.svelte`, `src/lib/components/search/search-scopes.ts`, `src/lib/server/services/knowledge/store/documents.ts`, `src/lib/server/services/memory-profile/native-read.ts`, `src/routes/(app)/knowledge/`.
- Decisions it rests on: ADR-0034 (server-backed search), ADR-0071 (native Memory), `CONTEXT.md` (Workspace Search, Lexical Workspace Search, Eligibility).
