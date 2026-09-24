# Slice E — Folder Knowledge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice C** (`InstructionsDialog`/`ScopeToken`/the shared
> limit) **and Slice D** (`HomeSurface` in project mode, the project page, `projects.ts`). Slice G needs this
> slice's file counts.

**Goal:** Let a project link ordinary Library Documents, so every chat in the project knows those files exist —
names and one-line summaries on every turn, shallow included — and reads their content only when the turn
needs it.

**Architecture:** A new `project_knowledge_links` table keyed to the project and the artifact, deliberately not
`artifact_links` (which is conversation- and message-scoped). One new knowledge module behind the existing
`knowledge.ts` facade owns the links and the project-scoped artifact query. The packet gains a **protected**
`## Project Files` section pushed in **both** the deep and the shallow tier. Content enters through three
existing paths and nothing new: retrieval scoring, `read_generated_file`'s name resolver, and the
linked-context-source resolution helpers for a filename the user typed.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle on better-sqlite3, Vitest, Playwright, Tailwind tokens.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice E" (lines 249–296) and the Folder Knowledge
decision (lines 41–46); mockups §M5 and §M8 (`…-workspaces-mockups.html`, sections 5 and 8).

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **The files are ordinary Library Documents.** Linking never copies; unlinking never deletes.
- **Ownership is checked on every write:** the project and the artifact must both belong to the user.
- **The list is on every path**, shallow turns included; the content is not.
- **Incognito chats in a project still see the project's files.** What an incognito chat *creates* stays hidden
  from other chats, as today.
- **No second resolver.** The `/document`-linked-context-source helpers are reused, not reimplemented.
- **File names are never listed in the Info popover.** Only a count, and a way to reach Sources.
- Svelte 5 runes only; Lucide icons only; tokens only; EN + HU in the same commit.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/project-page.spec.ts tests/e2e/project-files.spec.ts \
  tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts \
  tests/cross-cutting
```

## Review Focus

1. **Linking and unlinking another user's project or artifact.** Both ids are attacker-controlled. The project
   must be looked up as `and(eq(projects.id, projectId), eq(projects.userId, userId))`, and the artifact through
   the knowledge boundary's ownership scope — never a bare `artifacts.id` read (Task E1).
2. **A project with more linked files than the section cap.** `+N more` must appear, the section must stay
   inside its character budget, and a name must never be emitted half-truncated (Task E4).
3. **Deleting a project or a library file.** The link rows must go, the library file must survive a project
   deletion, and the library file's deletion must not leave a dangling link (Task E1, Task E7).
4. **Unlinking a file while a turn is in flight.** The section is assembled from a fresh read per turn, so the
   next turn must not list it — and the in-flight turn must not fail (Task E4).
5. **A project file named in the message, in a shallow turn.** The name must resolve through the shared
   linked-source helpers and its content must reach the prompt, without the section alone being enough
   (Task E5).

---

## Contracts

### SQL DDL

`drizzle/1777140000109_project_knowledge_links.sql` (verify with `npx drizzle-kit generate`):

```sql
CREATE TABLE `project_knowledge_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_knowledge_links_project_artifact_unique` ON `project_knowledge_links` (`project_id`,`artifact_id`);
--> statement-breakpoint
CREATE INDEX `project_knowledge_links_user_project_idx` ON `project_knowledge_links` (`user_id`,`project_id`);
```

Register the table in `src/lib/server/services/account-lifecycle/user-scoped-tables.ts`
(`name: "project_knowledge_links"`, `erasure: "cascade"`, `resets: ["workspace"]`) and add its name to
`scripts/prepare-db.ts`'s required-table list. `npm run check:migrations` and
`npx vitest run src/lib/server/services/account-lifecycle` both must pass — the second has a schema-derived
completeness guard that fails on an unregistered user-scoped table.

**Why not `artifact_links`:** that table's `conversationId`/`messageId` are the whole point of its shape and
every read filters on them; a project link has neither. A `projectId` column on `artifacts` was also rejected —
one artifact may be linked to several projects, and `artifacts` must stay project-agnostic.

### `src/lib/server/services/knowledge/project-knowledge.ts` (create)

Surfaced through `knowledge.ts` with one `export { … } from "./knowledge/project-knowledge";` line placed
between the `capsules` block (`knowledge.ts:31`) and the `context` block (`:32`).

```ts
export interface ProjectKnowledgeItem {
	artifactId: string;
	name: string;
	mimeType: string | null;
	type: ArtifactType;
	sizeBytes: number;
	/** Unix seconds, when the link was added — this is the "Added" column. */
	linkedAt: number;
	summary: string | null;
}

export async function listProjectKnowledge(params: {
	userId: string;
	projectId: string;
}): Promise<ProjectKnowledgeItem[]>;

/** Returns the ids only: the retrieval boost needs them without the metadata. */
export async function listProjectKnowledgeArtifactIds(params: {
	userId: string;
	projectId: string;
}): Promise<string[]>;

/**
 * Links the given artifacts. Throws ProjectKnowledgeError("project_not_found" | "artifact_not_owned")
 * before writing anything.
 */
export async function linkProjectKnowledge(params: {
	userId: string;
	projectId: string;
	artifactIds: string[];
}): Promise<ProjectKnowledgeItem[]>;

