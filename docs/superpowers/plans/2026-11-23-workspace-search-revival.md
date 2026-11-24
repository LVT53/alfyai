# Workspace Search revival (Stage A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspace Search finds every kind of thing a person makes or keeps in AlfyAI (chats, Memory entries, documents and files, pictures and videos, apps) by every word typed, in any order, with Hungarian capitals folded, true counts per kind, and results that open where they live.

**Architecture:** Search stays one server boundary (ADR-0034). `services/workspace-search.ts` becomes the folder `services/workspace-search/` (same import path), split by kind: chats, documents (documents, pictures and videos, apps) and memory entries. A shared matcher (`$lib/shared/workspace-search-text.ts`) folds and splits text identically in the server and in the modal's highlighting. Long text is found by SQL `LIKE` with each word's typed, capitalised and upper-case spellings; short text (titles, names, prompts, descriptions, canvas words, memory entries) is matched in the server with full case and accent folding. No schema change: the full-text index (Stage B) gets its own plan after the owner's size check.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Drizzle on better-sqlite3 (bundled SQLite 3.53.2), Vitest, Playwright, Lucide icons, Biome, Fallow.

**Spec:** `docs/superpowers/specs/2026-11-23-workspace-search-revival-design.md`, with the approved mockups in `docs/design/workspace-search/`. An independent Opus review of the first draft (23 November 2026) is folded in.

## Global Constraints

- Before touching code, check the current docs for Svelte 5 runes, SvelteKit's `goto` (`replaceState`, `noScroll`, `keepFocus`), Vitest module mocks, Playwright route stubs and SQLite JSON functions (`json_valid`, `json_extract`, `json_each`), through Context7 or the official docs; say in the task report which were checked (root `AGENTS.md`).
- Build after the Memory redesign's part 1 (`docs/superpowers/plans/2026-11-23-memory-recall-part-1.md`) has merged: Task 6 reuses its newest-source-date rule.
- Search stays lexical and server-backed: no embeddings, no reranker, no schema change; the route is an adapter (ADR-0034, `CONTEXT.md`).
- Nothing a person cannot open is ever returned: another person's material, a deleted chat, an incognito chat's artifacts, a memory entry the Memory page hides, a project they do not own. No memory result for an account whose Memory is off or that is not on native Memory. Tables keyed by artifact (`image_descriptions`, `video_jobs`) are only ever read through the ownership-scoped artifact query, never by user alone.
- Memory is read through `memory-profile/native-read.ts` only.
- Matching: a result holds every word of the query in any of its matched fields; a query with no words after cleaning (for example "!!") shows the empty-query view; at least 2 characters, at most 8 words.
- Limits: "All" shows 3 per kind; a scope page holds 20; counts stop at 100 ("99+"); a candidate read stops at 400 rows of its own kind. Snippets are cut in SQL around the match, for the rows on the page only.
- Every new UI string in English and Hungarian, short natural Hungarian; kind badges reuse `artifacts.type.*`; the Feature Guide entry, `CONTEXT.md` and the folder `AGENTS.md` files that name the service change in this work.
- Icons come from `@lucide/svelte` only.
- Synthetic data only; test databases through `createInMemoryDatabase()` (`src/lib/server/db/in-memory.ts`). `npm run check` 0 errors and 0 warnings, Biome clean, no new Fallow finding, a build without warnings. Commit only your task's files (`git commit ... -- <paths>`). Nothing is pushed or deployed.

## Review Focus

1. **A Hungarian word with capitals** ("ÁRVÍZ", "Árvíz") in a message or a document: found through the capitalised spellings. Without accents ("arviz") it is found in titles, names, prompts, descriptions and memory now, and in long text after Stage B. Tests: Task 1 "folds case and accents"; Task 3 "finds an accented capital in a message body".
2. **Matches clustered in a few long chats:** counts and pages count chats, not messages. Test: Task 3 "counts chats, not messages".
3. **A memory entry that changed after it was found:** its link opens the scope's list with the search filled in and finding it. Test: Task 7 "falls back to the filled-in list when the entry has changed".
4. **Material a person cannot open:** a picture, video, canvas or app from an incognito chat, an artifact of a deleted chat, another person's entry, a project they do not own, a retired memory bank. Tests: Task 5's visibility tests and the containment test; Task 6 "skips a bank it cannot read".
5. **Memory switched off or a legacy account:** no memory results and no Memory chip. Tests: Task 6 "returns nothing when Memory is off"; Task 8 "hides the Memory chip when memory is not searchable".

## Order and parallel work

