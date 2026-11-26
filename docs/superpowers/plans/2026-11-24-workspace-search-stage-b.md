# Workspace Search Stage B (the full-text index) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long text (message bodies and the bodies of documents and files) is found through an SQLite FTS5 trigram index, so "arviz", "árvíz", "ÁRVÍZ" and "ÁrVíZ" all find "Árvíztűrő" anywhere in a word, quickly, and Stage A's thirteen deferred minors are fixed or recorded.

**Architecture:** Two contentless-delete FTS5 tables keyed by row id (`messages_fts`, `artifacts_fts`, `tokenize='trigram remove_diacritics 1'`), kept in step by six triggers and filled by migration 145, which runs inside `npm run db:prepare`. The search keeps Stage A's shape (ADR-0034: candidate SQL per kind, confirmation and ranking in the server); only the long-text clause changes: a word of three letters or more is looked up in the index (`rowid IN (SELECT rowid FROM … MATCH …)`), a shorter word keeps Stage A's `LIKE` spellings, because trigram cannot match under three characters. Snippets are still cut in SQL around a typed spelling; when the hit was found only by folding, the server cuts the snippet from the row's text itself. An operator command checks and refills the index; account erasure and the two clears compact it.

**What stays as Stage A left it, and why:** titles, project and document names, labels, summaries, picture and video prompts, canvas words and picture descriptions keep their GLOB classes: they are short, already folded for case and accents, and read only for the person's own rows. Words under three letters keep the `LIKE` spellings: a trigram index cannot match them. Memory entries keep the shared matcher in code (they are not in SQLite).