/** Unlinks only. Never touches the artifact or its bytes. */
export async function unlinkProjectKnowledge(params: {
	userId: string;
	projectId: string;
	artifactId: string;
}): Promise<boolean>;

export class ProjectKnowledgeError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: "project_not_found" | "artifact_not_owned",
	) {}
}

export function isProjectKnowledgeError(error: unknown): error is ProjectKnowledgeError;
```

Ownership rules, all of them:

- the project is resolved with `getProject(userId, projectId)` (`projects.ts:59`) and a miss throws
  `project_not_found` (404);
- every artifact id is validated against the user's own knowledge scope — resolve the candidate set with
  `listKnowledgeArtifacts(userId)` (`knowledge.ts:283`) or `getArtifactOwnershipScope` +
  `buildArtifactVisibilityCondition`, and reject any id not in it with `artifact_not_owned` (404). **Do not read
  `artifacts` by id alone.**
- `linkProjectKnowledge` inserts with `onConflictDoNothing` so re-linking is idempotent, inside one
  `db.transaction`.

### API

Routes stay thin adapters over the facade:

| Route | Method | Body / params | Returns |
|---|---|---|---|
| `src/routes/api/projects/[id]/knowledge/+server.ts` | `GET` | — | `{ files: ProjectKnowledgeItem[] }` |
| ″ | `POST` | `{ artifactIds: string[] }` (non-empty; reject otherwise with 400) | `{ files }` |
| `src/routes/api/projects/[id]/knowledge/[artifactId]/+server.ts` | `DELETE` | — | `{ success: true }` |

Map `ProjectKnowledgeError` to its `status` and `code`. Follow the route-local guard style of
`src/routes/api/projects/sidebar-order/+server.ts:20-49` (`parseOptionalIds`-style validation, `try/catch`
around the service call, `json({ error })` on failure).

### Upload

`src/lib/server/services/knowledge/upload-intake.ts`:

- a sibling of `validateKnowledgeUploadConversation` (`:106-135`), same shape:

```ts
export async function validateKnowledgeUploadProject(params: {
	userId: string;
	projectId: string | null | undefined;
}): Promise<string | null>;
```

  It normalises like the conversation one, resolves through `getProject`, and throws a
  `KnowledgeUploadProjectError` mirroring `KnowledgeUploadConversationError` (`:33-53`, `status = 400`,
  `code = "invalid_project"`), with an `isKnowledgeUploadProjectError` predicate.
- `projectId: string | null` is threaded beside `conversationId` through `completeKnowledgeUploadFromFile`
  (`:352-366`) and `completeKnowledgeUploadFromStoredFile` (`:397-408`) into `saveUploadedArtifact` (`:373-377`)
  / `saveUploadedArtifactFromStoredFile` (`:420-428`) and `finishKnowledgeUpload` (`:379` / `:430`). After the
  artifact is stored, a non-null `projectId` links it with `linkProjectKnowledge`.
  **Link after the store succeeds** — a failed upload must not leave a link.

`src/routes/api/knowledge/upload/shared.ts` — add `"x-alfyai-project-id"` to the header set (`:23-26`) and read
it in `readKnowledgeUploadRequestMetadata` (`:126-142`). The **live** upload path is
`src/routes/api/knowledge/upload/raw/+server.ts:165-177` (the legacy multipart route at
`src/routes/api/knowledge/upload/+server.ts` is deprecated); wire the project id there beside
`metadata.conversationId` at `:177`. Do the same in the chunked upload route for consistency.

### The packet section

`src/lib/server/services/chat-turn/context-selection.ts`.

A packet section is a plain object, rendered by `buildContextSection`
(`utils/prompt-context.ts:82-85`) as `## <title>` + newline + the trimmed body, and dropped entirely when the
body is blank. The compactor's keep rule is `compactContextSections` (`prompt-context.ts:563-568`): a section
with `protected: true` is **always included whole, never trimmed, never omitted**, and
`resolveBudgetPriority` (`context-selection.ts:845-858`) emits protected sections first. This is the mechanism
the spec means by "a protected packet section".

Add a builder beside the existing project-folder builders:

```ts
// near buildProjectFolderPromptSection (:674), buildProjectAwarenessPromptSection (:745)
const PROJECT_FILES_MAX_ENTRIES = 30;
const PROJECT_FILES_MAX_CHARS = 1500;
const PROJECT_FILES_MORE_LABEL = "+{n} more";   // localized through projects.filesMore

function buildProjectFilesPromptSection(files: ProjectKnowledgeItem[]): PromptContextSection | null;
```

- Body: one line per file, `- <name> — <summary>` (the em dash only when a summary exists), then a final
  `+N more` line when entries were dropped. Blank body (`null`) when there are no files, so the section
  disappears rather than rendering an empty heading.
- **Both caps, and the character cap wins:** stop adding entries when either the entry count would exceed 30 or
  the accumulated body would exceed 1,500 characters. **Never emit a partially truncated name or summary** — a
  file that does not fit whole is dropped and counted into `+N more`.
- `layer: "documents"`, `protected: true`.

**Push it in both tiers:**

- deep tier: in the `sections` block that starts at `:1786`, next to the `:1796-1804` project-folder pushes;
- shallow tier: in the `sections` block at `:1293` (which today holds only the compression snapshot, session
  summary, session context, the memory profile and the file-production job section).