Tasks 1 to 6 run in order: Tasks 3, 5 and 6 all change `workspace-search/index.ts`, and 4 feeds 5. Task 7 touches only the Knowledge page and may run beside Tasks 3 to 6 in its own worktree, since the link's parameters are fixed here. Then Tasks 8, 9 and 10.

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
- `searchTerms`: fold the query, split on whitespace, trim each word's leading and trailing characters that are neither letters nor digits (`/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu`), drop empty and repeated words, keep the first `SEARCH_MAX_TERMS`, cut each to 64 characters. An empty result means the empty-query view.
- `typedSearchWords`: the same words in the same order, deduplicated by their folded form, but only `normalize("NFC")` and `toLowerCase()`, accents kept; the SQL `LIKE` clauses use these.
- `matchesAllTerms`: every term occurs in `foldForSearch(text)` as a substring; `false` for an empty term list.
- `matchRanges`: every occurrence of every term, as ranges of the original text (folded positions mapped back through a per-code-point index map), merged where they overlap, sorted.
- `searchSnippet`: `null` when there is no match; otherwise up to `maxChars` (default 160) characters of the original text around the earliest match, with "…" where cut, whitespace folded.

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
	expect(searchTerms("!!")).toEqual([]);
	expect(matchesAllTerms("anything", [])).toBe(false);
	expect(typedSearchWords('"ÁRVÍZ" kitchen árvíz arviz')).toEqual(["árvíz", "kitchen"]);
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

(`typedSearchWords('"ÁRVÍZ" kitchen árvíz arviz')` keeps the first spelling of each folded word: "árvíz" and "arviz" fold alike.)

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

**Interfaces:**
- Produces: the same import path, `$lib/server/services/workspace-search`, and the same exports. Later tasks add `types.ts`, `chats.ts`, `documents.ts` and `memories.ts` here.

- [ ] **Step 1: `git mv` both files and fix the relative imports inside them**

- [ ] **Step 2: Run the tests that import search**

Run: `npx vitest run src/lib/server/services/workspace-search src/routes/api/workspace-search src/lib/client/api/workspace-search.test.ts tests/cross-cutting/incognito-artifact-containment.test.ts && npm run check`
Expected: all PASS, nothing else changed.

- [ ] **Step 3: Commit**

```bash
paths=(src/lib/server/services/workspace-search src/lib/server/services/workspace-search.ts src/lib/server/services/workspace-search.test.ts)
git add -A "${paths[@]}"
git commit -m "Move Workspace Search into a folder before splitting it by kind" -m "The service is 913 lines and is about to gain memory, pictures, videos and apps; a folder keeps each kind in its own file under the same import path." -- "${paths[@]}"
```

---

### Task 3: The new contract, and chats matched by every word

**Files:**
- Create: `src/lib/server/services/workspace-search/types.ts` (the types now at the end of `index.ts`, plus the new ones)
- Create: `src/lib/server/services/workspace-search/chats.ts` (the chat loaders and scoring now in `index.ts`)
- Create: `src/lib/server/services/workspace-search/chats.test.ts`
- Modify: `src/lib/server/services/workspace-search/index.ts` and `index.test.ts`, `src/routes/api/workspace-search/+server.ts` and its test, `src/lib/client/api/workspace-search.ts` and its test

**Interfaces:**
- Produces, in `types.ts` (existing types keep their fields):

```ts
export type WorkspaceSearchKind = "chats" | "memory" | "documents" | "media" | "apps";
export type WorkspaceSearchScope = "all" | WorkspaceSearchKind;
export type WorkspaceSearchBadge =
	| "document" | "slides" | "canvas" | "app" | "image" | "video" | "uploaded" | "generated" | "report" | "skill_note";
export interface WorkspaceSearchMemoryResult {
	id: string;
	scope: { kind: "personal" } | { kind: "project"; projectId: string };
	projectName: string | null;
	text: string;
	lastSaidAt: string | null;
	href: string;
}
// WorkspaceSearchDocumentResult gains: searchKind: "documents" | "media" | "apps"; badge: WorkspaceSearchBadge;
//   originConversationTitle: string | null; preview: { src: string; width: number | null; height: number | null } | null;
//   durationMs: number | null
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
	documentOverflow: boolean; // removed in Task 8
	knowledgeHref: string | null; // removed in Task 8
}
export const SEARCH_ALL_PER_KIND = 3;
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_COUNT_CAP = 100;
export const SEARCH_CANDIDATE_CAP = 400;
```

- Produces: `searchWorkspace(userId: string, options: { query?: string | null; scope?: WorkspaceSearchScope; cursor?: string | null })`. A cursor is `"o:<offset>"`; an unreadable one counts as none. `searchTerms(query)` being empty selects the empty-query view.
- Produces, in `chats.ts`: `searchChats(userId: string, query: { terms: string[]; words: string[] }, window: { offset: number; limit: number }): Promise<{ results: WorkspaceSearchConversationResult[]; total: number }>`.
- The route reads `q` (or `query`), `scope` (one of the six, else `"all"`) and `cursor`; `fetchWorkspaceSearch(query, { scope?, cursor?, signal? })` sends them.