**Tech Stack:** SQLite 3.53.2 (better-sqlite3 12.11.1; production's CLI 3.46.1 has FTS5), Drizzle 0.x with drizzle-kit 0.31.11, SvelteKit (Svelte 5 runes), Vitest, Playwright, Biome, Fallow 3.33.1.

**Spec:** `docs/superpowers/specs/2026-11-23-workspace-search-revival-design.md` (section 6, "Stage B", and "Testing and acceptance"). Stage A: `docs/superpowers/plans/2026-11-23-workspace-search-revival.md`; its hand-over and deferred minors: the shared notes folder, `workspace-search-stage-a-handover-2026-11-23.md`.

## Global Constraints

- The owner approved Stage B directly ("Do Workspace Search Stage B … work through deferred minor review findings"); trigram is the tokenizer. Production's measurement (counts only, done by the orchestrator): 4,266 messages with text, 4.84 MB; artifacts' `content_text`: `generated_output` 7.43 MB (2,198 rows), `normalized_document` 1.73 MB, `work_capsule` 0.48 MB, `artifact` 0.33 MB, `source_document` summary only; database 329 MB.
- `contentless_delete=1` tables keyed by row id; index only rows that hold text, with the same condition on every trigger; no `INSERT OR REPLACE` on `messages` or `artifacts`; a `"` inside a MATCH phrase is doubled; `'optimize'` after an account erasure; the containment test and the e2e `wipeUserData` know the new tables and leave the shadow tables alone; drizzle-kit gets a `tablesFilter`.
- Migrations are hand-written: `drizzle/1777140000145_workspace_search_index.sql`, journal `when` 1777140000145, idx 157, every statement ending with `--> statement-breakpoint`. `scripts/prepare-db.ts` lists the two tables in `requiredExistingTables`.
- Acceptance: the index follows inserts, edits and deletes after every migration; a search over 50,000 synthetic messages (several users, row ids interleaved by time, newest first) answers within 200 ms on this Mac.
- Synthetic data only. No ssh, no box, no production data. `npm run check` 0 errors and 0 warnings once after the code tasks; a build without warnings; no new Fallow finding (the orchestrator remakes the baseline). Each task runs only its own tests while iterating; one agent gate at the end on port 5200.
- Commits small, each with the trailer `Search-Stage-B-Task: N` then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push or merge. Every new UI string in English and Hungarian.

### Which artifact rows are indexed (decided here)

A row is indexed when its `content_text` is not empty and it is one of: `source_document`, `normalized_document` (an upload's extracted text), `skill_note`, `generated_output` (every generated file: the library's chat files and the rows Stage A's search filters out, because `retrieval_class` and the metadata that tell them apart can change after a write while a row's type never does), or `type = 'artifact'` whose kind (`metadata_json.artifactType`, missing = document) is not `image`, `video`, `canvas` or `app`. Never indexed: App code, picture, video and canvas JSON, `work_capsule` (an internal workflow summary that no search ever returned), and any other type. The index is a candidate selector only: the search's own conditions (kind, ownership, the generated-file rule) still decide what is returned. Messages: every row with non-empty `content`, any role, as Stage A searched them.

## Review Focus

1. **A one- or two-letter word beside longer ones** ("AI kitchen"): the long word goes through the index, the short one through `LIKE`, and they may sit in different messages of one chat. Test: Task 3 "finds a short word and a long word in different messages".
2. **FTS syntax typed as a word** (`o"neil`, `c++`, `not`, `near(`, `-x`, `*`, `^`): always a literal phrase, never a syntax error or an operator. Test: Task 3 "takes query syntax literally".
3. **A later migration that rebuilds `messages` or `artifacts`** (drops the triggers, renumbers row ids): the index would go stale silently. Tests: Task 1 "keeps its triggers after every migration" and "a later migration that rebuilds an indexed table refills the index".
4. **The deploy's migration runs while the old release serves** (its writers wait up to `busy_timeout` 10 s): the fill must take well under that on production's size. Measured in Task 5 on 15 MB of synthetic text over about 7,000 rows; recorded in the hand-over.
5. **Erased text left in the index** (contentless-delete keeps tombstoned entries until a merge): erasure and the two clears compact the index. Test: Task 2 "compaction leaves none of a deleted message's words".

---

### Task 1: The index, its triggers and the fill (migration 145)

**Files:**
- Create: `drizzle/1777140000145_workspace_search_index.sql`
- Modify: `drizzle/meta/_journal.json`, `scripts/prepare-db.ts` (`requiredExistingTables`), `drizzle.config.ts`
- Modify: `tests/e2e/e2e-servers.ts` (`wipeUserData`), `tests/cross-cutting/incognito-artifact-containment.test.ts` (its all-tables scan)
- Test: `src/lib/server/db/workspace-search-index-migration.test.ts`

**Interfaces:**
- Produces the tables `messages_fts(content)` and `artifacts_fts(content_text)` (`content=''`, `contentless_delete=1`, `tokenize='trigram remove_diacritics 1'`), rowid = the base row's rowid, and the triggers `messages_fts_insert`, `messages_fts_update` (`AFTER UPDATE OF content`), `messages_fts_delete`, `artifacts_fts_insert`, `artifacts_fts_update` (`AFTER UPDATE OF content_text, type, metadata_json`), `artifacts_fts_delete`.
- Eligibility, written once per row alias R (`NEW`, `OLD`, the table itself): messages `length(R.content) > 0`; artifacts `length(R.content_text) > 0 AND (R.type IN ('source_document','normalized_document','skill_note','generated_output') OR (R.type = 'artifact' AND coalesce(CASE WHEN json_valid(R.metadata_json) THEN json_extract(R.metadata_json, '$.artifactType') END, 'document') NOT IN ('image','video','canvas','app')))`. Insert triggers fire `WHEN` eligible(NEW); delete triggers `WHEN` eligible(OLD); update triggers fire when the text changed or eligibility flipped (`coalesce(…, 0)` on both sides), delete the old row id when eligible(OLD) and insert the new one when eligible(NEW).

- [ ] **Step 1: Write the failing tests** (`workspace-search-index-migration.test.ts`; the "before" folder is built as `memory-migration-excluded-migration.test.ts` builds it)
  1. "indexes the text that was there before the migration": a database at 144 holding two users' messages (one empty), and one artifact of each type and kind (document, slides, image, video, canvas, app, upload text, generated file, Skill Note, work capsule); apply 145; `MATCH '"arviz"'` finds the messages and every text row holding "Árvíz"; the image, video, canvas, app and work-capsule rows and the empty message are not in the index (`SELECT rowid FROM artifacts_fts`).
  2. "follows inserts, edits and deletes after every migration" (fully migrated `createInMemoryDatabase()`): a new message is found; an edit drops the old word and finds the new; a metadata-only update leaves exactly one index row; deleting the message, deleting its chat (cascade) and deleting the user (cascade) each remove it; an artifact whose kind changes to `app` leaves the index, one whose type changes to `work_capsule` too, and a new text row joins it.
  3. "keeps its triggers after every migration": the six trigger names exist on `messages` and `artifacts` in `sqlite_master`.
  4. "a later migration that rebuilds an indexed table refills the index": every `drizzle/*.sql` numbered above 145 that drops, renames or recreates `messages` or `artifacts` also holds `'delete-all'` for that table's index and the six triggers (passes vacuously today; fails the day such a migration lacks them).
  5. "nothing replaces a message or an artifact row": no file under `src/` or `scripts/` holds `insert or replace` / `replace into` (case-insensitive) naming `messages` or `artifacts` (REPLACE deletes without firing delete triggers).
- [ ] **Step 2: Run them to see them fail** — `npx vitest run src/lib/server/db/workspace-search-index-migration.test.ts` → FAIL (no migration 145).
- [ ] **Step 3: Write the migration** (header comment: why contentless-delete, why rowid, what is indexed and why), the journal entry, the two required tables, and `tablesFilter: ["*", "!messages_fts*", "!artifacts_fts*"]` in `drizzle.config.ts`. `wipeUserData` reads `PRAGMA table_list`, skips `shadow` tables and empties `virtual` ones with `DELETE FROM`. The containment test's all-tables scan reads `PRAGMA table_list` too and leaves `shadow` tables out (their blobs are the index's own encoding, not readable text).
- [ ] **Step 4: Run them to see them pass**, plus `npx vitest run src/lib/server/db tests/cross-cutting/incognito-artifact-containment.test.ts scripts` and `npm run check:migrations`.
- [ ] **Step 5: Commit** "Index message and document text for Workspace Search" (`Search-Stage-B-Task: 1`).