Fetch its data in the same place the tier already fetches project data — the deep tier's `Promise.all` at
`:1450-1500` (where `getConversationProjectLabel` at `:1489-1491` and `getProjectReferenceContext` at
`:1492-1495` live). The shallow tier fetches `getConversationProjectId` already (`:1210`), so add
`listProjectKnowledge` there. One read per turn, no caching across turns: unlinking a file must take effect on
the next turn.

Observability: extend the existing `[CONTEXT] Working document selection` emission
(`knowledge/context.ts:155`, inside `logWorkingDocumentSelection` `:124-171`) with
`projectFilesListed` and `projectFilesMore` — do not add a second log line.

### Content on demand — three paths, all reusing what exists

**(a) Retrieval scoring.** `knowledge/store/documents.ts`:

```ts
export async function findRelevantArtifactsByTypesDetailed(params: {
	userId: string;
	query: string;
	types: ArtifactType[];
	limit: number;
	excludeConversationId?: string;
	queryEmbedding?: number[];
	/** Artifacts linked to the current project: preferred, never required. */
	scopeBoostArtifactIds?: string[];
}): Promise<RankedArtifactMatch[]>;
```

and the same optional field on the private `rankArtifactMatches` (`:1002-1008`). The boost goes on the fusion
line (`:1093-1097`):

```ts
	const scopeBoost = params.scopeBoostArtifactIds?.includes(artifact.id)
		? PROJECT_SCOPE_SCORE_BOOST
		: 0;
	const baseScore =
		lexicalScore * 10 + semanticScore * 18 + rerankScore * 24 + artifact.updatedAt / 1_000_000_000_000 + scopeBoost;
```

with `const PROJECT_SCOPE_SCORE_BOOST = 5;` — small enough that it breaks ties in favour of project files and
cannot rescue an irrelevant one (one unit of `lexicalScore` is worth 10). **A boost, not a filter**: a project
file that does not match the query still must not appear, because the `lexicalScore > 0 || semanticScore > 0 ||
rerankScore > 0` gate at `:1117-1122` is untouched.

Callers to update: `knowledge/context.ts:747` and `:755` (`findRelevantKnowledgeArtifacts`), which already
receives the conversation; resolve the project's ids once at its entry and pass them down. Keep the boost out of
`semantic-ranking.ts` (generic math) and `tei-reranker.ts` (transport).

> **Schema note.** `artifacts` has **no `projectId` column** (`schema.ts:328-355`), and a project's linked
> library documents have `artifacts.conversationId = NULL`, so a scope filter cannot be expressed as a
> `conversations.projectId` join. The linked-id set from `project_knowledge_links` **is** the scope. That is
> why the contract is an id list, not a join.

**(b) `read_generated_file` by name.** `src/lib/server/services/normal-chat-tools/read-generated-file.ts` — the
resolver `resolveReadTarget` (`:1287-1292`) and its helper `findNormalizedDocument` (`:1219-1283`) are private.
Add a project tier to the existing precedence, between the "same user's files elsewhere" tier (`:1382-1392`) and
the library-document pass (`:1394-1401`): when the conversation has a project, match the needle against
`listProjectKnowledge`'s names (exact, then case-insensitive, then stem), and prefer it. The `needle` is
`filename?.trim() || requestTitle?.trim()` (`:1340`), so both inputs reach the same rule. The tool description
(`normal-chat-tools/index.ts:290-300` EN, `:382-392` HU) must mention that a project's files can be named
directly — guidance lives in the tool interface (ADR-0055).

**(c) A filename the user typed.** Reuse the linked-context-source helpers, exactly as the spec requires:

```ts
// knowledge/project-knowledge.ts
/**
 * Project files whose name appears in the message, as linked-context-source candidates.
 * The caller validates them through resolveLinkedContextSourcesForConversation.
 */
export async function resolveProjectFileMentions(params: {
	userId: string;
	projectId: string;
	message: string;
}): Promise<LinkedContextSource[]>;
```

Match with the existing scoring helpers, not with a new one: `includesNormalized(query, artifact.name)`
(`document-resolution.ts:125-128`, which already pushes `"matched_artifact_name"`) or
`scoreMatch(message, artifact.name) > 0` (`knowledge/context.ts:306-308`). Build the candidates with the
existing canonicaliser (`toCanonicalLinkedContextSource`, `linked-context-sources.ts:115-128`), then let
`resolveLinkedContextSourcesForConversation` (`linked-context-sources.ts:55-60`) do the ownership check, the
prompt-readiness check and the attachment dedupe. **Do not write a second resolver**, and do not bypass the
existing 404/409 behaviour for a not-ready document.

Wire it where the turn's linked sources are resolved on the deep path (`context-selection.ts:1474` is where
`listConversationSourceArtifactNames` is called; the linked-source resolution happens in
`chat-turn/preflight.ts:409` and `chat-turn/request.ts:418-429`). Add the resolved project-file mentions to the
same set the preflight validates, so they travel as ordinary linked sources for that turn only.

Reading the content itself uses the existing snippet path — `getPromptArtifactSnippets`
(`task-state/artifacts.ts:115-123`), the same ranked, reranked, character-budgeted call the deep tier already
makes for attachments and evidence. Do not add a second content loader.

### Message metadata and Sources

`src/lib/server/services/messages.ts` — `PersistedMessageMetadata` gains `projectFilesRead?: number` (the count
of project-linked documents whose content actually entered the turn). Re-export onto `ChatMessage` as with the
other fields, and project it in `mapRowToChatMessage`'s metadata projection (`:233-275`).