Chat matching, exactly:
- A chat matches when every word appears in its title, its project's name or any of its messages (different words may sit in different places).
- Per word, a SQL condition: the title or project name `LIKE` one of the word's spellings, or `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE <spelling>)`. A word's spellings are its `typedSearchWords` form, that form with its first letter upper-cased, and fully upper-cased (`toLocaleUpperCase`), as `LIKE '%…%'` with `%`, `_` and the escape character escaped.
- Over the person's visible conversations (today's ownership rules), the matching chats are counted with `LIMIT SEARCH_COUNT_CAP + 1` and paged with `ORDER BY` match strength (every word in the title first, then the title or project, then messages only), then `updated_at DESC`, then `id`. Each title is also confirmed with `matchesAllTerms` for highlighting.
- For a chat on the page that matched through messages only, one query reads its newest matching message's id and a snippet cut in SQL: `substr(content, max(1, instr(content, <spelling>) - 120), 320)` for the first spelling of the first word that `instr` finds. The row keeps `match.type: "body"` with that message's id.
- `scope: "all"` returns `SEARCH_ALL_PER_KIND` chats; `scope: "chats"` returns `SEARCH_PAGE_SIZE` from the cursor's offset, with `nextCursor` while more remain. In this task the other kinds keep today's results (`searchKind: "documents"`, `badge: "document"`, `originConversationTitle: null`, `preview: null`, `durationMs: null`; their `totals` are their returned counts), `memories` is empty and `memorySearchable` is `false`.

Of the moved mocked suite (`index.test.ts`), keep its default-mode, ownership and family-row cases; its phrase-matching and scoring cases are replaced by the real-database tests below.

- [ ] **Step 1: Write the failing tests** in `chats.test.ts`, on `createInMemoryDatabase()`:
  1. "finds a chat by its title with words in any order": title "Plan for the kitchen", query "kitchen plan" → found.
  2. "finds an accented capital in a message body": message "Árvíztűrő tükörfúrógép kell" in a chat titled "Gépek", query "árvíz" → found, the snippet holds "Árvíztűrő".
  3. "finds a word in the title and another in a message": title "Thesis", a message "dovetail joints", query "thesis dovetail" → found.
  4. "counts chats, not messages": 3 chats each holding 300 messages with "hello", and 40 more chats with one each → `total` is 43; `scope: "chats"` pages 20, 20 and 3.
  5. "stops counting at the cap": 150 chats each with one "hello" message → `total` is 100.
  6. "never returns another person's chat": the same text in another user's chat → not found.
  7. "treats a query of punctuation as no query": "!!" → the empty-query view.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/workspace-search/chats.test.ts`
Expected: FAIL.

- [ ] **Step 3: Move the types and the chat code, implement the matching, counting, paging and snippets, update the route and the client**

- [ ] **Step 4: Run the search tests and the check**

Run: `npx vitest run src/lib/server/services/workspace-search src/routes/api/workspace-search src/lib/client/api/workspace-search.test.ts src/lib/components/search && npm run check`
Expected: all PASS (the modal still reads `conversations` and `documents`).

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/workspace-search src/routes/api/workspace-search src/lib/client/api/workspace-search.ts src/lib/client/api/workspace-search.test.ts)
git add "${paths[@]}"
git commit -m "Match chats by every word, count chats, and cut snippets in SQL" -m "A query was one literal phrase over an unbounded scan of every message, returned whole on each keystroke. Chats now match every word in their title, project or messages, accented capitals included; counts and pages are of chats, so matches clustered in a few long chats no longer hide the rest; only the page's snippets are read." -- "${paths[@]}"
```

---

### Task 4: Read many documents in one pass

**Files:**
- Modify: `src/lib/server/services/knowledge/store/documents.ts`, `src/lib/server/services/knowledge/store.ts` (the facade)
- Test: `src/lib/server/services/knowledge/store/documents.batch.test.ts`

**Interfaces:**
- Produces: `getLogicalDocumentsForArtifacts(userId: string, artifactIds: readonly string[]): Promise<Map<string, KnowledgeDocumentItem>>`, exported through `knowledge/store.ts`. It reads the person's chats once for the whole batch and returns what `getLogicalDocumentForArtifact` would return for each id. The single reader is left as it is.
- Produces: `attachImagePreviews` exported (today private, `documents.ts:1230`).

- [ ] **Step 1: Write the failing tests**: "returns what the single reader returns, for every id" (30 synthetic artifacts of mixed kinds, compared item by item); "reads the person's chats once" (spy on the chat query).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/knowledge/store/documents.batch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the batch reader and export both functions**

