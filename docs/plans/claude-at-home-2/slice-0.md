# Slice 0 — the artifact spine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Land the backbone every other slice stands on — the three tables, the `artifacts/` service boundary,
the type-aware panel, the shared card, the chat header count button — and move the **File** type onto them with
**no regression** for today's produced files. No new model-facing behaviour.

**Architecture:** Artifacts are a new family on the **existing** `artifacts` backbone: one new `type` value
(`'artifact'`) and three child tables (`artifact_versions`, `artifact_comments`, `artifact_kv`). The service
boundary is `src/lib/server/services/artifacts/` behind one facade `artifacts/index.ts`, mirroring the shape of
`knowledge/` and `file-production/`. The panel is `document-workspace/DocumentWorkspace.svelte` **rebuilt in
place** — same file, same props, same test ids — with an optional `kind` on its items and a type→body registry
whose missing entry *is* the File body (the preview stack the panel already renders). One new
`src/lib/components/artifacts/ArtifactCard.svelte` renders every kind, and today's `FileProductionCard.svelte`
becomes the File body inside it. The File type in chat keeps its existing `ToolActivityRow` chrome, so nothing
about a produced file's lifecycle (progress, Stop, Retry, Dismiss, stale detection) changes.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle on better-sqlite3, Vitest, Playwright, Biome, Fallow.
No new dependency is added by this slice.

**Spec:** [`-artifacts-spec.md`](./claude-at-home-2-artifacts-spec.md) §3, §5, §6 (Slice 0). Surfaces 1, 2 and 3
of [`-artifact-surfaces-mockups.html`](./claude-at-home-2-artifact-surfaces-mockups.html) and the File card in
[`-artifacts-mockups.html`](./claude-at-home-2-artifacts-mockups.html) are the design target.
[ADR-0066](../adr/0066-artifacts-are-a-family-of-five-types.md) is the authority on naming.

## Global Constraints

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- **"Artifact" is never shown in the UI.** Code, tables, routes and file names may say artifact; strings,
  `title`, `aria-label` and errors may not. This slice ships per-kind labels and a test that enforces it.
- **One user.** Every read goes through `getArtifactOwnershipScope`
  (`src/lib/server/services/knowledge/store/core.ts:141`). No new exemption in `ALLOWED_WITHOUT_SCOPE` — a green
  guard bought with an exemption is a defect, not a pass.
- **No sharing, no permissions, no co-editing.** Not now, not as a seam.
- **Schema:** the migration and the `_journal.json` entry land in the same commit as the Drizzle tables;
  `npm run check:migrations` must pass. Every new user-keyed table is registered in
  `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` or the completeness guard fails.
- **Svelte 5 only** in touched files: `$props()`, callback props, `onclick`/`onsubmit`, `{@render}`. No new
  `<slot>`, `on:`, `createEventDispatcher`, `afterUpdate`/`beforeUpdate`.
- **Icons:** Lucide via `@lucide/svelte` only — `layout-grid`, `list`, `history`, `download`, `maximize-2`, `x`,
  `file-text`, `square-pen`, `app-window`, `presentation`, `panel-right` exist in 1.17.0; the mockup's `checks`
  is `list-checks` and `chart` is `chart-column`.
- **Lazy:** this slice adds no heavy dependency, and must not make the panel shell import anything heavy.
- **i18n:** EN + HU in `src/lib/i18n/artifacts.ts`, registered in `I18N_MODULES` **and** its prefix added to
  `AUDITED_PREFIXES` (`src/lib/i18n.test-helpers.ts`) in the same commit.
- **Commits:** small, focused, explaining the *why*; stage by explicit path; never bare `git stash`; end every
  message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Never push.
- **`npm run lint` is broken** by nested worktrees — run `npx biome check src scripts tests` and say so.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check                     # 0 errors, 0 warnings
npx biome check src scripts tests
npm test
npm run build                     # 0 warnings
npm run check:migrations
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

## Review Focus

1. **The ownership guard going green by exemption.** `ALLOWED_WITHOUT_SCOPE` must not grow. The guard's second
   test deletes stale exemptions, so an exemption added "just in case" fails the suite later — and a live one
   silences the real query (Task S4).
2. **A File regression.** Produced files have live behaviour: progress, Stop, Retry, Dismiss, the 90 s stale
   heuristic, the placeholder-id case. Every existing `FileProductionCard.test.ts` behaviour must survive the
   card split, and the DOM must not gain a second title (Task S6).
3. **A panel rebuild that breaks one of its three callers.** Chat, Knowledge and the project files dialog all
   render `DocumentWorkspace.svelte` and pass `DocumentWorkspaceItem`s. `npm run check` catches prop drift;
   only a test per caller catches behaviour drift (Task S5).
4. **A count that goes stale or wrong.** The count comes from the conversation detail payload, must be absent at
   zero, must not count another conversation's artifacts, and must not count an incognito conversation's
   artifacts from outside it (Tasks S2/S7).
5. **`artifact_kv` reached without a scoped artifact read.** The table has no user column, so the guard's
   "selects by user" test cannot see it: this slice makes **any** kv reader require a scope marker
   (Task S4).
6. **The migration number printed here being taken.** Take the next free journal number from the tree
   (Task S1).

---

## Contracts

### The migration

The journal's last entry at authoring time is `1777140000110_drop_home_suggestion_events` (`_journal.json`
idx 123), so the next free number is **`1777140000111`, journal idx 124**. **Verify in-tree before writing**
(`ls drizzle/ | tail`, `tail -20 drizzle/meta/_journal.json`) and if it differs, take the real next free number
and say so in the commit message — this is exactly how Feature 1's slice A ended up one number off.

New file `drizzle/1777140000111_artifacts_spine.sql`:

```sql
CREATE TABLE artifact_versions (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author        TEXT NOT NULL,            -- 'user' | 'alfy'
  summary       TEXT NOT NULL,            -- "Alfy shortened the Saturday paragraph"
  body          TEXT NOT NULL,            -- the whole serialised artifact at this point
  body_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX artifact_versions_artifact_idx ON artifact_versions(artifact_id, created_at);

CREATE TABLE artifact_comments (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES artifact_comments(id) ON DELETE CASCADE, -- a reply
  anchor_json   TEXT NOT NULL,            -- {kind:'text',blockId,quote,prefix,suffix} | {kind:'node',nodeId} | {kind:'point',x,y}
  author        TEXT NOT NULL,            -- 'user' | 'alfy'
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  created_at    INTEGER NOT NULL
);
CREATE INDEX artifact_comments_artifact_idx ON artifact_comments(artifact_id, created_at);

CREATE TABLE artifact_kv (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, key)
);
```

Plus the matching `_journal.json` entry (`{"idx": 124, "version": "7", "when": 1777140000111, "tag":
"1777140000111_artifacts_spine", "breakpoints": true}`) and the three names appended to
`requiredExistingTables` in `scripts/prepare-db.ts` (the check is a soft warning, but this is the file that
says which tables a deploy expects).

**Drizzle definitions** go in `src/lib/server/db/schema.ts` beside `artifacts` (`:335-376`), matching that
table's style:

```ts
export const artifactVersions = sqliteTable(
	"artifact_versions",
	{
		id: text("id").primaryKey(),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		author: text("author").notNull(),
		summary: text("summary").notNull(),
		body: text("body").notNull(),
		bodyHash: text("body_hash").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => ({
		artifactIdx: index("artifact_versions_artifact_idx").on(
			table.artifactId,
			table.createdAt,
		),
	}),
);
```

`artifactComments` mirrors it (`parentId` self-reference with `onDelete: "cascade"`, `anchorJson`, `author`,
`body`, `status: text("status").notNull().default("open")`). `artifactKv` has no id and no user column; its
composite key is declared the way this schema already declares composite keys — **read how `artifactChunks` or
`artifactLinks` does it (`schema.ts:600-618`) and match, rather than trusting a signature written from
memory**. `created_at`/`updated_at` use `mode: "timestamp"` like every other timestamp in this file; that maps
to the same `INTEGER` the spec's DDL asks for.

### `src/lib/server/services/artifacts/` — the boundary

