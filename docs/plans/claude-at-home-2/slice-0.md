# Slice 0 — the artifact spine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Land the backbone every other slice stands on — the three tables, the `artifacts/` service boundary,
the type-aware panel, the shared card, the chat header count button — and move the **File** type onto them with
**no regression** for today's produced files. No new model-facing behaviour.

**Architecture:** Artifacts are a new family on the **existing** `artifacts` backbone. The family's own rows are
written with `type: "artifact"`; **today's produced files keep `type: "generated_output"`** and are read as
artifacts of kind `file` (see *The File kind is `generated_output`* below — this is the one place where the
family spans two `type` values, and it is deliberate). Three child tables hang off the artifact row:
`artifact_versions`, `artifact_comments`, `artifact_kv`. The service boundary is
`src/lib/server/services/artifacts/` behind one facade `artifacts/index.ts` — a **directory** with an `index.ts`,
not the parent spec's single `services/artifacts.ts`, which AGENTS.md rules out as a new top-level
`services/*.ts` boundary — mirroring the shape of `knowledge/` and `file-production/`. The panel is `document-workspace/DocumentWorkspace.svelte` **rebuilt in place** — same
file, same props plus two optional additions, same test ids — with an optional `kind` on its items and a type→body
registry whose missing entry *is* the File body (the preview stack the panel already renders). One new
`src/lib/components/artifacts/ArtifactCard.svelte` renders every kind, and today's `FileProductionCard.svelte`
becomes the File body inside it. The File type in chat keeps its existing `ToolActivityRow` chrome, so nothing
about a produced file's lifecycle (progress, Stop, Retry, Dismiss, stale detection) changes.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle 0.45 on better-sqlite3, Vitest, Playwright, Biome, Fallow.
No new dependency is added by this slice.

**Spec:** [`claude-at-home-2-artifacts-spec.md`](./claude-at-home-2-artifacts-spec.md) §3, §5, §6 (Slice 0).
Surfaces 1, 2 and 3 of
[`claude-at-home-2-artifact-surfaces-mockups.html`](./claude-at-home-2-artifact-surfaces-mockups.html) and the
File card in [`claude-at-home-2-artifacts-mockups.html`](./claude-at-home-2-artifacts-mockups.html) are the
design target. [ADR-0066](../adr/0066-artifacts-are-a-family-of-five-types.md) is the authority on naming, and
`decisions.md` rulings 10 and 11 bind this slice directly (panel keeps its path and name; comments are one
shared layer with per-type anchor resolvers).

## Global Constraints

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- **"Artifact" is never shown in the UI.** Code, tables, routes and file names may say artifact; strings,
  `title`, `aria-label` and errors may not. This slice ships per-kind labels and a test that enforces it.
- **One user.** Every read goes through `getArtifactOwnershipScope`
  (`src/lib/server/services/knowledge/store/core.ts:141`). No new exemption in `ALLOWED_WITHOUT_SCOPE` — a green
  guard bought with an exemption is a defect, not a pass. `artifact_kv` has no user column, so **every** kv
  accessor must resolve the artifact through a scoped read first (this is why the kv accessors exist at all,
  rather than a table-level helper).
- **No sharing, no permissions, no co-editing.** Not now, not as a seam.
- **Schema:** the migration and the `_journal.json` entry land in the same commit as the Drizzle tables;
  `npm run check:migrations` must pass. The three new names must be added to `requiredExistingTables` in
  `scripts/prepare-db.ts:32` **in the same commit** — that list is guarded twice and is not cosmetic:
  `scripts/prepare-db.ts:804-808` throws when a listed table is missing from a live database, and
  `scripts/prepare-db.test.ts:140` ("lists every schema table in requiredExistingTables") fails when a
  `sqliteTable("…")` in `schema.ts` is absent from the list. (The soft `console.warn` for the reverse direction
  lives in `scripts/verify-migrations.ts:77-79`, a different check — do not confuse the two.)