---

### Task 2: Checking, refilling and compacting the index

**Files:**
- Create: `src/lib/server/services/workspace-search/search-index.ts`, `search-index.test.ts`
- Create: `scripts/workspace-search-index.ts`; Modify: `package.json` (`"search:index": "tsx scripts/workspace-search-index.ts"`), `.fallowrc.json` only if Fallow asks
- Modify: `src/lib/server/services/account-lifecycle/index.ts` and `account-lifecycle.test.ts`

**Interfaces:**
- Produces, in `search-index.ts` (reads and writes through `db` from `$lib/server/db`):

```ts
export interface SearchIndexCount { indexed: number; expected: number; missing: number; extra: number }
export interface SearchIndexReport { messages: SearchIndexCount; artifacts: SearchIndexCount }
export function checkSearchIndex(): SearchIndexReport;   // compares index row ids with the eligible base row ids
export function rebuildSearchIndex(): SearchIndexReport; // one transaction: 'delete-all', refill with the eligibility above, 'optimize'; returns the check after
export function compactSearchIndex(): void;              // 'optimize' on both tables
```
- The eligibility lives here once more as SQL text (a migration cannot import it); the test below is what keeps the two equal.
- The script: `npm run search:index` checks and prints the report (exit 1 when anything is missing or extra); `npm run search:index -- --rebuild` refills. It takes the database from `getDatabasePath()`, as `scripts/memory-label-migration.ts` does.
- `eraseUserAccountData`, `purgeUserData` (Clear Workspace) and `clearMemoryAndKnowledgeForUser` call `compactSearchIndex()` after their last delete; a failure is logged as `[WORKSPACE_SEARCH] index_compact_failed` with the error's class and never fails the erasure.