The count and the token both come from the turn's evidence: `prepareTaskContext` (`task-state.ts:1152-1170`)
returns `selectedArtifacts`, which becomes `selectedEvidence` (`context-selection.ts:1705-1707`) and
`contextDebug.selectedEvidence` (`task-state.ts:1420-1441`), which is what
`buildArtifactGroups` (`message-evidence.ts:318-326`) reads. So:

- `projectFilesRead` = the size of the intersection of the turn's selected evidence artifact ids with the
  project's linked ids. Compute it where the evidence summary is built and pass it into the assistant metadata
  bag (`chat-turn/stream-completion.ts:552-596`, `routes/api/chat/send/+server.ts:565-578`).
- **The Sources token:** `MessageEvidenceItem.metadata` is already a free-form
  `Record<string, string | number | boolean | null>` (`message-evidence.ts:775`) and is already used this way
  for memory (`metadata: { memoryItemId: itemId }`, `:181`). Stamp
  `metadata: { projectId, projectName }` on evidence items whose `artifactId` is in the project's linked set,
  inside `buildArtifactGroups`, which needs the project context passed to it — extend its params (and
  `buildAssistantEvidenceSummary`, `:675-688`) with `projectFiles?: { projectId: string; projectName: string;
  artifactIds: Set<string> } | null`. **Do not extend `EvidenceSourceType`** (`:738`) — these are documents.
  Still set `description`/`reason` so `itemDetail` (`:296-299`) keeps working.

`src/lib/components/chat/MessageEvidenceDetails.svelte` — render the token in the row's icon/title area inside
`renderItem` (`:412`), which is where the type icon and title already sit: for a document row that is
`:419-429` (`TypeIcon` `:426`, `<span class="evidence-title">{item.title}</span>` `:427`), for the plain row
`:533-537`. Add `ScopeToken` after the title when `item.metadata?.projectName` is present. It has no chip
element today, so the token is a new element in that row.

**Opening Sources from the Info popover.** Two components need a new external trigger:

- `MessageEvidenceDetails.svelte` has `let expanded = $state(false)` (`:57`) and a single internal `toggle()`
  (`:157-161`) with no external API. Add `expandRequest?: number` and an `$effect` that sets `expanded = true`
  once per increment. Leave `toggle()` and `preserveScrollOnToggle` alone.
- `MessageBubble.svelte` — the Info popover opens on CSS hover on desktop (`.info-container:hover .info-popover`,
  `:1816-1822`) with a touch override (`infoPopoverTouched` `:184`, `.info-popover-open` `:1826-1831`). There is
  no imperative close. Add `infoForcedClosed = $state(false)` and a class that hides the popover while it is
  true; the row click sets it true and increments `sourcesExpandRequest`, and any subsequent pointer leave or
  toggle resets it. Pass `onOpenSources` into `ResponseAuditDetails` (`:1086-1093` renders the evidence panel).
- `ResponseAuditDetails.svelte` — `buildPrimaryRows` (`:83-161`) pushes `AuditRow` objects
  (`{ label, value, kind?, iconUrl? }`, `:19-24`). Add `kind: "sources"` with an `onSelect?: () => void`, render
  it as a button row in the loop at `:169-187`, and add the new "Project files" row: label
  `projects.infoProjectFiles`, value `projects.infoProjectFilesValue` with `{count}` and the down-arrow hint.
  The row is present **only** when `projectFilesRead > 0`, and **never lists file names**.

### The Files modal and the quiet line (§M5, §M1)

Route-local, under `src/routes/(app)/projects/[projectId]/_components/`:

- `ProjectFilesDialog.svelte` — `DialogShell` with `maxWidthClass="max-w-[700px]"` and the project token in the
  title. Description: `projects.filesDescription`. A toolbar row: search field, "Add from library"
  (`btn-secondary`, `Library` icon), Upload (`btn-primary`, `Upload` icon). Then the library's table look, not
  the library's component: columns Name, Type pill, Size, Added. Row actions: preview (`Eye`, opens the shared
  Document Workspace) and unlink (`Unlink`), both with `aria-label`s. Footer: `projects.filesFooter`
  (`{count}`) on the left, Done on the right.
- `AddFromLibraryDialog.svelte` — the same frame with a search field and a checkbox list of library documents.
  Documents already linked are **disabled and marked** `projects.filesAlreadyAdded`; the confirm button reads
  `projects.filesAddCount` with the selected count, and is disabled at zero.
- Preview opening: the modal owns the two `$state` values the knowledge coordinator uses
  (`reduceWorkspaceDocumentOpen` from `$lib/client/document-workspace-state`, then
  `workspaceDocuments`/`activeWorkspaceDocumentId`/`workspaceOpen`), and records the open with
  `recordDocumentWorkspaceOpen(artifactId)` (`src/lib/client/api/knowledge.ts:749`) from the route-owned
  handler. Reuse `DocumentWorkspace.svelte`; do not add a second viewer.

Wire the quiet line's files half in `HomeSurface.svelte` (project mode): a paperclip icon + `projects.filesLabel`
(`{count}`) when files exist, else `projects.filesAdd`; a middot separator between the instructions half and the
files half only when both are present; the click calls `onOpenFiles`. The project page owns both modals and
passes the callbacks down.