- [ ] **Step 4: Run the knowledge tests and the check**, then commit

```bash
paths=(src/lib/server/services/knowledge/store/documents.ts src/lib/server/services/knowledge/store.ts src/lib/server/services/knowledge/store/documents.batch.test.ts)
git add "${paths[@]}"
git commit -m "Read many Knowledge documents in one pass" -m "Search materialised each candidate on its own, each one re-reading the person's chats; it is about to read up to 400 candidates per kind." -- "${paths[@]}"
```

---

### Task 5: Every kind of document, picture, video and app

**Files:**
- Create: `src/lib/server/services/workspace-search/documents.ts` (the document loaders and scoring now in `index.ts`, then the new kinds)
- Create: `src/lib/server/services/workspace-search/documents.test.ts`
- Modify: `src/lib/server/services/workspace-search/index.ts`, `tests/cross-cutting/incognito-artifact-containment.test.ts`

**Interfaces:**
- Consumes: `getLogicalDocumentsForArtifacts` and `attachImagePreviews` (Task 4); `buildArtifactCanonicalOwnershipCondition` (`knowledge/ownership.ts:121`); `getArtifactOwnershipScope`; `parseVideoTakeRequest` (`services/images/video/request.ts:172`).
- Produces: `searchDocuments(userId: string, query: { terms: string[]; words: string[] }, scope: WorkspaceSearchScope, window: { offset: number; limit: number }): Promise<{ results: WorkspaceSearchDocumentResult[]; totals: Pick<Record<WorkspaceSearchKind, number>, "documents" | "media" | "apps"> }>` and `searchKindAndBadge(item: KnowledgeDocumentItem): { searchKind: "documents" | "media" | "apps"; badge: WorkspaceSearchBadge }`.

`searchKindAndBadge`, exactly, first rule that applies:

| Item | searchKind | badge (its words) |
|---|---|---|
| artifact kind `app` | apps | `app` (`artifacts.type.app`) |
| artifact kind `image` | media | `image` (`artifacts.type.image`) |
| artifact kind `video` | media | `video` (`artifacts.type.video`) |
| an upload whose MIME type starts with `image/` | media | `image` |
| an upload whose MIME type starts with `video/` | media | `video` |
| artifact kind `slides` | documents | `slides` (`artifacts.type.slides`) |
| artifact kind `canvas` | documents | `canvas` (`artifacts.type.canvas`) |
| artifact kind `document` | documents | `document` (`artifacts.type.document`) |
| `documentOrigin` `skill_note` | documents | `skill_note` (`searchModal.badgeSkillNote`) |
| generated, `documentRole` starting with "Atlas research report" | documents | `report` (new `searchModal.badgeReport`) |
| generated | documents | `generated` (`searchModal.badgeGenerated`) |
| everything else | documents | `uploaded` (`searchModal.badgeUploaded`) |

Matched fields and candidate queries, each scoped in SQL by the person's ownership scope and `buildArtifactCanonicalOwnershipCondition` before `LIMIT SEARCH_CANDIDATE_CAP`, a word matching when one of its spellings (Task 3) is found in any of the item's fields:
- Every item: name, label and summary (never `documentRole`, which holds job ids).
- Text bodies (uploads' extracted text, generated files, Documents, Slides, Skill Notes): `content_text`. The JSON-bodied kinds (image, video, canvas, app) never match on `content_text`, as today's code keeps app and image out.
- A picture's prompt: `CASE WHEN json_valid(content_text) THEN json_extract(content_text, '$.prompt') END`.
- A canvas's words: every `text` and `label` string of its nodes (`json_each` over the body's node list, guarded by `json_valid`; confirm the path in `canvas.ts`/`canvas-body.ts`).
- A video's prompt: `EXISTS` over `video_jobs` of that artifact whose `request_json` holds the spelling; the hit is confirmed with `parseVideoTakeRequest(request_json).prompt` and `matchesAllTerms`.
- An uploaded picture's description: `EXISTS (SELECT 1 FROM image_descriptions d WHERE d.artifact_id = artifacts.id AND d.description LIKE <spelling>)`.
- Short fields, prompts, canvas words and descriptions are also confirmed with `matchesAllTerms` (folding accents); a text body is confirmed by its SQL condition and scored at least as a content match, so a word deep in a long body still counts.
- Then one `getLogicalDocumentsForArtifacts` call, `isArtifactCanonicallyOwned`, `searchKindAndBadge`, today's field scores (name 30, label 26, summary 14, content 10), recency for ties, totals per kind up to `SEARCH_COUNT_CAP`.
- For the rows on the page only: the origin chat's title (one batch read), a body snippet cut in SQL as in Task 3, `preview` from `attachImagePreviews` for a made picture, from the thumbnail rule the Knowledge list uses for an uploaded picture (`documentThumbnail`, `DocumentsList.svelte:984`; move that rule to a shared module if it lives in the component), and from the poster for a video (`posterFileId`, served with `?variant=poster`) with `durationMs` from its body.
- The empty-query view reads only the three newest visible documents through `getLogicalDocumentsForArtifacts`, never the whole library.