Facade `index.ts` re-exports the module's public surface. Callers import **only** from
`$lib/server/services/artifacts/index.ts` (mirrors F1's chat-turn facade rule). Files and their ownership:

| File | Owns |
|---|---|
| `index.ts` | the facade: the public functions and types below, and nothing else |
| `types.ts` | `ArtifactKind`, `ArtifactAuthor`, `ArtifactAnchor`, `ArtifactRecord`, `ArtifactSummary`, `ArtifactDetail`, `ArtifactVersion`, `ArtifactComment`, and the inputs |
| `record.ts` | create / read / update / delete of the `artifacts` row, the type registry, the ownership scope call, and the kind↔metadata mapping |
| `versions.ts` | append (called by `record.updateArtifactBody`), list, get body, restore |
| `comments.ts` | threads, replies, resolve, delete, anchor parsing |
| `serialize/index.ts` | the `ArtifactSerializer` interface + a registry; **this slice ships the `file` entry only** |
| `read-model.ts` | what the panel and the conversation detail need (`ArtifactSummary[]`, counts) |

```ts
// types.ts — the shape every later slice extends
export type ArtifactKind = "document" | "app" | "canvas" | "slides" | "file";
export type ArtifactAuthor = "user" | "alfy";

export interface ArtifactMetadata {
	artifactType: ArtifactKind;
	title: string;
	idIndex?: Record<string, number>;
	[key: string]: unknown;
}

export interface ArtifactRecord {
	id: string;
	userId: string;
	conversationId: string | null;
	kind: ArtifactKind;
	title: string;
	body: string | null;
	bodyHash: string | null;
	metadata: ArtifactMetadata;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactSummary {
	id: string;
	kind: ArtifactKind;
	title: string;
	conversationId: string | null;
	versionNumber: number;
	commentCount: number;
	updatedAt: number;
}

export interface ArtifactDetail extends ArtifactSummary {
	body: string | null;
	bodyHash: string | null;
	metadata: ArtifactMetadata;
}

export interface CreateArtifactInput {
	userId: string;
	conversationId: string | null;
	kind: ArtifactKind;
	title: string;
	body?: string | null;
	summary?: string | null;
	metadata?: Record<string, unknown>;
	/** Who caused the first version row. Defaults to "user". */
	author?: ArtifactAuthor;
	/** The first version's summary, e.g. "Alfy wrote the first draft". */
	versionSummary?: string;
}
```

Public functions (slice 0), all ownership-scoped:

```ts
createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord>;
getArtifact(params: { userId: string; artifactId: string; includeIncognito?: boolean }): Promise<ArtifactDetail | null>;
updateArtifactBody(params: { userId: string; artifactId: string; body: string; bodyHash: string; author: ArtifactAuthor; summary: string }): Promise<{ ok: true; versionId: string } | { ok: false; reason: "not_found" | "refused" }>;
deleteArtifact(params: { userId: string; artifactId: string }): Promise<boolean>;
listArtifactsForConversation(params: { userId: string; conversationId: string }): Promise<ArtifactSummary[]>;
countArtifactsForConversation(params: { userId: string; conversationId: string }): Promise<number>;
```

Rules that belong **inside** `record.ts`, not in its callers:

- The row is written with `type: "artifact"` (the existing column has no constraint, so no DDL change) and
  `metadata_json` carrying `{ artifactType, title }` — `metadata_json.artifactType` is the single source of
  truth for the kind. **Do not add an `artifacts.artifact_type` column**: the spec leaves it optional and
  prefers `metadata_json` (§3), and a column would need its own migration plus a backfill for a value already
  present.
- `retrievalClass` stays `"durable"`. No existing retrieval query selects `type = 'artifact'`, which is why the
  new family cannot leak into the context packet by accident; evidence integration is Slice 5's job.
- `updateArtifactBody` writes `content_text` + `updated_at` **and** appends the version row **in one
  transaction** (`db.transaction`), and returns `"refused"` only when a caller-supplied guard says so (Slice 1).
  A body whose hash does not match its content is not written at all: compute `body_hash` inside the function
  from `body`, never trust the caller's `bodyHash` for storage — take it as the *expected* value and compare.
- `getArtifact` takes the scope from `getArtifactOwnershipScope(userId, { conversationId, includeIncognito })`
  — `includeIncognito: true` only for administration (archive, erasure, disk sweeps), and it must carry the
  scope marker in the source so the guard passes it (Task S4).
- A delete is a real delete: `deleteArtifact` removes the `artifacts` row and lets the FK cascade take the three
  children, inside a transaction (SQLite enforces `foreign_keys = ON` here — verify, and if it does not, delete
  children explicitly in the same transaction).

`versions.ts`:

```ts
appendVersion(params: { artifactId: string; userId: string; author: ArtifactAuthor; summary: string; body: string; bodyHash: string }): Promise<string>;      // returns the version id
listVersions(params: { userId: string; artifactId: string; limit?: number }): Promise<ArtifactVersionSummary[]>;  // newest first, default limit 50
getVersionBody(params: { userId: string; artifactId: string; versionId: string }): Promise<string | null>;
restoreVersion(params: { userId: string; artifactId: string; versionId: string }): Promise<{ ok: boolean; reason?: "not_found" | "no_body" }>;
```

`restoreVersion` writes the old body back through `record.updateArtifactBody` with `author: "user"` and the
summary `restored <the restored version's summary>` — so a restore is itself a version and nothing is lost.
Slice 0 ships it tested but unused; Document and Canvas call it.

`comments.ts`:

```ts
type ArtifactAnchor =
	| { kind: "text"; blockId: string; quote: string; prefix: string; suffix: string }
	| { kind: "node"; nodeId: string }
	| { kind: "point"; x: number; y: number };

createComment(params: { userId: string; artifactId: string; anchor: ArtifactAnchor; author: ArtifactAuthor; body: string; parentId?: string | null }): Promise<ArtifactComment>;
listComments(params: { userId: string; artifactId: string }): Promise<ArtifactComment[]>;   // oldest first, replies nested
resolveComment(params: { userId: string; artifactId: string; commentId: string; resolved: boolean }): Promise<boolean>;
deleteComment(params: { userId: string; artifactId: string; commentId: string }): Promise<boolean>;
parseArtifactAnchor(json: string): ArtifactAnchor | null;   // validating, never throws
```

`parseArtifactAnchor` validates rather than trusts: a `text` anchor needs all five fields as non-empty strings,
`node` needs a non-empty `nodeId`, `point` needs two finite numbers. Malformed JSON returns `null`, and a row
with a `null` anchor is surfaced as an *orphaned* comment by the slice that renders it — never as a crash.

### Routes

| Route | Request | Response | Notes |
|---|---|---|---|
| `GET /api/artifacts/[id]` | — | `{ artifact: ArtifactDetail; versions: ArtifactVersionSummary[]; comments: ArtifactComment[] }` | `requireAuth` (`$lib/server/auth/hooks.ts`); ownership through the scope; **404** for another user's artifact (match what the knowledge routes answer for a foreign artifact — read one and be consistent), never a 403 that confirms existence |
| `GET /api/artifacts?conversationId=…` | query | `{ artifacts: ArtifactSummary[] }` | newest first; validates the conversation belongs to the user before reading |

Both routes are thin: parse, authorise, call the facade, map to JSON via `createJsonResponse` /
`createJsonErrorResponse` (`$lib/server/api/responses.ts`). No SQL, no ownership logic in the route.

### Conversation detail

`ConversationDetail` gains `artifacts: ArtifactSummary[]`, assembled in
`src/lib/server/services/conversation-detail/read-model.ts` (which already attaches generated files, job cards
and draft state). This is the panel list's and the count button's single source, so it refreshes with the
detail payload the chat page already refetches after file-producing turns. Do not add a second fetch path in
the page.

### Client API

New `src/lib/client/api/artifacts.ts`, following `file-production.ts` exactly (injectable fetch, `requestJson`,
no store):

```ts
export async function fetchArtifact(artifactId: string, fetchImpl: FetchLike = fetch): Promise<ArtifactDetailResponse>;
export async function fetchConversationArtifacts(conversationId: string, fetchImpl: FetchLike = fetch): Promise<ArtifactSummary[]>;
```

Lists unwrap through `_unwrapList<T>(payload, "artifacts")` from `./_utils`.

### The panel (`document-workspace/DocumentWorkspace.svelte`)

The panel keeps its **path, its component name, its props, its `data-testid`s** (`page-scroll-container` and the
callers' selectors) and its three callers. What changes:

1. `DocumentWorkspaceItem` (`src/lib/server/services/knowledge/types.ts:238`) gains
   `kind?: ArtifactKind` — **optional, defaulting to `"file"`**, because every item the three existing callers
   build today is a file. `artifactId` already exists on the item and is already what the callers pass as
   `activeDocumentId`, so nothing about the active-id contract moves.
2. The content area dispatches on `kind` through a registry:

```ts
// src/lib/components/artifacts/artifact-bodies.ts
import type { Component } from "svelte";
import type { ArtifactKind } from "$lib/server/services/artifacts/types";

export interface ArtifactBodyProps {
	artifact: { id: string; kind: ArtifactKind; title: string; body: string | null };
	onDirtyChange?: (dirty: boolean) => void;
	onBodyChange?: (body: string) => void;
}

export type ArtifactBodyLoader = () => Promise<{ default: Component<ArtifactBodyProps> }>;

/**
 * A missing entry IS the File body: the panel already renders produced files
 * through the lazy preview stack, so "no loader" means "keep doing that".
 * Slices 1-4 each add exactly one line here.
 */
export const ARTIFACT_BODIES: Partial<Record<ArtifactKind, ArtifactBodyLoader>> = {};
```

3. The panel's header keeps the eyebrow + title + actions layout it has, with the type label from
   `artifacts.kind.<kind>` and the version pill from `ArtifactSummary.versionNumber`; the action set for slice 0
   is the list toggle (`list`), history (`history`, disabled with a title explaining it arrives with Document),
   download (`download`, delegated to the existing download path), `maximize-2` and `x`. No new modal — the
   shell stays the only viewer (AGENTS.md).

### The card

New `src/lib/components/artifacts/ArtifactCard.svelte`:

```ts
export interface ArtifactCardView {
	id: string;
	kind: ArtifactKind;
	title: string;
	/** Rendered as "made by Alfy {when}"; the caller supplies the already-localised time. */
	madeBy?: string | null;
	versionNumber?: number | null;
	/** Null while a job is still running, so Open is not offered. */
	openTargetId?: string | null;
	tickable?: { items: { id: string; text: string; done: boolean }[]; onToggle: (id: string) => void } | null;
}

interface Props {
	view: ArtifactCardView;
	/** Live job state for the File kind in the chat. */
	job?: FileProductionJob | null;
	/** "full" draws the header row; "body" renders only the body, for a host that draws its own header. */
	chrome?: "full" | "body";
	onOpen?: (artifactId: string) => void;
	onRetry?: (jobId: string) => void;
	onCancel?: (jobId: string) => void;
	onDismiss?: (jobId: string) => void;
}
```

- **File in chat keeps its host.** `ToolActivityRow.svelte:257-266` keeps rendering the File body; it now
  renders `ArtifactCard` with `chrome="body"`, so the row's existing verb/title/size stay the only header and
  `FileProductionCard.svelte` is imported by the card rather than by the row. **Every existing
  `FileProductionCard.test.ts` behaviour must still pass**; where a test asserts the row's markup, it moves to
  the card's test unchanged.
- **The four new kinds** render `chrome="full"` in the panel list and in the chat, with a type-specific body
  preview arriving in slices 1–4 (slice 0 renders the icon, title, kind label, version pill and Open).
- `tickable` is slice 0's seam for ADR-0066's tickable checklist card; slice 1 is the first caller.
- **Open** calls `onOpen(artifactId)`; the chat page routes that through the **same** `openWorkspaceDocument`
  path `document.artifactId` already uses, so the panel's state machine does not fork.

### The chat header count button

Markup (mockup surface 1): a quiet button — `layout-grid` icon + the count — that opens the panel on its list
state, and is **not drawn at all** when the chat has made nothing.

```svelte
{#if artifactCount > 0}
	<button
		type="button"
		class="artifact-count-button"
		data-testid="artifact-count-button"
		aria-label={$t('artifacts.header.buttonA11y', { count: artifactCount })}
		onclick={openArtifactList}
	>
		<LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
		<b>{artifactCount}</b>
	</button>
{/if}
```

Placement, and this is a real constraint rather than a preference:

- The desktop home of the button is the chat title bar (`+page.svelte:2643`), which is today
  `justify-center` with a single `<h1>`. It becomes a three-column row (leading spacer, centred title, trailing
  actions) so the title does **not** move by more than the button's width.
- That bar is `hidden … lg:flex`. **Read `tests/e2e/mobile-design.spec.ts` and `tests/e2e/responsive*.spec.ts`
  for assertions about `.chat-title-bar` visibility before touching its breakpoint.** The default plan: leave
  the breakpoint alone and add a page-local `lg:hidden` compact row above the scroll container carrying the
  same button, right-aligned, ≤ 32 px tall, with no title in it (the app `Header.svelte` already shows the
  conversation title on small screens). If those specs pin the title bar visible at 390 px after all, put the
  button in the bar and delete the extra row.
- The count comes from the conversation detail payload and nothing else; it is `0`-absent, not `0`-greyed.

### The File migration (what "no regression" means concretely)

1. Produced files keep their card content: status line, progress sweep + Stop, produced-file rows with Open and
   Download, failure reason with Retry and Dismiss, the 90 s stale heuristic, and the placeholder-id case.
2. The produced-file row's **Open** already receives a `DocumentWorkspaceItem` through `onOpenDocument`; that
   item's `artifactId` is what the panel opens. Use it — do not invent a job→artifact join. If a produced file
   has no artifact row, the row offers Download only and the card's `openTargetId` stays `null`.
3. `artifacts` rows for produced files are what the count button counts.

### Ownership, incognito, lifecycle

- `tests/cross-cutting/incognito-artifact-containment.test.ts` PART B gains the three tables: `artifactVersions`
  and `artifactComments` join `readsGuardedTables` and `selectsByUser` (via `artifactVersions.userId` /
  `artifactComments.userId`), and **`artifactKv` joins `readsGuardedTables` with its "selects by user" test being
  `source.includes("artifactKv.artifactId")`** — because a kv row has no user column, every kv access is
  inherently per-artifact, so a kv reader without a scope marker is exactly the case this guard exists to catch.
  Add that reasoning as a comment beside the helper; a reader who cannot see why will delete it.
- PART A gains behaviour tests for the new tables (see the test list), because PART B only proves a source
  pattern.
- `SCOPE_MARKERS` gains the markers the new service files will carry.
- `user-scoped-tables.ts`: register `artifactVersions` and `artifactComments` as `erasure: "cascade"` with
  `resets: ["workspace"]` only — plan decision 19 explains why `memory` is deliberately absent (the parent
  `artifacts` row survives Clear Memory for `generated_output`, and stripping history from a surviving artifact
  is not what Clear Memory means). `artifactKv` is **not** registered: it has no person column, and the
  completeness guard keys on person columns.
- Account data archive: extend the archive builder so a File artifact's row and its version list appear in
  `Open AlfyAI Data Archive.html`. **Read how artifacts are included today and follow that path**; if the
  archive does not include the artifact family at all yet, add the File kind in this slice and record the gap
  for slices 1–4 in the report rather than inventing a new export format.

### i18n (`src/lib/i18n/artifacts.ts`, new)

| Key | EN | HU |
|---|---|---|
| `artifacts.header.buttonA11y` | `Open what this chat made ({count})` | `Nyisd meg, amit ez a beszélgetés készített ({count})` |
| `artifacts.panel.title` | `What this chat made` | `Amit ez a beszélgetés készített` |
| `artifacts.panel.count` | `{count} items · newest first` | `{count} elem · legújabb elöl` |
| `artifacts.panel.list` | `Show list` | `Lista` |
| `artifacts.panel.empty` | `Nothing made here yet.` | `Itt még nem készült semmi.` |
| `artifacts.card.open` | `Open` | `Megnyitás` |
| `artifacts.card.madeBy` | `made by Alfy {when}` | `Alfy készítette: {when}` |
| `artifacts.card.version` | `v{n}` | `v{n}` |
| `artifacts.kind.file` | `File` | `Fájl` |
| `artifacts.kind.document` | `Document` | `Dokumentum` |
| `artifacts.kind.app` | `App` | `Alkalmazás` |
| `artifacts.kind.canvas` | `Canvas` | `Tábla` |
| `artifacts.kind.slides` | `Slides` | `Diasor` |
| `artifacts.error.load` | `Could not open this item.` | `Nem sikerült megnyitni ezt az elemet.` |
| `artifacts.error.list` | `Could not load what this chat made.` | `Nem sikerült betölteni, amit ez a beszélgetés készített.` |

Two rules with the same commit: the module is added to `I18N_MODULES` and `"artifacts."` to
`AUDITED_PREFIXES` in `src/lib/i18n.test-helpers.ts`, and `src/lib/i18n/artifacts.test.ts` asserts that **no
value** in either locale matches `/artifact/i` (the ADR-0066 naming rule as a test).

Relative time ("2 min ago") reuses whatever the app already has — **check `src/lib/i18n/common.ts` and the
`fileProduction` keys for an existing formatter before adding `artifacts.relative.*`**; if none exists, add the
three forms (`justNow`, `minutesAgo`, `hoursAgo`) with EN and HU values.

### The eval harness skeleton

`scripts/eval-artifact-contracts/` is created here so slices 1–4 only append:

- `README.md` — what it does, what has to be configured, how to run it, and where results go.
- `scoring.ts` + `scoring.test.ts` — the pure scoring module, unit-tested in CI (no model, no browser).
- `types.ts` — `EvalCase`, `EvalAttempt`, `EvalVerdict` (`"good" | "acceptable" | "bad"`), plus `reasons`.
- `cases.ts` — an empty registry with the per-suite shape, so each type's slice appends one entry.
- `run.ts` — the live orchestration: resolves the endpoint from the same configuration the P1 harness used,
  runs one suite, writes `results/<suite>-<timestamp>.json` and a small gallery, and **exits 0 with an
  explanation when nothing is configured**.
- `.gitignore` (or an entry in the repo's existing ignore file — check which pattern the repo uses) for
  `scripts/eval-artifact-contracts/results/`.

Follow `scripts/eval/README-option-a-fidelity.md` for the CI/live split; do not add the live run to `npm test`,
`npm run build` or CI.

---

## File ownership

Exclusive to Slice 0. No other slice touches these files.

| File | Change |
|---|---|
| `drizzle/1777140000111_artifacts_spine.sql`, `drizzle/meta/_journal.json` | create / append |
| `src/lib/server/db/schema.ts` | the three tables |
| `scripts/prepare-db.ts` | three names in `requiredExistingTables` |
| `src/lib/server/services/artifacts/**` + tests | create |
| `src/lib/server/services/conversation-detail/read-model.ts`, `types.ts` + test | `artifacts` in the payload |
| `src/server/services/account-lifecycle/user-scoped-tables.ts` + test | register two tables |
| `src/lib/server/services/account-data-archive/**` + test | artifact rows in the archive |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | the three tables + PART A behaviour tests |
| `src/routes/api/artifacts/**` + tests | create |
| `src/lib/client/api/artifacts.ts` + test | create |
| `src/lib/server/services/knowledge/types.ts` | `kind?: ArtifactKind` on `DocumentWorkspaceItem` |
| `src/lib/components/artifacts/**` + tests | create (`ArtifactCard.svelte`, `artifact-bodies.ts`) |
| `src/lib/components/document-workspace/DocumentWorkspace.svelte` + test | type-aware content area; no prop or test-id changes |
| `src/lib/components/chat/ToolActivityRow.svelte` + test | render the card with `chrome="body"` |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | count button, panel wiring, `openArtifact` |
| `src/lib/i18n/artifacts.ts` + test, `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts` | the dictionary and its registration |
| `scripts/eval-artifact-contracts/**` | skeleton |
| `tests/integration/artifact-spine.test.ts`, `tests/e2e/artifact-panel.spec.ts` | create |

**Serialisation:** `src/lib/components/document-workspace/DocumentWorkspace.svelte`,
`src/routes/(app)/chat/[conversationId]/+page.svelte` and `src/lib/i18n/artifacts.ts` are hot files for every
later slice; Slice 0 must be merged before any of them starts.

**One naming reconciliation the owner has to rule on.** [`slice-6.md`](./slice-6.md) was written after this
file and calls the panel `ArtifactPanel.svelte`, describing it as "Slice 0's file" — 4 occurrences; slices 3–5
do not name the panel file at all. This slice keeps the path and the name
(`document-workspace/DocumentWorkspace.svelte`) because three live callers render it and two source-scan test
suites pin that path (`no-ad-hoc-maps.test.ts:164`, `DocumentsList.test.ts:1471`), which is plan decision 17.
**Do not rename the file to satisfy a prose reference:** if the owner prefers the name `ArtifactPanel`, that is
a separate, reviewed rename commit with the three callers and the two pinning tests updated together — and
`slice-6.md`'s wording is corrected at the same time. Until then, read every "ArtifactPanel.svelte" in
`slice-6.md` as this file's `document-workspace/DocumentWorkspace.svelte`.

---

## Tasks

### Task S1: The three tables, in the tree's own migration discipline

**Files:** `drizzle/1777140000111_artifacts_spine.sql`, `drizzle/meta/_journal.json`,
`src/lib/server/db/schema.ts`, `scripts/prepare-db.ts`, `src/lib/server/db/schema.test.ts` (if it enumerates tables)
**Test:** `npm run check:migrations` plus an integration test that inserts and cascades

- [ ] **Step 1: Confirm the next free migration number in the tree**

```bash
ls drizzle/ | tail -5
tail -20 drizzle/meta/_journal.json
```
Expected: last file `1777140000110_drop_home_suggestion_events.sql`, last `idx` 123. If not, take the real next
free number and say so in the commit.

- [ ] **Step 2: Write the failing test**

`tests/integration/artifact-spine.test.ts` (new) opens with a test that fails for the honest reason — the
tables do not exist:

```ts
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts, artifactComments, artifactKv, artifactVersions } from "$lib/server/db/schema";

it("cascades a deleted artifact's versions, comments and key-value rows", async () => {
	// insert one artifact + one version + one comment + one kv row, delete the artifact,
	// then assert all three child tables are empty for that id.
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run tests/integration/artifact-spine.test.ts`
Expected: FAIL — `artifactVersions` is not exported / no such table.

- [ ] **Step 4: Write the migration, the journal entry, the Drizzle tables and the `prepare-db.ts` list**

Exactly the DDL and definitions in Contracts. Confirm `foreign_keys = ON` for this connection
(`PRAGMA foreign_keys`) and assert the cascade in the test; if the pragma is off, delete children explicitly in
the same transaction and write the reason in a comment.

- [ ] **Step 5: Run the gates for this step**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check:migrations
npm run db:prepare
npx vitest run tests/integration/artifact-spine.test.ts
```
Expected: migration check green, `db:prepare` clean, cascade test PASS.

- [ ] **Step 6: Commit**

```bash
git add drizzle src/lib/server/db/schema.ts scripts/prepare-db.ts tests/integration/artifact-spine.test.ts
git commit -m "Add the artifact family's three tables

Versions, comments and the per-app key-value store hang off the existing
artifacts row rather than a parallel document store, so ownership, incognito
containment, erasure and the disk sweeps keep working through the one
backbone they already understand."
```

### Task S2: The `artifacts/` service boundary

**Files:** `src/lib/server/services/artifacts/index.ts`, `types.ts`, `record.ts`, `serialize/index.ts` + tests
**Test:** `src/lib/server/services/artifacts/record.test.ts`, `serialize/index.test.ts`

**Interfaces:** produces `createArtifact`, `getArtifact`, `updateArtifactBody`, `deleteArtifact`,
`listArtifactsForConversation`, `countArtifactsForConversation` (Contracts above).

- [ ] **Step 1: Write the failing tests**

Behaviours, not implementation details:

1. `createArtifact` writes `type: "artifact"`, `retrieval_class: "durable"`, `metadata_json.artifactType`, and
   returns the record; the row is conversation-scoped when a conversation id is given.
2. `createArtifact` with a conversation id that belongs to another user is **refused** (and no row is written).
3. `getArtifact` returns the record for its owner and `null` for another user's id — `null`, not a throw.
4. `getArtifact` returns `null` for an artifact created inside an **incognito** conversation when called with
   the default scope, and the record when the same call passes `includeIncognito: true`.
5. `updateArtifactBody` writes `content_text` and appends exactly one version row, and the stored `body_hash`
   equals the hash of the stored body (mismatched caller hash is refused, not stored).
6. `deleteArtifact` removes the artifact and the three child tables' rows; a second call returns `false`.
7. `countArtifactsForConversation` counts only that conversation's artifacts, and only for its owner.
8. `serialize/index.ts` resolves a serializer by kind, returns `null` for a kind with no serializer instead of
   throwing, and the `file` serializer round-trips a produced-file descriptor.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/server/services/artifacts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the boundary**

Ownership first, everything else after: `record.ts` calls `getArtifactOwnershipScope` and builds its conditions
with `buildArtifactCanonicalOwnershipCondition` / the visibility helper already in
`knowledge/store/core.ts` — do not hand-roll a `user_id = ?` where a canonical condition exists. The source file
must carry a scope marker so the guard passes it (Task S4).

- [ ] **Step 4: Run the tests and the guard**

```bash
npx vitest run src/lib/server/services/artifacts
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npm run check
```
Expected: PASS. **If the guard fails, fix the scope — do not add an exemption.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/artifacts
git commit -m "Add the artifacts service boundary

One facade over record, versions, comments and per-kind serialisation, with the
ownership scope taken on every read. Later slices extend this module; nothing
outside it queries the artifact tables directly."
```

### Task S3: Versions and comments services

**Files:** `src/lib/server/services/artifacts/versions.ts`, `comments.ts` + tests
**Test:** `versions.test.ts`, `comments.test.ts`

- [ ] **Step 1: Write the failing tests**

Versions: append → list is newest first; `limit` defaults to 50; `getVersionBody` returns the stored body and
`null` for a version of another artifact; `restoreVersion` writes the old body back **as a new version** whose
summary names what was restored, and returns `{ok: false, reason: "no_body"}` when the version has none.

Comments: a root comment and a reply both round-trip with `parent_id` set; `listComments` nests replies under
their parent and orders both oldest first; `resolveComment(true)` flips `status` and `false` flips it back;
`deleteComment` on a parent removes its replies (assert the rows, not just the API); another user's ids are
`null`/`false` everywhere; `parseArtifactAnchor` returns `null` for malformed JSON and for each of the three
anchor shapes with a missing or wrong-typed field.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement**, then **Step 4: run**:

```bash
npx vitest run src/lib/server/services/artifacts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/artifacts
git commit -m "Add artifact versions and comments

Both are type-agnostic and ship before any type has UI: a version is the whole
serialised artifact at a point in time, a comment carries an opaque, validated
anchor, and neither is readable from outside the artifact's owner."
```

### Task S4: Ownership, incognito, lifecycle and archive

**Files:** `tests/cross-cutting/incognito-artifact-containment.test.ts`,
`src/lib/server/services/account-lifecycle/user-scoped-tables.ts` + `account-lifecycle.test.ts`,
`src/lib/server/services/account-data-archive/**` + test
**Test:** the guard file itself, the lifecycle suite, the archive suite

- [ ] **Step 1: Write the failing tests**

PART A of the guard gains, for the new tables:

1. a version row of an incognito artifact is not readable with the default scope, and neither is its comment;
2. an `artifact_kv` value set inside an incognito artifact is not readable from outside it;
3. deleting an incognito conversation removes its artifacts **and** their versions, comments and kv rows;
4. a normal conversation can still read its own versions, comments and kv values.

PART B gains the three tables as described in Contracts, including the `artifactKv` rule. Add an assertion in
PART B that the exemption list is unchanged in size **and** that each new table's reader path is reachable:
the guard's own "keeps the allow-list honest" test covers the second half.

`account-lifecycle.test.ts` gains the per-table no-survivor test: create a throwaway user with a File artifact
and one version, comment and kv row each; run `eraseUserAccountData`; assert zero rows in all three tables and
no artifact row. Then assert the **reset scopes**: `clearMemoryAndKnowledgeForUser` deletes a Document-kind
artifact (cascade takes its children) and **keeps** a `generated_output` artifact's history — the plan-19
decision, written as a test so it cannot drift silently.

The archive test asserts the File artifact's row and its version list appear in the generated archive.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npx vitest run src/lib/server/services/account-lifecycle
```

- [ ] **Step 3: Implement** the guard's table lists, the registry entries, and the archive section.

- [ ] **Step 4: Run the full cross-cutting and lifecycle suites**

```bash
npx vitest run tests/cross-cutting src/lib/server/services/account-lifecycle src/lib/server/services/account-data-archive
npm run check
```
Expected: PASS, **with no change to `ALLOWED_WITHOUT_SCOPE`**. Verify with
`git diff tests/cross-cutting/incognito-artifact-containment.test.ts` that the exemption object is untouched.

- [ ] **Step 5: Commit**

```bash
git add tests/cross-cutting src/lib/server/services/account-lifecycle src/lib/server/services/account-data-archive
git commit -m "Scope the artifact tables and wire them into erasure

The guard now reaches versions, comments and the key-value table: a key-value
row has no user column, so any reader of it must carry the scope marker that
proves the artifact id came from a scoped read. Erasure cascades; Clear Memory
is deliberately scoped to the workspace so it cannot strip history from an
artifact it keeps."
```

### Task S5: The panel becomes type-aware

**Files:** `src/lib/server/services/knowledge/types.ts`,
`src/lib/components/document-workspace/DocumentWorkspace.svelte` + `DocumentWorkspace.test.ts`,
`src/lib/components/artifacts/artifact-bodies.ts`
**Test:** the existing panel suite plus a new dispatch test

- [ ] **Step 1: Write the failing tests**

1. An item with no `kind` renders exactly what it renders today (**before** the change, capture the current
   rendering with a fixture and assert the same test ids and the same preview path after it).
2. An item with `kind: "document"` and a registered loader renders the loaded component's marker test id, and
   the loader was called **once** across two re-renders (the cached-promise rule).
3. A kind with **no** loader (today: every kind, including `file`) renders the existing preview stack.
4. A caller passing an unknown active id does not crash the panel.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the `kind` field and the dispatch, using
  the cached-promise lazy pattern already in this component (`DocumentWorkspace.svelte:611-626`) rather than a
  new one.

- [ ] **Step 4: Run the panel suite and the three callers' suites**

```bash
npx vitest run src/lib/components/document-workspace "src/routes/(app)/knowledge" "src/routes/(app)/projects"
npm run check
```
Expected: PASS. A failure here means a caller regressed: fix the caller, do not loosen the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/knowledge/types.ts src/lib/components/document-workspace src/lib/components/artifacts
git commit -m "Make the document workspace type-aware

The panel keeps its path, props and test ids: the three callers already pass an
artifact id as the active document, so a type-aware content area needs one
optional field and a loader registry. A missing loader is the File body the
panel already renders."
```

### Task S6: One card, and File moved onto it

**Files:** `src/lib/components/artifacts/ArtifactCard.svelte` + `ArtifactCard.test.ts`,
`src/lib/components/chat/ToolActivityRow.svelte` + test, `src/lib/components/chat/FileProductionCard.svelte`
**Test:** `ArtifactCard.test.ts`, the existing `FileProductionCard.test.ts`, `ToolActivityRow`'s test

- [ ] **Step 1: Write the failing tests**

1. `chrome="full"` renders the icon, the title, the kind label and Open; `chrome="body"` renders **no title of
   its own** (assert exactly one title element in the composed row markup — this is the regression that a naive
   split causes).
2. `openTargetId: null` renders no Open affordance; a non-null one calls `onOpen` with the id.
3. The File kind with a running job renders the progress/Stop states, with a failed job the Retry/Dismiss
   states, and with a stale job the stale treatment — the same assertions the existing
   `FileProductionCard.test.ts` makes, moved rather than deleted.
4. A `tickable` view renders the first five items and "+N more" (slice 0 only needs the seam to exist; the
   behaviour is slice 1's).

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the card and move the File body inside it,
  leaving `ToolActivityRow`'s rendering of the row chrome unchanged.

- [ ] **Step 4: Run the chat component suites**

```bash
npx vitest run src/lib/components/chat
npm run check
```
Expected: PASS, with no test deleted. If a `FileProductionCard.test.ts` test cannot survive the move, say which
one and why in the report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/components/chat
git commit -m "Draw one card for every artifact kind

The File card keeps its host row and its states; it becomes the File body inside
the shared card instead of a second card beside it, so the four new kinds arrive
into chrome that already works."
```

### Task S7: The panel list, the count button, and the chat page wiring

**Files:** `src/routes/api/artifacts/**` + tests, `src/lib/client/api/artifacts.ts` + test,
`src/lib/server/services/conversation-detail/read-model.ts` + `types.ts` + test,
`src/routes/(app)/chat/[conversationId]/+page.svelte`, `tests/e2e/artifact-panel.spec.ts`
**Test:** route tests, read-model test, the E2E spec

- [ ] **Step 1: Write the failing tests**

Route tests: `GET /api/artifacts/[id]` 401s unauthenticated, 404s for another user's artifact, returns
`{artifact, versions, comments}` for the owner; `GET /api/artifacts?conversationId=…` refuses a conversation
that is not the caller's.

Read-model test: the conversation detail payload carries `artifacts` newest first, matching the conversation,
and **not** carrying an incognito conversation's artifacts when the caller asks from outside it.

E2E `tests/e2e/artifact-panel.spec.ts`:

1. a chat that has made nothing renders **no** `artifact-count-button`;
2. after a file-producing turn the button shows the count; clicking it opens the panel on the list state with
   the File row visible;
3. opening the row shows the produced file's preview through the existing preview path, and closing returns to
   the chat with the message surface intact;
4. at 390×844 the button is reachable without scrolling and the panel opens without horizontal overflow.

Use the existing E2E helpers (`tests/e2e/helpers.ts`) and seed the produced file the way
`tests/e2e/project-files.spec.ts` seeds a generated file rather than inventing a new fixture path.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run src/routes/api/artifacts
npx playwright test tests/e2e/artifact-panel.spec.ts
```

- [ ] **Step 3: Implement** the routes, the client API, the detail payload and the page wiring (count button,
   list state, `openArtifact(artifactId)` reusing `openWorkspaceDocument`'s path).

- [ ] **Step 4: Run the slice's gates** (the Gates block) plus the targeted Playwright set:

```bash
npx playwright test tests/e2e/artifact-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/mobile-design.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/artifacts src/lib/client/api/artifacts.ts src/lib/server/services/conversation-detail "src/routes/(app)/chat/[conversationId]/+page.svelte" tests/e2e/artifact-panel.spec.ts
git commit -m "Open what a chat has made from its header

The count comes from the conversation detail payload the page already
refreshes, so it cannot drift from the panel; at zero the button is not drawn
at all, and the panel opens on its list rather than on a guess."
```

### Task S8: i18n, the naming guard, and the eval-harness skeleton

**Files:** `src/lib/i18n/artifacts.ts` + `artifacts.test.ts`, `src/lib/i18n/index.ts`,
`src/lib/i18n.test-helpers.ts`, `scripts/eval-artifact-contracts/**`
**Test:** `src/lib/i18n.test.ts`, `src/lib/i18n/artifacts.test.ts`, `scripts/eval-artifact-contracts/scoring.test.ts`

- [ ] **Step 1: Write the failing tests**

1. `src/lib/i18n/artifacts.test.ts`: every key exists in both locales (via the shared helper), **and** no value
   in either locale matches `/artifact/i`.
2. `scripts/eval-artifact-contracts/scoring.test.ts`: the scoring module grades a fixture attempt as
   `"good"`/`"acceptable"`/`"bad"` with reasons, and grades an empty answer as `"bad"` rather than throwing.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the dictionary, its registration, and the
  harness skeleton.

- [ ] **Step 4: Run the gates and the dry run**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/i18n.test.ts src/lib/i18n/artifacts.test.ts
npx tsx scripts/eval-artifact-contracts/run.ts --suite file --dry-run   # exits 0
npm test
npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n scripts/eval-artifact-contracts
git commit -m "Name the artifacts in the user's own words

ADR-0066 keeps the word 'Artifact' out of the UI, so the dictionary is per kind
in both languages and a test enforces it. The evaluation harness lands as a
skeleton here so each type's slice appends its own suite."
```

---

## Non-goals

- **No model-facing tools.** `create_artifact`, `edit_artifact` and `read_artifact` are Slice 1's (Document) and
  Slice 2's (App); this slice registers none and changes no prompt.
- **No Document, App, Canvas or Slides body.** The registry ships empty on purpose.
- **No comments UI and no versions UI.** The services and the tables exist and are tested; the first customer is
  Document.
- **No rename** of `DocumentWorkspace.svelte`, `DocumentWorkspaceItem`, or `documents.*` keys (plan decision 17).
- **No Knowledge-page listing change** and no new search scope (spec §9.2 is still open).
- **No first-open tour** — each type's tour belongs to the slice that gives it a UI.
- **No evidence integration** (Slice 5), no cost-display change (Slice 2/4), no `artifact_type` column.
- **No sharing, ever.**

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The guard is made green with an exemption | Silences the real query tomorrow; the second guard test then fails late | Forbidden in Global Constraints; Task S4 step 4 diffs the exemption object |
| The panel rebuild regresses one of three callers | Chat, Knowledge and the project dialog all render it; a silent prop drift is invisible until a user opens a file | Task S5 keeps path/props/test ids, and runs all three callers' suites |
| File behaviour is lost in the card split | Produced files are live: progress, Stop, Retry, Dismiss, stale, placeholder ids | Task S6 moves the assertions rather than deleting them, and asserts exactly one title |
| The count button counts the wrong thing | An incognito conversation's artifacts, or a stale count after a turn | The count comes from the detail payload only; the read model is scoped; E2E covers zero and after-turn |
| The migration number printed here is taken | Two migrations with the same number break the journal | Task S1 step 1 verifies in-tree and reports a difference |
| `metadata_json.artifactType` drifts from the `type` column | Two sources of truth for the kind | `record.ts` is the only writer and reads it back through one parser; no column is added |
| The card gains the word "Artifact" in a tooltip or aria-label | ADR-0066 is a product rule, not a style note | `src/lib/i18n/artifacts.test.ts` and the review's naming pass |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean (`npm run lint` is broken by nested worktrees; say so).
- [ ] `npm test` — green, including `tests/cross-cutting/**` and `src/lib/server/services/account-lifecycle`.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` green, `npm run db:prepare` clean, and the three tables in
      `scripts/prepare-db.ts`.
- [ ] `git diff tests/cross-cutting/incognito-artifact-containment.test.ts` shows **no new entry in
      `ALLOWED_WITHOUT_SCOPE`**; `git diff src/lib/server/services/account-lifecycle/user-scoped-tables.ts` shows
      exactly two new entries.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/artifact-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/mobile-design.spec.ts`
      — green.
- [ ] Real-app visual check at **1440×900 and 390×844, light and dark** against surfaces 1, 2 and 3 and the File
      card: the quiet count button with its number, the panel list with type labels and relative times, one File
      open, and the button absent in an empty chat.
- [ ] i18n parity green; `"artifacts."` in `AUDITED_PREFIXES`; the no-"Artifact"-in-the-UI test green.
- [ ] `scripts/eval-artifact-contracts/run.ts` exits 0 with an explanation when nothing is configured; the scoring
      module is in CI, the live run is not.
- [ ] No new runtime dependency in `package.json`.
- [ ] Chunk evidence recorded in the report: the chat route and the panel shell chunks before and after this
      slice, read from the build output (state the method — the build manifest or a `--json` build log).