The **Knowledge → Documents table** shows a small folder token on linked documents:
`src/routes/(app)/knowledge/_components/DocumentsList.svelte`, inside the name cell after
`<span class="document-title">{document.name}</span>` (`:1433-1435`), or in the mobile meta row
(`:1436-1452`) when the name cell is hidden. It needs one new optional prop in `DocumentsListProps` (beside
`onSelect` at `:88`) carrying the linked project names by artifact id; the knowledge page resolves them through
a browser call in `src/lib/client/api/knowledge.ts`. Keep it to one small token — no per-row menu.

### i18n

All of these go in the `projects.*` namespace (created by Slice D in `src/lib/i18n/projects.ts`; extend the
en/hu objects in place).

| Key | EN | HU |
|---|---|---|
| `projects.filesTitle` | `Files` | `Fájlok` |
| `projects.filesDescription` | `Every chat in this project knows these exist and reads them when they're needed.` | `A projekt minden csevegése tud róluk, és akkor olvassa el őket, amikor szükség van rájuk.` |
| `projects.filesSearch` | `Search files in this project` | `Keresés a projekt fájljai között` |
| `projects.filesAddFromLibrary` | `Add from library` | `Hozzáadás a könyvtárból` |
| `projects.filesUpload` | `Upload` | `Feltöltés` |
| `projects.filesColumnName` | `Name` | `Név` |
| `projects.filesColumnType` | `Type` | `Típus` |
| `projects.filesColumnSize` | `Size` | `Méret` |
| `projects.filesColumnAdded` | `Added` | `Hozzáadva` |
| `projects.filesPreviewA11y` | `Preview {name}` | `{name} előnézete` |
| `projects.filesUnlinkA11y` | `Remove {name} from this project` | `{name} eltávolítása a projektből` |
| `projects.filesFooter` | `{count} files · removing one here keeps it in your library` | `{count} fájl · az eltávolítás nem törli a könyvtárból` |
| `projects.filesFooterOne` | `1 file · removing it here keeps it in your library` | `1 fájl · az eltávolítás nem törli a könyvtárból` |
| `projects.filesEmpty` | `No files yet.` | `Még nincs fájl.` |
| `projects.filesAlreadyAdded` | `already added` | `már hozzáadva` |
| `projects.filesAddCount` | `Add {count} documents` | `{count} dokumentum hozzáadása` |
| `projects.filesAddCountOne` | `Add 1 document` | `1 dokumentum hozzáadása` |
| `projects.filesUnlinkFailed` | `Could not remove the file from this project.` | `Nem sikerült eltávolítani a fájlt a projektből.` |
| `projects.filesLinkFailed` | `Could not add the files to this project.` | `Nem sikerült hozzáadni a fájlokat a projekthez.` |
| `projects.filesUploadFailed` | `Could not upload the file.` | `Nem sikerült feltölteni a fájlt.` |
| `projects.filesMore` | `+{count} more` | `+{count} további` |
| `projects.infoProjectFiles` | `Project files` | `Projektfájlok` |
| `projects.infoProjectFilesValue` | `{count} read · see Sources ↓` | `{count} elolvasva · lásd a forrásokat ↓` |
| `projects.infoProjectFilesValueOne` | `1 read · see Sources ↓` | `1 elolvasva · lásd a forrásokat ↓` |
| `projects.linkedInLibrary` | `In {count} projects` | `{count} projektben` |
| `projects.linkedInLibraryOne` | `In 1 project` | `1 projektben` |

---

## File ownership

Exclusive to Slice E.

| File | Change |
|---|---|
| `src/lib/server/services/knowledge/project-knowledge.ts` + test | create |
| `src/lib/server/services/knowledge.ts` | one facade export line |
| `src/lib/server/services/knowledge/upload-intake.ts` | `projectId` validation + linking |
| `src/lib/server/services/knowledge/store/documents.ts` | `scopeBoostArtifactIds` + the boost |
| `src/lib/server/services/knowledge/context.ts` | pass the boost, extend the log line |
| `src/lib/server/services/chat-turn/context-selection.ts` | the section, both tiers, the mention resolution |
| `src/lib/server/services/normal-chat-tools/read-generated-file.ts` + `index.ts` | the project tier + guidance |
| `src/lib/server/services/message-evidence.ts` | the project token on items |
| `src/lib/server/services/messages.ts` | `projectFilesRead` |
| `src/lib/components/chat/MessageEvidenceDetails.svelte` | `expandRequest`, the token in the row |
| `src/lib/components/chat/MessageBubble.svelte` | forced-close state + the expand trigger |
| `src/lib/components/chat/ResponseAuditDetails.svelte` | the Project files row + `kind: "sources"` |
| `src/lib/components/home/HomeSurface.svelte` | the files half of the quiet line |
| `src/routes/(app)/projects/[projectId]/_components/*` | the two dialogs |
| `src/routes/(app)/knowledge/_components/DocumentsList.svelte` | the linked token |
| `src/lib/client/api/{projects,knowledge}.ts` | the browser calls |
| `src/routes/api/projects/[id]/knowledge/**`, `src/routes/api/knowledge/upload/**` | the routes |
| `src/lib/server/db/schema.ts`, `drizzle/**`, `scripts/prepare-db.ts`, `user-scoped-tables.ts` | the table |
| `src/lib/i18n/projects.ts` | the keys above |
| `tests/e2e/project-files.spec.ts` | create |
| `AGENTS.md` | the new knowledge module |

