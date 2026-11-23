# Workspace Search revival — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspace Search finds every kind of thing a person makes or keeps in AlfyAI (chats, Memory entries, documents and files, pictures and videos, apps) by words in any order, folding case and accents, with true counts per kind and results that open where they live.

**Architecture:** Search stays one server boundary (ADR-0034). `services/workspace-search.ts` becomes the folder `services/workspace-search/` with the same import path, split by kind: chats, documents (documents, pictures and videos, apps) and memory entries. A shared matcher (`$lib/shared/workspace-search-text.ts`) folds and splits text identically in the server and in the modal's highlighting. Stage A changes no schema. Stage B adds two SQLite FTS5 trigram tables kept in step by triggers, only after a count-only size check on production.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Drizzle on better-sqlite3 (bundled SQLite 3.53.2: FTS5 with `trigram remove_diacritics 1` checked), Vitest, Playwright, Lucide icons, Biome, Fallow.

**Spec:** `docs/superpowers/specs/2026-11-23-workspace-search-revival-design.md`, with the approved mockups in `docs/design/workspace-search/`.

## Global Constraints

- Before touching code, check the current docs for Svelte 5 runes, SvelteKit's `$app/navigation` (`replaceState`), Vitest module mocks, Playwright and SQLite FTS5 (external-content tables, triggers, the trigram tokenizer), through Context7 or the official docs; say in the task report which were checked (root `AGENTS.md`).
- Build this after the Memory redesign's part 1 (`docs/superpowers/plans/2026-11-23-memory-recall-part-1.md`) has merged: Task 5 reuses its newest-source-date rule.
- Search stays lexical and server-backed: no embeddings, no reranker; the route is an adapter (ADR-0034, `CONTEXT.md`).
- Nothing a person cannot open is ever returned: another person's material, a deleted chat, an incognito chat's artifacts, a memory entry the Memory page hides, a project they do not own; no memory result for an account whose Memory is off or that is not on native Memory.
- Memory is read through `memory-profile/native-read.ts` only.
- Every new UI string in English and Hungarian, short natural Hungarian; the Feature Guide entry and `CONTEXT.md` change in this work (root `AGENTS.md`).
- Icons come from `@lucide/svelte` only.
- Limits: query mode needs at least 2 characters (today's rule); at most 8 words count; "All" shows 3 per kind; a scope page holds 20; counts stop at 100 ("99+"); a body candidate read stops at 400 rows.
- The database changes only through migrations; nothing runs `VACUUM`.
- Synthetic data only. `npm run check` 0 errors and 0 warnings, Biome clean, no new Fallow finding, a build without warnings. Commit only your task's files (`git commit ... -- <paths>`). Nothing is pushed or deployed; production steps need the owner's word.

## Review Focus

1. **A Hungarian word with capitals or without accents** ("ÁRVÍZ", "arviz"): found in titles, names, prompts, descriptions and memory in Stage A, and in message and document text too in Stage B. Tests: Task 1 "folds case and accents"; Task 3 "finds an accented capital in a message body"; Task 11 "matches without accents in a message body".
2. **A memory entry that changed after it was found:** its link opens the scope's list with the search filled in, never an error. Test: Task 6 "falls back to the filled-in list when the entry has changed".
3. **Material a person cannot open:** a picture from an incognito chat, an artifact of a deleted chat, another person's entry, a project they do not own. Tests: Task 4 and Task 5 visibility tests; Task 4 extends `tests/cross-cutting/incognito-artifact-containment.test.ts`.
4. **A very common word** ("the", "és") matching thousands of messages: reads stay capped, the chip says "99+", and typing stays responsive. Tests: Task 3 "caps the body candidates and the count"; Task 11's speed check (50,000 messages).
5. **Memory switched off or a legacy account:** no memory results and no Memory chip. Test: Task 5 "returns no memory results when Memory is off"; Task 7 "hides the Memory chip when memory is not searchable".

## Order and parallel work

Stage A: Tasks 1 to 9. Tasks 1 and 2 first (2 moves files every later task touches). Then Tasks 3, 4 and 5 touch disjoint files and may run side by side in separate worktrees, merged one at a time. Task 6 needs Task 5's hrefs, Task 7 needs Tasks 3 to 6, and Tasks 8 and 9 come last. Stage B: Task 10 is the owner's measurement; Task 11 follows only on the owner's choice.

---

### Task 1: One matcher for the server and the modal

**Files:**
- Create: `src/lib/shared/workspace-search-text.ts`
- Create: `src/lib/shared/workspace-search-text.test.ts`

**Interfaces:**
- Produces:

```ts
export const SEARCH_MIN_QUERY_CHARS = 2;
export const SEARCH_MAX_TERMS = 8;
export function foldForSearch(text: string): string;
export function searchTerms(query: string): string[];
export function typedSearchWords(query: string): string[];
export function matchesAllTerms(text: string, terms: readonly string[]): boolean;
export function matchRanges(text: string, terms: readonly string[]): Array<{ start: number; end: number }>;
export function searchSnippet(text: string, terms: readonly string[], maxChars?: number): string | null;
```

Rules, exactly:
- `foldForSearch`: per code point, `normalize("NFKD")`, drop every `\p{M}` mark, then `toLowerCase()`.
- `searchTerms`: fold the query, split on whitespace, trim each word's leading and trailing characters that are neither letters nor digits (`/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu`), drop empty and repeated words, keep the first `SEARCH_MAX_TERMS`, cut each to 64 characters.
- `typedSearchWords`: the same words in the same order as `searchTerms`, but only `normalize("NFC")` and `toLowerCase()`, accents kept; the SQL `LIKE` clauses of Tasks 3 and 4 and the index queries of Task 11 use these.
- `matchesAllTerms`: every term occurs in `foldForSearch(text)` as a substring.
- `matchRanges`: every occurrence of every term, as ranges of the original text (map folded positions back through a per-code-point index map), merged where they overlap, sorted.
- `searchSnippet`: `null` when there is no match; otherwise up to `maxChars` (default 160) characters of the original text around the earliest match, with "…" where it was cut, whitespace folded.

- [ ] **Step 1: Write the failing tests**

```ts
it("folds case and accents", () => {
	expect(foldForSearch("ÁRVÍZTŰRŐ Tükörfúrógép")).toBe("arvizturo tukorfurogep");
	expect(matchesAllTerms("Árvíztűrő tükörfúrógép", searchTerms("arviz"))).toBe(true);
	expect(matchesAllTerms("Árvíztűrő tükörfúrógép", searchTerms("ÁRVÍZ"))).toBe(true);
});
it("takes words in any order and inside longer words", () => {
	expect(matchesAllTerms("Plan for the kitchen", searchTerms("kitchen plan"))).toBe(true);
	expect(matchesAllTerms("szállásajánlatok a projektben", searchTerms("ajánlat"))).toBe(true);
	expect(matchesAllTerms("Plan for the kitchen", searchTerms("kitchen budget"))).toBe(false);
});
it("splits a query into at most eight clean words", () => {
	expect(searchTerms('  "Kitchen,"  plan!  plan  ')).toEqual(["kitchen", "plan"]);
	expect(searchTerms("e-mail 1:50")).toEqual(["e-mail", "1:50"]);
	expect(searchTerms("a b c d e f g h i j")).toHaveLength(8);
	expect(typedSearchWords('"ÁRVÍZ" kitchen árvíz')).toEqual(["árvíz", "kitchen"]);
});
it("returns ranges of the original text for every word", () => {
	expect(matchRanges("Árvíz and the árvíz", searchTerms("arviz"))).toEqual([
		{ start: 0, end: 5 },
		{ start: 14, end: 19 },
	]);
});
it("cuts a snippet around the first match", () => {
	const text = `${"x ".repeat(200)}the thesis model ${"y ".repeat(200)}`;
	const snippet = searchSnippet(text, searchTerms("thesis"));
	expect(snippet).toContain("thesis");
	expect(snippet?.startsWith("…")).toBe(true);
	expect(snippet?.endsWith("…")).toBe(true);
	expect(snippet!.length).toBeLessThanOrEqual(162);
	expect(searchSnippet("nothing here", searchTerms("thesis"))).toBeNull();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/shared/workspace-search-text.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement the module**

- [ ] **Step 4: Run them to see them pass**, then commit

```bash
paths=(src/lib/shared/workspace-search-text.ts src/lib/shared/workspace-search-text.test.ts)
git add "${paths[@]}"
git commit -m "Add one search matcher that folds case and accents" -m "Workspace Search compared text with SQLite's ASCII-only lower() and took the query as one phrase, so Hungarian capitals and words in another order were missed. The server and the modal's highlighting now share one matcher." -- "${paths[@]}"
```

---

### Task 2: Turn the search service into a folder

**Files:**
- Move: `src/lib/server/services/workspace-search.ts` → `src/lib/server/services/workspace-search/index.ts`
- Move: `src/lib/server/services/workspace-search.test.ts` → `src/lib/server/services/workspace-search/index.test.ts`
- Modify: every import of the moved test's relative paths

**Interfaces:**
- Produces: the same import path, `$lib/server/services/workspace-search`, and the same exports. Later tasks add `types.ts`, `chats.ts`, `documents.ts` and `memories.ts` in this folder.

- [ ] **Step 1: `git mv` both files and fix the relative imports inside them**

- [ ] **Step 2: Run the tests that import search**

Run: `npx vitest run src/lib/server/services/workspace-search src/routes/api/workspace-search src/lib/client/api/workspace-search.test.ts tests/cross-cutting/incognito-artifact-containment.test.ts && npm run check`
Expected: all PASS, nothing else changed.

- [ ] **Step 3: Commit**

```bash
git add -A src/lib/server/services/workspace-search src/lib/server/services/workspace-search.ts src/lib/server/services/workspace-search.test.ts
git commit -m "Move Workspace Search into a folder before splitting it by kind" -m "The service is 913 lines and is about to gain memory, pictures, videos and apps; a folder keeps each kind in its own file under the same import path." -- src/lib/server/services/workspace-search src/lib/server/services/workspace-search.ts src/lib/server/services/workspace-search.test.ts
```

---

### Task 3: The new contract, and chats matched by words

**Files:**
- Create: `src/lib/server/services/workspace-search/types.ts` (the types now at the end of `index.ts`, plus the new ones)
- Create: `src/lib/server/services/workspace-search/chats.ts` (the chat loaders and scoring now in `index.ts`)
- Modify: `src/lib/server/services/workspace-search/index.ts`, `src/routes/api/workspace-search/+server.ts`, `src/lib/client/api/workspace-search.ts`
- Test: `src/lib/server/services/workspace-search/chats.test.ts`, the route test and the client test beside their modules

**Interfaces:**
- Produces, in `types.ts` (existing types keep their fields):

```ts
export type WorkspaceSearchKind = "chats" | "memory" | "documents" | "media" | "apps";
export type WorkspaceSearchScope = "all" | WorkspaceSearchKind;
export type WorkspaceSearchBadge =
	| "document" | "slides" | "canvas" | "uploaded" | "file" | "report" | "skill_note" | "picture" | "video" | "app";
export interface WorkspaceSearchMemoryResult {
	id: string;
	scope: { kind: "personal" } | { kind: "project"; projectId: string };
	projectName: string | null;
	text: string;
	lastSaidAt: string | null;
	href: string;
}
// WorkspaceSearchDocumentResult gains: searchKind: "documents" | "media" | "apps"; badge: WorkspaceSearchBadge; preview?: ImagePreview
export interface WorkspaceSearchResponse {
	query: string;
	mode: WorkspaceSearchMode;
	scope: WorkspaceSearchScope;
	conversations: WorkspaceSearchConversationResult[];
	memories: WorkspaceSearchMemoryResult[];
	documents: WorkspaceSearchDocumentResult[];
	totals: Record<WorkspaceSearchKind, number>;
	memorySearchable: boolean;
	nextCursor: string | null;
	documentOverflow: boolean; // removed in Task 7
	knowledgeHref: string | null; // removed in Task 7
}
export const SEARCH_ALL_PER_KIND = 3;
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_COUNT_CAP = 100;
export const SEARCH_BODY_CANDIDATE_CAP = 400;
```

- Produces: `searchWorkspace(userId: string, options: { query?: string | null; scope?: WorkspaceSearchScope; cursor?: string | null })`. A cursor is `"o:<offset>"`; an unreadable one counts as no cursor.
- Produces, in `chats.ts`: `searchChats(userId: string, terms: string[], window: { offset: number; limit: number }): Promise<{ results: WorkspaceSearchConversationResult[]; total: number }>`.
- The route reads `q` (or `query`), `scope` (one of the six, else `"all"`) and `cursor`. `fetchWorkspaceSearch(query, { scope?, cursor?, signal? })` sends them.

Chat matching:
- Titles and project names: the person's visible conversations (today's ownership rules), matched with `matchesAllTerms` in the server.
- Message text: SQL candidates, one clause per term, each clause an `OR` of `LIKE` over the term as typed in lower case, with its first letter upper-cased, and fully upper-cased (`toLocaleUpperCase`), scoped to the person's conversations, newest first, `LIMIT SEARCH_BODY_CANDIDATE_CAP`, selecting `substr(content, 1, 4000)` rather than whole messages. The SQL clauses decide that a message holds every term (a word past the first 4,000 characters still counts); `searchSnippet` builds the snippet from those 4,000 characters, and a match that sits later gets no snippet.
- One row per chat, today's scores (title 30, project 22, +4 exact, body 12 to 23), ties by recency. `total` counts matching chats up to `SEARCH_COUNT_CAP`.
- `scope: "all"` returns `SEARCH_ALL_PER_KIND` chats; `scope: "chats"` returns `SEARCH_PAGE_SIZE` from the cursor's offset, with `nextCursor` when more remain. Other kinds are empty in this task (`documents` keep today's results with `searchKind: "documents"` and `badge` from Task 4's rule stubbed as `"document"`; `totals` for kinds not yet built are their returned counts; `memorySearchable: false`).

- [ ] **Step 1: Write the failing tests** in `chats.test.ts`, on a migrated in-memory database (the setup `native.test.ts` uses: `drizzle` over better-sqlite3 and `migrate(... "./drizzle")`):
  1. "finds a chat by its title with words in any order": title "Plan for the kitchen", query terms of "kitchen plan" → found.
  2. "finds an accented capital in a message body": message "Árvíztűrő tükörfúrógép kell" in a chat titled "Gépek", query "árvíz" → found, the snippet holds "Árvíztűrő".
  3. "caps the body candidates and the count": 500 messages containing "hello" across 150 chats → at most 400 rows read (spy on the prepared statement or count returned rows), and `total` is 100.
  4. "never returns another person's chat": the same text in another user's chat → not found.
  5. "pages a scope": 25 matching chats, `scope: "chats"` → 20 results and `nextCursor` `"o:20"`; the next page has 5 and no cursor.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/workspace-search/chats.test.ts`
Expected: FAIL.

- [ ] **Step 3: Move the types and the chat code, then implement the matching, totals and paging; update the route and the client**

- [ ] **Step 4: Run the search tests and the check**

Run: `npx vitest run src/lib/server/services/workspace-search src/routes/api/workspace-search src/lib/client/api/workspace-search.test.ts src/lib/components/search && npm run check`
Expected: all PASS (the modal still reads `conversations` and `documents`).

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/workspace-search src/routes/api/workspace-search src/lib/client/api/workspace-search.ts src/lib/client/api/workspace-search.test.ts)
git add "${paths[@]}"
git commit -m "Match chats by every word, folded, with capped reads and true counts" -m "A query was one literal phrase over an unbounded scan of every message, returned whole on each keystroke. Chats now match every word in any order, accented capitals included, read at most 400 message heads, and report how many chats match so the chip can say so." -- "${paths[@]}"
```

---

### Task 4: Every kind of document, picture, video and app

**Files:**
- Create: `src/lib/server/services/workspace-search/documents.ts` (the document loaders and scoring now in `index.ts`, then the new kinds)
- Modify: `src/lib/server/services/knowledge/store/documents.ts` (a batch reader)
- Modify: `src/lib/server/services/workspace-search/index.ts`
- Test: `src/lib/server/services/workspace-search/documents.test.ts`, `tests/cross-cutting/incognito-artifact-containment.test.ts`

**Interfaces:**
- Produces, in `knowledge/store/documents.ts`: `getLogicalDocumentsForArtifacts(userId: string, artifactIds: readonly string[]): Promise<Map<string, KnowledgeDocumentItem>>`, which reads the person's chats once for the whole batch; the existing single reader calls it.
- Produces, in `documents.ts`: `searchDocuments(userId: string, terms: string[], scope: WorkspaceSearchScope, window: { offset: number; limit: number }): Promise<{ results: WorkspaceSearchDocumentResult[]; totals: Pick<Record<WorkspaceSearchKind, number>, "documents" | "media" | "apps"> }>`, and `searchKindAndBadge(item: KnowledgeDocumentItem): { searchKind: "documents" | "media" | "apps"; badge: WorkspaceSearchBadge }`.

`searchKindAndBadge`, exactly, first rule that applies:

| Item | searchKind | badge |
|---|---|---|
| artifact kind `app` | apps | app |
| artifact kind `image` | media | picture |
| artifact kind `video` | media | video |
| an upload whose MIME type starts with `image/` | media | picture |
| an upload whose MIME type starts with `video/` | media | video |
| artifact kind `slides` | documents | slides |
| artifact kind `canvas` | documents | canvas |
| artifact kind `document` | documents | document |
| `documentOrigin` `skill_note` | documents | skill_note |
| generated, `documentRole` starting with "Atlas research report" | documents | report |
| generated | documents | file |
| everything else (uploads) | documents | uploaded |

Matched text per item: name, label, role and summary for all; then a picture's prompt (`parseImageVersionBody`), a video's prompt (`parseVideoVersionBody`), a canvas's block text (`normalizeCanvasBody`), an uploaded picture's description (`getImageDescriptions`), a Document's or Slides' or file's text; never an App's code and never raw JSON. Candidates: today's three loaders, each `LIMIT SEARCH_BODY_CANDIDATE_CAP`, with Task 3's per-term `LIKE` clauses, the ownership scope in SQL before the limit (`getArtifactOwnershipScope`), then one `getLogicalDocumentsForArtifacts` call and `isArtifactCanonicallyOwned`. A body's SQL clauses decide that it holds every term, as for messages, reading `substr(content_text, 1, 20000)` for the snippet; the short fields and the text read through a body reader (prompts, canvas text, descriptions) are checked with `matchesAllTerms`. Pictures get `preview` (`attachImagePreviews`); a video gets `preview` from the still it was made from when its body names one. Totals count per kind up to `SEARCH_COUNT_CAP`. The empty-query view reads only the three newest visible documents through the batch reader, never the whole library.

- [ ] **Step 1: Write the failing tests** in `documents.test.ts` (migrated in-memory database; synthetic artifacts written through the knowledge store and artifact family helpers the existing tests use):
  1. "classifies every kind" — one item per row of the table above → its `searchKind` and `badge`.
  2. "finds a picture by its prompt, not by its JSON" — an Image whose prompt says "timber house" → found by "timber"; not found by "fileid" or "takes".
  3. "finds a canvas by its block text, not by its JSON" — a canvas with a block "dovetail joints" → found by "dovetail", not by "nodes".
  4. "finds an uploaded picture by what Alfy saw in it" — description "a red bicycle" → found by "bicycle", under `media`.
  5. "never searches an App's code" — an App named "Countdown" whose body contains "useState" → not found by "useState".
  6. "keeps a research report under Documents with the Report badge" and "a plain generated file gets the File badge".
  7. "reads a batch in one pass" — `getLogicalDocumentsForArtifacts` for 30 ids reads the person's chats once (spy on the chat query).

  In `incognito-artifact-containment.test.ts`, add: a picture, a video, an app and a canvas made in an incognito chat never come back from `searchWorkspace`, nor any artifact of a deleted chat.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/workspace-search/documents.test.ts tests/cross-cutting/incognito-artifact-containment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the batch reader, the classification, the matched text, the previews and the totals**

- [ ] **Step 4: Run the tests and the check**

Run: `npx vitest run src/lib/server/services/workspace-search src/lib/server/services/knowledge tests/cross-cutting/incognito-artifact-containment.test.ts && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/workspace-search src/lib/server/services/knowledge/store/documents.ts tests/cross-cutting/incognito-artifact-containment.test.ts)
git add "${paths[@]}"
git commit -m "Search pictures, videos, apps and every document by what they hold" -m "Pictures, videos and apps were found by title only, video and canvas bodies matched as raw JSON, uploaded pictures' descriptions were never read, and every generated file was called a report. Each item now has one kind and badge, is matched through its own body reader, and is loaded in one batch." -- "${paths[@]}"
```

---

### Task 5: Memory entries in search

**Files:**
- Create: `src/lib/server/services/workspace-search/memories.ts`
- Modify: `src/lib/server/services/memory-profile/native-read.ts` (`listMemory`'s visible-row read and a search reader)
- Modify: `src/lib/server/services/memory-profile/publication.ts` (the newest-source-date rule)
- Modify: `src/lib/server/services/memory-context/native.ts` (use that rule)
- Modify: `src/lib/server/services/workspace-search/index.ts`
- Test: `src/lib/server/services/memory-profile/native-read.test.ts`, `src/lib/server/services/workspace-search/memories.test.ts`

**Interfaces:**
- Produces, in `publication.ts`: `entryLastSaidAt(sourceFactIds: readonly string[], factsById: ReadonlyMap<string, { source: { assertedAt: Date; explicitEditAt: Date | null } }>): string | null`, the rule part 1 wrote inline in `recallMemory` (the newest `explicitEditAt ?? assertedAt` among the entry's admitted facts, as ISO). `recallMemory` calls it instead of its inline copy.
- Produces, in `native-read.ts`: `readVisibleMemoryRows(userId: string, scope: MemoryScope)`, the per-bank read `listMemory` does before it filters by its query and pages (same checks: Memory on, native authority, bank access for the epoch, only rows the page would show), and `searchMemoryEntries(userId: string, terms: readonly string[], window: { offset: number; limit: number }): { entries: Array<{ ref: MemoryRef; text: string; projectName: string | null; lastSaidAt: string | null }>; total: number; searchable: boolean }`. It searches the personal bank and every project bank of a project the person owns (through `readMemoryScope`), matches each entry's display text with `matchesAllTerms`, orders by `lastSaidAt`, newest first, and counts up to `SEARCH_COUNT_CAP`. `searchable` is `false`, with nothing searched, when the account is not on native Memory or Memory is off.
- Produces, in `memories.ts`: `searchMemories(userId, terms, query, window)` mapping hits to `WorkspaceSearchMemoryResult` with `href` = `/knowledge?tab=memory&scope=personal&entry=<rowId>&q=<query>` or `scope=project:<projectId>`, URL-encoded.

- [ ] **Step 1: Write the failing tests**
  - `native-read.test.ts`: "searches every bank the person can see": a personal entry and a project entry both containing "thesis" → both found, with the project's name; "skips a project the person no longer owns"; "returns no memory results when Memory is off" (`searchable: false`, no entries); "hides an entry the page hides" (an entry whose supporting fact was revoked → not found); "keeps listMemory's results unchanged" (the existing `listMemory` tests pass untouched).
  - `memories.test.ts`: "links each entry to its scope in Memory" — the exact `href` for a personal and a project entry, the query encoded.
  - `native.test.ts` (part 1's tests) still pass after `recallMemory` uses `entryLastSaidAt`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-profile/native-read.test.ts src/lib/server/services/workspace-search/memories.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the shared rule, the visible-row read, the search reader and the mapping; wire `memories`, `totals.memory` and `memorySearchable` into `searchWorkspace`**

- [ ] **Step 4: Run the tests and the check**

Run: `npx vitest run src/lib/server/services/memory-profile src/lib/server/services/memory-context src/lib/server/services/workspace-search && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/workspace-search src/lib/server/services/memory-profile/native-read.ts src/lib/server/services/memory-profile/native-read.test.ts src/lib/server/services/memory-profile/publication.ts src/lib/server/services/memory-context/native.ts)
git add "${paths[@]}"
git commit -m "Make Memory entries searchable from Workspace Search" -m "Memory lived only on its own page. Search now reads the entries the Memory page shows, across the personal bank and the person's own projects, with when each was last said, and links each to its place in Memory." -- "${paths[@]}"
```

---

### Task 6: Open a memory entry from a link

**Files:**
- Modify: `src/routes/(app)/knowledge/+page.svelte` (the `tab` handling near lines 205-222)
- Modify: `src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte`
- Test: `src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts` (create it beside the component, following the folder's other component tests)

**Interfaces:**
- Consumes: the `href` of Task 5.
- Produces: `KnowledgeMemoryView` props `initialScope?: MemoryScope`, `initialEntryId?: string`, `initialQuery?: string`, read once (`untrack`) on mount. The page parses `scope` (`personal` or `project:<id>`), `entry` and `q` only when `tab=memory`.

Behaviour: the view loads `initialScope`; when a row with `ref.rowId === initialEntryId` is in it, it opens that row's detail, as a click would; otherwise it shows the scope's list with its search set to `initialQuery`. Then the page calls `replaceState` to `?tab=memory`, so a reload or Back shows the plain tab.

- [ ] **Step 1: Write the failing tests**: "opens the linked entry"; "falls back to the filled-in list when the entry has changed" (no row with that id → list shown, search box holds the query); "drops the link's parameters after use" (`replaceState` called with `?tab=memory`).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run "src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Implement the props, the page's parsing and the parameter cleanup**

- [ ] **Step 4: Run the tests and the check**, then commit

```bash
paths=("src/routes/(app)/knowledge/+page.svelte" "src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte" "src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts")
git add "${paths[@]}"
git commit -m "Let a link open one Memory entry" -m "The Memory page had no address for a single entry, so a search result could only open the tab. A link now opens the entry's detail, or the filled-in list when the entry has changed since." -- "${paths[@]}"
```

---

### Task 7: The modal: chips, sections and rows

**Files:**
- Modify: `src/lib/components/search/search-scopes.ts`, `src/lib/components/search/SearchModal.svelte`
- Modify: `src/lib/i18n/common.ts` (English near lines 300-351, Hungarian near lines 650-696)
- Modify: `src/lib/server/services/workspace-search/types.ts` and `index.ts` (drop `documentOverflow` and `knowledgeHref`)
- Test: `src/lib/components/search/search-scopes.test.ts`, `src/lib/components/search/SearchModal.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 5's response; `matchRanges` and `searchTerms` (Task 1) for highlighting.
- Produces, in `search-scopes.ts`: `SearchScopeId = WorkspaceSearchScope`; `SEARCH_SCOPE_ORDER = ["all", "chats", "memory", "documents", "media", "apps"]`; `buildSearchScopeChips(totals: Record<WorkspaceSearchKind, number>, memorySearchable: boolean): SearchScopeChip[]` (All's count is the sum; the Memory chip is left out when `memorySearchable` is false; a count of 100 shows as "99+"); `rowMatchesScope` by row kind and `searchKind`. `isScopeAvailable` and every `connections` and `reports` path go.

Modal behaviour:
- Sections in the order Chats, Memory, Documents, Pictures & videos, Apps, only when they have rows. Under All each shows its rows and, when its total is larger, a "Show all N" link that selects its chip.
- Choosing a chip fetches `scope=<kind>`; "Load more" fetches the next cursor and appends.
- A memory row: the entry's text in two lines, then `Personal` or the project's name, then "said …" in English or the relative time alone in Hungarian (`formatRelativeTime`, `src/lib/utils/time.ts`). A picture or video row: a 48-pixel thumbnail from `preview` (a film tile when a video has none). A document or app row: its badge.
- Icons (`@lucide/svelte`): chat `MessageSquare`, body match `TextSearch`, memory `Brain`, document `SquarePen`, slides `Presentation`, canvas `LayoutGrid`, uploaded `FileUp`, file `FileText`, report `BookOpen`, Skill Note `NotebookPen`, picture `Image`, video `Film`, app `AppWindow`.
- Matched words are highlighted with `matchRanges` in titles, entry text and snippets.
- The Knowledge overflow row, `searchModal.currentConversation`, `scopeReports`, `scopeConnections`, `scopeConnectionsComingSoon` and `scopeComingSoon` go; keyboard movement covers every new row; the footer keeps "{results} results across {kinds} kinds".

Words (key: English | Hungarian):

| Key | English | Hungarian |
|---|---|---|
| `searchModal.scopeConversations` | Chats | Beszélgetések |
| `searchModal.scopeMemory` | Memory | Memória |
| `searchModal.scopeMedia` | Pictures & videos | Képek és videók |
| `searchModal.scopeApps` | Apps | Alkalmazások |
| `searchModal.showAll` | Show all {count} | Mind a(z) {count} |
| `searchModal.loadMore` | Load more | Továbbiak |
| `searchModal.memoryPersonal` | Personal | Személyes |
| `searchModal.memorySaid` | said {ago} | {ago} |
| `searchModal.badge.slides` | Slides | Diák |
| `searchModal.badge.canvas` | Canvas | Vászon |
| `searchModal.badge.file` | File | Fájl |
| `searchModal.badge.report` | Report | Jelentés |
| `searchModal.badge.skillNote` | Skill Note | Készségjegyzet |
| `searchModal.badge.picture` | Picture | Kép |
| `searchModal.badge.video` | Video | Videó |
| `searchModal.badge.app` | App | Alkalmazás |

(The existing `Document` and `Uploaded` badge keys stay.)

- [ ] **Step 1: Write the failing tests**
  - `search-scopes.test.ts`: the chip order; "hides the Memory chip when memory is not searchable"; "shows 99+ at the cap"; "All is the sum".
  - `SearchModal.test.ts`: "draws no Connections chip"; "shows three per kind and a Show all link"; "Show all selects the kind's chip and fetches it"; "Load more appends the next page"; "draws a memory row with its scope and age"; "draws a picture row with its thumbnail"; "highlights words typed in another order"; "moves through every kind with the arrow keys".

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/components/search`
Expected: FAIL.

- [ ] **Step 3: Implement the scopes, the modal and the words; drop the two old response fields**

- [ ] **Step 4: Run the tests and the check**

Run: `npx vitest run src/lib/components/search src/lib/server/services/workspace-search src/lib/client/api && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/components/search src/lib/i18n/common.ts src/lib/server/services/workspace-search)
git add "${paths[@]}"
git commit -m "Redraw the search modal around every kind, with true counts" -m "The chips counted only loaded rows, 'Reports' held every generated file and 'Connections' could never be chosen. The modal now has a chip per kind with the server's counts, Memory, picture and app rows, Show all and Load more, and highlights words in any order." -- "${paths[@]}"
```

---

### Task 8: The guide, the glossary and the inventory

**Files:**
- Modify: `src/lib/i18n/guide.ts` (`guide.entry.search.*`, English near lines 153-155, Hungarian near 330-332)
- Modify: `CONTEXT.md` (Workspace Search, Lexical Workspace Search, Workspace Search Eligibility)
- Modify: `docs/plans/feature-guide/inventory.md` (line 166, the Connections mention)

- [ ] **Step 1: Change the words**
  - Guide, English: "Find any chat, memory, document, picture, video or app; Ctrl/⌘+K on a keyboard." Hungarian: "Bármelyik beszélgetést, emléket, dokumentumot, képet, videót vagy alkalmazást megtalálod; billentyűzeten Ctrl/⌘+K."
  - `CONTEXT.md`: Workspace Search covers conversations, Memory entries as the Memory page shows them, documents and files, pictures, videos and apps; Lexical Workspace Search finds every word typed, in any order, inside longer words, folding case and accents; Eligibility adds Memory entries the Memory page shows and still excludes raw memory internals (facts, sources, earlier versions) and connections.
  - The inventory line: search has no Connections scope.

- [ ] **Step 2: Run the guide checks**

Run: `npx vitest run src/lib/components/guide src/lib/i18n`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
paths=(src/lib/i18n/guide.ts CONTEXT.md docs/plans/feature-guide/inventory.md)
git add "${paths[@]}"
git commit -m "Say what Workspace Search finds now, in the guide and the glossary" -m "The Feature Guide said 'any chat or document' and the glossary kept Memory out; both now name every kind and the matching rules." -- "${paths[@]}"
```