- [ ] **Step 1: Write the failing tests** in `documents.test.ts`, on `createInMemoryDatabase()` with synthetic artifacts written the way the existing knowledge and artifact tests write them:
  1. "classifies every kind": one item per row of the table above → its `searchKind` and `badge`.
  2. "finds a picture by its prompt, not by its JSON": prompt "timber house" → found by "timber"; not by "seed", "width" or "prompt".
  3. "finds a canvas by its words, not by its JSON": a node text "dovetail joints" → found by "dovetail"; not by "nodes" or "label".
  4. "finds a video by its prompt": a video job whose request's prompt says "turntable" → found by "turntable".
  5. "finds an uploaded picture by what Alfy saw in it": description "a red bicycle" → found by "bicycle", under `media`.
  6. "never searches an App's code": an App named "Countdown" whose body holds "useState" → not found by "useState".
  7. "keeps a research report under Documents with the Report badge", "a plain generated file gets the Generated badge", "never matches a report's job id".
  8. "a word deep in a long upload still counts": the word at character 50,000 → found.
  9. "every kind opens where it does today": each result's `href` equals the hand-off `href` today's search gives that item.
  10. "counts per kind": 3 pictures, 2 videos, 4 documents and 1 app matching → `totals` `{ media: 5, documents: 4, apps: 1 }`.

  In `incognito-artifact-containment.test.ts`: a picture, a video, a canvas and an app made in an incognito chat never come back from `searchWorkspace`, nor any artifact of a deleted chat, nor a description or video job of either.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/workspace-search/documents.test.ts tests/cross-cutting/incognito-artifact-containment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the classification, the candidate queries, the confirmations, the previews and the totals**

- [ ] **Step 4: Run the tests and the check**

Run: `npx vitest run src/lib/server/services/workspace-search src/lib/server/services/knowledge tests/cross-cutting/incognito-artifact-containment.test.ts && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/workspace-search tests/cross-cutting/incognito-artifact-containment.test.ts)
git add "${paths[@]}"
git commit -m "Search pictures, videos, apps and every document by what they hold" -m "Pictures, videos and apps were found by title only, video and canvas bodies matched as raw JSON, uploaded pictures' descriptions were never read, and every generated file was called a report. Each item now has one kind and badge, is matched through its own fields inside the ownership-scoped query, and its JSON never fills the candidate cap." -- "${paths[@]}"
```

---

### Task 6: Memory entries in search

**Files:**
- Create: `src/lib/server/services/workspace-search/memories.ts` and `memories.test.ts`
- Modify: `src/lib/server/services/memory-profile/native-read.ts` and `native-read.test.ts`
- Modify: `src/lib/server/services/memory-profile/publication.ts`
- Modify: `src/lib/server/services/memory-context/native.ts`
- Modify: `src/lib/server/services/workspace-search/index.ts`

**Interfaces:**
- Produces, in `publication.ts`: `entryLastSaidAt(sourceFactIds: readonly string[], factsById: ReadonlyMap<string, { source: { assertedAt: Date; explicitEditAt: Date | null } }>): string | null`, the rule part 1 wrote inline in `recallMemory` (the newest `explicitEditAt ?? assertedAt` among the entry's admitted facts, as ISO). `recallMemory` calls it instead of its copy.
- Produces, in `native-read.ts`: `readVisibleMemoryRows(userId: string, scope: MemoryScope)`, the per-bank read `listMemory` does before its query and paging (same checks: Memory on, native authority, bank access for the epoch, only the rows the page would show; one read of rows and one of admitted facts per bank), used by `listMemory` and by `searchMemoryEntries(userId: string, terms: readonly string[], window: { offset: number; limit: number; countCap: number }): { entries: Array<{ ref: MemoryRef; text: string; projectName: string | null; lastSaidAt: string | null }>; total: number; searchable: boolean }`.
- `searchMemoryEntries` searches the personal bank and every project bank of a project the person owns (each through `readMemoryScope`), matches each entry's display text with `matchesAllTerms`, orders by `lastSaidAt`, newest first, and counts up to `countCap`. A bank that throws (a retired or `repair_blocked` bank's `memory_fence_stale`, a stale generation) is skipped. `searchable` is `false`, with nothing searched, when the account is not on native Memory or Memory is off.
- `listMemory` matches its own search box with `searchTerms` and `matchesAllTerms` instead of the whole lowercase phrase, so the Memory page and the search find the same entries.
- Produces, in `memories.ts`: `searchMemories(userId, terms, query, window)`, mapping hits to `WorkspaceSearchMemoryResult` with `href` `/knowledge?tab=memory&memoryScope=personal&memoryEntry=<rowId>&memoryQuery=<query>`, or `memoryScope=project:<projectId>`, each value URL-encoded. These names are not among the Knowledge page's document parameters (`getKnowledgeTabFromUrl`, `(app)/knowledge/+page.svelte:205-222`), so the Memory tab opens.