- [ ] **Step 1: Write the failing tests**
  - "a refilled index equals the one the triggers keep": rows of every kind written through inserts; the indexed row ids; `rebuildSearchIndex()`; the same row ids, and `checkSearchIndex()` reports 0 missing and 0 extra.
  - "the check finds a lost row and a stray one": delete one row id from `messages_fts` directly and insert a stray one → `missing: 1, extra: 1`; after `rebuildSearchIndex()` both are 0.
  - "compaction leaves none of a deleted message's words": a message with a word made of trigrams no other row holds; delete it; an `fts5vocab` row table over `messages_fts` still lists the trigram; `compactSearchIndex()`; it does not (if the vocabulary already hides tombstoned rows, the test reads the `_data` blobs' segment count instead and says so).
  - `account-lifecycle.test.ts`: "erasure compacts the search index" and the same for Clear Workspace: the erased person's unique trigram is gone from the vocabulary.
- [ ] **Step 2: Run them to see them fail** — `npx vitest run src/lib/server/services/workspace-search/search-index.test.ts src/lib/server/services/account-lifecycle`.
- [ ] **Step 3: Implement the module, the script and the three calls.**
- [ ] **Step 4: Run them to see them pass**; run the script against a scratch copy of a migrated database (`--rebuild`, then check → exit 0).
- [ ] **Step 5: Commit** "Let an operator check and refill the search index, and compact it after erasure" (`Search-Stage-B-Task: 2`).

---

### Task 3: Chats found through the index

**Files:**
- Modify: `src/lib/server/services/workspace-search/patterns.ts` and `patterns.test.ts`, `chats.ts` and `chats.test.ts`

**Interfaces:**
- Produces, in `patterns.ts`:

```ts
export const INDEX_MIN_TERM_CHARS = 3;
export function usesSearchIndex(term: string): boolean;   // Array.from(term).length >= 3
export function indexPhrase(term: string): string;        // `"${term.replaceAll('"', '""')}"`
export function foldedSnippet(text: string, terms: readonly string[], maxChars: number): string | null;
```
- `foldedSnippet` finds the first place the words fold to with the platform's `normalize("NFKD")`, removes marks, lower-cases, then confirms with `searchSnippet` on a window of the original text (600 characters each side); only when that window misses (a drift the fast fold cannot see) does it fold the whole text, and only for texts under 200,000 characters. It returns `null` when nothing matches.
- In `chats.ts`, a word the title and project do not hold is looked for in messages through `conversations.id IN (SELECT conversation_id FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH indexPhrase(term)))` when `usesSearchIndex(term)`, else through Stage A's `LIKE` spellings. `loadBodyMatch` uses the same two conditions on the message row; its snippet is the SQL cut around a typed spelling, and when that cut does not hold the words, the message's whole text through `foldedSnippet`.

- [ ] **Step 1: Write the failing tests** (`chats.test.ts` unless named)
  1. "finds a message typed without accents": message "Árvíztűrő tükörfúrógép kell", query "arviz" → found, `match.type` "body", the snippet holds "Árvíztűrő".
  2. "finds mixed capitals in a message": "ÁrVíZ" → found.
  3. "finds a short word and a long word in different messages": messages "the AI said so" and "about the kitchen", query "ai kitchen" → found; "ai garden" → not.
  4. "takes query syntax literally": messages holding `o"neil`, `c++ and c#`, `not near(x) -x *y ^z`; each of `o"neil`, `near(x)`, `-x`, `not`, `*y` finds its chat and nothing throws.
  5. "never finds another person's message through the index": the same word in a stranger's chat → only the owner's.
  6. `patterns.test.ts`: `indexPhrase('o"neil')` is `"o""neil"`; `usesSearchIndex("ai")` false, `usesSearchIndex("árv")` true; `foldedSnippet` finds "Árvíz" for "arviz" at character 900,000 of a 1,000,000-character text and returns `null` for a missing word.
- [ ] **Step 2: Run them to see them fail** — `npx vitest run src/lib/server/services/workspace-search/chats.test.ts src/lib/server/services/workspace-search/patterns.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass**, with the whole folder.
- [ ] **Step 5: Commit** "Find chat messages through the index, accents and case folded" (`Search-Stage-B-Task: 3`).

