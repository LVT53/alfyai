# Slice 7 — the Knowledge Documents tab and Workspace Search for every kind

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

> **Orchestrator amendment, 2026-09-25 — binding; it overrides the text below wherever they differ.**
> The agreed mockup (surfaces §4) shows exactly six chips, in this order: **All · Documents · Canvas · Apps ·
> Slides · Uploaded**. There is **no "file" chip**: a produced File (a `generated_output` row) is a file row like
> an upload, so it groups under **Uploaded** and keeps its file-format pill (PDF, DOCX…) — exactly the mockup's
> "Vienna trip summary.pdf · v2 · PDF" row, which is counted in its "12 uploaded". Ruling 46 is corrected to say so.
> Everywhere below, therefore:
> - drop `"file"` from `KIND_FILTERS`, `DocumentTypeFilter`, `DOCUMENT_TYPE_FILTER_ORDER` and the tests;
>   `documentTypeFilterFor` returns `"uploaded"` for every non-artifact row, generated or uploaded; drop the
>   `knowledge.documents.count.file` key;
> - chip order is `all, document, canvas, app, slides, uploaded`, and the summary line orders its non-zero buckets
>   `uploaded, document, canvas, app, slides` — both as the mockup shows them;
> - chip labels are the mockup's category nouns, not the singular `artifacts.type.*` labels. New keys:
>   `knowledge.documents.filter.document` "Documents" / "Dokumentumok", `…filter.canvas` "Canvas" / "Táblák",
>   `…filter.app` "Apps" / "Alkalmazások", `…filter.slides` "Slides" / "Diasorok" (`…filter.all` and
>   `…filter.uploaded` as in §i18n). A row's Type pill keeps the singular `artifacts.type.*` label, as the
>   mockup's CANVAS / DOCUMENT / APP / SLIDES pills do;
> - sequencing (this spec's Risks, question 1): there is no constraint against Slice 4 — no artifact of a kind can
>   exist before that kind's slice lets Alfy create it (ruling 43), so Slice 7 lands in wave 3 beside Slice 4, and
>   slice 0's no-loader fallback stays the safety net.

**Goal:** Two existing surfaces — the Knowledge page's Documents tab and Workspace Search — today know about
uploaded documents, produced files and Skill Notes only. This slice teaches both to also list, filter, search
and open the four artifact-family kinds Document, App, Canvas and Slides (`type: "artifact"` rows, slice 0's
`ArtifactKind` union) alongside what already works, with **no regression** to the rows and behaviour that
already render. Surfaces mockup §4 ("Knowledge Base — the Documents tab, all five kinds in one list") and §6
("Workspace Search — every kind is findable") are the design target; ruling 46 is the mandate; slice 0's
non-goal line ("No Knowledge-page listing change and no new search scope") stays true *of slice 0* and becomes
false here, on purpose.

**Architecture:** Both surfaces already read library rows through one substrate —
`src/lib/server/services/knowledge/store/documents.ts` — confirmed by its own module note in
`src/lib/server/services/knowledge/AGENTS.md`: *"Workspace Search... composes logical document listing/search
from `knowledge/store/documents.ts`"*. That substrate is built entirely around the **old** four-value
`ArtifactType` union (`source_document | normalized_document | generated_output | skill_note`) and a
family-bundling model (source ↔ normalized pairing, generated-output grouping by `documentFamilyId`) that has
no meaning for the new artifact family: a Document/App/Canvas/Slides row (`type: "artifact"`) is never paired
with a sibling, and its version history lives in the new `artifact_versions` table, not in `documentFamilyId`.
Rather than forcing the new family through that machinery, this slice adds a **second, much simpler read path**
for `type: "artifact"` rows — no family bundling, no derived-link walk, one row in, one row out — and **merges**
the two paths' results at the `KnowledgeDocumentItem` level, in exactly the places that already fan out to both
surfaces:

- **Listing** (`listLogicalDocumentsPage`) feeds both the Documents tab (`getKnowledgeLibraryPage`) and
  Workspace Search's empty-query "recent" view (`loadDefaultDocuments`) — one merge, two surfaces, for free.
- **Resolving one artifact-family id back into a document** (`getLogicalDocumentForArtifact`) is the *one*
  choke point for three callers: Workspace Search's typed-query candidate expansion
  (`workspace-search.ts:659`), the Knowledge page's URL-handoff fallback
  (`resolveKnowledgeWorkspaceDocument` → `/api/knowledge/documents/resolve` →
  `fetchKnowledgeWorkspaceDocument` → `KnowledgeWorkspaceCoordinator.svelte`'s `openHandoffDocument`), and —
  incidentally, out of this slice's scope but worth naming — Slice 5's project bundle
  (`project-knowledge.ts:536`). One new, self-contained early branch here repairs all three call sites at once.
- **Opening** a listed row reuses the **existing** open path end to end. `KnowledgeDocumentItem` already flows
  through `toWorkspaceDocument()` into a `DocumentWorkspaceItem`, which slice 0 already extended with
  `kind?: ArtifactKind` for exactly this purpose (`plan.md` decision 18). This slice adds the one missing link —
  `toWorkspaceDocument()` learns to read `kind` off the source row — and the panel (`DocumentWorkspace.svelte`,
  **not touched by this slice**) does the rest per slice 0's own contract. No new modal, no second preview path.

The corollary, worth stating up front because it changes how this slice is scheduled: **it touches none of
Feature 2's serialized hot files.** Not `schema.ts` (no new table, no migration), not
`services/artifacts/index.ts` (this slice never imports from the `artifacts/` service boundary — it reads the
`artifacts` table the same way `workspace-search.ts` and `knowledge/store/documents.ts` already do for every
other row type), not `artifact-bodies.ts`, not `DocumentWorkspace.svelte`, not
`chat/[conversationId]/+page.svelte`, not `i18n/artifacts.ts` (this slice **consumes** `artifacts.type.*`,
read-only, and adds none of its own kind words — ruling 22). Its only dependency on the rest of Feature 2 is a
**read-only type dependency**: `ArtifactKind` (`src/lib/shared/artifacts/kinds.ts`) and `ArtifactType` gaining
the `"artifact"` member (`knowledge/types.ts:12-17`, per slice 0's contract). Both are Slice 0's; this file is
written against `slice-0.md`'s contracts and neither has been verified against Slice 0's actual merged code,
because Slice 0 is being implemented on another branch concurrently — **every claim in this file about a
slice-0 symbol is marked "per slice-0.md, unverified in this tree" and must be re-confirmed against the real
`src/lib/server/services/artifacts/` and `src/lib/shared/artifacts/kinds.ts` before Task 1 starts.**

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, Drizzle ORM on better-sqlite3 (read paths only — no schema change,
no migration in this slice), Vitest, Playwright, Biome. No new runtime dependency.

**Spec pointers:**
[`claude-at-home-2-artifact-surfaces-mockups.html`](../claude-at-home-2-artifact-surfaces-mockups.html) §4 and
§6 (exact row anatomy, quoted throughout below); [`decisions.md`](./decisions.md) rulings 10, 15, 18, 20, 22, 26,
31, 43–46 (46 is this slice's mandate; 18 is why File needs no new code here; 20 and 22 are the naming rules
every new label in this file follows); [`working-plan.md`](./working-plan.md) §5 (file ownership / landing
order) and §1 (global run constraints — Node 22, branch hygiene, ports); [`slice-0.md`](./slice-0.md) `§The
boundary`, `§The File kind is generated_output`, `§The panel`, `§i18n` (the contracts this slice builds on);
[`slice-5.md`](./slice-5.md) `§The project bundle` (the closest sibling surface — its row vocabulary,
`artifacts.bundle.*`, is echoed, not duplicated, below); [`docs/plans/claude-at-home-1/slice-F.md`](../claude-at-home-1/slice-F.md)
(house format model); [`deepen-brief.md`](./deepen-brief.md) (what "implementation-ready" means).

## Global Constraints

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- **"Artifact" is never shown in the UI.** Every new label routes through the shared `artifacts.type.*` family
  (Document/Dokumentum, App/Alkalmazás, Canvas/Tábla, Slides/Diasor, File/Fájl — owned by slice 0, ruling 22)
  or a new, both-language `knowledge.documents.*` / `searchModal.*` key added in this slice. No new type-label
  family is created — ruling 22 forbids a second one.
- **No new migration, no schema change.** This slice reads existing columns (`artifacts.type`,
  `artifacts.metadata_json`, `artifacts.name`, `artifacts.content_text`, `artifacts.summary`,
  `artifacts.conversation_id`, `artifacts.created_at`, `artifacts.updated_at`) through the existing `artifacts`
  table. `npm run check:migrations` must stay green with **zero diff**.
- **No new route.** Every change lands inside existing service functions and existing routes' existing
  behaviour (`GET /api/knowledge` list load via `+page.server.ts`, `GET /api/workspace-search`,
  `GET /api/knowledge/documents/resolve`). If a task in this file seems to need a new route, stop and recheck
  the Contracts section below — it was designed specifically to avoid that.
- **Every new or widened query stays ownership- and incognito-scoped through the existing machinery.**
  `getArtifactOwnershipScope`, `buildArtifactVisibilityCondition`, `buildArtifactCanonicalOwnershipCondition`
  and `isArtifactCanonicallyOwned` (all in `src/lib/server/services/knowledge/store/core.ts:141-246`) are
  **reused exactly as every other row type already uses them** — this slice adds no new scoping rule and no new
  exemption. `tests/cross-cutting/incognito-artifact-containment.test.ts` PART B must stay green with **no new
  entry in `ALLOWED_WITHOUT_SCOPE`** (`:529-546`).
- **Zero behaviour change for existing rows.** Every touched shared function (`getLogicalDocumentForArtifact`,
  `listLogicalDocumentsPage`, `scoreDocument`, `getDocumentKind`, `toWorkspaceDocument`) gets a **pure addition**
  — an early-return branch guarded on `type === "artifact"` or `document.kind` being set — never a restructure
  of the path an uploaded document, a produced file or a Skill Note already takes. A reviewer should be able to
  diff every touched function and see the old code path byte-identical below the new branch.
- **i18n:** every new key exists in English and natural Hungarian in the same commit. New knowledge-page keys
  live in `src/lib/i18n/knowledge.ts` (the file that already owns `knowledge.*`); no new key is added to
  `src/lib/i18n/common.ts` or `src/lib/i18n/artifacts.ts` — see `§i18n` below for why neither is needed.
- **Icons:** Lucide via `@lucide/svelte` only, per the repo-wide rule. `AppWindow`, `Presentation` and
  `SquarePen` are already vetted for this feature by slice 0's own Global Constraints (`slice-0.md:61-64`,
  `package.json:63`, `@lucide/svelte` 1.17.0). `LayoutDashboard` (Canvas) is **not** on slice 0's vetted list —
  it is the icon the mockup itself uses for Canvas throughout §4–§6 and it exists in `@lucide/svelte` 1.17.0;
  confirm it against `node_modules/@lucide/svelte`'s exports before using it (Task 3, step 1).
- **Commits:** small, focused, explaining *why*; stage by explicit path; never bare `git stash`; end every
  message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Never push.
- **`npm run lint` is broken** by nested worktrees — run `npx biome check src scripts tests` and say so in the
  report.
- **Dependency on Slice 0 (and, loosely, Slices 1–4):** this slice cannot be implemented before Slice 0 merges
  (`ArtifactKind`, `ArtifactType` gaining `"artifact"`, and the panel's `kind`-dispatch all have to exist for
  a listed/found row to be *openable*, even though this slice's own files never touch the panel). It can be
  implemented **before** Slices 1–4 merge — a kind with no registered editor body yet still lists, still shows
  its type chip and Version column, and still opens (to whatever slice 0's own "no loader registered" fallback
  renders — see *Risks*). Verify `src/lib/shared/artifacts/kinds.ts`, `src/lib/server/services/knowledge/types.ts`'s
  `ArtifactType` union, and `src/lib/server/services/artifacts/index.ts`'s existence before Task 1, step 1.

## Gates

Every gate is a **must-pass** for the slice; the reviewer runs them against the final commit.

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check                     # pass = 0 errors, 0 warnings
npx biome check src scripts tests # pass = 0 diagnostics (`npm run lint` is broken by nested worktrees)
npm test                          # pass = 0 failed, 0 skipped-without-reason; record the counts
npm run build                     # pass = 0 warnings
npm run check:migrations          # pass = green, ZERO diff (this slice adds no table)
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Playwright for this slice (`E2E_PORT=5480`):

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export E2E_PORT=5480
npx playwright test tests/e2e/knowledge.spec.ts tests/e2e/search-modal.spec.ts \
  tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts
```

## Review Focus

1. **Pagination/total-count disagreement across the merged two-source list.** This exact bug class already
   shipped once and was fixed with a dedicated regression test —
   `src/lib/server/services/knowledge/store/logical-document-page-total.test.ts`'s header explains it: rows
   filtered one way, the count computed another, "the library claimed more documents than it could page
   through." Merging a second source **doubles** the surface for that bug. Task 1 adds a mixed-row-type sibling
   test to that exact file, not a new one, so the two totals stay next to each other.
2. **Ownership and incognito on every new branch.** An artifact-family row must never appear from outside its
   conversation's scope, never for another user, and never for an incognito conversation the caller is not
   inside. An artifact whose owning conversation has been deleted must become invisible, exactly like a
   `generated_output` row does today (see *Contracts → eligibility*, this is inherited behaviour, not new
   logic — verify the inheritance rather than re-deriving the rule).
3. **An App's raw HTML body must never leak into a search match reason or a rendered snippet.** `scoreDocument`'s
   per-family content-scoring loop must skip App-kind rows (`§Contracts → workspace-search.ts`); the Documents
   tab's own search never reads body content for any kind (old or new), so it has no equivalent risk — confirm
   that stays true.
4. **Zero regression for uploaded, produced and Skill Note rows.** Every touched function's old path must be
   byte-identical below the new guard. Run the full existing suites for `documents.ts`, `workspace-search.ts`,
   `documents-table.ts`, `DocumentsList.svelte`, `SearchModal.svelte` before touching anything, and diff their
   pass counts after.
5. **No user-visible "Artifact."** Grep the diff for the literal word in any string literal reachable by `$t(...)`,
   any `aria-label`, any `title` attribute.
6. **Two different "kind" vocabularies must not collide.** `SearchRowKind` (`"conversation" | "document" |
   "knowledge-overflow"`, `search-scopes.ts:42`) is the search-modal's row-category concept and is **untouched**
   by this slice. `ArtifactKind` (`"document" | "app" | "canvas" | "slides" | "file"`) is the new artifact-family
   concept, carried as `KnowledgeDocumentItem.kind` / `WorkspaceSearchDocumentResult.kind`. A `document`-scoped
   `SearchRowKind` row can have any `ArtifactKind` or none; they are never the same field and never read from
   each other.
7. **Two different "version" vocabularies must not collide.** `KnowledgeDocumentItem.versionNumber` (existing,
   paired with `documentFamilyId`/`isOriginal`) is the **extraction-quality re-parse family** — unrelated,
   pre-existing, and never touched by this slice. `KnowledgeDocumentItem.artifactVersionNumber` (new) is the
   artifact family's own edit-history counter, sourced from `ArtifactCardSummary.versionNumber` (slice 0,
   `artifact_versions.version_number`). A row never has both populated; `deriveArtifactVersionBadge` and
   `deriveDocumentVersion` are two separate functions, each reading only its own field.

---

## Contracts

Everything in this section is a contract for the Tasks below. Where a claim depends on a slice-0 symbol that is
not yet in this tree, it says so.

### Shared kind vocabulary this slice consumes, not owns

```ts
// src/lib/shared/artifacts/kinds.ts — slice 0 creates this; PER SLICE-0.MD, UNVERIFIED IN THIS TREE.
export type ArtifactKind = "document" | "app" | "canvas" | "slides" | "file";
```

```ts
// src/lib/server/services/knowledge/types.ts — slice 0 adds "artifact" to this union
// (slice-0.md §The boundary: "the row is written with type: 'artifact'"; working-plan.md §5 confirms
// slice 0 owns this exact edit). PER SLICE-0.MD, UNVERIFIED IN THIS TREE — today this union is:
export type ArtifactType =
	| "source_document"
	| "normalized_document"
	| "generated_output"
	| "skill_note"
	| "work_capsule";
// After slice 0: adds "artifact".
```

This slice imports `ArtifactKind` type-only wherever it needs it (browser and server files alike — the shared
module carries no runtime import, per slice 0's own note, so this is safe from every layer) and never redeclares
a kind union, a kind label, or a kind→icon mapping that duplicates one already owned by slice 0's
`src/lib/i18n/artifacts.ts` (`artifacts.type.*`).

### `src/lib/server/services/knowledge/types.ts` — `KnowledgeDocumentItem` gains two fields

```ts
export interface KnowledgeDocumentItem {
	// … every existing field unchanged (types.ts:90-128) …

	/**
	 * Set only for the new artifact family (Document/App/Canvas/Slides — never
	 * "file": a produced file stays on the existing generated/uploaded path
	 * below, ruling 18). Undefined for every row this app already knew about.
	 * Read from `metadata_json.artifactType` via `parseArtifactFamilyKind`
	 * (store/documents.ts) — never re-derived elsewhere.
	 */
	kind?: ArtifactKind;

	/**
	 * The artifact family's OWN version counter — `ArtifactCardSummary.versionNumber`
	 * (slice 0, backed by `artifact_versions.version_number`). Populated only
	 * when `kind` is set. This is NOT the same concept as `versionNumber` above
	 * (the pre-existing extraction-quality re-parse family, paired with
	 * `documentFamilyId`/`isOriginal`) — the two must never be read
	 * interchangeably. See Review Focus #7.
	 */
	artifactVersionNumber?: number | null;
}
```

`type ArtifactKind` is imported type-only from `$lib/shared/artifacts/kinds`.

### `src/lib/server/services/knowledge/store/documents.ts`

**`parseArtifactFamilyKind`** — a small, local, defensive parse. Not imported from
`src/lib/server/services/artifacts/`: that facade's public contract (`slice-0.md §The boundary`'s "Public
functions" table) does not list a kind-parsing helper as exported, so this slice does not take a dependency on
an internal of another slice's module it cannot verify. *If, once Slice 0 is merged, `artifacts/index.ts` does
export an equivalent (e.g. `kindForArtifactRow`/`parseArtifactMetadata`), prefer it and delete this copy —
check the facade's actual exports before Task 1, step 3.*

```ts
/** Reads `metadata_json.artifactType`, validated against the known kinds. Never throws. */
function parseArtifactFamilyKind(metadataJson: string | null): ArtifactKind | null {
	const metadata = parseJsonRecord(metadataJson ?? null);
	const value = metadata?.artifactType;
	return value === "document" || value === "app" || value === "canvas" || value === "slides"
		? value
		: null;
	// Deliberately never returns "file": a `type: "artifact"` row's kind is always
	// one of the four family kinds; "file" only ever comes from a `generated_output`
	// row on the EXISTING path below, via `getLogicalDocumentKind`.
}
```

**`getLogicalDocumentForArtifact`** gains one new branch, tried **before** the existing four-type lookup
(`documents.ts:843-923`) so the old path is untouched:

```ts
export async function getLogicalDocumentForArtifact(
	userId: string,
	artifactId: string,
): Promise<KnowledgeDocumentItem | null> {
	const trimmedArtifactId = artifactId.trim();
	if (!trimmedArtifactId) return null;

	const ownershipScope = await getArtifactOwnershipScope(userId);

	// NEW: the artifact family has no source/normalized pairing and no
	// derived-link walk — one row in, one row (or null) out.
	const familyRow = await selectSingleArtifactFamilyRow({
		artifactId: trimmedArtifactId,
		userId,
		ownershipScope,
	});
	if (familyRow) return familyRow;

	// … existing source_document / normalized_document / generated_output /
	// skill_note lookup, byte-identical (documents.ts:850-923) …
}
```

`selectSingleArtifactFamilyRow` selects the one row (`eq(artifacts.id, artifactId)`, `eq(artifacts.type,
"artifact")`, `buildArtifactVisibilityCondition({userId, ownershipScope})`), returns `null` on no match or a
failed `isArtifactCanonicallyOwned` check, and otherwise maps it through `mapArtifactFamilyRow` (below). This
one branch repairs, for free: Workspace Search's typed-query candidate expansion
(`workspace-search.ts:659`), the Knowledge page's URL-handoff resolve route (`/api/knowledge/documents/resolve`
→ `resolveKnowledgeWorkspaceDocument`, `knowledge.ts:292-297`, a one-line wrapper over this same function), and
— outside this slice's scope, noted for the record — Slice 5's project bundle (`project-knowledge.ts:536`).

**`mapArtifactFamilyRow`** — the artifact-family row → `KnowledgeDocumentItem` mapper. No second DB round trip:
every field it needs is already on the row selected via `knowledgeArtifactListSelection`
(`store/core.ts:95-108`, which already includes `id, name, type, mimeType, sizeBytes, conversationId, summary,
metadataJson, createdAt, updatedAt` — everything but `contentText`, which only the Workspace Search candidate
loader needs, see below).

```ts
function mapArtifactFamilyRow(
	row: LogicalDocumentArtifactRow,
	versionNumber: number | null,
): KnowledgeDocumentItem {
	const kind = parseArtifactFamilyKind(row.metadataJson ?? null) ?? "document"; // never throws; "document" is
	// the honest default for a row this slice cannot classify — it still lists and opens, just with a guessed chip.
	return {
		id: row.id,
		type: "artifact",
		displayArtifactId: row.id,
		promptArtifactId: null,           // no "What AI sees" duality — see DocumentsList §Contracts
		familyArtifactIds: [row.id],       // itself only; no source/normalized pairing
		name: row.name,
		mimeType: null,
		sizeBytes: null,                   // "size" is not a meaningful concept for a live-edited artifact; see UI states
		conversationId: row.conversationId,
		summary: null,
		normalizedAvailable: false,
		kind,
		artifactVersionNumber: versionNumber,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}
```

`versionNumber` is read the same way `ArtifactCardSummary.versionNumber` is documented to work in
`slice-0.md §The boundary`: the newest `artifact_versions` row for this artifact id, or `0`/`null` if none has
been written yet. **This slice does not query `artifact_versions` directly** — it is not this slice's table to
own a second reader for. Instead `mapArtifactFamilyRow`'s caller batches one query:
`SELECT artifact_id, MAX(version_number) FROM artifact_versions WHERE artifact_id IN (...) GROUP BY artifact_id`
(mirroring the batching style `attachExtractionJobs`, `knowledge.ts:205-237`, already uses for the extraction
ledger — one query per page, not one per row). *If Slice 0's facade later exposes a batched version-number
reader, prefer it — check before Task 1, step 4.*

**`listLogicalDocumentsPage`** — both branches gain the merge. `LogicalDocumentPageOptions` gains one field:

```ts
export interface LogicalDocumentPageOptions {
	includeGeneratedOutputs?: boolean;
	query?: string;
	sortKey?: LogicalDocumentSortKey;
	sortDirection?: LogicalDocumentSortDirection;
	offset?: number;
	limit?: number;
	/** Narrow to one kind bucket. Omitted (or "all", client-side only — see
	 *  documents-table.ts) means every kind. */
	kindFilter?: KnowledgeDocumentKindFilter;
}

/** The six buckets the Documents tab can filter by. "all" is a client-only
 *  concept (§documents-table.ts) — passing it here is a bug, not a no-op. */
export type KnowledgeDocumentKindFilter = ArtifactKind | "uploaded";
```

`LogicalDocumentPageResult` gains one field, computed once per call and independent of `kindFilter` and `offset`
/`limit` — it always answers "how many of each kind does the *unfiltered, un-paginated* candidate set have",
because that is what a chip's own count and the summary line both need (§`DocumentsList.svelte` below):

```ts
export interface LogicalDocumentPageResult {
	documents: KnowledgeDocumentItem[];
	totalItems: number;
	/** Counted after the current `query` is applied (so the numbers move as the
	 *  user types) but BEFORE `kindFilter` is applied (so switching chips never
	 *  changes the other chips' own numbers). */
	countsByKind: Record<KnowledgeDocumentKindFilter, number>;
}
```

**Algorithm — both branches of `listLogicalDocumentsPage` (the `!query && sortKey === "date"` SQL-fast-path at
`documents.ts:731-784`, and the full-fetch "search relevance" path at `documents.ts:786-841`) are unified into
one shape.** The existing code scores-then-sorts in one of two modes — relevance order when `query` is non-empty
(`sortLogicalDocumentRecordEntries` puts score first), or plain `sortKey`/`sortDirection` order when it is not —
and maps `LogicalDocumentRecord → KnowledgeDocumentItem` only as the very last step, after sorting and slicing.
The merge below keeps that same two-mode rule, but maps **both** sources to `KnowledgeDocumentItem` (plus a
score) before the one final sort, so a single comparator can order the union — mapping earlier than today costs
nothing extra (the map is a pure, cheap object-shape transform) and is what makes a single sort over both sources
well-defined:

1. Fetch the **existing four-type candidate set** exactly as today up to and including its own scoring
   (`buildArtifactVisibilityCondition` + `inArray(artifacts.type, [...])`, `isArtifactCanonicallyOwned` filter,
   `buildLogicalDocumentRecordsFromRows`, then `scoreLogicalDocumentRecordForSearch(record, query)` when `query`
   is non-empty or a constant `1` when it is not, exactly as `documents.ts:786-841` already computes it) —
   unchanged code, unchanged per-record score. Map every `{record, score}` pair to `{item: mapLogicalDocumentItem(record), score}`.
2. Fetch the **artifact-family candidate set**: `eq(artifacts.type, "artifact")` +
   `buildArtifactVisibilityCondition({userId, ownershipScope})`, post-filtered by `isArtifactCanonicallyOwned`
   — same two-step ownership pattern every other query in this file already uses. Map each row through
   `mapArtifactFamilyRow` (batching the version-number lookup as above), then score it: `query` non-empty →
   `scoreArtifactFamilyRowForSearch(item, query)`, a new, deliberately shallow scorer that checks **`name` only**
   — matching the Documents tab's existing search depth for every other kind (title/label/role/summary, never
   body content; `scoreLogicalDocumentRecordForSearch` doesn't read `contentText` either, `documents.ts:213-241`
   — this slice does not deepen the Documents tab's search, only widens which kinds it covers); `query` empty →
   the same constant `1`.
3. If `query` is non-empty, drop every zero-score entry from **both** `{item, score}[]` sets (mirroring
   `documents.ts:828`'s existing `.filter((entry) => !query || entry.score > 0)`).
4. Compute `countsByKind` by tallying both (now query-filtered, not yet `kindFilter`-filtered) sets by bucket —
   `item.kind ?? (getLogicalDocumentKind(item) === "generated" ? "file" : "uploaded")` for the legacy set.
   `getLogicalDocumentKind` (the existing three-way classifier at `documents.ts:189-202`) takes
   `Pick<KnowledgeDocumentItem, "documentOrigin" | "type">`, and `mapLogicalDocumentItem` already copies both
   fields onto the mapped item unchanged, so this reads the item directly — no need to keep the pre-map record
   around past step 1. `item.kind` directly for the family set (always set, never `undefined`, by
   `mapArtifactFamilyRow`).
5. If `kindFilter` is set, drop every entry whose bucket (computed the same way as step 4) doesn't match. This
   step runs strictly **after** `countsByKind`, never before — a chip's own count must never move when that same
   chip is clicked.
6. Concatenate the two `{item, score}[]` sets into one array and sort it **once**, with a single rule that
   replicates the existing dual mode rather than re-deriving a third one: `query` non-empty → sort by `score`
   descending, tie-broken by `compareKnowledgeDocumentItems(left.item, right.item, "date", "desc")`; `query`
   empty → sort by `compareKnowledgeDocumentItems(left.item, right.item, sortKey, sortDirection)` directly.
   `compareKnowledgeDocumentItems` is a new, small, server-side function mirroring the existing tie-break
   discipline (`compareLogicalDocumentText` + name → `updatedAt` desc → `id` asc, `documents.ts:243-249`)
   generalised to read `KnowledgeDocumentItem` fields directly, since both mapped sets already share that shape.
   It does not import or reuse `documents-table.ts` (browser-only) — it is a new, small, server-side twin, not a
   cross-layer import.
7. `totalItems = merged.length`; return `{ documents: merged.slice(offset, offset + limit).map(({item}) => item), totalItems, countsByKind }`.

**This retires the SQL-side `LIMIT`/`OFFSET` fast path** (`documents.ts:731-784`) for the no-query/date-sort
case: once a second source must be merged, a SQL `LIMIT`/`OFFSET` on only one of the two sources cannot produce
a correct page of the union, so both paths now always fetch their full ownership-scoped candidate set and
sort/slice in memory — exactly what the *existing* search-relevance branch already does today for the old
family alone (`documents.ts:786-841`), just applied unconditionally. This is a deliberate, reasoned trade
(*Risks* has the perf note and the fallback if it's ever wrong in practice), not an oversight: AlfyAI is a
self-hosted, one-user-per-account app, and `KNOWLEDGE_LIBRARY_MAX_PAGE_SIZE` (100) already bounds what's
*returned* — this change only removes a bound on what's *fetched before sorting*, for a table that, in this kind
of deployment, realistically holds a few hundred rows at most.

### `src/lib/server/services/knowledge.ts`

`getKnowledgeLibraryPage` threads `kindFilter` through unchanged otherwise, and `KnowledgeLibraryPage` grows the
one new field:

```ts
export interface KnowledgeLibraryPageOptions {
	query?: string | null;
	sortKey?: KnowledgeLibrarySortKey | null;
	sortDirection?: KnowledgeLibrarySortDirection | null;
	page?: number | null;
	pageSize?: number | null;
	kindFilter?: KnowledgeDocumentKindFilter | null;
}

export interface KnowledgeLibraryPage {
	documents: KnowledgeLibraryDocumentItem[];
	query: string;
	sort: { key: KnowledgeLibrarySortKey; direction: KnowledgeLibrarySortDirection };
	pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
	countsByKind: Record<KnowledgeDocumentKindFilter, number>;
}
```

`attachExtractionJobs` (`knowledge.ts:205-237`) is untouched: `isExtractableLibraryDocument` already excludes any
row whose `documentOrigin` isn't `"uploaded"`/undefined-and-`source_document`-shaped, and an artifact-family row
has neither, so it is already correctly skipped with zero code change — verify this with a test rather than
trust it (Task 1).

### `src/lib/server/services/workspace-search.ts`

`WorkspaceSearchDocumentResult` gains one field, passed through by `mapDocumentResult`
(`workspace-search.ts:612-641`) exactly like every other field already is:

```ts
export interface WorkspaceSearchDocumentResult {
	// … every existing field unchanged (workspace-search.ts:801-828) …
	kind?: ArtifactKind;
}
```

**`loadDefaultDocuments`** (the empty-query "recent" view, `workspace-search.ts:701-716`) needs **no code
change** — it already calls `listLogicalDocumentsPage(userId, {includeGeneratedOutputs: true, ...})` with no
`kindFilter`, so Task 1's merge lands the new kinds in its result automatically. Verify this with a test, don't
just trust the wiring (Task 2).

**`searchDocuments`** (the typed-query path, `workspace-search.ts:643-699`) needs one new candidate loader,
parallel to the two it already runs:

```ts
async function loadMatchingArtifactFamilyCandidateRows(
	userId: string,
	query: string,
	ownershipScope: ArtifactOwnershipScope,
): Promise<KnowledgeDocumentItem[]> {
	const likeQuery = `%${escapeLike(query.toLowerCase())}%`;
	const rows = await db
		.select({ /* knowledgeArtifactListSelection columns + contentText */ })
		.from(artifacts)
		.where(
			and(
				buildArtifactVisibilityCondition({ userId, ownershipScope }),
				eq(artifacts.type, "artifact"),
				sql`(
					lower(${artifacts.name}) like ${likeQuery} escape '\\'
					or (
						json_extract(${artifacts.metadataJson}, '$.artifactType') <> 'app'
						and (
							lower(${artifacts.contentText}) like ${likeQuery} escape '\\'
							or lower(${artifacts.summary}) like ${likeQuery} escape '\\'
						)
					)
				)`,
			),
		)
		.orderBy(desc(artifacts.updatedAt), artifacts.id)
		.limit(DOCUMENT_FAMILY_CANDIDATE_LIMIT); // = 24, matching DOCUMENT_METADATA_CANDIDATE_LIMIT/DOCUMENT_CONTENT_CANDIDATE_LIMIT

	return rows
		.filter((row) => isArtifactCanonicallyOwned({ userId, ownershipScope, artifact: row }))
		.map((row) => mapArtifactFamilyRow(row, /* batched version numbers */));
}
```

Unlike the two existing loaders (which return bare id/type candidate rows and require a second
`getLogicalDocumentForArtifact` call per id to materialise), this one already returns full
`KnowledgeDocumentItem`s — there is no family to expand, so the second round trip the old path needs is not
needed here. **`searchDocuments`'s candidate resolution therefore becomes two branches merged into one
`documents` array**: the existing `legacyIds → Promise.all(getLogicalDocumentForArtifact)` path, unchanged; and
this loader's rows, used directly. Both feed the same downstream `scoreDocument` → dedupe-by-`displayArtifactId`
→ sort → slice pipeline, unchanged.

**`scoreDocument`** (`workspace-search.ts:552-610`) gains one guard, at the top of its per-family-member content
loop:

```ts
for (const artifactId of document.familyArtifactIds) {
	if (document.kind === "app") continue; // an App's contentText is HTML markup, not prose — never a match reason
	// … existing content/summary scoring, byte-identical …
}
```

This is necessary in addition to the candidate loader's own App-content exclusion: a candidate loader only
decides which rows are *considered*; once a row is a candidate (for instance because its **name** matched),
`scoreDocument` re-scores it against every field independently, and without this guard an App's raw markup could
still win the "best field" comparison and produce an HTML snippet in the UI (Review Focus #3).

**`mapDocumentResult`** (`workspace-search.ts:612-641`) gains one passthrough line: `kind: document.kind,`.

### Routes — none new

| Route | What changes | Why no new route |
|---|---|---|
| `GET /api/workspace-search` (`workspace-search/+server.ts`) | Response payload gains `kind` per document result (additive JSON field) | `searchWorkspace(userId, {query})`'s signature is unchanged; the route is a 15-line pass-through and stays one |
| Knowledge page load (`+page.server.ts` → `getKnowledgeLibraryPage`) | Gains a `type` URL param, parsed the same way `sort`/`dir` already are | This is a page load function, not a JSON API route |
| `GET /api/knowledge/documents/resolve` | No code change — `resolveKnowledgeWorkspaceDocument` is a 1-line wrapper over `getLogicalDocumentForArtifact`, which now resolves an artifact-family id automatically | The chokepoint design above |

Neither existing route's auth pattern changes. Both already use `requireAuth` (`workspace-search/+server.ts:7`,
`documents/resolve/+server.ts:6`) — this is **not** one of "our artifact routes" ruling 39 (amended) refers to
(that ruling is scoped to the *new* `/api/artifacts/**` routes slice 0 creates); these are pre-existing app
routes this slice extends, and their auth stays exactly as it is.

### Client

**`src/routes/(app)/knowledge/+page.server.ts`** — `DOCUMENT_TAB_PARAMS` gains `"type"`
(`+page.server.ts:16`), and `load` reads it the same way `sort`/`dir` are read (`parseSortKey`/`parseSortDirection`
pattern, `+page.server.ts:24-33`):

```ts
const KIND_FILTERS = new Set<KnowledgeDocumentKindFilter>(["document", "app", "canvas", "slides", "file", "uploaded"]);
function parseKindFilter(value: string | null): KnowledgeDocumentKindFilter | null {
	const kind = value as KnowledgeDocumentKindFilter | null;
	return kind && KIND_FILTERS.has(kind) ? kind : null; // unrecognised value silently ignored — same rule as sort/dir
}
```

`getKnowledgeLibraryPage(user.id, { ..., kindFilter: parseKindFilter(event.url.searchParams.get("type")) })`.

**`src/routes/(app)/knowledge/+page.svelte`** — mirrors the existing `documentSortKey`/`handleDocumentSortChange`
/`buildKnowledgeLibraryUrl` pattern (`+page.svelte:144-149,257-346`) exactly, adding one new piece of state and
one new URL param, never restructuring the existing ones:

```ts
let documentTypeFilter = $state<DocumentTypeFilter>(initialLibrary?.kindFilter ?? "all");

function handleDocumentTypeFilterChange(filter: DocumentTypeFilter) {
	documentTypeFilter = filter;
	documentCurrentPage = 1;
	void updateKnowledgeLibraryParams({ type: filter === "all" ? null : filter, page: 1 });
}
```

`syncDocumentUrlState`/`buildKnowledgeLibraryUrl` gain the same `type` param plumbing `sort`/`dir` already have
(`syncSearchParam(searchParams, "type", params.typeFilter === "all" ? null : params.typeFilter)`), and
`countsByKind` flows from `library.countsByKind` into `DocumentsList`'s new prop (below) the same way
`library.pagination`/`library.sort` already flow into its existing props.

**`src/routes/(app)/knowledge/_components/documents-table.ts`** — gains the client-facing filter vocabulary and
two new pure functions, alongside the existing ones (all additive):

```ts
export type DocumentTypeFilter = "all" | KnowledgeDocumentKindFilter; // "all" | ArtifactKind | "uploaded"

export const DOCUMENT_TYPE_FILTER_ORDER: readonly DocumentTypeFilter[] =
	["all", "document", "app", "canvas", "slides", "file", "uploaded"];

/** Which chip a row belongs under. Skill Notes fold into "uploaded" for this
 *  purpose — ruling 46 is about "all five kinds" plus what predates them, and a
 *  sixth chip for an internal, rare kind is scope the mockup doesn't show. The
 *  Type COLUMN still renders "Skill note" distinctly (existing behaviour,
 *  unchanged) — only the chip grouping coarsens it. */
export function documentTypeFilterFor(document: KnowledgeDocumentItem): Exclude<DocumentTypeFilter, "all"> {
	if (document.kind) return document.kind;
	return getDocumentKind(document) === "generated" ? "file" : "uploaded";
}

export type ArtifactFamilyVersionBadge =
	| { kind: "artifact-version"; versionNumber: number }
	| { kind: "none" };

/** The Version cell for a `kind`-bearing row. Never reads `versionNumber`/
 *  `documentFamilyId`/`isOriginal` — those are the unrelated extraction-family
 *  fields (Review Focus #7). */
export function deriveArtifactVersionBadge(document: KnowledgeDocumentItem): ArtifactFamilyVersionBadge {
	if (!document.kind || document.artifactVersionNumber == null) return { kind: "none" };
	return { kind: "artifact-version", versionNumber: document.artifactVersionNumber };
}
```

`getDocumentKind` (`documents-table.ts:202-213`) gains one early-return line, **before** its existing checks:

```ts
export function getDocumentKind(
	document: Pick<KnowledgeDocumentItem, "documentOrigin" | "type" | "kind">,
): "generated" | "skill_note" | "uploaded" | ArtifactKind {
	if (document.kind) return document.kind;
	// … existing three-way check, byte-identical …
}
```

This one line is also what makes `compareDocuments`'s existing `sortKey === "type"` branch
(`documents-table.ts:268-272`, `compareText(getDocumentKind(left), getDocumentKind(right))`) sort the four new
kinds sensibly with **zero further change** — `getDocumentKind`'s widened return type flows through unchanged.

**`src/routes/(app)/knowledge/_components/DocumentsList.svelte`** — prop and render changes:

```ts
interface DocumentsListProps {
	// … every existing prop unchanged …
	typeFilter?: DocumentTypeFilter;
	onTypeFilterChange?: (filter: DocumentTypeFilter) => void;
	/** Counted server-side, independent of pagination — see LogicalDocumentPageResult. */
	countsByKind?: Record<KnowledgeDocumentKindFilter, number>;
}
```

Row-level template changes (all guarded on `document.kind` being set, so an unset `kind` — every row this app
already knew about — renders through the **existing, unchanged** branches):

- **Type column / mobile meta line:** a new first branch —
  `{#if document.kind}<span class="type-badge type-artifact">{$t(`artifacts.type.${document.kind}`)}</span>{:else}` — before the existing skill-note/generated/uploaded chain.
- **Version column:** `{#if document.kind}` renders `deriveArtifactVersionBadge`'s result as
  `{$t('artifacts.card.version', { n: badge.versionNumber })}` when its `kind` is `"artifact-version"` (reusing
  slice 0's own `artifacts.card.version` = `"v{n}"` key rather than declaring a duplicate — ruling 22's spirit
  applied to a second string, not just the five kind words) or the same blank `—` em-dash the existing
  `{kind: "none"}` case already renders, `{:else}` the existing `deriveDocumentVersion` branch, unchanged.
- **"What AI sees" action:** hidden — not merely disabled — for a `kind`-bearing row:
  `{#if document.kind}{:else if aiVersionAvailable}...{:else}...{/if}`. A Document/App/Canvas/Slides artifact has
  no separate normalised/AI-facing version — the body the user edits **is** what Alfy reads — so
  `normalizedAvailable` is already `false` for these rows (`mapArtifactFamilyRow`), and showing a permanently
  disabled eye icon with a tooltip that talks about "no normalised version" on every one of these rows would be
  a needless, confusing dead affordance. `hasNormalisedVersion` needs no change (it already returns `false`
  here); this is purely a template-level hide.
- **Download action:** hidden for a `kind`-bearing row. A Document/App/Canvas/Slides artifact has no
  `storagePath`/raw bytes — its content lives in `artifact_versions.body` — so the existing
  `/api/knowledge/[id]/download` route (built around `resolveWorkingDocumentFileServing`, which expects a stored
  file) does not apply, and building a new per-kind export path from inside this slice would cross into
  Slices 1–4's own export-ownership (App's `.html` download, Slides' PPTX export, etc. — `decisions.md` rulings
  3 and 42). Export happens **inside the panel**, through each type's own affordance, once opened — not from the
  list row. Actions column for a `kind`-bearing row is therefore just **Delete**.
- **Filter chip row**, new, above the table (mirrors the mockup's `fchips` row): one chip per
  `DOCUMENT_TYPE_FILTER_ORDER` entry, label = `artifacts.type.<kind>` for the five kind chips,
  `knowledge.documents.filter.all` / `knowledge.documents.filter.uploaded` for the other two, count = the
  matching value of `countsByKind` (`0` renders the chip, not hides it — a kind that exists in the product but
  has nothing yet is still a real filter, not a secret one), `aria-label` =
  `knowledge.documents.filter.optionA11y`. Clicking calls `onTypeFilterChange`; no debounce (a discrete click,
  not text input, unlike the search box).
- **Summary line**, new, in the section header (mirrors the mockup's `krow`): one
  `$t('knowledge.documents.count.<bucket>', {count})` phrase per **non-zero** bucket in `countsByKind`, joined
  with a literal `" · "` (a visual separator, not translated text — consistent with how the app already joins
  relative-time/location fragments elsewhere, e.g. the search modal's own meta lines), plus the existing total
  pill (`knowledge.documents.totalLabel`, reusing the `"{count} elem"` Hungarian vocabulary slice 0 already
  chose for `artifacts.panel.count`, for cross-feature consistency).
- **Empty / filtered-to-empty state:** reuses the existing `knowledge.noDocumentsMatch` message whenever
  **either** a search query or a non-`"all"` type filter is active (both are narrowing operations over the same
  underlying list) — no third empty-state string is added.

**`src/routes/(app)/knowledge/_helpers.ts`** — `toWorkspaceDocument` gains one branch, tried first:

```ts
export function toWorkspaceDocument(document: KnowledgeDocumentItem): DocumentWorkspaceItem {
	if (document.kind) {
		return {
			id: `artifact:${document.displayArtifactId}`,
			source: "knowledge_artifact",
			filename: document.name,
			title: document.name,
			kind: document.kind, // slice 0's field on DocumentWorkspaceItem — PER SLICE-0.MD, UNVERIFIED IN THIS TREE
			mimeType: null,
			artifactId: document.displayArtifactId,
			conversationId: document.conversationId,
		};
	}
	// … existing mapping, byte-identical (_helpers.ts:13-35) …
}
```

This is the **entire** client-side "open" change this slice needs. The panel itself
(`DocumentWorkspace.svelte`) is not touched — per slice 0's contract it dispatches on `item.kind` and fetches the
artifact's body itself (`ArtifactBodyProps.body` is supplied by the panel, not by this item); this slice's job
ends at producing a correctly-`kind`-tagged `DocumentWorkspaceItem`.

**`src/lib/components/search/SearchModal.svelte`** — `documentBadgeKey` (`:575-581`) gains one branch, and one
new icon-selection branch is added beside the existing `documentOrigin`-keyed chain (`:847-856`):

```ts
function documentBadgeKey(document: WorkspaceSearchDocumentResult): I18nKey {
	if (document.kind) return `artifacts.type.${document.kind}` as I18nKey; // reuses slice 0's five labels — no new badge keys
	// … existing three-way check, byte-identical …
}
```

Icon: `AppWindow` for `"app"`, `LayoutDashboard` for `"canvas"`, `Presentation` for `"slides"`,
`SquarePen` for `"document"` (`"file"` never appears here — a produced file keeps its existing `documentOrigin
=== "generated"` → `Sparkles` branch, ruling 18, zero change).

**`src/lib/components/search/search-scopes.ts`** — **no change.** `isReportRow` (`:67-69`) checks
`row.documentOrigin === "generated"`; an artifact-family row's `documentOrigin` is `undefined`
(`mapArtifactFamilyRow` never sets it), so `isReportRow` already returns `false` for every new-kind row and
`rowMatchesScope` already places it in the `"documents"` scope, never `"reports"` — automatically, correctly,
with zero code change. This is also the mockup's own stated intent: §6's legend reads *"One flat result list,
each row labelled with its kind — **no new search scope needed**."* Do not add a `SearchScopeId` for the new
kinds; verify the above with a test instead (Task 4).

### i18n

New keys, `src/lib/i18n/knowledge.ts`, EN + HU in the same commit:

| Key | English | Hungarian |
|---|---|---|
| `knowledge.documents.filter.all` | `All` | `Összes` |
| `knowledge.documents.filter.uploaded` | `Uploaded` | `Feltöltött` |
| `knowledge.documents.filter.optionA11y` | `Filter: {label}, {count} items` | `Szűrő: {label}, {count} elem` |
| `knowledge.documents.count.uploaded` | `{count} uploaded` | `{count} feltöltött` |
| `knowledge.documents.count.document` | `{count} documents` | `{count} dokumentum` |
| `knowledge.documents.count.app` | `{count} apps` | `{count} alkalmazás` |
| `knowledge.documents.count.canvas` | `{count} canvas` | `{count} tábla` |
| `knowledge.documents.count.slides` | `{count} slides` | `{count} diasor` |
| `knowledge.documents.count.file` | `{count} files` | `{count} fájl` |
| `knowledge.documents.totalLabel` | `{count} items` | `{count} elem` |

Consumed, not added: `artifacts.type.*` (five kind labels, slice 0), `artifacts.card.version` (`"v{n}"`, slice
0), `knowledge.noDocumentsMatch` (existing empty state).

**Why no `common.ts` change.** `documentBadgeKey` now returns an `artifacts.type.*` key directly for a
`kind`-bearing row instead of a new `searchModal.badge*` key — one label vocabulary for "what kind is this"
across the whole app, per ruling 22's spirit. **Why no `artifacts.ts` change.** This slice consumes that
dictionary's `artifacts.type.*` and `artifacts.card.version` entries; it declares no kind words and no versioned
string of its own — a second slice adding a second copy of the same five words is exactly what ruling 22
forbids.

Two rules with the same commit as every other i18n change in this feature: `src/lib/i18n.test.ts` (parity) stays
green, and no new value in either locale matches `/artifact/i` — the existing `src/lib/i18n/artifacts.test.ts`
already asserts that for the keys this slice reuses; this slice's own new keys are plain UI copy with no reason
to mention the word at all, verified by eye in Task 6.

### UI states (1440 px and 390 px)

Tokens are the real ones in `src/app.css` (`--surface-page`, `--surface-elevated`, `--text-primary`,
`--text-muted`, `--icon-muted`, `--border-default`, `--focus-ring`, `--accent`, `--radius-md`, `--space-xs|sm|md|lg`,
`--text-2xs|xs|sm|md`), matching the Documents tab's existing token usage — no hardcoded hex.

| State | Component | What the user sees |
|---|---|---|
| Empty (zero artifacts, zero uploads) | Documents tab | existing `knowledge.noDocuments` empty state, unchanged — chips still render (all at 0) so the surface doesn't look broken, just quiet |
| Filtered to empty (a chip or search narrows to zero) | Documents tab | `knowledge.noDocumentsMatch`, existing state, unchanged copy |
| Loading a filtered/sorted/searched page | Documents tab | existing `documentsNavigating`/`loading` prop path, unchanged — the chip row itself never shows a spinner; only the table body does, exactly as sort/search do today |
| Long chip row wrap | Documents tab, 390 px | chips wrap onto a second line rather than scrolling horizontally — `flex-wrap: wrap`, `--space-xs` row/column gap, no `overflow-x` on the chip container (the table itself keeps its own horizontal scroll, unchanged) |
| Long summary line (all six buckets non-zero) | Documents tab | wraps naturally inside the existing header row; no truncation, no tooltip needed — six short phrases joined by `" · "` fit within the header's existing width budget even at 390 px, verified visually in Task 6 |
| A `kind`-bearing row, 1440 px | Documents tab table | Type column shows the coloured/kind pill; Version column shows `v{n}` or `—`; Actions column shows Delete only (no eye, no download, no reextract) |
| A `kind`-bearing row, 390 px | Documents tab, mobile meta line | same three facts (kind pill, version, no AI-sees/download) collapse into the existing mobile meta-line pattern the table already uses for other kinds |
| Search modal row for a new kind, 1440/390 | `SearchModal.svelte` | kind-appropriate icon + the existing badge pill, now reading the kind word instead of Generated/Uploaded/Skill note, for these rows only |
| Empty query, Workspace Search | `SearchModal.svelte` | unchanged "recent" view, now including up to `DEFAULT_LIMIT` (3) of the newest artifacts alongside recent documents — same cap, same layout |

**Focus and keyboard order.**

- Chip row: one `<button type="button">` per chip, in `DOCUMENT_TYPE_FILTER_ORDER`, immediately after the search
  input in DOM/tab order and before the sort control — matching the mockup's left-to-right toolbar reading
  order. `aria-pressed` reflects the active chip.
- Table rows: unchanged tab order (row is focusable, Enter/Space opens, action buttons are separate stops) — a
  `kind`-bearing row simply has one fewer action stop (Delete only), which shortens its own tab sequence but
  does not change any other row's.
- Search modal: unchanged keyboard handling (`ArrowUp`/`ArrowDown`/`Enter`/`Escape`/`Tab` cycling) — this slice
  adds no new row type to the modal's row list, only new icon/badge content inside the existing document row.

### Failure modes

| Failure | Server behaviour | EN | HU |
|---|---|---|---|
| Unrecognised `type` URL param on the Documents tab | silently ignored, falls back to "all" (same rule as an unrecognised `sort`/`dir` value, `+page.server.ts`'s existing `Set.has()` guard) | — (no user-visible error; the list just renders unfiltered) | — |
| An artifact-family row's `metadata_json.artifactType` is malformed or missing | `parseArtifactFamilyKind` returns `null`; `mapArtifactFamilyRow` falls back to `kind: "document"` so the row still lists and opens rather than vanishing or crashing | (no error string; the row simply shows the Document chip) | — |
| The artifact's owning conversation was deleted | the row is invisible in both surfaces — inherited from `isArtifactCanonicallyOwned`'s existing rule for any row with a now-out-of-scope `conversationId`, identical to how a `generated_output` row already behaves (`knowledge/AGENTS.md`'s "Artifact-ownership note") | (no error; the row is simply absent, same as a deleted produced file today) | — |
| The artifact is in an incognito conversation the caller is outside | invisible in both surfaces, via `getArtifactOwnershipScope`'s existing `memoryIncognito` filter — no new logic | — | — |
| Clicking a `kind`-bearing row whose editor is not yet registered (Task dependency risk, see *Risks*) | the panel opens to whatever slice 0's own "no loader registered" fallback renders — **this slice does not define that fallback**, since it does not touch `DocumentWorkspace.svelte` | (slice 0's copy, not this slice's) | (slice 0's copy) |
| Workspace Search query matches only an App's HTML markup | the App is never surfaced by that match — `scoreDocument`'s App guard skips content/summary scoring for App rows, so only a genuine `name` match surfaces it | — | — |
| The version-number batch query fails (DB error) | `artifactVersionNumber` falls back to `null`; the Version column renders `—` rather than the request failing — a version badge is cosmetic, not load-bearing | — | — |

No failure mode in this slice produces a raw English server string in the UI — every user-visible change above
is either silent (a graceful fallback) or an existing, already-localised dictionary key.

### Limits and configuration

No new cap is introduced. This slice reuses every existing limit unchanged:

| Constant | Value | Where | Note |
|---|---|---|---|
| `KNOWLEDGE_LIBRARY_MAX_PAGE_SIZE` | `100` (`knowledge.ts:136`) | Documents tab page size | unchanged; still the ceiling on what one page *returns* |
| `DOCUMENT_METADATA_CANDIDATE_LIMIT` / `DOCUMENT_CONTENT_CANDIDATE_LIMIT` | `24` (`workspace-search.ts:26-27`) | existing Workspace Search candidate loaders | unchanged |
| `DOCUMENT_FAMILY_CANDIDATE_LIMIT` | `24` | **new**, `workspace-search.ts`, this slice's candidate loader | matches the existing two for symmetry — not a new policy decision, a consistency one |
| `DEFAULT_LIMIT` / `QUERY_LIMIT` | `3` / `6` (`workspace-search.ts:24-25`) | per-section result cap, both surfaces | unchanged — a `kind`-bearing document competes for the same document-section slots as every other document, not a reserved slot of its own |

None of these is environment-backed or admin-configurable, matching the existing constants they sit beside — no
new `env.ts`/`config-store.ts` entry is warranted for a page-size or candidate-limit constant nothing in this
slice's design needs to tune.

---

## File ownership

| File | Change | Shared |
|---|---|---|
| `src/lib/server/services/knowledge/types.ts` | `KnowledgeDocumentItem.kind` / `.artifactVersionNumber` | **shared** — slice 0 (`kind?` on `DocumentWorkspaceItem`, `"artifact"` in `ArtifactType`), slices 1–4 (per-kind fields) land first per `working-plan.md §5`; this slice appends two fields to a *different* interface in the same file — low-conflict, append-only |
| `src/lib/server/services/knowledge/store/documents.ts` + `documents.test.ts` + `logical-document-page-total.test.ts` | `parseArtifactFamilyKind`, `getLogicalDocumentForArtifact` new branch, `listLogicalDocumentsPage` merge + `kindFilter`/`countsByKind`, `KnowledgeDocumentKindFilter`, `compareKnowledgeDocumentItems` | exclusive to this slice |
| `src/lib/server/services/knowledge.ts` + `knowledge.test.ts` | `KnowledgeLibraryPageOptions.kindFilter`, `KnowledgeLibraryPage.countsByKind` | exclusive |
| `src/lib/server/services/workspace-search.ts` + `workspace-search.test.ts` | new candidate loader, `scoreDocument` App guard, `WorkspaceSearchDocumentResult.kind`, `mapDocumentResult` passthrough | exclusive |
| `src/routes/api/workspace-search/workspace-search.test.ts` | regression coverage only (payload shape) | exclusive |
| `src/routes/(app)/knowledge/+page.server.ts` | `type` URL param | exclusive |
| `src/routes/(app)/knowledge/+page.svelte` | `documentTypeFilter` state, handler, URL sync | exclusive — **not** a Feature-2 hot file per `working-plan.md §5` (only `chat/[conversationId]/+page.svelte` is listed there) |
| `src/routes/(app)/knowledge/_components/documents-table.ts` + `documents-table.test.ts` | `DocumentTypeFilter`, `documentTypeFilterFor`, `deriveArtifactVersionBadge`, `getDocumentKind` widened | exclusive |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` + `DocumentsList.test.ts` | chip row, summary line, Version/Type column branches, hidden AI-sees/download for `kind`-bearing rows | exclusive |
| `src/routes/(app)/knowledge/_helpers.ts` + `_helpers.test.ts` | `toWorkspaceDocument` kind-aware branch | exclusive |
| `src/lib/components/search/SearchModal.svelte` + `SearchModal.test.ts` | `documentBadgeKey` branch, icon selection branch | exclusive |
| `src/lib/i18n/knowledge.ts` | ten new keys, EN+HU | exclusive |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | PART A: new behaviour cases (Documents tab + Workspace Search, an incognito/foreign artifact-family row never appears); PART B: no new entry expected (this slice reuses existing scope calls — verify, don't assume) | **shared, append-only** — `working-plan.md §5`: "S0 extends; then S1, S2, S3, S4, S5b, S6 (S7) append." **Flagged below (Risks) as a real scheduling ambiguity**: S7 is dispatched in Wave 3 (same wave as S3/S4), chronologically *before* S5b/S6 (Waves 4–5) — so if S7 merges first, it appends *before* S5b/S6 despite the table's printed order. Resolved the same way every append-only conflict already is (`working-plan.md §5`: "keep both sides") — this slice appends its case wherever it lands in actual merge order, never rewriting another slice's case |
| `tests/e2e/knowledge.spec.ts` | new seeded case (Documents tab: chips, Version column, five-kind row) | exclusive |
| `tests/e2e/search-modal.spec.ts` | new seeded case (a Document/App/Canvas/Slides row appears, labelled, and opens) | exclusive |

**No changes** (stated explicitly because a reviewer will otherwise go looking): `schema.ts`, `drizzle/*`,
`src/lib/server/services/artifacts/**`, `src/lib/shared/artifacts/**`, `src/lib/components/artifacts/**`,
`src/lib/components/document-workspace/DocumentWorkspace.svelte`, `src/lib/i18n/artifacts.ts`,
`src/lib/i18n/common.ts`, `src/lib/components/search/search-scopes.ts`, `src/lib/client/api/artifacts.ts`,
`src/routes/(app)/chat/[conversationId]/+page.svelte`, `src/lib/server/services/knowledge/project-knowledge.ts`
(Slice 5's file — this slice's `getLogicalDocumentForArtifact` widening benefits it for free, but this slice
does not edit it or claim credit for its tests).

---

## Tasks

Each task ends at a commit boundary. Work top to bottom; do not start a task whose predecessor is red.

### Task 1: The server-side listing merge

**Files:** `src/lib/server/services/knowledge/types.ts`, `src/lib/server/services/knowledge/store/documents.ts` +
`documents.test.ts` + `logical-document-page-total.test.ts`, `src/lib/server/services/knowledge.ts` +
`knowledge.test.ts`
**Test:** the three files above

- [ ] **Step 0: Verify the slice-0 dependency before writing anything.**
  ```bash
  cat src/lib/shared/artifacts/kinds.ts        # expect ArtifactKind to exist
  grep -n '"artifact"' src/lib/server/services/knowledge/types.ts   # expect it in ArtifactType
  ls src/lib/server/services/artifacts/index.ts                     # expect the facade to exist
  ```
  If any of these is missing, stop — Slice 0 has not merged into this branch yet. Do not stub around it.

- [ ] **Step 1: Write the failing tests**

  `documents.test.ts`, new `describe("artifact-family rows", ...)` block: `getLogicalDocumentForArtifact`
  resolves a bare `type: "artifact"` row to a `KnowledgeDocumentItem` with `kind`/`artifactVersionNumber` set and
  `familyArtifactIds: [id]`; `listLogicalDocumentsPage` includes an artifact-family row alongside an uploaded
  document and a produced file, in date order, with `countsByKind` correctly tallying all three buckets;
  `kindFilter: "canvas"` returns only the Canvas row and leaves `countsByKind` unchanged from the unfiltered
  call; a `query` narrows an artifact-family row by name but never by an App's body; an artifact-family row
  whose conversation belongs to another user, or is incognito-and-out-of-scope, is absent from every one of the
  above. `getDocumentKind`-adjacent: `documentTypeFilterFor` is **not** tested here — it lives in
  `documents-table.ts`, a browser file (Task 3).

  `logical-document-page-total.test.ts`, one new `it`: seed a real migrated SQLite DB (mirroring the file's
  existing seed helper) with one uploaded document, one produced file and two artifact-family rows for the same
  user, assert `totalItems` on an unfiltered, unpaginated call equals `4`, and assert a `limit: 1` call's single
  page plus repeated `offset` walks visit all four exactly once — the exact discipline this file's header
  comment names as the reason it exists.

  `knowledge.test.ts`: `getKnowledgeLibraryPage` returns `countsByKind` and respects `kindFilter`.

- [ ] **Step 2: Run to verify they fail**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npx vitest run src/lib/server/services/knowledge/store/documents.test.ts \
    src/lib/server/services/knowledge/store/logical-document-page-total.test.ts \
    src/lib/server/services/knowledge.test.ts
  ```

- [ ] **Step 3: Implement** `parseArtifactFamilyKind`, `mapArtifactFamilyRow` (with the batched
  `artifact_versions` MAX-version-number query), the `getLogicalDocumentForArtifact` new branch, the
  `listLogicalDocumentsPage` merge algorithm (both branches unified per §Contracts), `compareKnowledgeDocumentItems`,
  and `getKnowledgeLibraryPage`'s `kindFilter`/`countsByKind` threading.

- [ ] **Step 4: Run the gates**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npm run check
  npx biome check src scripts tests
  npx vitest run src/lib/server/services/knowledge
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/server/services/knowledge/types.ts src/lib/server/services/knowledge/store/documents.ts \
    src/lib/server/services/knowledge/store/documents.test.ts \
    src/lib/server/services/knowledge/store/logical-document-page-total.test.ts \
    src/lib/server/services/knowledge.ts src/lib/server/services/knowledge.test.ts
  git commit -m "List the artifact family alongside what the library already knew

  Document/App/Canvas/Slides rows get their own simple read path rather
  than being forced through the source/normalized/generated-output
  bundling that has no meaning for them, merged at the KnowledgeDocumentItem
  level so both the Documents tab and Workspace Search's default view pick
  them up from the same one place."
  ```

### Task 2: Workspace Search's typed-query path

**Files:** `src/lib/server/services/workspace-search.ts` + `workspace-search.test.ts`,
`src/routes/api/workspace-search/workspace-search.test.ts`
**Test:** both test files

- [ ] **Step 1: Write the failing tests** — a typed query matches an artifact-family row by name; a typed query
  against an App's body text (with no name match) returns nothing; `WorkspaceSearchDocumentResult.kind` is
  present for these rows and absent for every existing kind; the default (empty-query) view already includes an
  artifact-family row with no further code change (Contracts' claim, verified rather than assumed); ownership
  and incognito parity with `documents.test.ts`'s equivalent cases (Task 1) — do not skip this because Task 1
  covered the read path, `workspace-search.ts` has its own candidate loader with its own ownership call to get
  right.

- [ ] **Step 2: Run to verify they fail**

  ```bash
  npx vitest run src/lib/server/services/workspace-search.test.ts
  ```

- [ ] **Step 3: Implement** `loadMatchingArtifactFamilyCandidateRows`, the `scoreDocument` App guard, the
  `searchDocuments` two-branch merge, `mapDocumentResult`'s `kind` passthrough.

- [ ] **Step 4: Run the gates**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npm run check
  npx biome check src scripts tests
  npx vitest run src/lib/server/services/workspace-search.test.ts src/routes/api/workspace-search
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/server/services/workspace-search.ts src/lib/server/services/workspace-search.test.ts \
    src/routes/api/workspace-search/workspace-search.test.ts
  git commit -m "Make Workspace Search's typed query find every kind

  A third candidate loader alongside the two the old family already has,
  merged before scoring rather than forced through the id-then-expand path
  the old family needs and the new one doesn't. An App's markup body is
  excluded from both candidate selection and re-scoring, so a CSS class
  name can never surface an unrelated app."
  ```

### Task 3: The Documents tab — chips, Version column, the merged list

**Files:** `src/routes/(app)/knowledge/+page.server.ts`, `src/routes/(app)/knowledge/+page.svelte`,
`src/routes/(app)/knowledge/_components/documents-table.ts` + `documents-table.test.ts`,
`src/routes/(app)/knowledge/_components/DocumentsList.svelte` + `DocumentsList.test.ts`,
`src/routes/(app)/knowledge/_helpers.ts` + `_helpers.test.ts`
**Test:** the four `*.test.ts` files above

- [ ] **Step 1: Verify the icon before using it**

  ```bash
  grep -n "LayoutDashboard" node_modules/@lucide/svelte/dist/svelte/icons/*.d.ts 2>/dev/null | head -1
  ```

  Confirms `LayoutDashboard` exists in the installed `@lucide/svelte`; if not, pick the mockup's next-closest
  vetted alternative and say so in the commit message.

- [ ] **Step 2: Write the failing tests**

  `documents-table.test.ts`: `documentTypeFilterFor` buckets a Skill Note and an uploaded document both into
  `"uploaded"`, a produced file into `"file"`, and each artifact-family row into its own kind; `getDocumentKind`
  returns the raw kind for a `kind`-bearing row and is unchanged for every other row (a literal snapshot of
  today's three return values, so a regression here is loud); `deriveArtifactVersionBadge` reads
  `artifactVersionNumber` only, never `versionNumber`/`documentFamilyId` (assert a row with both sets of fields
  populated — a synthetic case that should never occur in real data, but the function must still be honest about
  which one it reads).

  `DocumentsList.test.ts`: the chip row renders `DOCUMENT_TYPE_FILTER_ORDER` with live counts and fires
  `onTypeFilterChange`; a `kind`-bearing row renders its type pill and `v{n}`/`—` Version cell correctly; a
  `kind`-bearing row's Actions column has no "what AI sees" button and no Download button, only Delete; the
  summary line lists only non-zero buckets; every existing `DocumentsList.test.ts` case for uploaded/generated/
  skill-note rows still passes unchanged.

  `_helpers.test.ts`: `toWorkspaceDocument` on a `kind`-bearing `KnowledgeDocumentItem` produces a
  `DocumentWorkspaceItem` with `kind` set and every existing-row case still passes unchanged.

- [ ] **Step 3: Run to verify they fail**

  ```bash
  npx vitest run "src/routes/(app)/knowledge/_components/documents-table.test.ts" \
    "src/routes/(app)/knowledge/_components/DocumentsList.test.ts" \
    "src/routes/(app)/knowledge/_helpers.test.ts"
  ```

- [ ] **Step 4: Implement** the `type` URL param (`+page.server.ts`, `+page.svelte`), `documents-table.ts`'s new
  exports, `DocumentsList.svelte`'s chip row / summary line / column branches / hidden actions, and
  `_helpers.ts`'s `toWorkspaceDocument` branch.

- [ ] **Step 5: Run the gates**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npm run check
  npx biome check src scripts tests
  npx vitest run "src/routes/(app)/knowledge"
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add "src/routes/(app)/knowledge"
  git commit -m "Show every kind in the Documents tab, with its own chip and version

  The tab stays named Documents and keeps every existing row's rendering
  byte-identical; a kind-bearing row adds a type pill, its own version
  counter (never the unrelated extraction-family one), and drops the two
  actions — AI-facing preview and Download — that only make sense for a
  row with stored bytes. Export for these kinds lives inside the panel,
  per type, not on the list row."
  ```

### Task 4: Workspace Search's UI — icons, badges, no new scope

**Files:** `src/lib/components/search/SearchModal.svelte` + `SearchModal.test.ts`, `src/lib/i18n/knowledge.ts`
**Test:** `SearchModal.test.ts`, `src/lib/i18n.test.ts`

- [ ] **Step 1: Write the failing tests** — `documentBadgeKey` returns `artifacts.type.<kind>` for a
  `kind`-bearing document and is unchanged for every other row; the icon-selection branch picks the right Lucide
  component per kind; a `kind`-bearing row lands in `search-scopes.ts`'s `"documents"` scope, never
  `"reports"` (a regression test on the **existing, untouched** file, proving the "no change needed" claim
  rather than assuming it).

- [ ] **Step 2: Run to verify they fail**

  ```bash
  npx vitest run src/lib/components/search/SearchModal.test.ts
  ```

- [ ] **Step 3: Implement** the `documentBadgeKey` branch and the icon-selection branch. Add the ten
  `knowledge.documents.*` keys from §i18n (this task, not Task 3, because the chip/count keys are consumed by
  both the Documents tab and — for the badge label reuse — implicitly relied on by this file too; landing them
  together in one commit avoids a half-localised intermediate state).

- [ ] **Step 4: Run the gates**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npm run check
  npx biome check src scripts tests
  npx vitest run src/lib/components/search/SearchModal.test.ts src/lib/i18n.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/components/search/SearchModal.svelte src/lib/components/search/SearchModal.test.ts \
    src/lib/i18n/knowledge.ts
  git commit -m "Label a search result with its real kind, in the app's one vocabulary

  Reuses artifacts.type.* instead of declaring a second badge-key family
  for the same five words. search-scopes.ts needs no change: an
  artifact-family row's documentOrigin is unset, so it already lands in
  the Documents scope and never Reports, exactly as the mockup's own
  legend says — 'no new search scope needed.'"
  ```

### Task 5: Containment — PART A and PART B

**Files:** `tests/cross-cutting/incognito-artifact-containment.test.ts`
**Test:** itself

- [ ] **Step 1: Read the guard's own machinery first** — `SCOPE_MARKERS` (`:498-508`), `ALLOWED_WITHOUT_SCOPE`
  (`:529-546`), `readsGuardedTables`/`selectsByUser`/`carriesScopeMarker` (`:561-593`), exactly as slice-0.md's
  own equivalent task instructs, because this slice's new code calls the *same* scope functions every other
  query in these files already calls (`getArtifactOwnershipScope`, `buildArtifactVisibilityCondition`,
  `isArtifactCanonicallyOwned`) rather than introducing a new marker convention — confirm the guard's
  pattern-matching already covers `knowledge/store/documents.ts` and `workspace-search.ts` (it should, since both
  files already exist and are already exercised by this guard for their pre-existing queries) before assuming no
  `SCOPE_MARKERS` entry is needed.

- [ ] **Step 2: Write the failing PART A behaviour tests** — an artifact-family row created inside an incognito
  conversation never appears in `listLogicalDocumentsPage` or `searchWorkspace` results from outside that
  conversation; a normal conversation's artifact-family row is unaffected; deleting the owning conversation
  removes the row from both surfaces (it becomes unreachable, not necessarily hard-deleted — see Contracts'
  eligibility note) while the row itself may still exist in the table.

- [ ] **Step 3: Run to verify they fail, then confirm PART B needs no new entry**

  ```bash
  npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
  ```

  If PART B's guard *does* flag a new query as unscoped, that is a real defect in Task 1/2's implementation (a
  raw `db.select` that bypassed `getArtifactOwnershipScope`) — fix the query, never add an
  `ALLOWED_WITHOUT_SCOPE` entry (forbidden, `plan.md` Global Constraints).

- [ ] **Step 4: Run the full gate**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
  git diff tests/cross-cutting/incognito-artifact-containment.test.ts | grep -A2 ALLOWED_WITHOUT_SCOPE || true
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add tests/cross-cutting/incognito-artifact-containment.test.ts
  git commit -m "Prove the artifact family is contained the same way generated_output is

  No new scope marker, no new exemption: the new listing and search paths
  call the same ownership functions every existing query already calls, so
  the incognito/foreign/deleted-conversation guarantees fall out of code
  already proven, not new logic that has to be proven again."
  ```

### Task 6: E2E coverage, i18n parity, final gates

**Files:** `tests/e2e/knowledge.spec.ts`, `tests/e2e/search-modal.spec.ts`
**Test:** both, plus the full gate suite

- [ ] **Step 1: Write the failing E2E cases.** Neither existing spec seeds a document/generated-file/artifact row
  today (`tests/e2e/search-modal.spec.ts`'s coverage is entirely structural/visual per its own header) — seed
  directly through `db`, the way the repo's other E2E specs already do (`tests/e2e/conversation-title-refresh.spec.ts:3-4`
  is the precedent), not through a test-only HTTP route:

  ```ts
  import { db } from "../../src/lib/server/db";
  import { artifacts } from "../../src/lib/server/db/schema";
  // One artifact-family row: type "artifact", metadata_json.artifactType = "canvas",
  // in the conversation the spec just created via createConversation (tests/e2e/helpers.ts).
  ```

  `knowledge.spec.ts` new case: the Documents tab shows the seeded row with its Canvas chip and type pill, the
  "Canvas 1" chip narrows the list to it, and the row's Actions column has no Download button.

  `search-modal.spec.ts` new case: typing the row's name finds it, labelled with its kind, and the row is
  reachable/keyboard-activatable like every other result row.

- [ ] **Step 2: Run to verify they fail, then implement whatever gap they expose** (this task should mostly find
  wiring gaps between Tasks 1–5, not new logic).

- [ ] **Step 3: Run every gate**

  ```bash
  export PATH=/opt/homebrew/opt/node@22/bin:$PATH
  npm run check
  npx biome check src scripts tests
  npm test
  npm run build
  npm run check:migrations
  npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
  npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
  export E2E_PORT=5480
  npx playwright test tests/e2e/knowledge.spec.ts tests/e2e/search-modal.spec.ts \
    tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts
  ```

- [ ] **Step 4: Visual check** at 1440×900 and 390×844, light and dark, against surfaces mockup §4 and §6.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/e2e/knowledge.spec.ts tests/e2e/search-modal.spec.ts
  git commit -m "Seed a real artifact row through both surfaces end to end

  Neither spec seeded a document row before this slice — search-modal's
  own header explains its coverage was structural only. Direct db writes,
  matching the repo's existing E2E seeding convention, so this is real
  pipeline coverage rather than a fixture that only proves the seed
  worked."
  ```

---

## Non-goals

- **No new migration, no schema change.** Every field this slice adds is derived from existing columns.
- **No new route.** Every change lands inside existing service functions behind existing routes.
- **No toolbar redesign.** The Documents tab's search box, sort control and Upload button keep their current
  behaviour and copy exactly; this slice adds a chip row and widens what the existing search/sort/list already
  cover, nothing else about the toolbar changes.
- **No deepening of the Documents tab's own search.** It stays name-only for every kind, old and new alike —
  consistent with what it already does today, not a new capability this slice invents.
- **No change to `DocumentWorkspace.svelte`, `ArtifactCard.svelte`, or the `artifact-bodies.ts` registry.**
  Opening a listed row is entirely downstream of `toWorkspaceDocument` producing a correctly-tagged item; what
  happens after that is Slice 0's (and Slices 1–4's) contract, untouched here.
- **No new `SearchScopeId` and no Workspace Search tab redesign.** The mockup says so explicitly (§6's legend);
  verified with a test (Task 4), not just assumed.
- **No project-bundle change.** That is Slice 5's `§The project bundle`. This slice's
  `getLogicalDocumentForArtifact` widening happens to help it, incidentally; this slice does not edit
  `project-knowledge.ts` or claim any of that surface's tests.
- **No separate Skill Note filter chip.** Skill Notes fold into the "Uploaded" chip for filtering purposes only
  — their Type-column pill is unchanged.
- **No download/export affordance for a `kind`-bearing row from the list.** That belongs to each type's own
  slice, inside the panel.
- **No sharing, ever** (inherited, feature-wide).

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The pagination/total-count bug class repeats, doubled | `logical-document-page-total.test.ts`'s own header names the exact prior incident: rows filtered one way, the count computed another. Merging a second source is a second chance to get this wrong | Task 1 adds a mixed-row-type sibling test to that **same file**, not a new one, so the two guarantees stay next to each other and a future reader sees both |
| Always-full-fetch is slower than the retired SQL fast path | Removing the `LIMIT`/`OFFSET` fast path means every Documents-tab page load now fetches the user's full artifact set before sorting | Deliberate, stated trade (§Contracts): AlfyAI is self-hosted, single-account-scale; if this is ever measured to matter, the fallback is a cheap `EXISTS` check that restores the SQL fast path when the user has zero artifact-family rows — named here as a future optimisation, not built now |
| A listed kind has no registered editor yet | Slice 4 (Slides) and this slice both start in Wave 3 (`working-plan.md §3`); if Slice 7 merges before Slice 4, a listed Slides row opens to the panel's own "no loader registered" fallback, not a real editor | This slice cannot fix it (it does not touch `DocumentWorkspace.svelte`, and touching it would violate that file's own serialized ownership). **Recommendation, not a change made here:** sequence Slice 7's merge after Slice 4, or accept the narrow window and confirm slice 0's panel has *some* non-crashing fallback for an unregistered `kind` before Slice 7 ships — flagged for the orchestrator in the report |
| The containment suite's append order is genuinely ambiguous | `working-plan.md §5` prints "S5b, S6 (S7)" but dispatches S7 in Wave 3, chronologically before S5b/S6 (Waves 4–5) | Not resolved by rewriting the ruling (out of this file's edit scope) — this slice appends in whatever order it actually lands, and the existing "keep both sides" merge rule for append-only files already absorbs the ambiguity |
| An App's raw HTML leaks into a search result | its `content_text` is markup, not prose; a naive content search would surface confusing snippets and false "content match" labels | The exclusion is enforced at **two** layers (the candidate loader's SQL and `scoreDocument`'s re-scoring loop) specifically because either alone is an incomplete guard — see Review Focus #3 |
| The "What AI sees" hide is missed on one render path (desktop table vs mobile meta line) | `DocumentsList.svelte` renders the Status-adjacent action twice (desktop column, mobile meta line via the shared `statusContent` snippet) — a `kind` guard added to only one path leaves a dead, confusingly-tooltipped icon on the other | Task 3's test asserts both render paths, not just the desktop table |
| `metadata_json.artifactType` is absent or malformed on a real row | a genuinely broken row would otherwise vanish silently or crash the list | `parseArtifactFamilyKind` returns `null` on anything unexpected, and `mapArtifactFamilyRow` falls back to `kind: "document"` rather than dropping the row — a wrong chip is a smaller failure than a missing row |
| A future slice-0 facade export (`kindForArtifactRow`) duplicates this slice's local `parseArtifactFamilyKind` | two parsers for the same value can drift | Flagged explicitly in Contracts as a "check before Task 1" item, not silently risked |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — 0 diagnostics (`npm run lint` is broken by nested worktrees; say so).
- [ ] `npm test` — 0 failures; record the pass counts before and after the slice in the report.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` — green, **zero diff** (no table added).
- [ ] `git diff tests/cross-cutting/incognito-artifact-containment.test.ts` shows **no new entry in
      `ALLOWED_WITHOUT_SCOPE`**.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new broad ignore.
- [ ] `E2E_PORT=5480 npx playwright test tests/e2e/knowledge.spec.ts tests/e2e/search-modal.spec.ts
      tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts` — green, pass count read from the output.
- [ ] Real-app visual check at **1440×900 and 390×844, light and dark**, against surfaces mockup §4 and §6: the
      chip row with live counts, the Version column for a `kind`-bearing row, the summary line, a search result
      labelled with its kind.
- [ ] Keyboard pass at both widths: chip row is a real tab stop sequence with `aria-pressed`; a `kind`-bearing
      row's shortened Actions column (Delete only) is still fully reachable.
- [ ] i18n parity green (`npx vitest run src/lib/i18n.test.ts`); no user-visible "Artifact" in either locale —
      grep the diff, don't just trust the reused-key design.
- [ ] No new runtime dependency in `package.json`.
- [ ] Existing `documents.test.ts`, `workspace-search.test.ts`, `documents-table.test.ts`, `DocumentsList.test.ts`,
      `SearchModal.test.ts` pass counts are **strictly greater than** their pre-slice counts, never lower — a
      dropped existing test is a regression this slice must not introduce.