- [ ] **Step 1: Write the failing tests**
  - `native-read.test.ts`: "searches every bank the person can see" (a personal and a project entry with "thesis" → both, with the project's name); "skips a project the person no longer owns"; "skips a bank it cannot read" (a retired bank → the others still answer); "returns nothing when Memory is off" (`searchable: false`); "hides an entry the page hides" (a revoked supporting fact → not found); "the Memory page finds words in any order" (`listMemory` with "kitchen plan" finds "Plan for the kitchen"); the existing `listMemory` tests still pass.
  - `memories.test.ts`: "links each entry to its place in Memory": the exact `href` for a personal and a project entry, the query encoded.
  - Part 1's `native.test.ts` still passes with `entryLastSaidAt`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-profile/native-read.test.ts src/lib/server/services/workspace-search/memories.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the shared rule, the visible-row read, the search reader, `listMemory`'s matching and the mapping; wire `memories`, `totals.memory` and `memorySearchable` into `searchWorkspace`**

- [ ] **Step 4: Run the tests and the check**

Run: `npx vitest run src/lib/server/services/memory-profile src/lib/server/services/memory-context src/lib/server/services/workspace-search && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/workspace-search src/lib/server/services/memory-profile/native-read.ts src/lib/server/services/memory-profile/native-read.test.ts src/lib/server/services/memory-profile/publication.ts src/lib/server/services/memory-context/native.ts)
git add "${paths[@]}"
git commit -m "Make Memory entries searchable from Workspace Search" -m "Memory lived only on its own page. Search now reads the entries the Memory page shows, across the personal bank and the person's own projects, skipping a bank it cannot read, with when each was last said and a link to its place in Memory; the page's own search finds words in any order too." -- "${paths[@]}"
```

---

### Task 7: Open a memory entry from a link

**Files:**
- Modify: `src/routes/(app)/knowledge/+page.svelte`
- Modify: `src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte`
- Modify: `src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts` (it exists, with 28 tests)

**Interfaces:**
- Consumes: the parameters fixed in Task 6: `tab=memory`, `memoryScope` (`personal` or `project:<id>`), `memoryEntry`, `memoryQuery`.
- Produces: `KnowledgeMemoryView` props `initialScope?: MemoryScope`, `initialEntryId?: string`, `initialQuery?: string`, read once (`untrack`) on mount.

Behaviour: the page passes the three props when `tab=memory` holds them. The view selects `initialScope` and looks for the row with the existing `findCurrentRow` (`KnowledgeMemoryView.svelte:392`), which pages past the first 50; when found it opens that row's detail as a click would, otherwise it shows the scope's list with its search set to `initialQuery`. The page then calls `goto("?tab=memory", { replaceState: true, noScroll: true, keepFocus: true })`, so a reload or Back shows the plain tab.

- [ ] **Step 1: Write the failing tests**: "opens the linked entry", including one past the first 50; "falls back to the filled-in list when the entry has changed" (no such row → the list, the search holding the query and finding the entry's words); "leaves the address at ?tab=memory" (assert the resulting URL, not the call).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run "src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts"`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the props, the page's parsing and the address cleanup**

- [ ] **Step 4: Run the tests and the check**, then commit

```bash
paths=("src/routes/(app)/knowledge/+page.svelte" "src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte" "src/routes/(app)/knowledge/_components/KnowledgeMemoryView.test.ts")
git add "${paths[@]}"
git commit -m "Let a link open one Memory entry" -m "The Memory page had no address for a single entry, and a q parameter turned the page to Documents. A link with its own parameters now opens the entry's detail, or the filled-in list when the entry has changed since, and leaves the address plain." -- "${paths[@]}"
```

---

### Task 8: The modal: chips, sections and rows

**Files:**
- Modify: `src/lib/components/search/search-scopes.ts`, `src/lib/components/search/SearchModal.svelte` and their tests
- Modify: `src/lib/utils/time.ts` and its test (an "ago" formatter)
- Modify: `src/lib/i18n/common.ts` (English near lines 300-351, Hungarian near 646-696)
- Modify: `src/lib/server/services/workspace-search/types.ts` and `index.ts` (drop `documentOverflow` and `knowledgeHref`)
- Modify: every test that selects the search box by its old label ("Search conversations and documents": four e2e specs and two unit tests; find them with `grep -rln "Search conversations and documents" src tests`)

**Interfaces:**
- Consumes: Tasks 3 to 6's response; `searchTerms` and `matchRanges` (Task 1).
- Produces, in `time.ts`: `formatAgo(isoOrUnix: string | number, options: { t: Translate; now?: number }): string`, with Part 1's day buckets in words: under a day `time.ago.today`, one day `time.ago.yesterday`, 2 to 13 days `time.ago.days`, 14 to 59 `time.ago.weeks` (days / 7), 60 to 729 `time.ago.months` (days / 30), 730 and more `time.ago.years` (days / 365).
- Produces, in `search-scopes.ts`: `SearchScopeId = WorkspaceSearchScope`; `SEARCH_SCOPE_ORDER = ["all", "chats", "memory", "documents", "media", "apps"]`; `buildSearchScopeChips(totals: Record<WorkspaceSearchKind, number>, memorySearchable: boolean): SearchScopeChip[]` (All's count is the sum of the kinds; the Memory chip is left out when `memorySearchable` is false; a count of 100 shows as "99+"); `rowMatchesScope` by row kind and `searchKind`. `isScopeAvailable` and every `connections` and `reports` path go.

Modal behaviour:
- Sections Chats, Memory, Documents, Pictures & videos, Apps, only when they have rows; under All, each with a "Show all N" link when its total is larger, which selects its chip.
- A chip fetches `scope=<kind>`; "Load more" fetches the next cursor and appends. On a phone the chosen chip scrolls into view in the sideways-scrolling chip row.
- A memory row: the entry's text in two lines, then `memoryNew.personal` or the project's name, then `searchModal.memorySaid` with `formatAgo(lastSaidAt)`. A picture or video row: a 48-pixel thumbnail from `preview`, and a video's duration. A document or app row: its badge, and "Made in “<chat>”" when `originConversationTitle` is set.
- Icons: chat `MessageSquare`, message match `TextSearch`, memory `Brain`, document `SquarePen`, slides `Presentation`, canvas `LayoutDashboard` (as `DocumentsList.svelte:135`), uploaded `FileUp`, generated `FileText`, report `BookOpen`, Skill Note `NotebookPen`, image `Image`, video `Film`, app `AppWindow`.
- Matched words are highlighted with `matchRanges`.
- The footer's count is the sum of the totals ("{results} results across {kinds} kinds").
- Removed: the Knowledge overflow row, the Reports section, and the keys `searchModal.currentConversation`, `scopeReports`, `scopeConnections`, `scopeConnectionsComingSoon`, `scopeComingSoon`, `reports`, `recentReports`, `viewAllDocuments`.

Words (key: English | Hungarian):

| Key | English | Hungarian |
|---|---|---|
| `searchModal.scopeConversations` | Chats | Beszélgetések |
| `searchModal.scopeMemory` | Memory | Memória |
| `searchModal.scopeMedia` | Pictures & videos | Képek és videók |
| `searchModal.scopeApps` | Apps | Alkalmazások |
| `searchModal.showAll` | Show all {count} | Mind a(z) {count} |
| `searchModal.loadMore` | Load more | Továbbiak |
| `searchModal.memorySaid` | said {ago} | {ago} |
| `searchModal.madeIn` | Made in “{chat}” | Itt készült: „{chat}” |
| `searchModal.badgeReport` | Report | Jelentés |
| the search box's label and placeholder | Search chats, memory, documents and more | Keresés a beszélgetésekben, az emlékekben, a dokumentumokban és máshol |
| `time.ago.today` | today | ma |
| `time.ago.yesterday` | yesterday | tegnap |
| `time.ago.days` | {count} days ago | {count} napja |
| `time.ago.weeks` | {count} weeks ago | {count} hete |
| `time.ago.months` | {count} months ago | {count} hónapja |
| `time.ago.years` | {count} years ago | {count} éve |

- [ ] **Step 1: Write the failing tests**
  - `time.test.ts`: `formatAgo` for 0, 1, 3, 14, 60 and 730 days in both languages.
  - `search-scopes.test.ts`: the chip order; "hides the Memory chip when memory is not searchable"; "shows 99+ at the cap"; "All is the sum".
  - `SearchModal.test.ts`: "draws no Connections chip"; "shows three per kind and a Show all link"; "Show all selects the kind's chip and fetches it"; "Load more appends the next page"; "draws a memory row with its scope and age"; "draws a picture row with its thumbnail and a video row with its duration"; "highlights words typed in another order"; "moves through every kind with the arrow keys".

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/components/search src/lib/utils/time.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the formatter, the scopes, the modal and the words; drop the two old response fields; update the label selectors in the six tests**

- [ ] **Step 4: Run the tests and the check**

Run: `npx vitest run src/lib/components src/lib/utils src/lib/server/services/workspace-search src/lib/client/api && npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/components src/lib/utils/time.ts src/lib/utils/time.test.ts src/lib/i18n/common.ts src/lib/server/services/workspace-search tests/e2e)
git add "${paths[@]}"
git commit -m "Redraw the search modal around every kind, with true counts" -m "The chips counted only loaded rows, 'Reports' held every generated file and 'Connections' could never be chosen. The modal now has a chip per kind with the server's counts, Memory, picture, video and app rows, Show all and Load more, and highlights words in any order." -- "${paths[@]}"
```

---

### Task 9: The guide, the glossary and the maps

**Files:**
- Modify: `src/lib/i18n/guide.ts` (`guide.entry.search.*`, English near lines 153-155, Hungarian near 330-332)
- Modify: `CONTEXT.md` (Workspace Search, Lexical Workspace Search, Workspace Search Eligibility, Result Limits, Scope, Document Eligibility)
- Modify: `src/lib/server/services/AGENTS.md` and `src/lib/server/services/knowledge/AGENTS.md` (they name `workspace-search.ts`)
- Modify: `docs/plans/feature-guide/inventory.md` (line 166)

- [ ] **Step 1: Change the words**
  - Guide, English: "Find any chat, memory, document, picture, video or app; Ctrl/⌘+K on a keyboard." Hungarian: "Bármelyik beszélgetést, emléket, dokumentumot, képet, videót vagy alkalmazást megtalálod; billentyűzeten Ctrl/⌘+K." The entry's `added` date stays.
  - `CONTEXT.md`: Workspace Search covers conversations, the Memory entries the Memory page shows, documents and files, pictures, videos and apps; Lexical Workspace Search finds every word typed, in any order, inside longer words, folding case (and accents in short text); Eligibility adds those Memory entries and still excludes raw memory internals and connections; Result Limits and Scope describe the chips, three per kind under All, twenty per page and the 99+ cap.
  - The two `AGENTS.md` files point at `services/workspace-search/`.
  - The inventory line: search has no Connections scope.

- [ ] **Step 2: Run the guide checks**

Run: `npx vitest run src/lib/components/guide src/lib/i18n`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
paths=(src/lib/i18n/guide.ts CONTEXT.md src/lib/server/services/AGENTS.md src/lib/server/services/knowledge/AGENTS.md docs/plans/feature-guide/inventory.md)
git add "${paths[@]}"
git commit -m "Say what Workspace Search finds now, in the guide, the glossary and the maps" -m "The Feature Guide said 'any chat or document', the glossary kept Memory out, and two folder maps named a file that is now a folder." -- "${paths[@]}"
```

---

### Task 10: End to end, and the gate

**Files:**
- Modify: `tests/e2e/search-modal.spec.ts` and its screenshot baselines

- [ ] **Step 1: Update the spec**
  - The chips test (line 299) expects All, Chats, Documents, Pictures & videos and Apps for the shared admin, which is not on native Memory, so no Memory chip; the "Connections greyed" test (line 312) becomes "draws no Connections chip".
  - "a memory result opens its entry": stub `/api/workspace-search*` to return one memory result and `/api/knowledge/memory*` the way `tests/e2e/memory-replacement.spec.ts:82-101` does; click the row; expect the Memory tab showing that entry's detail and the address `?tab=memory`. No real native account is created, so nothing leaks into later specs on the worker's database.
  - "a picture result shows its thumbnail": seed an Image item the way the `images*.spec.ts` files do and expect a row with an `img`.
  - "the chosen chip stays in view on a phone": a phone viewport, choose Apps, expect the chip inside the chip row's visible box.
  - The chip labels in Hungarian too (`setUiLanguage`).
  - Refresh the light and dark screenshot baselines (lines 221 and 249) and look at them before committing.

- [ ] **Step 2: Run the whole gate once**

Run: `scripts/gates.sh agent "$TMPDIR/alfyai-gates-search" --port 4720 tests/e2e/search-modal.spec.ts tests/e2e/login.test.ts tests/e2e/knowledge.spec.ts tests/e2e/memory-replacement.spec.ts` (another base port if 4720 is in use)
Expected: every step exits 0. A vitest file that times out under load is rerun alone before it counts as a failure.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/search-modal.spec.ts tests/e2e/search-modal.spec.ts-snapshots
git commit -m "Cover the revived search end to end" -m "The modal's chips, a memory result opening its entry, a picture row with its thumbnail and the chip row on a phone, on the production build, in both languages." -- tests/e2e/search-modal.spec.ts tests/e2e/search-modal.spec.ts-snapshots
```

---

Stage B (the full-text index, which brings accent folding and speed to long text) is not in this plan. It gets its own plan after the owner approves and reads the count-only size measurement described in the spec.