- **Every new user-keyed table is registered in
  `src/lib/server/services/account-lifecycle/user-scoped-tables.ts`** or the schema-derived completeness guard
  fails. `artifact_kv` is the exception and its non-registration must be argued in a comment (no person column —
  see that file's own keying rules at `account-lifecycle.test.ts:20-24`).
- **Svelte 5 only** in touched files: `$props()`, callback props, `onclick`/`onsubmit`, `{@render}`. No new
  `<slot>`, `on:`, `createEventDispatcher`, `afterUpdate`/`beforeUpdate`.
- **Icons:** Lucide via `@lucide/svelte` only — `layout-grid`, `list`, `history`, `download`, `maximize-2`, `x`,
  `file-text`, `square-pen`, `app-window`, `presentation`, `panel-right` all exist in 1.17.0
  (`package.json:63`); the mockup's `checks` is `list-checks` and `chart` is `chart-column`. No hand-written
  `<svg>`.
- **Lazy:** this slice adds no heavy dependency, and must not make the panel shell import anything heavy. The
  panel's existing lazy pattern is a cached module promise (`DocumentWorkspace.svelte:611-626`); the new body
  registry uses the same shape and nothing else.
- **Shared-file discipline:** `DocumentWorkspace.svelte`, `ArtifactCard.svelte`, `artifact-bodies.ts`,
  `i18n/artifacts.ts` and the chat page are **shared with slices 1–6**; slice 0 lands first and each later slice
  appends. See *File ownership* for the order and what each slice adds.
- **i18n:** EN + HU in `src/lib/i18n/artifacts.ts`, registered in `I18N_MODULES` **and** its prefix added to
  `AUDITED_PREFIXES` (`src/lib/i18n.test-helpers.ts:7,15`) in the same commit.
- **Commits:** small, focused, explaining the *why*; stage by explicit path; never bare `git stash`; end every
  message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Never push.
- **`npm run lint` is broken** by nested worktrees — run `npx biome check src scripts tests` and say so.

## Gates

Every gate is a **must-pass** for the slice; the reviewer runs them against the final commit.

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check                     # pass = 0 errors, 0 warnings
npx biome check src scripts tests # pass = 0 diagnostics (`npm run lint` is broken by nested worktrees)
npm test                          # pass = 0 failed, 0 skipped-without-reason; record the counts
npm run build                     # pass = 0 warnings
npm run check:migrations          # pass = green
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Playwright for this slice: `tests/e2e/artifacts-panel.spec.ts` plus the regression set
`tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/mobile-design.spec.ts
tests/e2e/conversation-title-refresh.spec.ts`.

## Review Focus

1. **The ownership guard going green by exemption.** `ALLOWED_WITHOUT_SCOPE`
   (`tests/cross-cutting/incognito-artifact-containment.test.ts:529-546`) must not grow. The guard's second
   test deletes stale exemptions, so an exemption added "just in case" fails the suite later — and a live one
   silences the real query (Task S4).
2. **A File regression.** Produced files have live behaviour: progress, Stop, Retry, Dismiss, the 90 s stale
   heuristic (`src/lib/components/chat/file-production-helpers.ts:14`), the placeholder-id case. Every existing
   `FileProductionCard.test.ts` behaviour must survive the card split, and the composed row must not gain a
   second title (Task S6).
3. **A panel rebuild that breaks one of its three callers.** Chat, Knowledge and the project files dialog all
   render `DocumentWorkspace.svelte` and pass `DocumentWorkspaceItem`s. `npm run check` catches prop drift;
   only a test per caller catches behaviour drift (Task S5).
4. **A count that goes stale or wrong.** The count comes from the conversation detail payload, must be absent at
   zero, must not count another conversation's artifacts, and must not count an incognito conversation's
   artifacts from outside it (Tasks S2/S7).
5. **`artifact_kv` reached without a scoped artifact read.** The table has no user column, so the guard's
   "selects by user" test cannot see it: this slice makes **any** kv reader require a scope marker
   (Task S4) and ships no unscoped kv entry point (Contracts → kv accessors).
6. **The migration number printed here being taken.** Take the next free journal number from the tree
   (Task S1 step 1).
7. **The version-number trap.** `created_at` is `unixepoch()` — **one-second** resolution — so two versions
   written in the same second are order-ambiguous. The slice fixes this with a `version_number` column rather
   than by sorting on a second-resolution timestamp (Contracts → the migration).

---

## Contracts

Everything in this section is a **contract**: slices 1–6 import these types and call these signatures. If
implementation forces a change, change it here first, in the same commit, and say why.

### The migration

The journal's last entry at authoring time is `1777140000110_drop_home_suggestion_events`
(`drizzle/meta/_journal.json`, idx 123, `"version": "7"`), so the next free number is **`1777140000111`,
journal idx 124**. **Verify in-tree before writing** (`ls drizzle/ | tail -5`,
`tail -20 drizzle/meta/_journal.json`) and if it differs, take the real next free number and say so in the
commit message — this is exactly how Feature 1's slice A ended up one number off.

New file `drizzle/1777140000111_artifacts_spine.sql`:

```sql
-- The artifact spine: versions, comments and per-artifact key-value state for the
-- artifact family that hangs off the existing `artifacts` row. Three child tables
-- rather than a parallel document store, so ownership, incognito containment,
-- erasure and the disk sweeps keep working through the one backbone they already
-- understand.

CREATE TABLE artifact_versions (
  id             TEXT PRIMARY KEY,
  artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  author         TEXT NOT NULL,            -- 'user' | 'alfy'
  summary        TEXT NOT NULL,            -- "Alfy shortened the Saturday paragraph"
  body           TEXT NOT NULL,            -- the whole serialised artifact at this point
  body_hash      TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX artifact_versions_number_unique_idx
  ON artifact_versions(artifact_id, version_number);
CREATE INDEX artifact_versions_artifact_idx ON artifact_versions(artifact_id, created_at);

CREATE TABLE artifact_comments (
  id             TEXT PRIMARY KEY,
  artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES artifact_comments(id) ON DELETE CASCADE, -- a reply
  anchor_json    TEXT,                     -- null = orphaned; see parseArtifactAnchor
  author         TEXT NOT NULL,            -- 'user' | 'alfy'
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  created_at     INTEGER NOT NULL
);
CREATE INDEX artifact_comments_artifact_idx ON artifact_comments(artifact_id, created_at);

CREATE TABLE artifact_kv (
  id             TEXT PRIMARY KEY,
  artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX artifact_kv_artifact_key_unique_idx ON artifact_kv(artifact_id, key);
```

Two deliberate departures from the parent spec's §3 DDL, both additive:

- **`version_number`** (spec has no such column). `created_at` defaults to `sql`(unixepoch())`` — one-second
  resolution — so an author's edit and Alfy's follow-up in the same second cannot be ordered by time, and
  `ArtifactCardSummary.versionNumber` would be a lie. The column is the authoritative number; the unique index makes
  a double-number a constraint violation rather than a silent duplicate.
- **`anchor_json` is nullable** (spec says `NOT NULL`). A comment whose anchor cannot be parsed has to stay
  representable — the spec's own §7 testing list wants an "orphaned" outcome, and a `NOT NULL` column forces the
  service either to drop the row or to write a fake anchor. `NULL` renders as *orphaned*.

Plus the matching `_journal.json` entry, appended inside `entries` (the object shape and key order match the
file's existing entries verbatim):

```json
{ "idx": 124, "version": "7", "when": 1777140000111, "tag": "1777140000111_artifacts_spine", "breakpoints": true }
```

and the three names appended to `requiredExistingTables` in `scripts/prepare-db.ts:32`
(`"artifact_versions"`, `"artifact_comments"`, `"artifact_kv"`), keeping the list's existing order convention.

**Drizzle definitions** go in `src/lib/server/db/schema.ts` beside `artifacts` (`:335-376`), matching that
table's style. `created_at`/`updated_at` use `mode: "timestamp"` like every other timestamp in this file; that
maps to the same `INTEGER` the DDL asks for.

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
		versionNumber: integer("version_number").notNull(),
		author: text("author").notNull(),
		summary: text("summary").notNull(),
		body: text("body").notNull(),
		bodyHash: text("body_hash").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => [
		uniqueIndex("artifact_versions_number_unique_idx").on(
			table.artifactId,
			table.versionNumber,
		),
		index("artifact_versions_artifact_idx").on(table.artifactId, table.createdAt),
	],
);
```

`artifactComments` mirrors it: `id`, `artifactId`, `userId`, `parentId` (self-reference
`references((): AnySQLiteColumn => artifactComments.id, { onDelete: "cascade" })` — **read how this file
already declares a self-reference before writing it**, the `AnySQLiteColumn` import is already there at
`schema.ts:2`), `anchorJson: text("anchor_json")` (nullable, no `.notNull()`), `author`, `body`,
`status: text("status").notNull().default("open")`, `createdAt`; one index
`artifact_comments_artifact_idx` on `(artifactId, createdAt)`.

**`artifact_kv` keeps the house idiom: a surrogate `id`, and the pair unique.** Ruling 17 settles it. There is
**no composite-primary-key precedent in this file**: every `.primaryKey()` call in `schema.ts` is column-level
(e.g. `artifactChunks` at `:378` and `artifactLinks` at `:422` both declare `id: text("id").primaryKey()`), and
`primaryKey` is **not** in the `drizzle-orm/sqlite-core` import at `schema.ts:2-9` at all — adding it would be a
first-of-its-kind pattern for a constraint a unique index already expresses. The array-returning table callback
is the form this file already uses elsewhere (`schema.ts:103`, `:1965`, `:2013`, `:2559`), and `uniqueIndex` is
already imported (`:2-9`). Write exactly:

```ts
export const artifactKv = sqliteTable(
	"artifact_kv",
	{
		id: text("id").primaryKey(),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => artifacts.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		valueJson: text("value_json").notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(table) => [
		uniqueIndex("artifact_kv_artifact_key_unique_idx").on(table.artifactId, table.key),
		// No user column on purpose: a key-value row is reachable only through a
		// scoped read of its artifact. See artifacts/kv.ts and the containment
		// guard's kv rule.
	],
);
```

`npm run check:migrations` compares the migration files against `schema.ts` by table name; a unique index the
Drizzle side declares and the DDL side forgets must be caught by the cascade/key test in Task S1, not by that
script (read `scripts/verify-migrations.ts:44-79` to see exactly what it does and does not compare before
assuming it covers this).

### `src/lib/server/services/artifacts/` — the boundary

Facade `index.ts` re-exports the module's public surface. Callers import **only** from
`$lib/server/services/artifacts/index.ts` (mirrors F1's chat-turn facade rule). Files and their ownership:

| File | Owns |
|---|---|
| `index.ts` | the facade: the public functions and types below, and nothing else |
| `types.ts` | `ArtifactKind` (re-exported from the shared module), `Anchor` (re-exported the same way), `ArtifactAuthor`, `ArtifactScopeOptions`, `ArtifactMetadata`, `ArtifactRecord`, `ArtifactCardSummary`, `ArtifactDetail`, `ArtifactVersionSummary`, `ArtifactComment`, the kv row type, and the inputs |
| `limits.ts` | the caps in *Limits and configuration*, as exported constants with their reasons in comments |
| `hash.ts` | `hashArtifactBody` — the one body-hash function this slice owns (slice 1 changes its *input*, not its mechanism) |
| `record.ts` | create / read / update / delete of the `artifacts` row, the type registry, the ownership scope call (`readScopedArtifactRow`, the one scoped read every child accessor starts from), the kind↔row-type mapping, **and the version append** (a private step inside `createArtifact`'s and `updateArtifactBody`'s transaction) |
| `versions.ts` | list, get body, restore. *Amended in implementation:* the append lives in `record.ts`, because `restoreVersion` calls `record.updateArtifactBody` and an append in `versions.ts` called back from `record.ts` would be a new import cycle |
| `comments.ts` | threads, replies, resolve, delete, `parseArtifactAnchor` |
| `kv.ts` | the scoped key-value accessors (see below) |
| `serialize/index.ts` | the `ArtifactSerializer` interface + a registry; **this slice ships the `file` entry only** |
| `read-model.ts` | what the panel and the conversation detail need (`ArtifactCardSummary[]`, counts) |

```ts
// src/lib/shared/artifacts/kinds.ts — the union, and nothing else (no runtime imports)
export type ArtifactKind = "document" | "app" | "canvas" | "slides" | "file";

// src/lib/server/services/artifacts/types.ts — the shape every later slice extends
// Both unions live in shared modules; re-exported here so server callers have one import
// site. Browser components import the shared modules directly.
export type { ArtifactKind } from "$lib/shared/artifacts/kinds";
export type { Anchor } from "$lib/shared/artifacts/anchor";

export type ArtifactAuthor = "user" | "alfy";
export type ArtifactCommentStatus = "open" | "resolved";

// Amended in implementation: every scoped read and write takes these, passed
// straight through to getArtifactOwnershipScope. Without `conversationId` an
// incognito chat could not open its OWN artifacts (the default scope hides every
// incognito conversation), and the kv/containment tests need `includeIncognito`.
export interface ArtifactScopeOptions {
	/** The conversation being served; its own artifacts stay in scope even when incognito. */
	conversationId?: string | null;
	/** Administration only: archive, erasure, disk sweeps. */
	includeIncognito?: boolean;
}

// Amended in implementation: a File is never created by the family — it is a
// generated_output row (ruling 18) — so the type system refuses it.
export type CreatableArtifactKind = Exclude<ArtifactKind, "file">;

export interface ArtifactMetadata {
	artifactType: ArtifactKind;
	title: string;
	// No `idIndex`: the parent spec's §3 sketch carried one, nothing here or in any later
	// slice writes it, and dead state does not ride along (ruling 37.2). A type that needs
	// its own index adds a named field of its own.
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
	versionNumber: number;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactCardSummary {
	id: string;
	kind: ArtifactKind;
	title: string;
	conversationId: string | null;
	/** The newest version's number; 0 for a row with no version yet. */
	versionNumber: number;
	commentCount: number;
	updatedAt: number;
}

export interface ArtifactDetail extends ArtifactCardSummary {
	body: string | null;
	bodyHash: string | null;
	metadata: ArtifactMetadata;
}

export interface ArtifactVersionSummary {
	id: string;
	versionNumber: number;
	author: ArtifactAuthor;
	summary: string;
	createdAt: number;
}

export interface ArtifactComment {
	id: string;
	artifactId: string;
	parentId: string | null;
	/** null = the anchor could not be parsed; render as orphaned, never crash. */
	anchor: Anchor | null;
	author: ArtifactAuthor;
	body: string;
	status: ArtifactCommentStatus;
	createdAt: number;
	/** Replies, oldest first. Empty on a reply itself. */
	replies: ArtifactComment[];
}

export interface ArtifactKvRow {
	key: string;
	valueJson: string;
	updatedAt: number;
}

export interface CreateArtifactInput {
	userId: string;
	conversationId: string | null;
	kind: CreatableArtifactKind;
	title: string;
	body?: string | null;
	metadata?: Record<string, unknown>;
	/** The first version's author. Defaults to "user". */
	author?: ArtifactAuthor;
	/** The first version's summary, e.g. "Alfy wrote the first draft". */
	versionSummary?: string;
}
```

**`ArtifactKind` lives in `src/lib/shared/artifacts/kinds.ts`, not in `types.ts`.** The panel, the card and the
body registry are browser components; importing the kind union from a `$lib/server/services/**` module would pull
a server path into the client graph for a five-string union. The shared module holds the union only — no
runtime imports — and `types.ts` re-exports it so server callers still have one import site. Slices 1–4 append
nothing here (the five kinds are fixed by ADR-0066) but do import it.

**Name collision, avoided by naming ours differently.** `ArtifactSummary` is already exported by
`src/lib/server/services/knowledge/types.ts:60` and is the type of `ConversationDetail.attachedArtifacts` /
`activeWorkingSet` (`conversation-detail/types.ts:25,40,41`). The two types are different things — one describes
a library document's list row, the other an artifact-family row — and they must not be unified. Ruling 20
settles the naming: **our card summary type is `ArtifactCardSummary`**, and nothing imports the knowledge-side
type under an alias, because an alias hides which type is in play:

- `conversation-detail/types.ts` imports ours plainly:
  `import type { ArtifactCardSummary } from "$lib/server/services/artifacts/types";`
- nothing in this slice renames the knowledge-side `ArtifactSummary` (that would churn
  `knowledge/types.ts`, the read model and their tests for no behaviour).

`versions.ts`:

```ts
// Every signature below also takes `& ArtifactScopeOptions` (amended in implementation).
listVersions(params: { userId: string; artifactId: string; limit?: number }): Promise<ArtifactVersionSummary[]>;  // newest first, default 50
getVersionBody(params: { userId: string; artifactId: string; versionId: string }): Promise<string | null>;
restoreVersion(params: { userId: string; artifactId: string; versionId: string }): Promise<
	{ ok: true; versionId: string } | { ok: false; reason: "not_found" | "no_body" }
>;
```

*Amended in implementation:* there is no public `appendVersion`. The append (number = max + 1, summary clamped
to `ARTIFACT_VERSION_SUMMARY_MAX_CHARS`) is a private step inside `record.ts`'s create and update
transactions — the only two writers — so a stored body and its newest version cannot disagree, and a caller
cannot append a version without writing the body it records. `no_body` means the version's stored body is the
empty string (restoring it would blank the artifact).

`restoreVersion` writes the old body back through `record.updateArtifactBody` with `author: "user"` and the
summary `restored <the restored version's summary>` — so a restore is itself a version and nothing is lost.
Slice 0 ships it tested but unused; Document and Canvas call it.

`comments.ts`:

```ts
// The union is not declared here. It is the one shared `Anchor` type in
// `src/lib/shared/artifacts/anchor.ts` — the file this slice creates (the union alone,
// beside `kinds.ts`) and that slice 1 appends its Document resolver to. `types.ts`
// re-exports it, so server callers still have one import site (ruling 35: two unions for
// one concept is how they drift).
import type { Anchor } from "$lib/shared/artifacts/anchor";

// Every signature below also takes `& ArtifactScopeOptions` (amended in implementation).
createComment(params: {
	userId: string;
	artifactId: string;
	anchor: Anchor | null;          // required on a root; ignored (stored NULL) on a reply
	author: ArtifactAuthor;
	body: string;
	parentId?: string | null;
}): Promise<ArtifactComment | null>;   // null = refused: over-long body, root with no/invalid anchor, reply to a reply, unreachable artifact
listComments(params: { userId: string; artifactId: string }): Promise<ArtifactComment[]>;  // roots oldest first, replies nested
resolveComment(params: { userId: string; artifactId: string; commentId: string; resolved: boolean }): Promise<boolean>;
deleteComment(params: { userId: string; artifactId: string; commentId: string }): Promise<boolean>;
parseArtifactAnchor(json: string | null): Anchor | null;   // validating, never throws
```

*Amended in implementation:* `createComment` returns `null` on a refusal (the Limits section's rule —
"the kv/comments/versions writers return `false`/`null`"), its `anchor` is nullable because a reply's is ignored,
and threading is one level deep: a reply's parent must be a root on the same artifact. Ties within
`created_at`'s one-second resolution are broken by insertion order (`rowid`).

`parseArtifactAnchor` validates rather than trusts: a `text` anchor needs all five fields as non-empty strings,
`node` needs a non-empty `nodeId`, `point` needs two finite numbers. `null` input, malformed JSON, an unknown
`kind`, or a wrong-typed field all return `null`. A reply inherits its parent's anchor (the column is written
`NULL` on a reply) — a reply is anchored to its parent, never to the document.

**The anchor shape is the shared interface ruling 11 asks for; the *resolution* is per type and does not live
here.** Slice 1 owns `text` resolution against the document's block index, slice 3 owns `node`/`point` against
the board. The shared `Anchor` type is the one place both look at, and `parseArtifactAnchor` is the only parser.

`kv.ts` — **new in this slice, and the reason Task S4's kv test can be honest.** A key-value row has no user
column, so a table-level accessor could be called with any artifact id that came from anywhere. Every function
below therefore begins with a scoped artifact read and refuses (`null` / `false` / `[]`) when it fails:

```ts
getKv(params: { userId: string; artifactId: string; key: string }): Promise<string | null>;
setKv(params: { userId: string; artifactId: string; key: string; valueJson: string }): Promise<boolean>;   // upsert
listKv(params: { userId: string; artifactId: string }): Promise<ArtifactKvRow[]>;                          // key ascending
deleteKv(params: { userId: string; artifactId: string; key: string }): Promise<boolean>;
```

These four are the seam slice 2's `window.alfy.storage` bridge calls; they are not reachable from any route in
slice 0. Slice 2 adds the route and the postMessage bridge; it must not add a fifth accessor.

*Amended in implementation:* all four take `& ArtifactScopeOptions` (an incognito App has to reach its own
storage from inside its chat, and the containment test reads it with `includeIncognito`), and all four refuse an
artifact that is not an **App** — storage is an App's and nothing else's, so a Document id cannot be used as a
key-value bag. `setKv` also refuses a value that is not JSON and an empty key.

Public functions (slice 0), all ownership-scoped:

```ts
createArtifact(input: CreateArtifactInput): Promise<
	| { ok: true; artifact: ArtifactRecord }
	| { ok: false; reason: "conversation_not_found" | "too_large" }
>;
getArtifact(params: {
	userId: string;
	artifactId: string;
} & ArtifactScopeOptions): Promise<ArtifactDetail | null>;
updateArtifactBody(params: {
	userId: string;
	artifactId: string;
	body: string;
	author: ArtifactAuthor;
	summary: string;
	/** Optional optimistic guard: the hash the caller last read. */
	baseHash?: string;
} & ArtifactScopeOptions): Promise<
	| { ok: true; versionId: string; bodyHash: string }
	| { ok: false; reason: "not_found" | "too_large" | "stale" | "hash_mismatch" }
>;
deleteArtifact(params: { userId: string; artifactId: string } & ArtifactScopeOptions): Promise<boolean>;
listArtifactsForConversation(params: { userId: string; conversationId: string }): Promise<ArtifactCardSummary[]>;
```

*Amended in implementation:*

- **No `countArtifactsForConversation`.** The conversation detail carries the list, and the header count is
  that list's length — the verification checklist's own instruction ("if the read model ends up inlining the
  count, delete the export rather than leaving a dead one"). A second query for a number the page already
  holds would be a second source that can disagree.
- **A File is read, never written, by the family.** `updateArtifactBody` answers `not_found`, and
  `deleteArtifact` `false`, for a `generated_output` row: AGENTS.md's Knowledge Library rule (no in-app editing
  of generated files) still binds produced files; only the four new kinds are edited in place.
- **`hash_mismatch` is reserved, not reachable here.** The hash is computed inside `updateArtifactBody` from the
  body it stores, so on this path it cannot disagree; the reason stays in the union for slice 1's
  hash-then-hand-off path.
- **`bodyHash` of a row with no version** (a produced file, or an artifact created empty) is the hash of its
  current body, so `getArtifact`'s `bodyHash` and `updateArtifactBody`'s `stale` check can never disagree about
  the same stored string.

`updateArtifactBody`'s refusal reasons, exactly:

| reason | when |
|---|---|
| `not_found` | the scoped read returns nothing (missing, another user's, or incognito-and-unscoped) |
| `too_large` | `body` exceeds `ARTIFACT_BODY_MAX_BYTES` |
| `stale` | `baseHash` was supplied and does not equal the current body hash |
| `hash_mismatch` | the hash computed from `body` is not the value being written (a caller-supplied `bodyHash` disagreement, or a body edited after hashing) |

There is deliberately **no caller-supplied `bodyHash` parameter**: the hash is computed inside the function from
the body it stores, so a mismatched pair cannot reach the database. `hash_mismatch` exists for the sequential
write path (hash, then hand off, then store) that slice 1's patch protocol uses.

`createArtifact`'s two refusal reasons are `conversation_not_found` (the conversation does not exist **or**
belongs to someone else — one reason, deliberately, so a caller cannot probe for another user's conversation id)
and `too_large` (the body exceeds `ARTIFACT_BODY_MAX_BYTES`; nothing is written). Its `title` is **clamped** to
`ARTIFACT_TITLE_MAX_CHARS` rather than refused: a long title is a cosmetic problem, and refusing a whole artifact
over one would lose the body with it. The clamp is applied before the row is written and the stored value is what
`getArtifact` returns — no truncation at render time.

Rules that belong **inside** `record.ts`, not in its callers:

- The row is written with `type: "artifact"` (the existing column has no constraint, so no DDL change) and
  `metadata_json` carrying `{ artifactType, title }` — `metadata_json.artifactType` is the single source of
  truth for the kind. **Do not add an `artifacts.artifact_type` column**: the spec leaves it optional and
  prefers `metadata_json` (§3), and a column would need its own migration plus a backfill for a value already
  present.
- `retrievalClass` stays `"durable"`. No existing retrieval query selects `type = 'artifact'`, which is why the
  new family cannot leak into the context packet by accident; evidence integration is Slice 5's job.
- `updateArtifactBody` writes `content_text` + `updated_at` **and** appends the version row **in one
  transaction** (`db.transaction`). A body whose hash does not match its content is not written at all.
- `getArtifact` takes the scope from `getArtifactOwnershipScope` (`knowledge/store/core.ts:141`) — read that
  call's options shape and match it; do not hand-roll `user_id = ?` where a canonical condition exists
  (`buildArtifactCanonicalOwnershipCondition`, `knowledge/store/core.ts:197-222`, and the visibility helper at
  `:168`). `includeIncognito: true` only for administration, and the source must carry the scope marker so the
  guard passes it (Task S4).
- A delete is a real delete: `deleteArtifact` removes the `artifacts` row and lets the FK cascade take the three
  children, inside a transaction. `foreign_keys = ON` is set for this connection
  (`src/lib/server/db/index.ts:9`, and `src/lib/server/db/in-memory.ts:32` for tests) — the cascade test in
  Task S1 asserts it rather than trusting it; if the pragma is ever off in a path this slice runs on, delete the
  children explicitly in the same transaction and write the reason in a comment.
- `getArtifact` returns `bodyHash` = the newest version's `body_hash` (the hash recorded when that body was
  written). The `artifacts` row has no hash column and this slice does not add one; the two agree by
  construction because `updateArtifactBody` hashes what it stores.

`hash.ts`:

```ts
/** sha256 hex of the exact stored string. Slice 1 canonicalises the INPUT (ruling 12), not this function. */
export function hashArtifactBody(body: string): string;
```

This is the honest boundary for ruling 12: slice 0 hashes bytes; slice 1 defines the canonical block form for
Markdown and hashes *that*, and slice 3 does the same for JSON with stable key order. Neither may add a second
hasher.

### The File kind is `generated_output`

The one decision in this slice that a later reader will otherwise get wrong.

Today's produced files are `artifacts` rows with **`type = "generated_output"`** and **no**
`metadata.artifactType`:

- written at `src/lib/server/services/file-production/source-persistence.ts:278` (with
  `retrieval_class: "ephemeral_followup"`) and `src/lib/server/services/knowledge/capsules.ts:173`;
- read at `src/lib/server/services/chat-files.ts:216,348` and
  `src/lib/server/services/file-production/read-model.ts:100-110`.

**Do not re-type them to `"artifact"`.** Two live rules key on that value:

1. `buildArtifactCanonicalOwnershipCondition` excludes `generated_output` (and `work_capsule`) from canonical
   ownership (`knowledge/store/core.ts:218`) — those are conversation-scoped working artifacts whose
   conversation link is the authority. Re-typing them would silently change their ownership condition.
2. Clear Memory's artifact delete excludes `generated_output` (`account-lifecycle/index.ts:94`) — re-typing
   would make "Clear memory and knowledge" start deleting a user's produced files.

So the family is defined by **two row types in slice 0**, and the mapping lives in exactly one place in
`record.ts`:

```ts
/** The only place row type ↔ kind is decided. Never throw: an unknown row is a file. */
export function kindForArtifactRow(row: { type: string; metadataJson: string | null }): ArtifactKind {
	const metadata = parseArtifactMetadata(row.metadataJson);   // never throws
	if (metadata?.artifactType) return metadata.artifactType;
	return row.type === "generated_output" ? "file" : "file";
}
```

`parseArtifactMetadata(json: string | null): ArtifactMetadata | null` is a validating parse in the same file
(`null` on malformed JSON or a non-object), and `kindForArtifactRow` falls back to `"file"` — the honest default,
because the row types this slice meets that are not `'artifact'` are produced files. `listArtifactsForConversation`
and `countArtifactsForConversation` therefore select `type IN ('artifact', 'generated_output')` **and** filter by
conversation id, scoped by user. A `generated_output` row is only listed when it has a produced file to open
(`chatGeneratedFiles` link present) — the existing `file-production/read-model.ts:100-110` grouping is the
precedent for the join; read it before writing a second one.

The card's File kind uses the live job/ledger data it already has in chat (Task S6); the panel's File body is
the existing preview stack. Nothing about the produced-file path changes.

### Routes

| Route | Request | Response | Notes |
|---|---|---|---|
| `GET /api/artifacts/[id]?conversationId=…` | optional query | `{ artifact: ArtifactDetail; versions: ArtifactVersionSummary[]; comments: ArtifactComment[] }` | `requireAuth` (`$lib/server/auth/hooks.ts`); ownership through the scope; **404** for another user's artifact. `conversationId` is forwarded as `ArtifactScopeOptions.conversationId` to all three reads (artifact, versions, comments), so the conversation that made the artifact can open its own even while incognito — the scope is still built from the caller's own conversations, so naming any other conversation reaches nothing new. |
| `GET /api/artifacts?conversationId=…` | query | `{ artifacts: ArtifactCardSummary[] }` | newest first; validates the conversation belongs to the user before reading |

`GET /api/artifacts/[id]`'s 404 body is the family's own — `{ ok: false, reason: "not_found" }` — with the
wording style of the existing knowledge route (`src/routes/api/knowledge/[id]/+server.ts:11-16`), rather than an
invented error string. Never a 403: a 403 confirms existence.

**The unauthenticated case names its layer.** `requireAuth` throws `redirect(302, "/login")`
(`src/lib/server/auth/hooks.ts:9-15`), so the route test mocks `requireAuth` the way the existing knowledge-route
suites do and asserts the **foreign-artifact 404** and the owner's 200. The **401** belongs to the HTTP layer:
`hooks.server.ts` answers an unauthenticated `/api/**` request with 401 before the route runs
(`decisions.md` ruling 19). Do not write a **route-handler-level** test asserting a 401 from these routes: at
that layer it would fail against the real helper.

Both routes are thin: parse, authorise, call the facade, map to JSON (`src/lib/server/api/responses.ts` for the
success bodies). No SQL, no ownership logic in the route.

**Success and failure have one shape across this feature: `{ ok: true, … }` / `{ ok: false, reason, … }`.** The
`reason` vocabulary lives in the service return types above (`not_found`, `too_large`, `stale`, `hash_mismatch`,
`conversation_not_found`, `no_body`) and every route in slices 1–5 answers with the same field, built with
`json(...)` and a status. Do **not** route these failures through `createJsonErrorResponse`: its body is
`{ error: string }` (`src/lib/server/api/responses.ts`), which would give the panel two error shapes to parse,
and the plan's `reason` values are the contract its tests assert.

### Conversation detail

`ConversationDetail` (`src/lib/server/services/conversation-detail/types.ts:30`) gains:

```ts
/** The artifact family rows for this conversation: the panel list and the header count's source. */
artifacts?: ArtifactCardSummary[];
```

with the plain import from the *Name collision* note above. Assembled in
`src/lib/server/services/conversation-detail/read-model.ts`, which already attaches generated files, job cards
and draft state (bootstrap literal at `:100`, full assembly at `:119,159`). This is the panel list's and the
count button's single source, so it refreshes with the detail payload the chat page already refetches after
file-producing turns. Do not add a second fetch path in the page.

`read-model.query-count.test.ts` asserts `toBeGreaterThan(0)` and `read-model.test.ts` uses `toMatchObject`, so
neither pins an exact query count or an exact payload shape — but **read them before adding a query**, and keep
the artifact read on the same `listArtifactsForConversation` call the panel needs, not one query per row.

### Client API

New `src/lib/client/api/artifacts.ts`, following `src/lib/client/api/file-production.ts` exactly (injectable
`fetchImpl`, `requestJson`, no store):

```ts
import type { ArtifactComment, ArtifactCardSummary, ArtifactDetail, ArtifactVersionSummary } from "$lib/server/services/artifacts/types";

export interface ArtifactDetailResponse {
	artifact: ArtifactDetail;
	versions: ArtifactVersionSummary[];
	comments: ArtifactComment[];
}

export async function fetchArtifact(
	artifactId: string,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactDetailResponse>;

export async function fetchConversationArtifacts(
	conversationId: string,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactCardSummary[]>;
```

Lists unwrap through `_unwrapList<T>(payload, "artifacts")` from `./_utils` — read that helper's signature at
`src/lib/client/api/_utils.ts` and match it (`_unwrapList` is the shared list-unwrapping helper the repo's own
guidance names). Error strings passed to `requestJson` follow the file-production style
(`"Failed to open this item"`).

### The panel (`document-workspace/DocumentWorkspace.svelte`)

The panel keeps its **path, its component name, its props, its `data-testid`s** (`page-scroll-container` at
`:1239`, the version chips below, the callers' selectors) and its three callers. Ruling 10 forbids the rename;
the only test that pins the path is `src/lib/shared/file-types/no-ad-hoc-maps.test.ts:164-169` (the
`DocumentsList.test.ts:1471` citation in `plan.md` decision 17 / ruling 10 is **wrong** — `DocumentsList.test.ts`
contains no reference to the panel path; verified by grep over `src/`). What changes:

1. `DocumentWorkspaceItem` (`src/lib/server/services/knowledge/types.ts:238`) gains
   `kind?: ArtifactKind` — **optional, defaulting to `"file"`**, because every item the three existing callers
   build today is a file. `artifactId` already exists on the item (as does `versionNumber`) and is already what
   the callers pass as `activeDocumentId`, so nothing about the active-id contract moves.
2. The content area dispatches on `kind` through a registry:

```ts
// src/lib/components/artifacts/artifact-bodies.ts
import type { Component } from "svelte";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export interface ArtifactBodyProps {
	artifactId: string;
	kind: ArtifactKind;
	title: string;
	body: string | null;
	/** Fires when the body's own dirty state changes, so the panel can guard closing. */
	onDirtyChange?: (dirty: boolean) => void;
	/** The body hands its serialised form back for versions/refusal. Slice 1 first. */
	onBodyChange?: (body: string) => void;
}

export type ArtifactBodyLoader = () => Promise<{ default: Component<ArtifactBodyProps> }>;

/**
 * A missing entry IS the File body: the panel already renders produced files
 * through the lazy preview stack, so "no loader" means "keep doing that".
 * Slices 1-4 each add exactly one line here, and each must keep the loaders lazy
 * (a static import of a heavy editor puts it in the chat chunk).
 */
export const ARTIFACT_BODIES: Partial<Record<ArtifactKind, ArtifactBodyLoader>> = {};
```

3. The panel gains **exactly two optional props** (no existing prop changes, so all three callers keep
   compiling untouched):

```ts
/** The panel's list view ("what this chat made"). Absent = the list is never shown. */
list?: { open: boolean; items: DocumentWorkspaceItem[]; title?: string } | null;
onListOpenChange?: ((open: boolean) => void) | undefined;
```

   The list renders `list.items` through the same `ArtifactCard.svelte` rows
   (`chrome="full"`), each calling the existing `onSelectDocument(item.artifactId)` and then
   `onListOpenChange(false)`, so selecting from the list re-uses the panel's existing document-selection path
   instead of forking it. The list toggle in the header flips the same flag through the same callback; when the
   panel's own button is pressed the parent's state is the single source, exactly as `presentation` works.
   Escape handling already exists (`DocumentWorkspace.svelte:768` renders
   `<svelte:window onkeydown={handleWindowKeydown} />`, with the `Escape` check at `:569`) — **extend that one
   handler** to close the list first, then behave as today; do not add a second window listener.
4. The panel's header keeps the eyebrow + title + actions layout it has, with the type label from
   `artifacts.type.<kind>` and the version pill from `ArtifactCardSummary.versionNumber`; the action set for slice 0
   is the list toggle (`list`), history (`history`, disabled with a title explaining it arrives with Document),
   download (`download`, delegated to the existing download path), `maximize-2` and `x`. No new modal — the
   shell stays the only viewer (AGENTS.md).
5. **Test-id collision to avoid.** The panel already renders document *version chips* with
   `data-testid="document-version-control"` and `document-version-badge` (`:961`, `:1210`, `:1218`) — those
   belong to the preview's page controls, not to artifact versions. The artifact version pill gets its own ids
   (`data-testid="artifact-version-pill"`), and the list gets `data-testid="artifact-panel-list"`. Do not reuse
   the document ids, and do not rename them.

### The card

New `src/lib/components/artifacts/ArtifactCard.svelte`:

```ts
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import type { FileProductionJob } from "$lib/server/services/file-production/types";

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

- **File in chat keeps its host.** `ToolActivityRow.svelte:257-266` keeps rendering the row chrome and now
  renders `ArtifactCard` with `chrome="body"`; `FileProductionCard.svelte` is imported by the card (lazily, the
  way the row does it today at `ToolActivityRow.svelte:86-92`) rather than by the row. **Every existing
  `FileProductionCard.test.ts` behaviour must still pass**; where a test asserts the row's markup, it moves to
  the card's test unchanged.
- **The four new kinds** render `chrome="full"` in the panel list and in the chat, with a type-specific body
  preview arriving in slices 1–4 (slice 0 renders the icon, title, kind label, version pill and Open).
- `tickable` is slice 0's seam for ADR-0066's tickable checklist card; slice 1 is the first caller.
- **Open** calls `onOpen(artifactId)`; the chat page routes that through `openWorkspaceDocument`
  (`src/routes/(app)/chat/[conversationId]/+page.svelte:881`, already the target of the panel's `onOpenDocument`
  at `:2695`) so the panel's state machine does not fork.
- **Budget ratchet.** `src/lib/shared/file-types/no-ad-hoc-maps.test.ts:37` sets `THRESHOLD = 4` distinct
  extension/MIME literals per file, and `TRANSITIONAL_ALLOWLIST` (`:113-190`) carries per-file budgets as
  ratchets — the panel's entry is `{ext: 4, mime: 0}` at `:164-169`. The type-aware panel and the new card must
  either stay under the threshold or be added to that allowlist with an explicit budget and a comment; do not
  raise `THRESHOLD`, and do not delete the panel's existing entry (that would be a ratchet loosening in the
  other direction — the entry exists because the panel legitimately maps preview kinds).

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

- The desktop home of the button is the chat title bar
  (`src/routes/(app)/chat/[conversationId]/+page.svelte:2643`, style at `:2807`), which is today `justify-center`
  with a single `<h1>`. It becomes a three-column row (leading spacer, centred title, trailing actions) so the
  title does **not** move by more than the button's width. The only test that reads inside this bar is
  `tests/e2e/conversation-title-refresh.spec.ts:111` (`.chat-title-bar h1 .chat-title-main`) and
  `page-runtime.test.ts:2433` — keep the `h1.chat-title-main` structure exactly.
- That bar is `hidden … lg:flex`. `tests/e2e/mobile-design.spec.ts`, `mobile-scale.spec.ts`,
  `responsive.spec.ts` and `responsive-verification.spec.ts` exist and must be run before the breakpoint is
  touched; today none of them assert on `.chat-title-bar` (verified by grep over `tests/`). The default plan:
  leave the breakpoint alone and add a page-local `lg:hidden` compact row above the scroll container carrying
  the same button, right-aligned, ≤ 32 px tall, with no title in it (the app `Header.svelte` already shows the
  conversation title on small screens). If those specs turn out to pin the title bar visible at 390 px, put the
  button in the bar and delete the extra row — and say so in the commit.
- The count comes from the conversation detail payload and nothing else; it is `0`-absent, not `0`-greyed.
- The list state is **new**: `OpenDocumentsRail.svelte:30-51` renders the panel's *open* documents, which is a
  different list from "what this chat made". Do not repurpose the rail; use the `list` prop above.

### The File migration (what "no regression" means concretely)

1. Produced files keep their card content: status line, progress sweep + Stop, produced-file rows with Open and
   Download, failure reason with Retry and Dismiss, the 90 s stale heuristic
   (`file-production-helpers.ts:14`), and the placeholder-id case (`:64-66`).
2. The produced-file row's **Open** already receives a `DocumentWorkspaceItem` through `onOpenDocument`; that
   item's `artifactId` is what the panel opens. Use it — do not invent a job→artifact join. If a produced file
   has no artifact row, the row offers Download only and the card's `openTargetId` stays `null`.
3. `artifacts` rows for produced files are what the count button counts — through
   `listArtifactsForConversation`'s `type IN ('artifact', 'generated_output')` rule, not a second query.

### Ownership, incognito, lifecycle, archive

- `tests/cross-cutting/incognito-artifact-containment.test.ts` PART B gains the three tables. Read the helpers
  first: `SCOPE_MARKERS` at `:498-508`, `ALLOWED_WITHOUT_SCOPE` at `:529-546`, `readsGuardedTables` at `:561`,
  `selectsByUser` at `:579`, `carriesScopeMarker` at `:591`, and the two guard tests at `:595-668`.
  - `artifactVersions` and `artifactComments` join `readsGuardedTables` and `selectsByUser` (via
    `artifactVersions.userId` / `artifactComments.userId`).
  - `artifactKv` joins `readsGuardedTables` with its "selects by user" test being
    `source.includes("artifactKv.artifactId")` — because a kv row has no user column, every kv access is
    inherently per-artifact, so a kv reader without a scope marker is exactly the case this guard exists to
    catch. Add that reasoning as a comment beside the helper; a reader who cannot see why will delete it.
- PART A gains behaviour tests for the new tables (see the test list), because PART B only proves a source
  pattern.
- `SCOPE_MARKERS` gains the markers the new service files will carry (`artifacts.conversationId` is already
  there at `:498-508`; add whatever `record.ts`/`kv.ts` introduce and nothing decorative).
- `src/lib/server/services/account-lifecycle/user-scoped-tables.ts`: register `artifactVersions` and
  `artifactComments` as `erasure: "cascade"` with `resets: ["workspace"]` only — plan decision 19 explains why
  `memory` is deliberately absent (the parent `artifacts` row survives Clear Memory for `generated_output`, and
  stripping history from a surviving artifact is not what Clear Memory means). Match the entry shape of the
  `artifacts` entry at `:271-276` and keep the list's **child-before-parent ordering**; the reset list builder
  is `tablesForResetScope` at `:454`. `artifactKv` is **not** registered: it has no person column, and the
  completeness guard keys on person columns (`account-lifecycle.test.ts:20-24`, `:31-38`, `:41-52`) — write that
  reason in the file, not only in this slice.
- **Three pinned lists in `account-lifecycle.test.ts` must be updated in the same commit** or the suite fails:
  the exact sorted table-name list at `:686`, and the exact ordered `memory`/`workspace` reset lists at `:790+`.
- Account data archive: the archive reads artifacts directly and **deliberately bypasses the ownership scope**
  — the reasoning is in the file itself around `index.ts:348-355`, and the user filter is the only guard. A
  File artifact's rows must therefore reach `addFilesSection` (signature at `:386`): add `"artifact"` to the
  `readableArtifacts` filter at `:135-141` (which today names only `source_document`, `normalized_document` and
  `generated_output`) and add the version list to the artifact's entry page. Add the version query beside
  `listArtifacts` (`:911`) and filter it `.where(eq(artifactVersions.userId, userId))` — that filter is both
  correct and what keeps the containment guard's `selectsByUser` test satisfied, so do not drop it and do not
  reach for an exemption. **`artifact_kv` rows are archived, and erased** (ruling 24): an App's stored data can
  be real user content — a cost splitter's expenses, a tracker's ticks — so the archive gains a readable JSON
  entry per artifact (its keys and values, scoped to the artifact, never a table dump) beside the version list.
  The bridge that *writes* kv rows arrives in slice 2; that is not a reason to ship an export format that
  silently drops what the user typed into an App. Ruling 24 settles the earlier "app-owned cache or user
  content" question: user content wins.
  - **Erasure is the same decision seen from the other side.** Kv rows must disappear with their artifact:
    erasure hard-deletes the `artifacts` row (`account-lifecycle/index.ts:127`) and the FK cascade takes all
    three children. Assert it in Task S4 step 1 — archiving and erasing together are what keeps the archive
    honest rather than a leak.

### i18n (`src/lib/i18n/artifacts.ts`, new)

| Key | EN | HU |
|---|---|---|
| `artifacts.header.buttonA11y` | `Open what this chat made ({count})` | `Nyisd meg, amit ez a beszélgetés készített ({count})` |
| `artifacts.panel.title` | `What this chat made` | `Amit ez a beszélgetés készített` |
| `artifacts.panel.count` | `{count} items · newest first` | `{count} elem · legújabb elöl` |
| `artifacts.panel.list` | `Show list` | `Lista` |
| `artifacts.panel.back` | `Back to the item` | `Vissza az elemhez` |
| `artifacts.panel.empty` | `Nothing made here yet.` | `Itt még nem készült semmi.` |
| `artifacts.card.open` | `Open` | `Megnyitás` |
| `artifacts.card.madeBy` | `made by Alfy {when}` | `Alfy készítette: {when}` |
| `artifacts.card.version` | `v{n}` | `v{n}` |
| `artifacts.type.file` | `File` | `Fájl` |
| `artifacts.type.document` | `Document` | `Dokumentum` |
| `artifacts.type.app` | `App` | `Alkalmazás` |
| `artifacts.type.canvas` | `Canvas` | `Tábla` |
| `artifacts.type.slides` | `Slides` | `Diasor` |
| `artifacts.error.load` | `Could not open this item.` | `Nem sikerült megnyitni ezt az elemet.` |
| `artifacts.error.list` | `Could not load what this chat made.` | `Nem sikerült betölteni, amit ez a beszélgetés készített.` |
| `artifacts.error.gone` | `This item was deleted.` | `Ezt az elemet törölték.` |
| `artifacts.error.tooLarge` | `This item is too large to save.` | `Ez az elem túl nagy ahhoz, hogy elmentsük.` |
| `artifacts.action.retry` | `Try again` | `Újrapróbálom` |
| `artifacts.action.dismiss` | `Dismiss` | `Elvetés` |
| `artifacts.history.comingWithDocument` | `History arrives with documents.` | `Az előzmények a dokumentumokkal érkeznek.` |

`artifacts.type.canvas` is **`Canvas`** in English and **`Tábla`** in Hungarian (ruling 20, per ADR-0066's
label list): the English word stays the product's own term, and "Tábla" reads as the thing the user draws on
(the Hungarian question in spec §9.3). Note the pair in the dictionary's header comment so slices 3–4 do not
"fix" the Hungarian back to a literal translation.

**One type family, owned here.** Ruling 22: `artifacts.type.*` is the feature's only type-label family, owned by
this slice. An earlier draft of this file shipped the same five words under `artifacts.kind.*`; that spelling is
gone with the ruling — no later slice adds a second family or a second set of the same five words.

Two rules with the same commit: the module is added to `I18N_MODULES` and `"artifacts."` to
`AUDITED_PREFIXES` (`src/lib/i18n.test-helpers.ts:7,15` — other prefixes are audited, so a missing entry is a
silent gap), and `src/lib/i18n/artifacts.test.ts` asserts that **no value** in either locale matches
`/artifact/i` (the ADR-0066 naming rule as a test).

**Relative time needs no new keys.** `formatRelativeTime(unixTimestamp, { t, locale })` already exists
(`src/lib/utils/time.ts:44`) over `time.relative.{justNow,minutes,hours,yesterday}` — EN at
`src/lib/i18n/common.ts:22-25`, HU at `:322-325`. The card's `madeBy` string is composed by the caller from
`$t('artifacts.card.madeBy', { when: formatRelativeTime(row.updatedAt, { t: $t }) })`. Do not add
`artifacts.relative.*`; a second relative-time vocabulary is exactly the kind of duplication the repo's
boundaries forbid.

### Limits and configuration

Every cap this slice enforces, where it lives, and its default. **None of these is environment-backed or
admin-configurable in v1** — the honest reason is in the table, and the constant lives in
`src/lib/server/services/artifacts/limits.ts` as an exported `const` with that reason as its comment. If a cap
ever needs admin tuning it follows the `env.ts` → `config-store.ts` → settings-route path (AGENTS.md), and that
is a change to *that* cap alone.

| Constant | Default | Where enforced | Why not configurable |
|---|---|---|---|
| `ARTIFACT_BODY_MAX_BYTES` | `2 * 1024 * 1024` | `record.createArtifact` / `record.updateArtifactBody` → `too_large` | Bodies are `content_text` in SQLite; a 2 MiB ceiling is 20× the largest real document body and a config knob for a value nothing tunes is a worse trade than a constant with a test |
| `ARTIFACT_TITLE_MAX_CHARS` | `200` | `record.createArtifact` (clamps, never refuses) | Card and panel titles are one line; truncation belongs at write, not at every render |
| `ARTIFACT_VERSION_SUMMARY_MAX_CHARS` | `500` | `versions.appendVersion` | A summary is a sentence, and it is rendered in the history list |
| `ARTIFACT_VERSIONS_DEFAULT_LIMIT` | `50` | `versions.listVersions` | Matches the repo's list-page conventions; the parameter is overridable per call |
| `ARTIFACT_COMMENT_BODY_MAX_CHARS` | `10_000` | `comments.createComment` | A comment is prose, not a document |
| `ARTIFACT_KV_MAX_KEYS` | `200` | `kv.setKv` (insert path only) | An App's storage; slice 2's bridge must not become an unbounded bag |
| `ARTIFACT_KV_KEY_MAX_CHARS` | `128` | `kv.setKv` | localStorage-shaped keys |
| `ARTIFACT_KV_VALUE_MAX_BYTES` | `256 * 1024` | `kv.setKv` | One App's whole state should stay in the low hundreds of kB; slice 2 surfaces the refusal |

Refusals are return values, not throws: `createArtifact` and `updateArtifactBody` return their typed failure
(`too_large`), and the kv/comments/versions writers return `false`/`null`. A throw from these paths would need
every slice-1–4 caller to wrap them, and the model-facing tools (slice 1) must return a structured refusal the
model can read.

### UI states (1440 px and 390 px)

Tokens are the real ones in `src/app.css`: `--surface-page`, `--surface-elevated`, `--surface-overlay`,
`--text-primary`, `--text-muted`, `--icon-muted`, `--border-default`, `--border-subtle`, `--focus-ring`,
`--accent`, `--danger`, `--radius-md`, `--radius-lg`, `--space-xs|sm|md|lg`, `--text-2xs|xs|sm|md|base|lg`,
`--font-sans`. No hardcoded hex.

| State | Component | What the user sees |
|---|---|---|
| Empty (no items) | panel list | `artifacts.panel.empty` in `--text-muted`, `--text-sm`, centred in the content area with `--space-lg` padding; **the count button is not drawn at all** |
| Loading | panel list | one quiet line, `aria-busy="true"`, `--text-muted`; no spinner — the panel is a reading surface (`--surface-page` background stays flat) |
| Error | panel list | `artifacts.error.list` in `--danger` + a `--focus-ring`-ringed **Try again** button, focused on arrival so the keyboard user is not stranded |
| Error (one item) | panel content | `artifacts.error.load` in `--danger`, plus the list's back action |
| Deleted while open | panel content | `artifacts.error.gone` in `--danger`; the panel returns to the list, the **chat surface is untouched** (no toast, no page reload) |
| Long title (1 line) | card header | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`, `title={view.title}` for the full string |
| Long list (200 rows) | panel list | scrolls inside the panel content (`overflow-y: auto`), the header stays fixed — the panel owns its own scroll, `body` never scrolls (AGENTS.md scroll contract) |
| 1440 px | panel + chat | count button sits in `.chat-title-bar`'s trailing column, 28 px tall, `--radius-md`, transparent at rest, `--surface-elevated` on hover, `--focus-ring` ring at 2 px with 2 px offset. The panel is docked (`--presentation` unchanged) |
| 390 px | chat | `.chat-title-bar` is `hidden` below `lg`; the compact `lg:hidden` row carries the same button at 32×32 px, right-aligned, `--space-sm` from the edge, above the scroll container. The panel opens full-width with no horizontal overflow (`overflow-x: hidden` on the content area) |

**Focus and keyboard order.**

- Chat, 1440 px: the title bar's leading spacer is not focusable, so the first stop in the bar is the count
  button; `h1.chat-title-main` stays a heading, not a control.
- Chat, 390 px: the compact row's button is the **first** focusable element in the page content, above the
  message scroll and the composer.
- Panel header actions, DOM order (which is also tab order): list toggle → history → download → expand →
  close. Every one is a real `<button type="button">` with an `aria-label`; the disabled history button keeps
  `aria-disabled="true"` and its title, and is not removed (a disappearing control re-flows the header).
- Panel list rows: one `<ul>` with one focusable control per row; Enter/Space opens (the panel's existing
  selection path), Escape closes the list back to the document, and a second Escape does what it does today.
- Cards in chat: the card body is not a tab stop; the Open affordance and (for a checklist) each tick box are.
  A tick box is a real `<input type="checkbox">` with an accessible name, so Space toggles without a click
  handler being invented.

### Failure modes

| Failure | Server behaviour | EN | HU |
|---|---|---|---|
| Artifact missing, another user's, or incognito-and-out-of-scope | `GET /api/artifacts/[id]` → `404` `{"error":"Artifact not found"}` (shape copied from `src/routes/api/knowledge/[id]/+server.ts:11-16`) | `artifacts.error.load` — "Could not open this item." | "Nem sikerült megnyitni ezt az elemet." |
| Conversation not the caller's | `GET /api/artifacts?conversationId=…` → `404` | `artifacts.error.list` | "Nem sikerült betölteni, amit ez a beszélgetés készített." |
| Unauthenticated | `requireAuth` throws `redirect(302, "/login")` | (the login page) | (a bejelentkező oldal) |
| Body over `ARTIFACT_BODY_MAX_BYTES` | service returns `{ok:false, reason:"too_large"}` (no route writes bodies in slice 0; slice 1's tool maps it) | `artifacts.error.tooLarge` — "This item is too large to save." | "Ez az elem túl nagy ahhoz, hogy elmentsük." |
| Optimistic guard tripped | `{ok:false, reason:"stale"}` | slice 1 renders the per-op refusal; slice 0 has no UI for it and must not invent one | — |
| Network drops mid-open | client API throws; the panel shows `artifacts.error.load` with the focused Try again | as above | as above |
| Artifact deleted while open | next read/write returns `not_found`; the panel shows `artifacts.error.gone` and returns to the list | "This item was deleted." | "Ezt az elemet törölték." |
| Malformed `anchor_json` | `parseArtifactAnchor` → `null`; the comment renders as orphaned (a quiet `--text-muted` note), never a crash | (orphaned comments are silent by design; no new string) | — |
| Malformed `metadata_json` | `parseArtifactMetadata` → `null`; the kind falls back to `file` and the title to the row's `name`; never a throw | — | — |
| Kv value over the cap | `setKv` → `false`; slice 2's bridge reports it to the app | slice 2's contract | slice 2 |

No failure mode in this slice produces a raw English server string in the UI: every user-visible line above is
a dictionary key, and the routes' JSON errors are diagnostics, not UI copy.

### Prototype pointers

Be honest about what exists: **the panel rebuild and the card were not prototyped.** P2
(`proto/artifact-document-editor`) and P3 (`proto/artifact-canvas`) covered the Document editor and the Canvas
board, which are slices 1 and 3 — not this one. Slice 0's hard parts have live reference implementations
instead, and the implementer should read those rather than invent:

| Hard part | Read this |
|---|---|
| The File card's full state machine (status line, progress + Stop, retryable vs terminal failure, Dismiss, stale, placeholder id) | `src/lib/components/chat/FileProductionCard.svelte` and `src/lib/components/chat/file-production-helpers.ts` (`STALE_THRESHOLD_MS` `:14`, `formatElapsed` `:27`, `isStaleJob` `:47`, pending-id prefix `:64`) |
| Panel shell, rail, header, version chips, existing test ids | `src/lib/components/document-workspace/DocumentWorkspace.svelte` (`:33-56` props, `:1200` the rail render, `:1239` `page-scroll-container`) and `src/lib/components/document-workspace/OpenDocumentsRail.svelte:30-51` |
| The lazy cached-promise pattern the registry must copy | `DocumentWorkspace.svelte:611-626` |
| The row that hosts the File body today | `src/lib/components/chat/ToolActivityRow.svelte:86-92` (the lazy import) and `:257-266` (the render) |
| Design target | surfaces 1–3 of `docs/plans/claude-at-home-2-artifact-surfaces-mockups.html`; the File card in `docs/plans/claude-at-home-2-artifacts-mockups.html` |
| For the slices that follow (not this one) | P1 `proto/artifact-apps-quality` (`PROTO_APPS_THINKING=off npm run proto:apps`, thinking-off and the verification-pass evidence), P2 `proto/artifact-document-editor` (`npm run proto:document` → :5195, the block-id trap and the 390 px toolbar), P3 `proto/artifact-canvas` (`npm run proto:canvas` → :5196, the sandbox iframe and `_probe.mjs`'s frame-time numbers) |

### The eval harness skeleton

`scripts/eval-artifact-contracts/` is created here so slices 1–4 only append:

- `README.md` — what it does, what has to be configured, how to run it, and where results go.
- `scoring.ts` + `scoring.test.ts` — the pure scoring module, unit-tested in CI (no model, no browser).
- `types.ts` — `EvalCase`, `EvalAttempt`, `EvalVerdict` (`"good" | "acceptable" | "bad"`), plus `reasons`.
- `cases.ts` — an empty registry with the per-suite shape, so each type's slice appends one entry.
- `run.ts` — the live orchestration: resolves the endpoint from the same configuration the P1 harness used, runs
  one suite, writes `results/<suite>-<timestamp>.json` and a small gallery, and **exits 0 with an explanation
  when nothing is configured**. (P1's harness lives on the throwaway `proto/artifact-apps-quality` branch — the
  findings doc names it as `scripts/prototype-artifact-apps/`, which is **not** in the `dev` tree; read it there
  before writing `run.ts`, and mark unverified anything you cannot see on the branch.)
- `.gitignore`: add `scripts/eval-artifact-contracts/results/*` to the **repo-root** `.gitignore` (the existing
  pattern is `scripts/eval/results/*` at `.gitignore:76`; `scripts/eval/` has no local ignore file, so follow
  the root file rather than creating a nested one).

Follow `scripts/eval/README-option-a-fidelity.md` for the CI/live split; do not add the live run to `npm test`,
`npm run build` or CI.

---

## File ownership

Exclusive to Slice 0 unless the row says **shared**.

| File | Change | Shared |
|---|---|---|
| `drizzle/1777140000111_artifacts_spine.sql`, `drizzle/meta/_journal.json` | create / append | |
| `src/lib/server/db/schema.ts` | the three tables (no new `sqlite-core` import — `uniqueIndex` is already there) | |
| `scripts/prepare-db.ts` | three names in `requiredExistingTables` | |
| `src/lib/server/services/artifacts/**` + tests | create | |
| `src/lib/shared/artifacts/kinds.ts` | create: the `ArtifactKind` union | **shared with slices 1–6** (read-only for them) |
| `src/lib/shared/artifacts/anchor.ts` | create: the shared `Anchor` union (ruling 11/35) — the type only, no resolver | **shared with slices 1–6**; slice 1 appends the Document resolver, slice 3 the canvas one |
| `src/lib/server/services/conversation-detail/read-model.ts`, `types.ts` + test | `artifacts` in the payload | **shared with slice 5** (evidence reads the payload) |
| `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` + `account-lifecycle.test.ts` | register two tables, update the three pinned lists | |
| `src/lib/server/services/account-data-archive/**` + test | artifact rows, versions and kv entries in the archive | |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | the three tables + PART A behaviour tests; **created here, appended to by slices 5 and 6 in that order** (ruling 31) | **shared with slices 5–6** (append-only) |
| `src/routes/api/artifacts/**` + tests | create | |
| `src/lib/client/api/artifacts.ts` + test | create | |
| `src/lib/server/services/knowledge/types.ts` | `kind?: ArtifactKind` on `DocumentWorkspaceItem` | **shared with slices 1–4** (they add per-kind item fields) |
| `src/lib/components/artifacts/**` + tests | create (`ArtifactCard.svelte`, `artifact-bodies.ts`) | **shared with slices 1–4** (each appends one registry line and its card body) |
| `src/lib/components/document-workspace/DocumentWorkspace.svelte` + test | type-aware content area, the `list` props | **shared with slices 1–4** (each adds a body; slice 6 touches it by ruling 10) |
| `src/lib/components/chat/ToolActivityRow.svelte` + test | render the card with `chrome="body"` | |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | count button, panel wiring, `openArtifact` | **shared with slices 1–5** |
| `src/lib/i18n/artifacts.ts` + test, `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts` | the dictionary and its registration | **shared with slices 1–6** (each appends keys) |
| `scripts/eval-artifact-contracts/**`, `.gitignore` | skeleton | **shared with slices 1–4** (each appends a suite) |
| `AGENTS.md` | add the `artifacts/` boundary to the App Map + placement guide, and the ADR-0066 rule that "Artifact" is never UI copy | **shared with slice 5** (its two guidance-line fixes, ruling 5) |
| `tests/integration/artifact-spine.test.ts`, `tests/e2e/artifacts-panel.spec.ts` | create | |

**Serialisation.** Slice 0 lands **first**; slices 1–6 rebase on it. The shared files above are append-only for
them (one registry line, one card body, one dictionary block, one eval suite per slice, with slice 1 also
extending the panel's content area for Document). `AGENTS.md`: slice 0 adds the boundary entry; slice 5 makes
its two corrections to the file-production guidance paragraph — same file, different paragraphs, slice 0 first.

**The panel keeps its path and its name — settled by ruling 10.** [`slice-6.md`](./slice-6.md) was written after
this file and calls the panel `ArtifactPanel.svelte`, describing it as "Slice 0's file" — 4 occurrences; slices
3–5 do not name the panel file at all. Ruling 10 keeps this slice's path and name
(`document-workspace/DocumentWorkspace.svelte`): three live callers render it, a source-scan suite pins that
path (`no-ad-hoc-maps.test.ts:164`), and the same shell serves surfaces that are not artifacts at all
(generated files, chat attachments, library opens, search-result opens). **Do not rename the file** — a rename
is a separate, reviewed change with the callers and the pinning test updated together, not part of Feature 2.
Read every "ArtifactPanel.svelte" in `slice-6.md` as this file's
`document-workspace/DocumentWorkspace.svelte`; the glossary's **Artifact Panel** names the surface, not the
filename.

---

## Tasks

Each task ends at a commit boundary. Work top to bottom; do not start a task whose predecessor is red.

### Task S1: The three tables, in the tree's own migration discipline

**Files:** `drizzle/1777140000111_artifacts_spine.sql`, `drizzle/meta/_journal.json`,
`src/lib/server/db/schema.ts`, `scripts/prepare-db.ts`, `tests/integration/artifact-spine.test.ts`
**Test:** `tests/integration/artifact-spine.test.ts` plus `npm run check:migrations`

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

Add a second assertion to the same test file that proves the composite key is real, not just declared in
Drizzle: inserting the same `(artifact_id, key)` twice must fail, and so must the same
`(artifact_id, version_number)`. A pragma assertion (`PRAGMA foreign_keys`) belongs in the cascade test, so a
future connection change fails here rather than in production.

- [ ] **Step 3: Run it to verify it fails**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run tests/integration/artifact-spine.test.ts
```

Expected: FAIL — `artifactVersions` is not exported / no such table.

- [ ] **Step 4: Write the migration, the journal entry, the Drizzle tables and the `prepare-db.ts` list**

Exactly the DDL and definitions in Contracts (including `version_number`, the nullable `anchor_json`, the
`primaryKey` import and the array-form callback). Confirm `foreign_keys = ON` on this connection
(`src/lib/server/db/index.ts:9`) and assert the cascade in the test; if the pragma is off, delete children
explicitly in the same transaction and write the reason in a comment.

- [ ] **Step 5: Run the gates for this step**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check:migrations
npm run db:prepare
npx vitest run tests/integration/artifact-spine.test.ts
npx vitest run scripts/prepare-db.test.ts
```

Expected: migration check green, `db:prepare` clean (it throws, not warns, when a required table is missing —
`scripts/prepare-db.ts:804-808`), cascade and unique-key tests PASS, and `prepare-db.test.ts:140`'s
"lists every schema table" test PASS.

- [ ] **Step 6: Commit**

```bash
git add drizzle src/lib/server/db/schema.ts scripts/prepare-db.ts tests/integration/artifact-spine.test.ts
git commit -m "Add the artifact family's three tables

Versions, comments and the per-app key-value store hang off the existing
artifacts row rather than a parallel document store, so ownership, incognito
containment, erasure and the disk sweeps keep working through the one
backbone they already understand.

version_number is explicit because created_at is second-resolution, and a
nullable anchor_json is what lets an unparseable comment survive as an
orphan instead of being dropped or faked."
```

### Task S2: The `artifacts/` service boundary

**Files:** `src/lib/server/services/artifacts/index.ts`, `types.ts`, `limits.ts`, `hash.ts`, `record.ts`,
`serialize/index.ts` + tests, `src/lib/shared/artifacts/kinds.ts`
**Test:** `record.test.ts`, `serialize/index.test.ts`, `limits.test.ts`

**Interfaces:** produces `createArtifact`, `getArtifact`, `updateArtifactBody`, `deleteArtifact`,
`listArtifactsForConversation`, `countArtifactsForConversation` (Contracts above).

- [ ] **Step 1: Write the failing tests**

Behaviours, not implementation details:

1. `createArtifact` writes `type: "artifact"`, `retrieval_class: "durable"`, `metadata_json.artifactType`, and
   returns `{ok: true, artifact}` with the first version row (`version_number` 1) already present; the row is
   conversation-scoped when a conversation id is given, and its title is clamped to
   `ARTIFACT_TITLE_MAX_CHARS`.
2. `createArtifact` with a conversation id that belongs to another user is refused with
   `{ok: false, reason: "conversation_not_found"}` and no row is written.
3. `getArtifact` returns the record for its owner and `null` for another user's id — `null`, not a throw.
4. `getArtifact` returns `null` for an artifact created inside an **incognito** conversation when called with
   the default scope, and the record when the same call passes `includeIncognito: true`.
5. `updateArtifactBody` writes `content_text` and appends exactly one version row numbered `max + 1`, and the
   stored `body_hash` equals `hashArtifactBody` of the stored body; a `baseHash` that disagrees with the
   current body is refused `"stale"` and **nothing is written**; a body over `ARTIFACT_BODY_MAX_BYTES` is
   refused `"too_large"` and nothing is written.
6. `deleteArtifact` removes the artifact and the three child tables' rows; a second call returns `false`.
7. `listArtifactsForConversation` returns the conversation's artifacts **and** its `generated_output` rows
   (kind `file`) newest first, and nothing from another conversation or another user;
   `countArtifactsForConversation` agrees with the list's length for the same input.
8. `kindForArtifactRow` maps an `'artifact'` row by `metadata.artifactType`, maps `'generated_output'` to
   `"file"`, and falls back to `"file"` for malformed `metadata_json` instead of throwing.
9. `serialize/index.ts` resolves a serializer by kind, returns `null` for a kind with no serializer instead of
   throwing, and the `file` serializer round-trips a produced-file descriptor.
10. `limits.ts` values are the documented defaults (a test that pins them, so a silent change is visible in the
    diff).

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run src/lib/server/services/artifacts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the boundary**

Ownership first, everything else after: `record.ts` calls `getArtifactOwnershipScope`
(`knowledge/store/core.ts:141`) and builds its conditions with `buildArtifactCanonicalOwnershipCondition` /
the visibility helper already in `knowledge/store/core.ts` — do not hand-roll a `user_id = ?` where a canonical
condition exists. The source file must carry a scope marker so the guard passes it (Task S4).

- [ ] **Step 4: Run the tests and the guard**

```bash
npx vitest run src/lib/server/services/artifacts
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npm run check
```

Expected: PASS. **If the guard fails, fix the scope — do not add an exemption.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/artifacts src/lib/shared/artifacts
git commit -m "Add the artifacts service boundary

One facade over record, versions, comments and per-kind serialisation, with the
ownership scope taken on every read. A produced file stays a generated_output
row and is read as an artifact of kind 'file' — re-typing it would move it out
of the conversation-scoped ownership rule and make Clear Memory delete it.
Later slices extend this module; nothing outside it queries the artifact
tables directly."
```

### Task S3: Versions, comments and the key-value accessors

**Files:** `src/lib/server/services/artifacts/versions.ts`, `comments.ts`, `kv.ts` + tests
**Test:** `versions.test.ts`, `comments.test.ts`, `kv.test.ts`

- [ ] **Step 1: Write the failing tests**

Versions: append numbers `1..n`; list is newest first; `limit` defaults to 50 and is honoured; `getVersionBody`
returns the stored body and `null` for a version of another artifact; `restoreVersion` writes the old body back
**as a new version** whose summary names what was restored and whose number is `max + 1`, and returns
`{ok: false, reason: "no_body"}` when the version has none.

Comments: a root comment and a reply both round-trip with `parent_id` set and the reply's `anchor` null;
`listComments` nests replies under their parent and orders both oldest first; `resolveComment(true)` flips
`status` and `false` flips it back; `deleteComment` on a parent removes its replies (assert the rows, not just
the API); another user's ids are `null`/`false` everywhere; `parseArtifactAnchor` returns `null` for `null`
input, malformed JSON, an unknown `kind`, and each of the three anchor shapes with a missing or wrong-typed
field — and returns the anchor for each valid shape.

Key-value: `setKv` then `getKv` round-trips; `setKv` on an existing key updates instead of inserting a second
row; `listKv` is key-ascending; `deleteKv` removes; **every one of the four returns its empty value for another
user's artifact id and for an incognito artifact read with the default scope** (this is the test that makes the
kv table's missing user column safe); the key-count and value-size caps refuse (`false`) without throwing.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement**, then **Step 4: run**:

```bash
npx vitest run src/lib/server/services/artifacts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/artifacts
git commit -m "Add artifact versions, comments and scoped key-value accessors

Both are type-agnostic and ship before any type has UI: a version is the whole
serialised artifact at a point in time, a comment carries an opaque, validated
anchor that resolves to an orphan rather than a crash, and neither is readable
from outside the artifact's owner.

The key-value accessors take a user id even though the table has no user
column: the only safe way to reach a key-value row is through a scoped read of
its artifact, so the scope check lives inside the accessor instead of in the
callers slice 2 will write."
```

### Task S4: Ownership, incognito, lifecycle and archive

**Files:** `tests/cross-cutting/incognito-artifact-containment.test.ts`,
`src/lib/server/services/account-lifecycle/user-scoped-tables.ts` + `account-lifecycle.test.ts`,
`src/lib/server/services/account-data-archive/**` + test
**Test:** the guard file itself, the lifecycle suite, the archive suite

- [ ] **Step 1: Write the failing tests**

PART A of the guard gains, for the new tables:

1. a version row of an incognito artifact is not readable with the default scope, and neither is its comment;
2. an `artifact_kv` value set inside an incognito artifact is not readable from outside it (through `getKv`
   with the default scope) and **is** readable through the same call with `includeIncognito: true` — the
   positive half is what proves the test is measuring scope and not a broken accessor;
3. deleting an incognito conversation removes its artifacts **and** their versions, comments and kv rows;
4. a normal conversation can still read its own versions, comments and kv values.

PART B gains the three tables as described in Contracts, including the `artifactKv` rule. Add an assertion in
PART B that the exemption list is unchanged in size **and** that each new table's reader path is reachable:
the guard's own "keeps the allow-list honest" test covers the second half.

`account-lifecycle.test.ts` gains the per-table no-survivor test: create a throwaway user with a File artifact
and one version, comment and kv row each; run `eraseUserAccountData`; assert zero rows in all three tables and
no artifact row. Then assert the **reset scopes**: `clearMemoryAndKnowledgeForUser` deletes a Document-kind
artifact (cascade takes its children) and **keeps** a `generated_output` artifact's history — the plan-19
decision, written as a test so it cannot drift silently. Update the three pinned lists in the same commit: the
sorted table-name list at `:686` and the ordered `memory`/`workspace` reset lists at `:790+`.

The archive test asserts the File artifact's row, its version list **and its kv entry** (ruling 24: readable
JSON per artifact, scoped to that artifact, never a table dump) appear in the generated archive, and that a
**second user's** rows do not (the archive bypasses the scope on purpose, so its `user_id` filter is the only
guard and must be proven).

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
artifact it keeps.

The archive gains the artifact family's readable rows and their version
history. Its key-value rows are deliberately not exported yet: the bridge that
writes them arrives with the App slice, and freezing an export format for a
store that does not exist is how a format becomes wrong."
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
5. `list.open` renders the list with one row per item and `list.title` when given; pressing a row calls
   `onSelectDocument(item.artifactId)` **and** `onListOpenChange(false)`; `Escape` closes the list before the
   panel's own Escape behaviour runs (assert the panel is still open with the document showing).

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the `kind` field, the dispatch and the two
  optional list props, using the cached-promise lazy pattern already in this component
  (`DocumentWorkspace.svelte:611-626`) rather than a new one, and extending the existing window keydown handler
  (`:768`, `Escape` at `:569`) rather than adding a second listener.

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
panel already renders.

Two optional props carry the list view, and the panel's existing Escape
handler learns to close it first, so 'what this chat made' is a state of the
one shell instead of a second surface beside it."
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
5. The card is lazy: a static import of the File body would put it in every chat chunk — assert the card module
   does not statically import `FileProductionCard.svelte` (the same way `ToolActivityRow` is asserted today) if
   the row's existing test already does this; otherwise assert the lazily-imported module is not requested until
   the body opens.

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
into chrome that already works. The File body stays a lazy import, so the chat
chunk does not grow by the production card's states."
```

### Task S7: The panel list, the count button, and the chat page wiring

**Files:** `src/routes/api/artifacts/**` + tests, `src/lib/client/api/artifacts.ts` + test,
`src/lib/server/services/conversation-detail/read-model.ts` + `types.ts` + test,
`src/routes/(app)/chat/[conversationId]/+page.svelte`, `tests/e2e/artifacts-panel.spec.ts`
**Test:** route tests, read-model test, the E2E spec

- [ ] **Step 1: Write the failing tests**

Route tests: `GET /api/artifacts/[id]` 404s for another user's artifact and returns `{artifact, versions,
comments}` for the owner; `GET /api/artifacts?conversationId=…` refuses a conversation that is not the
caller's. **Mock `requireAuth` for the unauthenticated path** the way the knowledge route suites do — the real
helper redirects rather than returning 401 (`src/lib/server/auth/hooks.ts`).

Read-model test: the conversation detail payload carries `artifacts` newest first, matching the conversation,
**not** carrying an incognito conversation's artifacts when the caller asks from outside it, and naming the
field's type through its own name — `ArtifactCardSummary`, never the knowledge-side `ArtifactSummary` aliased
into place, which is the point of ruling 20.

E2E `tests/e2e/artifacts-panel.spec.ts`:

1. a chat that has made nothing renders **no** `artifact-count-button`;
2. with a produced file present the button shows the count; clicking it opens the panel on the list state with
   the File row visible;
3. opening the row shows the produced file's preview through the existing preview path, and closing returns to
   the chat with the message surface intact;
4. at 390×844 the button is reachable without scrolling and the panel opens without horizontal overflow.

**The fixture — name it, because it does not exist.** There is no E2E fixture for a produced file:
`tests/e2e/project-files.spec.ts:55` seeds an **uploaded** library document through `/api/knowledge/upload/raw`,
and no spec anywhere drives `files/produce` or `chat_generated_files`; `tests/e2e/helpers.ts:130`'s
`buildAiSdkUiStreamBody` emits text deltas only, so a tool-call turn cannot be scripted with it. Do **not**
invent a test-only HTTP route for this. Seed the row the way the repo's other E2E specs already do — direct
`db` writes from the spec (`tests/e2e/conversation-title-refresh.spec.ts:3-4`, `home-projects.spec.ts:4-10`,
`zz-capture-connections.spec.ts:15-23`):

```ts
import { db } from "../../src/lib/server/db";
import { artifacts, chatGeneratedFiles } from "../../src/lib/server/db/schema";

// One produced file: an `artifacts` row with type 'generated_output' and its
// chat_generated_files row, in the conversation the spec just created.
```

Use `createConversation` from `tests/e2e/helpers.ts` for the conversation, then read the chat page and assert
the button. Say in the spec's header comment that the pipeline is not exercised here and which spec would need
to exist to exercise it (a tool-call stream fixture), so the next reader does not mistake the seed for coverage.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run src/routes/api/artifacts
npx playwright test tests/e2e/artifacts-panel.spec.ts
```

- [ ] **Step 3: Implement** the routes, the client API, the detail payload and the page wiring (count button,
  list state, `openArtifact(artifactId)` reusing `openWorkspaceDocument` at `+page.svelte:881`).

- [ ] **Step 4: Run the slice's gates** (the Gates block) plus the targeted Playwright set:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx playwright test tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts \
  tests/e2e/mobile-design.spec.ts tests/e2e/conversation-title-refresh.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/artifacts src/lib/client/api/artifacts.ts src/lib/server/services/conversation-detail "src/routes/(app)/chat/[conversationId]/+page.svelte" tests/e2e/artifacts-panel.spec.ts
git commit -m "Open what a chat has made from its header

The count comes from the conversation detail payload the page already
refreshes, so it cannot drift from the panel; at zero the button is not drawn
at all, and the panel opens on its list rather than on a guess.

The end-to-end spec seeds a produced file directly, the way the other specs
seed their rows: the text-only stream fixture cannot script a tool call, and a
test-only create route would be a second write path to keep honest."
```

### Task S8: i18n, the naming guard, the eval-harness skeleton and AGENTS.md

**Files:** `src/lib/i18n/artifacts.ts` + `artifacts.test.ts`, `src/lib/i18n/index.ts`,
`src/lib/i18n.test-helpers.ts`, `scripts/eval-artifact-contracts/**`, `.gitignore`, `AGENTS.md`
**Test:** `src/lib/i18n.test.ts`, `src/lib/i18n/artifacts.test.ts`, `scripts/eval-artifact-contracts/scoring.test.ts`

- [ ] **Step 1: Write the failing tests**

1. `src/lib/i18n/artifacts.test.ts`: every key exists in both locales (via the shared helper), **and** no value
   in either locale matches `/artifact/i`.
2. `scripts/eval-artifact-contracts/scoring.test.ts`: the scoring module grades a fixture attempt as
   `"good"`/`"acceptable"`/`"bad"` with reasons, and grades an empty answer as `"bad"` rather than throwing.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the dictionary, its registration, the
  harness skeleton, the root `.gitignore` entry, and the AGENTS.md additions (the `artifacts/` boundary in the
  App Map and the placement guide, plus the ADR-0066 rule that "Artifact" is never UI copy).

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
git add src/lib/i18n scripts/eval-artifact-contracts .gitignore AGENTS.md
git commit -m "Name the artifacts in the user's own words

ADR-0066 keeps the word 'Artifact' out of the UI, so the dictionary is per kind
in both languages and a test enforces it. The evaluation harness lands as a
skeleton here so each type's slice appends its own suite.

AGENTS.md gains the new service boundary and the naming rule, because a
boundary nobody wrote down is a boundary the next slice invents again."
```

---

## Non-goals

- **No model-facing tools.** `create_artifact`, `edit_artifact` and `read_artifact` are Slice 1's (Document) and
  Slice 2's (App); this slice registers none and changes no prompt.
- **No Document, App, Canvas or Slides body.** The registry ships empty on purpose.
- **No comments UI and no versions UI.** The services and the tables exist and are tested; the first customer is
  Document. (The card's `tickable` seam is the one exception — an explicit contract for slice 1, not a UI.)
- **No kv surface.** The accessors exist for slice 2's bridge; no route and no UI. The archive entry does
  exist (ruling 24) — that is data the user typed into an App, not a surface.
- **No re-typing of `generated_output`** to `'artifact'`, and no backfill migration.
- **No rename** of `DocumentWorkspace.svelte`, `DocumentWorkspaceItem`, or `documents.*` keys (ruling 10).
- **No Knowledge-page listing change** and no new search scope (spec §9.2 is still open).
- **No first-open tour** — all four tours (Document, App, Canvas, Slides; File gets none, ruling 8) belong to
  slice 6, landed last, because they depend on the four types existing and on the campaign machinery being
  adapted once (ruling 30).
- **No evidence integration** (Slice 5), no cost-display change (Slice 2/4), no `artifact_type` column.
- **No sharing, ever.**

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The guard is made green with an exemption | Silences the real query tomorrow; the second guard test then fails late | Forbidden in Global Constraints; Task S4 step 4 diffs the exemption object |
| The panel rebuild regresses one of three callers | Chat, Knowledge and the project dialog all render it; a silent prop drift is invisible until a user opens a file | Task S5 keeps path/props/test ids, runs all three callers' suites, and keeps the two new props optional |
| File behaviour is lost in the card split | Produced files are live: progress, Stop, Retry, Dismiss, stale, placeholder ids | Task S6 moves the assertions rather than deleting them, and asserts exactly one title |
| A produced file is re-typed and Clear Memory starts deleting it | `account-lifecycle/index.ts:94` and `core.ts:218` both key on `generated_output` | The row-type rule is in Contracts with both citations, and `kindForArtifactRow` is the only mapping |
| The count button counts the wrong thing | An incognito conversation's artifacts, or a stale count after a turn | The count comes from the detail payload only; the read model is scoped; E2E covers zero and after-turn |
| The migration number printed here is taken | Two migrations with the same number break the journal | Task S1 step 1 verifies in-tree and reports a difference |
| `metadata_json.artifactType` drifts from the `type` column | Two sources of truth for the kind | `record.ts` is the only writer and reads it back through one parser; no column is added |
| Two versions in the same second get the same number | `created_at` is second-resolution; a silent duplicate ordering makes `versionNumber` a lie | `version_number` is a column with a unique index, and Task S1 asserts the constraint |
| The card gains the word "Artifact" in a tooltip or aria-label | ADR-0066 is a product rule, not a style note | `src/lib/i18n/artifacts.test.ts` and the review's naming pass |
| The panel's type registry becomes an eager import | One static import of a heavy editor puts it in every chat page's chunk | Registry entries are loader functions; Task S5 step 1's "loader called once" test and Task S6 step 1's lazy assertion |
| The E2E seed is mistaken for pipeline coverage | A green spec that never exercises `produce_file` | The spec's header comment says what it does not cover and why (Task S7 step 1) |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — 0 diagnostics (`npm run lint` is broken by nested worktrees; say so).
- [ ] `npm test` — 0 failures; record the pass counts before and after the slice in the report.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` green, `npm run db:prepare` clean, and the three tables in
      `scripts/prepare-db.ts` plus `scripts/prepare-db.test.ts` green.
- [ ] `git diff tests/cross-cutting/incognito-artifact-containment.test.ts` shows **no new entry in
      `ALLOWED_WITHOUT_SCOPE`**; `git diff src/lib/server/services/account-lifecycle/user-scoped-tables.ts` shows
      exactly two new entries; `account-lifecycle.test.ts`'s three pinned lists are updated.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores (watch
      `countArtifactsForConversation`: it is live **because** `read-model.ts` calls it — if the read model ends
      up inlining the count, delete the export rather than leaving a dead one).
- [ ] `npx playwright test tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts
      tests/e2e/mobile-design.spec.ts tests/e2e/conversation-title-refresh.spec.ts` — green.
- [ ] Real-app visual check at **1440×900 and 390×844, light and dark** against surfaces 1, 2 and 3 and the File
      card: the quiet count button with its number, the panel list with type labels and relative times, one File
      open, and the button absent in an empty chat.
- [ ] Keyboard pass at both widths: tab order as the UI-states table describes; Escape closes the list before
      the panel; the disabled history button is still reachable and announces itself.
- [ ] i18n parity green; `"artifacts."` in `AUDITED_PREFIXES`; the no-"Artifact"-in-the-UI test green.
- [ ] `scripts/eval-artifact-contracts/run.ts` exits 0 with an explanation when nothing is configured; the
      scoring module is in CI, the live run is not; `scripts/eval-artifact-contracts/results/*` is ignored by the
      root `.gitignore`.
- [ ] No new runtime dependency in `package.json`.
- [ ] Chunk evidence recorded in the report: the chat route and the panel shell chunks before and after this
      slice, read from the build output (state the method — the build manifest or a `--json` build log).