**Serialisation:** `src/lib/i18n/projects.ts` is extended by D then E then G — serial by wave order.
`src/lib/components/home/HomeSurface.svelte` is edited by D, E and G — serial.

---

## Tasks

### Task E1: The table, the module, and the routes

**Files:** schema + migration, `project-knowledge.ts` + test, `knowledge.ts`, the two routes,
`user-scoped-tables.ts`, `prepare-db.ts`
**Test:** `project-knowledge.test.ts`, route tests

**Interfaces:**
- Produces: everything in the `project-knowledge.ts` contract above.
- Consumes: `getProject` (Slice D).

- [ ] **Step 1: Write the failing tests**

```ts
it("links a library document to a project and lists it with its summary and added date", ...);
it("is idempotent when the same document is linked twice", ...);
it("rejects linking another user's artifact without writing a row", ...);
it("rejects a project that belongs to another user", ...);
it("404s and writes nothing when the artifact does not exist", ...);
it("unlinks without deleting the artifact or its bytes", ...);
it("deletes the links when the project is deleted", ...);
it("deletes the link when the artifact is deleted", ...);
it("returns the artifact ids for the retrieval boost", ...);
```

Route tests: `POST` with `{ artifactIds: [] }` → 400; `DELETE` on an unlinked artifact → `{ success: true }`
(idempotent, no error); another user's project id → 404 with no state change.

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/knowledge/project-knowledge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Table + migration + journal entry, registry entry, `prepare-db.ts` listing, the module, the facade export, the
two routes. Run `npm run check:migrations && npm run db:prepare` and
`npx vitest run src/lib/server/services/account-lifecycle`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command and the account-lifecycle suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/db/schema.ts drizzle scripts/prepare-db.ts \
  src/lib/server/services/knowledge src/lib/server/services/account-lifecycle/user-scoped-tables.ts \
  src/routes/api/projects/\[id\]/knowledge
git commit -m "Link library documents to a project, without copying them