---

### Task 9: End to end, and the gate

**Files:**
- Modify: `tests/e2e/search-modal.spec.ts`

- [ ] **Step 1: Update the spec**
  - The chips test (line 299) expects All, Chats, Memory (for a native account), Documents, Pictures & videos and Apps; the "Connections greyed" test (line 312) becomes "draws no Connections chip".
  - New: "a memory result opens its entry": seed a native account with one published personal entry the way `tests/e2e/memory-replacement.spec.ts` does, search a word from it, click the row, and expect the Memory tab with that entry's detail and the address `?tab=memory`.
  - New: "a picture result shows its thumbnail": seed an Image item the way the `images*.spec.ts` files do and expect a row with an `img`.
  - Run the chip labels check in Hungarian too (`setUiLanguage`).

- [ ] **Step 2: Run the whole gate once**

Run: `scripts/gates.sh agent "$TMPDIR/alfyai-gates-search" --port 4720 tests/e2e/search-modal.spec.ts tests/e2e/login.test.ts tests/e2e/memory-replacement.spec.ts` (another base port if 4720 is in use)
Expected: every step exits 0. A vitest file that times out under load is rerun alone before it counts as a failure.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/search-modal.spec.ts
git commit -m "Cover the revived search end to end" -m "The modal's chips, a memory result opening its entry and a picture row with its thumbnail, on the production build, in both languages." -- tests/e2e/search-modal.spec.ts
```

---

### Task 10: Measure what an index would hold (Stage B gate, the owner's step)

- [ ] **Step 1: With the owner's go-ahead, on a copy of the newest production backup, read counts only**

```sql
SELECT count(*), sum(length(content)) FROM messages;
SELECT count(*), sum(length(coalesce(name,'')) + length(coalesce(summary,'')) + length(coalesce(content_text,''))) FROM artifacts;
```

- [ ] **Step 2: Report the two totals and an estimate** (a trigram index is roughly three times the indexed text, the word tokenizer roughly the text) in `docs/plans/workspace-search/index-size.md`, counts only. The owner chooses trigram, the word tokenizer (`unicode61 remove_diacritics 2`, no matching inside compound words), or staying on Stage A. Task 11 runs only after that choice.

---

### Task 11: The full-text index (Stage B)

**Files:**
- Create: a custom migration (`npx drizzle-kit generate --custom --name workspace_search_index`) and its test, `src/lib/server/db/workspace-search-index-migration.test.ts`
- Create: `docs/adr/0072-workspace-search-reads-a-trigger-kept-full-text-index.md`
- Modify: `src/lib/server/db/AGENTS.md` (a rule under Anti-Patterns)
- Modify: `src/lib/server/services/workspace-search/chats.ts`, `documents.ts`
- Create: `src/lib/server/services/workspace-search/index-speed.integration.test.ts` (runs only when `WORKSPACE_SEARCH_SPEED_CHECK === "1"`)

**Interfaces:**
- The migration, with the tokenizer the owner chose (trigram shown):

```sql
CREATE VIRTUAL TABLE message_search USING fts5(content, content='messages', content_rowid='rowid', tokenize='trigram remove_diacritics 1');
CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
  INSERT INTO message_search(message_search, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER message_search_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO message_search(message_search, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO message_search(rowid, content) VALUES (new.rowid, new.content);
END;
INSERT INTO message_search(message_search) VALUES ('rebuild');
```

  and the same for `artifact_search(name, summary, content_text)` over `artifacts`, its update trigger firing on `UPDATE OF name, summary, content_text`.
- Matching: a term of three or more characters goes to `MATCH` as a quoted phrase, all such terms joined by `AND`, joined back to the base row by `rowid` and then through today's ownership rules; a shorter term is checked with `matchesAllTerms` on the candidates; a query with no term of three characters keeps the Stage A path. The 400-row candidate cap and the counts stay.

- [ ] **Step 1: Write the failing tests**
  - Migration test, on a database migrated from empty: "follows inserts, edits and deletes" (insert a message, find it through `message_search`; edit it, the old word is gone and the new one found; delete it, gone; the same for an artifact); "passes the integrity check" (`INSERT INTO message_search(message_search) VALUES('integrity-check')` does not throw).
  - `chats.test.ts`: "matches without accents in a message body" ("arviz" finds "Árvíztűrő" in a body); `documents.test.ts`: the same for a document's text.
  - The speed check: 50,000 synthetic messages over 500 chats, 20 queries of one to three words; the 95th percentile of `searchChats` under 200 ms on this Mac.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/db/workspace-search-index-migration.test.ts src/lib/server/services/workspace-search`
Expected: FAIL.

- [ ] **Step 3: Write the migration, switch the body loaders to the index, write ADR-0072 (context, the decision, the trigram choice and the measurement behind it, consequences) and add to `db/AGENTS.md`:** "`messages` and `artifacts` feed the search index through triggers (`message_search`, `artifact_search`). A migration that rebuilds either table recreates the triggers and runs `'rebuild'`; nothing runs `VACUUM` without rebuilding both."

- [ ] **Step 4: Run the tests, the speed check and the gate**

Run: `npx vitest run src/lib/server/db src/lib/server/services/workspace-search && WORKSPACE_SEARCH_SPEED_CHECK=1 npx vitest run src/lib/server/services/workspace-search/index-speed.integration.test.ts && scripts/gates.sh agent "$TMPDIR/alfyai-gates-search-index" --port 4740 tests/e2e/search-modal.spec.ts`
Expected: all PASS; the migration check (`npm run check:migrations`) passes inside the gate.

- [ ] **Step 5: Commit**

```bash
paths=(drizzle src/lib/server/db src/lib/server/services/workspace-search docs/adr/0072-workspace-search-reads-a-trigger-kept-full-text-index.md)
git add "${paths[@]}"
git commit -m "Search message and document text through a full-text index" -m "Body text was found by LIKE scans that fold ASCII only and read up to 400 rows per keystroke. A trigram FTS5 index kept by triggers finds any word inside longer words without accents or case, answers within milliseconds, and needs no change to the code that writes messages or artifacts." -- "${paths[@]}"
```

After merge and deploy, both on the owner's word: `npm run db:prepare` builds the index on production; time it on the backup copy first and record the time in `docs/plans/workspace-search/index-size.md`.