---

### Task 4: Documents and files found through the index

**Files:**
- Modify: `src/lib/server/services/workspace-search/documents.ts` and `documents.test.ts`

**Interfaces:**
- Consumes Task 3's `usesSearchIndex`, `indexPhrase`, `foldedSnippet`.
- The text group's body clause becomes `artifacts.rowid IN (SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH indexPhrase(term))` for a word of three letters or more, else Stage A's `LIKE` spellings. `loadBodySnippets` falls back to `foldedSnippet` on the row's text as Task 3 does.

- [ ] **Step 1: Write the failing tests**
  1. "finds an upload's text typed without accents": a normalized document holding "Árvíztűrő" → found by "arviz", the snippet holds "Árvíztűrő".
  2. "finds a Skill Note and a Slides by their text" (Stage A test gap): each found by a word of its body, with badges `skill_note` and `slides`.
  3. "keeps App code and picture, video and canvas JSON out of the index": `SELECT count(*) FROM artifacts_fts WHERE artifacts_fts MATCH '"usestate"'` is 0 for an App whose code holds "useState", and likewise for words only in the JSON of a picture, a video and a canvas; the search finds none of them by those words.
  4. "a two-letter word still finds a body": "AI" in a document's text → found.
  5. The existing "a word deep in a long upload still counts" passes through the index.