artifact_links is conversation- and message-scoped: every read filters on those
columns, and a project link has neither. A separate table keyed to the project
keeps the link honest, and both foreign keys cascade so deleting either side
leaves nothing dangling."
```

### Task E2: Upload into a project

**Files:** `upload-intake.ts`, `src/routes/api/knowledge/upload/{shared,raw,chunk}.ts`
**Test:** `upload-intake.test.ts` (extend), `raw.test.ts` (extend)

**Interfaces:**
- Consumes: `linkProjectKnowledge` (Task E1).
- Produces: `x-alfyai-project-id` accepted on the raw upload path.

- [ ] **Step 1: Write the failing tests**

```ts
it("stores a library upload and links it to the given project", ...);
it("rejects an upload naming another user's project with 400 and stores nothing", ...);
it("links nothing when the project id is absent", ...);
it("does not link when the store step fails", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/knowledge/upload-intake.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Sibling validator, the `projectId` parameter through both completion functions and their `finishKnowledgeUpload`
calls, the header on the raw (and chunked) route, and the link **after** a successful store.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/knowledge/upload-intake.ts src/routes/api/knowledge/upload
git commit -m "Let a project upload link the file to itself

The upload is a normal library document that happens to be linked; that is why
unlinking it later leaves the file in the library, exactly like a document added
from the library."
```

### Task E3: The Files modal and the quiet line

**Files:** the two route-local dialogs, `HomeSurface.svelte`, `DocumentsList.svelte`,
`src/lib/client/api/{projects,knowledge}.ts`, `src/lib/i18n/projects.ts`,
`tests/e2e/project-files.spec.ts`
**Test:** the new E2E plus `knowledge.spec.ts`

**Interfaces:**
- Consumes: the routes (E1, E2), `ScopeToken` (Slice C), `DocumentWorkspace`.
- Produces: `onOpenFiles` wired in project mode.

- [ ] **Step 1: Write the failing E2E test**

```
it("opens the Files modal from the quiet line and lists the linked files", ...);
it("unlinks a file and keeps it in the library", ...);
it("uploads a file into the project, showing it in both the modal and the library", ...);
it("adds from the library, with already-added documents greyed out", ...);
it("shows the asset count on the quiet line after linking", ...);
it("shows the empty line with Add instructions · Add files for a fresh project", ...);
it("previews a file from a row without leaving the project page", ...);
it("shows the linked token on the Knowledge documents table", ...);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx playwright test tests/e2e/project-files.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Build both dialogs per Contracts, extend the quiet line, add the linked token to the library table, and add the
EN/HU keys.

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command and `npx playwright test tests/e2e/knowledge.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/routes/(app)/projects/[projectId]/_components" "src/routes/(app)/knowledge/_components/DocumentsList.svelte" \
  src/lib/components/home/HomeSurface.svelte src/lib/client/api src/lib/i18n/projects.ts \
  tests/e2e/project-files.spec.ts
git commit -m "Manage a project's files without leaving the project

The row action is unlink, not delete, and the footer says so: these are library
documents the project knows about, and removing the link must never look like
losing the file."
```

### Task E4: The `## Project Files` section in both tiers

**Files:** `context-selection.ts`, `knowledge/context.ts` (the log line), tests
**Test:** `context-selection.test.ts` (extend)

**Interfaces:**
- Consumes: `listProjectKnowledge` (E1).
- Produces: `projectFilesListed` / `projectFilesMore` in the working-document log.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists a project's files on a shallow turn", ...);
it("lists a project's files on a deep turn", ...);
it("omits the section entirely when the project has no files", ...);
it("lists a project's files in an incognito conversation in that project", ...);
it("stops at 30 entries and appends +N more", ...);
it("stops at the character budget before the entry count and appends +N more", ...);
it("never emits a partially truncated name", ...);
it("keeps the section whole when the packet is trimmed", ...);     // protected: true
it("reflects an unlink on the next turn", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/chat-turn/context-selection.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The builder with both caps, `protected: true`, pushed in the deep-tier block at `:1786` **and** the
shallow-tier block at `:1293`, with the data fetched in each tier's own `Promise.all`. Extend the
`logWorkingDocumentSelection` emission; add no second log line.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/chat-turn/context-selection.ts src/lib/server/services/knowledge/context.ts \
  src/lib/server/services/chat-turn/context-selection.test.ts
git commit -m "Tell every turn in a project which files the project knows

Names and one-line summaries only, and only what fits: a protected section is
never trimmed, so the cap has to be the section's own job or a long list would
crowd out the answer. The section is in the shallow tier too, because 'short
question' is exactly when naming a file should still work."
```

### Task E5: Content on demand

**Files:** `knowledge/store/documents.ts`, `knowledge/context.ts`, `read-generated-file.ts`, `index.ts`,
`project-knowledge.ts`, `context-selection.ts`, `chat-turn/preflight.ts` (only if the mention set must be
joined there), tests
**Test:** `documents.test.ts`, `read-generated-file.test.ts`, `project-knowledge.test.ts`,
`context-selection.test.ts`

**Interfaces:**
- Consumes: `listProjectKnowledgeArtifactIds`, `resolveProjectFileMentions` (E1, this task),
  `getPromptArtifactSnippets`.
- Produces: the three read paths.

- [ ] **Step 1: Write the failing tests**

```ts
it("boosts a project-linked document in the ranking without letting it match an unrelated query", ...);
it("leaves ranking unchanged when the turn has no project", ...);
it("resolves a project file by exact name through read_generated_file", ...);
it("prefers a project file over a same-named library file elsewhere", ...);
it("resolves a project file named in the message into the turn's linked sources", ...);
it("fails the same way the linked-source path does for a document that is not prompt ready", ...);
it("does not resolve another user's project file by name", ...);
it("gets the file's content into the prompt on a shallow turn when it is named", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/server/services/knowledge/store/documents.test.ts \
  src/lib/server/services/normal-chat-tools/read-generated-file.test.ts \
  src/lib/server/services/knowledge/project-knowledge.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

The boost on the fusion line plus the parameter on both functions and the two `knowledge/context.ts` call sites;
the project tier in `resolveReadTarget` with the tool description updated; and
`resolveProjectFileMentions` feeding `resolveLinkedContextSourcesForConversation`. Read content with
`getPromptArtifactSnippets`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/knowledge/store/documents.ts src/lib/server/services/knowledge/context.ts \
  src/lib/server/services/knowledge/project-knowledge.ts src/lib/server/services/normal-chat-tools \
  src/lib/server/services/chat-turn
git commit -m "Read a project's files only when the turn needs them

The list says the files exist; the content arrives three ways — relevance, the
tool naming them, and the user naming them. All three reuse what already
resolves a document, so a project file behaves exactly like a linked source
once somebody asks for it."
```

### Task E6: The Info row and the Sources token

**Files:** `messages.ts`, `message-evidence.ts`, `ResponseAuditDetails.svelte`, `MessageBubble.svelte`,
`MessageEvidenceDetails.svelte`, `chat-turn/stream-completion.ts`, `routes/api/chat/send/+server.ts`,
`src/lib/i18n/projects.ts`
**Test:** `messages.test.ts`, `message-evidence.test.ts`, `ResponseAuditDetails.test.ts`,
`MessageEvidenceDetails.test.ts`

**Interfaces:**
- Consumes: the turn's evidence (E5).
- Produces: `ChatMessage.projectFilesRead`, the token on evidence items, and the Info row.

- [ ] **Step 1: Write the failing tests**

```ts
it("persists projectFilesRead when project files were read", ...);
it("omits projectFilesRead when none were read", ...);
it("shows no Project files row in the Info popover when the count is zero", ...);
it("shows the count and the Sources hint when files were read", ...);
it("never puts a file name in the Info row", ...);
it("stamps the project token on evidence items that came from the project", ...);
it("expands the Sources panel when the Info row is clicked", ...);
it("closes the Info popover when the Sources row is clicked", ...);
it("still toggles Sources from its own button after an external expand", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/messages src/lib/server/services/message-evidence src/lib/components/chat`
Expected: FAIL.

- [ ] **Step 3: Implement**

Per Contracts: the metadata field and projection, the project stamp in `buildArtifactGroups` and its widened
params, `projectFilesRead` in the two assistant-metadata bags, `expandRequest` in `MessageEvidenceDetails`, the
forced-close plus `onOpenSources` wiring in `MessageBubble`, the row and `kind: "sources"` in
`ResponseAuditDetails`, the `ScopeToken` in the evidence row, and the two EN/HU keys.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/messages.ts src/lib/server/services/message-evidence.ts \
  src/lib/server/services/chat-turn/stream-completion.ts src/routes/api/chat/send \
  src/lib/components/chat src/lib/i18n/projects.ts
git commit -m "Say how many of the project's files the answer actually read

A count, not a list: the Info popover is a glance, and file names belong in
Sources where the user can open them. The row is a way to get there, so it
closes Info and opens Sources rather than naming anything."
```

### Task E7: Erasure, archive, and the docs

**Files:** `account-data-archive/index.ts` + test, `tests/cross-cutting/*`, `AGENTS.md`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists each project's linked files by name in the archive", ...);
it("leaves no project_knowledge_links row behind after erasure", ...);
it("leaves no project_knowledge_links row behind after clearing workspace data", ...);
it("keeps personal instructions but drops project knowledge on clear workspace data", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/server/services/account-data-archive src/lib/server/services/account-lifecycle
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Add the per-project file list to the human-readable archive, following the existing category shape. Run
`npx vitest run tests/cross-cutting` and resolve any new containment-guard offender **honestly** — scope the
query, or add an `ALLOWED_WITHOUT_SCOPE` entry with a reason that names why the read is safe. Add one `AGENTS.md`
line recording that `knowledge/project-knowledge.ts` owns project-file links and the project-scoped artifact
query.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command plus `npx vitest run tests/cross-cutting`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/account-data-archive tests/cross-cutting AGENTS.md
git commit -m "Cover project files in the archive and in erasure

A project's file list is a user-authored statement about their own work, so the
archive names the files. The rows themselves cascade with the user row, and the
completeness guard now knows about the table."
```

---

## Non-goals

- **No copies, no versions, no dedupe.** A link is a link.
- **No file editing** and no AI edits to library files (Living Documents are ADR-0065 and out of scope).
- **No project-scoped upload limit** of its own; the existing library limits apply.
- **No new viewer.** `DocumentWorkspace.svelte` stays the single shell.
- **No change to `/document` or `/source`**, and no change to `LinkedDocumentPicker.svelte`.
- **No `EvidenceSourceType` change** and no new evidence channel.
- **No second content loader** — `getPromptArtifactSnippets` only.
- **No caching of the file list across turns.**

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| A bare `artifacts.id` lookup on link | User A links user B's document and then reads it | Artifacts are validated through the knowledge ownership scope; tests cover all four cross-user combinations |
| The section crowds out the answer | `protected: true` means it is never trimmed, so an uncapped list would push out real context | Both caps are the section's own job; Task E4 pins the 30-entry and 1,500-character boundaries |
| A project-scope *filter* instead of a boost | A project file would appear for any query | The boost is additive and small; the relevance gate at `:1117-1122` is untouched, and a test pins that an unrelated query does not surface a project file |
| A `conversations.projectId` join used to scope artifacts | Silently finds nothing, because a library document has `conversationId = NULL` | The scope is the link table's id list; a comment in the module says why |
| The section is added to only one tier | It works until someone types a short message, which is exactly the reported bug shape | Pushed in both blocks, with separate tests per tier |
| A second resolver grows beside `linked-context-sources` | Two ownership stories, and the not-prompt-ready behaviour diverges | Mentions are canonicalised and then validated by `resolveLinkedContextSourcesForConversation` |
| `protected: true` used on the wrong layer | The budget priority changes ordering and the packet's shape shifts | `layer: "documents"`, matching the other document sections |
| The forced-close fights the hover CSS | The Info popover reopens under the cursor | The forced-close resets on pointer leave and on the next toggle; a test covers the toggle after an external expand |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` passes; `npm run db:prepare` clean; the account-lifecycle completeness guard
      green.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/project-files.spec.ts tests/e2e/project-page.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/cross-cutting`
      — green.
- [ ] **Real-app visual check** against mockups §M5 and §M8 at **1440×900 and 390×844, light and dark**: the
      Files modal's toolbar, columns, type pills, row actions and footer; Add from library's greyed rows and
      `Add N documents`; the Info popover's Project files row and the Sources row's folder token.
- [ ] **Staging, real model:** link two PDFs to a project, then in that project ask a **short** question → the
      answer shows the files are known (the model can name them) without quoting their content; then name one
      file → its content appears in the answer and in Sources with the folder token; then open Info → the
      Project files row reads `1 read · see Sources ↓` and clicking it opens Sources.
- [ ] **Staging:** unlink a file and confirm the next turn no longer lists it, while the library still holds it.
- [ ] **Staging:** delete the project and confirm the library files are still there.
- [ ] Read the staging service journal for new warnings.

## Owner decisions (ratified 2026-09-24)

All four questions raised here were answered. `decisions.md` is the master record.

1. **`+N more` names a count, not the files.** The remaining files stay reachable through retrieval and by name;
   listing them would need a second budget and would push real context out of a section that is never trimmed.
2. **The retrieval boost stays a fixed, small constant** (`PROJECT_SCOPE_SCORE_BOOST = 5`). A larger boost risks
   a project file outranking the document the user actually attached, which is a worse failure than the reverse.
3. **A non-prompt-ready file still links and still appears in the list**, failing only when its content is asked
   for, with the existing 409. Refusing the link would hide the file's existence from the model entirely, which
   is the opposite of what Folder Knowledge is for.
4. **The Knowledge → Documents token reads "In N projects"** — a bare folder icon cannot distinguish a document
   in one project from one in three, and that difference changes what editing the document would affect.