- [ ] **Step 2: Run them to see them fail** — `npx vitest run src/lib/server/services/workspace-search/documents.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass**, with the folder and `tests/cross-cutting/incognito-artifact-containment.test.ts`.
- [ ] **Step 5: Commit** "Find document and file text through the index" (`Search-Stage-B-Task: 4`).

---

### Task 5: The speed check and the fill time

**Files:**
- Create: `scripts/workspace-search-speed.ts` (an entry in `.fallowrc.json` with its reason)

**Interfaces:**
- `npx tsx scripts/workspace-search-speed.ts [--messages 50000] [--users 5]`: makes a scratch database under the OS temp folder, migrates it, writes synthetic chats, messages and documents in raw SQL with row ids interleaved across users by time (a seeded generator of English and Hungarian syllables, accents included), then times `searchWorkspace` for one person: a common word, a rare word, two words, an accent-less word, a two-letter word, and the empty view; 3 warm-ups, 20 runs each, prints median and p95. `--fill` instead builds a database at migration 144 with about 15 MB of text over about 7,000 rows (production's shape) and times applying 145, printing the index's size.

- [ ] **Step 1: Write the script; run it.** Expected: every median under 200 ms at 50,000 messages; the fill well under the old release's 10 s `busy_timeout`. If a median is over, find the slow clause with `EXPLAIN QUERY PLAN` and fix it before going on.
- [ ] **Step 2: Commit** "Measure Workspace Search on 50,000 synthetic messages and time the fill" (`Search-Stage-B-Task: 5`), with the numbers in the message.

---

### Task 6: Stage A's deferred minors (each its own commit, `Search-Stage-B-Task: 6`)

Each fix gets a test that fails first where it can be tested. The order is cheapest first.

| # | Minor | Fix | Test (fails first) |
|---|---|---|---|
| 6.1 | `likeSpellings` scans ASCII words three times; `toLocaleUpperCase` | Spellings equal after ASCII lower-casing collapse to one (LIKE folds ASCII case); `toUpperCase` | `patterns.test.ts`: `likeSpellings("ai")` has one pattern, `likeSpellings("új")` three |
| 6.2 | Empty-query view highlights typed letters | `highlightTerms` is empty unless the response is in query mode | `SearchModal.test.ts`: "a!" with recents → no `mark` |
| 6.3 | Load more uses the input's text and appends repeats | Load more asks with the shown response's query; rows already shown are skipped by key | Load more after the input changed asks with the shown query; a repeated chat appears once |
| 6.4 | A 0 chip is an enabled no-op; "Memory 0" before typing; focus falls to the body | `aria-disabled="true"` on a chip with no matches; no counts in the empty-query view; when Show all or Load more goes away after use, focus moves to the search box | three modal tests |
| 6.5 | Footer adds capped counts as exact; "across 1 kinds" | A capped kind makes the footer read "99+ results"; "kind" singular for one (English; Hungarian needs no plural) | footer tests |
| 6.6 | Memory search reads facts twice, skips a bank silently, reads banks on another kind's Load more | One fact read per bank; a skipped bank logs `[WORKSPACE_SEARCH] memory_bank_skipped code=…`; a cursor request reads only its own kind and the client keeps the other counts | `native-read.test.ts` (read count), `index.test.ts` (cursor reads one kind), log test |
| 6.7 | The memory link carries the whole typed query | It carries the cleaned words, at most 500 characters | `memories.test.ts` |
| 6.8 | A video row loads the full poster; a failed thumbnail leaves a blank tile | The poster's `thumb` variant (if the files route serves one for posters, else unchanged and recorded); `onerror` swaps to the kind's icon tile | `documents.test.ts`, `SearchModal.test.ts` |
| 6.9 | An edited picture is found by its latest take's prompt only | Every take's prompt (from the takes' own rows), if they keep it; else recorded | `documents.test.ts` |
| 6.10 | Copy: "Show all {count}" lacks the kind; "C#"/"C++" become "c"; noMatchesHint names two kinds | Per-kind Show all words (EN/HU); a trailing `#` or `+` after a letter is part of the word; the hint names every kind | `workspace-search-text.test.ts`, modal tests, i18n parity |
| 6.11 | Test gaps | An older answer after a newer one; the batch test's `typeof` check replaced by a behaviour check; Skill Note and Slides (Task 4) | as named |
| 6.12 | Nits | The modal uses `SEARCH_MIN_QUERY_CHARS`; the glossary says what folds where after Stage B | modal test |
| 6.13 | Review recommendations | A superseded fetch is aborted; cursor requests skip other kinds (6.6); latency measured on 50,000 synthetic messages (Task 5); a production-sized measurement stays the orchestrator's | modal abort test |

(The Hungarian placeholder that was cut off on a phone was fixed on `main` by `de851e701`.)

- [ ] Run `npx vitest run src/lib/components/search src/lib/server/services/workspace-search src/lib/shared src/lib/i18n` after the last one.

---

### Task 7: Words and maps

**Files:** `CONTEXT.md` (Lexical Workspace Search), `src/lib/server/services/AGENTS.md` (Workspace Search note: the index, the triggers, the command), `src/lib/server/db/AGENTS.md` (the two virtual tables: migrations only, never `INSERT OR REPLACE` on their tables, a rebuild of `messages` or `artifacts` refills the index), `README.md` (the operator command).

- [ ] Change the words; run `npx vitest run src/lib/components/guide src/lib/i18n`; commit "Say what the search index does and how to repair it" (`Search-Stage-B-Task: 7`).

---

### Task 8: The gates, the review and the hand-over

- [ ] `npm run check` (0 and 0).
- [ ] `pgrep -fl 'gates.sh|node_modules/.bin/playwright test'`; wait with `caffeinate -w <pid>` if one runs; then `scripts/gates.sh agent "$TMPDIR/alfyai-gates-sb" --port 5200 tests/e2e/search-modal.spec.ts tests/e2e/chat.spec.ts tests/e2e/knowledge.spec.ts`.
- [ ] One Opus whole-branch review (read-only subagent); fix its Important findings, each with a test that fails first.
- [ ] Write `search-stage-b-build-2026-11-24.md` in the shared notes folder: commits, gate lines, speed numbers, fill time, calls, what the deploy does to production's database (migration time, index size), the repair command.
