# Slice D — Project Instructions and the project page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice C landed**: it reuses `InstructionsDialog`,
> `ScopeToken`, `resolveTurnInstructions` and the shared instruction limit unchanged.

**Goal:** Give every project its own instructions, and give every project a page — the home page in project
mode — that is the single place to start a chat in the project, edit its instructions and (with Slice E) manage
its files.

**Architecture:** `projects.instructions TEXT NULL` alongside the existing project columns. `Project` gains a
`hasInstructions` boolean, never the text, in list and shell payloads; the full text is served only by the
project page's own load. The landing page's content moves out of
`src/routes/(app)/+page.svelte` into one shared `HomeSurface.svelte` that renders in `home` or `project` mode —
**one page component and one prepared-conversation flow, never a fork**. `## Project Instructions` joins the
system message after `## Your Instructions`, resolved once per turn by the existing
`resolveTurnInstructions`.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle on better-sqlite3, Vitest, Playwright, Tailwind tokens.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice D" (lines 210–247); mockups §M1
(`…-workspaces-mockups.html`, section 1) and §M2/§M3 for the reused dialog.

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Do not fork the landing logic.** One page component, one prepared-conversation flow, one send path.
- **The project appears as a token, never in running text.** Reuse `ScopeToken`; no string like
  "in Vienna trip project instructions".
- **Instructions apply on every turn**, shallow and incognito included, and beat personal instructions.
- **No instructions text in the shell payload.** Only `hasInstructions`.
- Svelte 5 runes only; Lucide icons only; `src/app.css` tokens only; EN + HU in the same commit.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/conversation.spec.ts tests/e2e/chat.spec.ts tests/e2e/home-compact.spec.ts \
  tests/e2e/incognito-indicator.spec.ts tests/e2e/mobile-design.spec.ts
```

## Review Focus

1. **The landing page after the extraction.** Every existing landing behaviour — incognito arm, draft
   persistence, prepared-conversation reuse and validation, first-message document navigation, the greeting
   pool and its memory — must be unchanged. The existing specs are the proof (Task D2).
2. **Deleting a project that has instructions.** The row goes with it, no ghost token anywhere, and the
   library files are untouched (Task D1, Task D5).
3. **A conversation moved into or out of a project** switches which instructions apply **from the next turn**,
   without a stale block surviving in the same turn (Task D4).
4. **Project instructions beating personal instructions in a real answer**, including on a short "shallow"
   message and in an incognito chat (Task D4).
5. **The first message sent from the project page** creates the conversation *inside that project* — never a
   loose conversation that then needs moving (Task D3).

---

## Contracts

### SQL DDL

`drizzle/1777140000108_projects_instructions.sql`:

```sql
ALTER TABLE `projects` ADD `instructions` text;
```

Plus the `_journal.json` entry. Verify the number with `npx drizzle-kit generate`.

### `projects.ts`

```ts
export interface Project {
	id: string;
	name: string;
	color?: string | null;
	sortOrder: number;
	createdAt: number;
	updatedAt: number;
	/** True when the project has non-empty instructions. The text itself is never listed. */
	hasInstructions: boolean;
}
```

`toProject` (`projects.ts:22-31`) sets `hasInstructions: Boolean(row.instructions?.trim())`.
`updateProject` (`:71-82`) widens to:

```ts
export async function updateProject(
	userId: string,
	projectId: string,
	updates: { name?: string; instructions?: string | null },
): Promise<Project | null>;
```

New read for the project page (this file owns project data; `home-summary.ts` will call these rather than
re-deriving them in Slice G):

```ts
export interface ProjectPageData {
	project: { id: string; name: string; instructions: string | null; hasInstructions: boolean };
	chats: Array<{ id: string; title: string; updatedAt: number; messageCount: number }>;
	chatCount: number;
	/** Unix seconds of the newest chat, or null when the project has none. */
	lastActivityAt: number | null;
}

export async function getProjectPageData(params: {
	userId: string;
	projectId: string;
	limit: number;
}): Promise<ProjectPageData | null>;

/** Eligible = has at least one conversation that has messages. Ordered by newest activity. */
export async function listRecentlyActiveProjects(params: {
	userId: string;
	limit: number;
}): Promise<Array<{ id: string; name: string; color: string | null; chatCount: number; lastActivityAt: number; hasInstructions: boolean }>>;
```

`listRecentlyActiveProjects` is written here, in Slice D, because the project page needs the same "has
messages" rule the home recent list uses
(`sql\`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id})\``,
`home-summary.ts:461-486`). Slice G consumes it for its cards. **Do not reimplement the rule in
`home-summary.ts`.**

### API

`src/routes/api/projects/[id]/+server.ts` — `PATCH` (`:6-23`) accepts `name` and/or `instructions`; rejecting
when both are absent:

```ts
	const body = await event.request.json().catch(() => null);
	const hasName = body?.name !== undefined;
	const hasInstructions = body?.instructions !== undefined;
	if (!hasName && !hasInstructions) {
		return json({ error: "Nothing to update" }, { status: 400 });
	}
	const updates: { name?: string; instructions?: string | null } = {};
	if (hasName) {
		if (typeof body.name !== "string" || body.name.trim().length === 0) {
			return json({ error: "Name is required" }, { status: 400 });
		}
		updates.name = body.name.trim();
	}
	if (hasInstructions) {
		const result = validateInstructionInput(body.instructions);
		if (!result.ok) {
			return json(
				{ error: result.error === "too_long" ? "Instructions are too long" : "Invalid instructions" },
				{ status: 400 },
			);
		}
		updates.instructions = result.value;
	}
```

`GET /api/projects` returns the widened `Project[]` automatically.

### Project page route

- `src/routes/(app)/projects/[projectId]/+page.server.ts` — `requireAuth`-equivalent through the layout,
  `getProjectPageData({ userId, projectId, limit })`; `404`-style redirect to `/` when the project is not the
  user's, and log nothing about the other user's project.

  **Ownership:** the lookup is `and(eq(projects.id, projectId), eq(projects.userId, userId))` — the existing
  pattern in `projects.ts`. A project belonging to another user must be indistinguishable from a
  non-existent one.
- `src/routes/(app)/projects/[projectId]/+page.svelte` — renders `HomeSurface` in project mode and owns the two
  modals' open state.

### `HomeSurface.svelte` (create)

Location `src/lib/components/home/HomeSurface.svelte` — beside the existing home components. It absorbs the
markup and the orchestration that live in `src/routes/(app)/+page.svelte:861-1052` today: the greeting band, the
incognito arm, the composer, the composer's send/draft/attachment wiring, the recent list and the degraded
capabilities strip. The route keeps only data loading and `HomeSurface`'s callbacks.

```ts
export type HomeMode =
	| { kind: "home" }
	| {
			kind: "project";
			project: { id: string; name: string };
			/** Slice E fills these two; Slice D renders the instructions half only. */
			fileCount?: number;
			chatCount: number;
			lastActivityAt: number | null;
	  };

interface Props {
	mode: HomeMode;
	/** Already scoped by the caller: all conversations on home, this project's on the project page. */
	recent: HomeRecentConversation[];
	weekly?: HomeWeeklyBucket[];
	/** Slice G passes its cards here. */
	projectsRow?: never;
	onOpenInstructions?: () => void;
	onOpenFiles?: () => void;
}
```

Behaviour differences by mode, and nothing else:

| Surface | `home` | `project` |
|---|---|---|
| Greeting | the existing greeting pool (`$lib/client/home/greeting.ts`) | the project name, same serif and colour |
| Stats line | the existing weekly bars | `projects.stats` / `projects.statsOne`: `{count} chats · active {relative}` |
| Composer placeholder | the existing one | `projects.startChatPlaceholder` with the project name |
| Under the composer | nothing | the quiet token line: Instructions / files (see below) |
| Recent heading | the existing one | `projects.listHeading` / `projects.listHeadingOne` |
| Empty list | the existing empty state | `project.emptyList` |
| Prepared conversation | `createNewConversation({ memoryIncognito })` | `createNewConversation({ memoryIncognito, projectId })` |
| Incognito arm | shown | **also shown** — incognito chats in a project still see the project's instructions and files |

The quiet line under the composer renders `ScopeToken`-style chips: a pencil icon + `project.instructionsLabel`
when `hasInstructions`, else a pencil icon + `project.addInstructions`; and Slice E appends a paperclip icon +
`project.fileCount` (or `project.addFiles`) in the same line, separated by a middot. Both are buttons;
`project` mode only.

Conversation creation flows through the existing prepared-conversation path. Add `projectId?: string | null` to
`PendingConversationMessage` (`src/lib/client/conversation-session.ts:25-43`), carry it through
`storePendingConversationMessage` (`:222-245`), `consumePendingConversationMessage` (`:253-313`, **including the
per-field fallback parse at `:298-311`**), and pass it into `createNewConversation({ projectId })` — which
already accepts it (`src/lib/stores/conversations.ts:395-397`).

### Prompt

`resolveTurnInstructions` (`src/lib/server/services/instructions.ts`, created in Slice C) fills its `project`
half by reading `getConversationProjectId(userId, conversationId)` (`projects.ts:143`) then `getProject`. The
system message gains, immediately after `## Your Instructions`:

```
## Project Instructions

AlfyAI follows these in every chat in this project. They take priority over your personal instructions, your memory and the Response Style; the user's current message overrides all of them.

<the project's text, indented by four spaces>
```

Same indentation rule and the same "no `stripDeprecatedPromptSections` tokens" rule as Slice C. The block is
present on every path — shallow turns included — because it is in the system message, and it is present in
incognito conversations in that project. The metadata's `instructionsApplied.projectId` is set when it applied.

### i18n

**Create a new namespace `src/lib/i18n/projects.ts`** for project-surface strings. Wire it into
`src/lib/i18n/index.ts:42-61` (both locale spreads), add `projects` to the scanned module list in
`src/lib/i18n.test-helpers.ts:7-13`, and add `"projects."` to `AUDITED_PREFIXES` (`:14-75`). Slice E (the Files
modal, the Info rows) and Slice G (the home cards) extend this same file — they are serialised after this
slice, so the en/hu objects are appended to in place.

| Key | EN | HU |
|---|---|---|
| `projects.startChatPlaceholder` | `Start a chat in {name}…` | `Kezdj csevegést itt: {name}…` |
| `projects.stats` | `{count} chats · active {relative}` | `{count} csevegés · aktív: {relative}` |
| `projects.statsOne` | `1 chat · active {relative}` | `1 csevegés · aktív: {relative}` |
| `projects.listHeading` | `{count} chats in this project` | `{count} csevegés ebben a projektben` |
| `projects.listHeadingOne` | `1 chat in this project` | `1 csevegés ebben a projektben` |
| `projects.emptyList` | `No chats yet. The first message you send here starts one.` | `Még nincs csevegés. Az első üzenet itt indít egyet.` |
| `projects.instructionsLabel` | `Instructions` | `Utasítások` |
| `projects.addInstructions` | `Add instructions` | `Utasítások hozzáadása` |
| `projects.filesLabel` | `{count} files` | `{count} fájl` |
| `projects.filesLabelOne` | `1 file` | `1 fájl` |
| `projects.addFiles` | `Add files` | `Fájlok hozzáadása` |
| `projects.openA11y` | `Open {name}` | `{name} megnyitása` |
| `projects.missing` | `This project no longer exists.` | `Ez a projekt már nem létezik.` |

Additions to `src/lib/i18n/chat.ts` for the sidebar:

| Key | EN | HU |
|---|---|---|
| `sidebar.openProject` | `Open {name}` | `{name} megnyitása` |
| `sidebar.newChatInProject` | `New chat` | `Új csevegés` |

(`sidebar.newChatInProject` may already exist — the current hover button uses it as its `title`. Reuse it if so;
do not add a duplicate key.)

---

## File ownership

| File | Change |
|---|---|
| `src/lib/components/home/HomeSurface.svelte` | create (extraction from the landing page) |
| `src/lib/components/home/HomeSurface.test.ts` | create |
| `src/routes/(app)/+page.svelte` | shrink to data + `HomeSurface` |
| `src/routes/(app)/projects/[projectId]/+page.server.ts`, `+page.svelte` | create |
| `tests/e2e/project-page.spec.ts` | create |
| `src/lib/client/conversation-session.ts` | `projectId` in the pending message |
| `src/lib/server/services/projects.ts` | column, `hasInstructions`, `getProjectPageData`, `listRecentlyActiveProjects` |
| `src/lib/server/services/projects.test.ts` | extend |
| `src/lib/server/db/schema.ts`, `drizzle/**` | the column and its migration |
| `src/routes/api/projects/[id]/+server.ts` | `instructions` in `PATCH` |
| `src/lib/server/services/instructions.ts` | fill the `project` half |
| `src/lib/server/services/normal-chat-context.ts` | `## Project Instructions` |
| `src/lib/server/services/normal-chat-context.test.ts` | ordering + stability |
| `src/lib/components/sidebar/ProjectItem.svelte`, `src/lib/components/sidebar/ConversationList.svelte` | hover button and menu target the project page |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | breadcrumb project segment becomes a link |
| `src/lib/i18n/projects.ts` (create), `src/lib/i18n/index.ts`, `src/lib/i18n/chat.ts`, `src/lib/i18n.test-helpers.ts` | the new namespace and its keys |
| `src/lib/server/services/account-data-archive/**` | archive project instructions |
| `tests/cross-cutting/incognito-conversation-containment.test.ts` | allow-list entry if a new file reads `conversations` |

**Serialisation:** `src/routes/(app)/chat/[conversationId]/+page.svelte` was edited by Slice A and will be
edited by Slice F — land D before F. `src/lib/components/home/HomeSurface.svelte` is edited by Slice G after
this slice.

---

## Tasks

### Task D1: The column, the flag, and the API

**Files:** `schema.ts`, `drizzle/**`, `projects.ts`, `routes/api/projects/[id]/+server.ts`,
`src/lib/server/services/auth-types.ts` (nothing to add — `Project` is a service type), tests

**Interfaces:**
- Produces: `Project.hasInstructions`, `updateProject({ instructions })`, `PATCH` with `instructions`.
- Consumes: `validateInstructionInput` (Slice C).

- [ ] **Step 1: Write the failing tests**

```ts
it("stores instructions and reports hasInstructions without exposing the text in the list", async () => {
	await updateProject(userId, projectId, { instructions: "Always answer in Hungarian." });
	const [project] = await listProjects(userId);
	expect(project.hasInstructions).toBe(true);
	expect(project).not.toHaveProperty("instructions");
});

it("clears instructions when PATCHed with an empty string", async () => {
	// "" -> null -> hasInstructions false
});

it("rejects instructions over the limit with 400 and writes nothing", async () => {});

it("renames and sets instructions in one PATCH", async () => {});

it("rejects a PATCH with neither field with 400", async () => {});

it("404s a project belonging to another user", async () => {
	await expect(patchAs(otherUser, projectId, { instructions: "x" })).resolves.toMatchObject({ status: 404 });
});

it("deletes the instructions with the project", async () => {});

it("counts only projects with at least one conversation that has messages as recently active", async () => {});

it("orders recently active projects by newest conversation activity", async () => {});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/projects src/routes/api/projects`
Expected: FAIL — no `hasInstructions`, no `instructions` branch.

- [ ] **Step 3: Implement**

Column + migration + journal entry, `toProject`, the widened `updateProject`, `getProjectPageData`,
`listRecentlyActiveProjects`, and the `PATCH` branches from Contracts. Run
`npm run check:migrations && npm run db:prepare`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/db/schema.ts drizzle src/lib/server/services/projects.ts \
  src/lib/server/services/projects.test.ts src/routes/api/projects
git commit -m "Give projects instructions, and list them without the text

The list and shell payloads carry a boolean, not the text: project names are
already in the sidebar, but a user's standing guidance has no business being
prefetched on every page. The page that shows the text loads it itself."
```

### Task D2: Extract `HomeSurface` (pure refactor, no behaviour change)

**Files:** `src/lib/components/home/HomeSurface.svelte` (create), `src/routes/(app)/+page.svelte`
**Test:** `src/lib/components/home/HomeSurface.test.ts` (create); **the existing landing specs are the
regression net** — they must pass untouched.

**Interfaces:**
- Produces: `HomeSurface` with the props in Contracts, in `home` mode only for now.
- Consumes: nothing from this slice.

- [ ] **Step 1: Move the markup and orchestration**

Move `src/routes/(app)/+page.svelte:861-1052`'s markup plus the orchestration it calls — greeting pick,
incognito arm, draft persistence, `ensurePreparedConversation`, `handleSend`,
`navigateToConversationFromLanding`, `restorePreparedConversation`, attachment and pending-message handling —
into `HomeSurface.svelte`. The route keeps: `data` from the layout, the home summary fetch, and the props it
passes down. **Change no behaviour in this task.**

- [ ] **Step 2: Run the existing landing specs unchanged**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx playwright test tests/e2e/home-compact.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts \
  tests/e2e/incognito-indicator.spec.ts tests/e2e/mobile-design.spec.ts
```
Expected: PASS, with **no edits to those spec files**. If a spec needs editing, the extraction changed
behaviour — fix the extraction, do not touch the spec.

- [ ] **Step 3: Add the component test**

`HomeSurface.test.ts` asserts the mode-dependent differences in `home` mode are absent: no project placeholder,
no instructions line, no project heading.

- [ ] **Step 4: Run the typecheck and the unit suite**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx vitest run src/lib/components/home src/routes/\(app\)
```
Expected: PASS, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/home "src/routes/(app)/+page.svelte"
git commit -m "Move the landing surface into a shared component, with no behaviour change

The project page is the home page in project mode, and forking it would mean
maintaining two send paths, two draft flows and two incognito arms. This commit
only moves code: the existing landing specs pass untouched, which is the proof."
```

### Task D3: The project page, project mode, and every entry point

**Files:** `src/routes/(app)/projects/[projectId]/+page.server.ts`, `+page.svelte`,
`src/lib/components/home/HomeSurface.svelte` (project mode),
`src/lib/client/conversation-session.ts`, `src/lib/components/sidebar/ProjectItem.svelte`,
`ConversationList.svelte`, `src/routes/(app)/chat/[conversationId]/+page.svelte` (breadcrumb),
`src/lib/i18n/projects.ts` (create), `src/lib/i18n/index.ts`, `src/lib/i18n/chat.ts`,
`src/lib/i18n.test-helpers.ts`, `tests/e2e/project-page.spec.ts` (create)
**Test:** the new spec, plus the sidebar and conversation specs

**Interfaces:**
- Consumes: `getProjectPageData` (Task D1), `InstructionsDialog`/`ScopeToken` (Slice C), `HomeSurface`
  (Task D2).
- Produces: `/projects/[projectId]`, and `projectId` carried through the pending-message flow.

- [ ] **Step 1: Write the failing E2E test**

`tests/e2e/project-page.spec.ts`:

```
it("opens from the sidebar hover button and from the New chat menu item", ...);
it("shows the project name as the greeting and the project's chats below", ...);
it("creates the first chat inside the project when a message is sent from the project page", ...);
it("shows the empty list line for a project with no chats", ...);
it("opens the instructions dialog with only the project scope from the quiet line", ...);
it("links the breadcrumb project segment back to the project page", ...);
it("redirects home for another user's project id", ...);
it("keeps the incognito arm on the project page and creates an incognito chat in the project", ...);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx playwright test tests/e2e/project-page.spec.ts`
Expected: FAIL — no route.

- [ ] **Step 3: Implement**

Create the route and its load. Add `project` mode to `HomeSurface` with the mode differences table from
Contracts and nothing more. Thread `projectId` through `conversation-session.ts` (four call sites, including
the fallback parse). Point `ProjectItem.svelte`'s hover button (`:278-293`) at the project page with
`aria-label={$t('projects.openA11y', { name: project.name })}` and `aria-label` on the menu's "New
chat" item; **the row click still only expands or collapses** (`:239`). Make the breadcrumb's project segment a
link in the chat page (`:2680-2696`). The "New chat" menu item navigates to the project page with the composer
focused.

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the sidebar, conversation and mobile specs**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx playwright test tests/e2e/conversation.spec.ts tests/e2e/conversation-forks.spec.ts \
  tests/e2e/home-compact.spec.ts tests/e2e/mobile-design.spec.ts
```
Expected: PASS. The sidebar's drag-and-drop move behaviour must be unchanged.

- [ ] **Step 6: Commit**

```bash
git add "src/routes/(app)/projects" src/lib/components/home/HomeSurface.svelte \
  src/lib/client/conversation-session.ts src/lib/components/sidebar \
  "src/routes/(app)/chat/[conversationId]/+page.svelte" src/lib/i18n tests/e2e/project-page.spec.ts
git commit -m "Give each project a page that is the home page in project mode

Clicking a project's name still only expands it; the hover button and the menu
now open the project, where the composer already belongs to it, so the first
message cannot land outside the folder by accident."
```

### Task D4: Project instructions reach the model

**Files:** `src/lib/server/services/instructions.ts`, `normal-chat-context.ts`,
`normal-chat-context.test.ts`, `src/lib/server/services/instructions.test.ts`,
`chat-turn/stream-completion.ts`, `routes/api/chat/send/+server.ts` (only if the resolved object is not already
threaded by Slice C)
**Test:** both test files

**Interfaces:**
- Consumes: `getConversationProjectId`, `getProject` (D1).
- Produces: the `## Project Instructions` section and a set `instructionsApplied.projectId`.

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves the conversation's project instructions for the turn", ...);
it("returns project null for a conversation with no project", ...);
it("returns project null when the project has no instructions", ...);
it("does not resolve another user's project", ...);

it("renders Project Instructions after Your Instructions", ...);
it("renders Project Instructions on a shallow turn", ...);           // resolveContextLatencyTier -> "shallow"
it("renders Project Instructions in an incognito conversation", ...);
it("is byte-identical across turns for identical project instructions", ...);
it("changes the prefix when the project's instructions change", ...);
it("applies to the next turn after a conversation is moved into a project", ...);
it("applies to the next turn after a conversation is moved out of that project", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/instructions.test.ts src/lib/server/services/normal-chat-context.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Fill the `project` half of `resolveTurnInstructions`, add the section after `## Your Instructions`, and set
`instructionsApplied.projectId` in the metadata bag. The shallow and incognito cases need no special code —
assert them anyway, because that is the whole reason the section lives in the system message.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/instructions.ts src/lib/server/services/instructions.test.ts \
  src/lib/server/services/normal-chat-context.ts src/lib/server/services/normal-chat-context.test.ts \
  src/lib/server/services/chat-turn src/routes/api/chat/send
git commit -m "Let a project's instructions outrank the account's

They ride the system message next to the personal block, so a short message
skips nothing and an incognito chat in the project still follows them. Moving a
conversation in or out of a project changes the block on the next turn, because
the block is resolved per turn from the conversation's project, never cached."
```

### Task D5: Archive, containment, and the docs

**Files:** `src/lib/server/services/account-data-archive/index.ts` + test,
`tests/cross-cutting/incognito-conversation-containment.test.ts`, `AGENTS.md`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

```ts
it("includes each project's Instructions in the human-readable archive", ...);
it("does not expose project instructions through the shared shell payload", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/account-data-archive`
Expected: FAIL.

- [ ] **Step 3: Implement, and settle the containment guard**

Add the per-project instructions to the archive. Then run
`npx vitest run tests/cross-cutting/incognito-conversation-containment.test.ts`. If a file this slice added
reads `conversations` or `projects` without a scope marker, the guard fails. Resolve it honestly: either scope
the query, or append an entry to that test's `ALLOWED_WITHOUT_SCOPE` map (`:533-566`) with a reason that names
why the read is safe. The guard's second test ("keeps the allow-list honest", `:615-623`) requires the key to
resolve to a real file, so a stale entry fails too. **Do not widen `SCOPE_MARKERS`.**

Finally add one `AGENTS.md` line recording that `projects.ts` owns project-page reads and that
`home-summary.ts` consumes `listRecentlyActiveProjects` rather than re-deriving project activity.

- [ ] **Step 4: Run them to verify they pass**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/server/services/account-data-archive tests/cross-cutting
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/account-data-archive tests/cross-cutting AGENTS.md
git commit -m "Carry project instructions into the archive and record the read boundary

A project's instructions are user-authored text about their own work, so they
belong in the human-readable archive next to the project itself."
```

---

## Non-goals

- **No Folder Knowledge or the Files modal.** Slice E fills the files half of the quiet line.
- **No home projects row.** Slice G consumes `listRecentlyActiveProjects`.
- **No `/instruction` command and no AI suggestions.** Slice F.
- **No project deletion of library files.** Decision 8.
- **No project instructions on the project's *conversations* individually**, and no per-chat overrides.
- **No moving `HomeSurface`'s orchestration into a store.** It stays a component with callback props.
- **No new endpoint for the project page's chat list** beyond the page's own server load.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The extraction silently changes landing behaviour | The landing page is the first thing anyone sees, and it has the most edge cases (draft reuse, incognito, document navigation) | Task D2 changes no behaviour and requires the existing specs to pass **unmodified**; a spec edit is treated as evidence of a behaviour change |
| `hasInstructions` drifts from the truth | The sidebar/token would lie, and the model would disagree with the UI | Both read the same column through `toProject`; tests cover set, clear and delete |
| A stale instruction block survives a project move within the same turn | The answer follows the old project once | Resolution is per turn and reads the conversation's current `projectId`; two tests pin the move in and the move out |
| Project instructions leak in the shell payload | Every page load prefetches private text | `Project` never carries the text; a test asserts the payload shape |
| Duplicated "chat has messages" rule | The project page and the home row would disagree about what counts as activity | `listRecentlyActiveProjects` lives in `projects.ts`; `home-summary.ts` calls it |
| The containment allow-list is widened to make a red test green | The guard's whole value is that entries name a real boundary | Task D5 step 3 requires a named reason, and the honesty test rejects stale keys |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` passes; `npm run db:prepare` clean.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/project-page.spec.ts tests/e2e/conversation.spec.ts tests/e2e/chat.spec.ts tests/e2e/home-compact.spec.ts tests/e2e/incognito-indicator.spec.ts tests/e2e/mobile-design.spec.ts`
      — green.
- [ ] **Real-app visual check** against mockup §M1 at **1440×900 and 390×844, light and dark**: greeting is the
      project name in the same serif and colour, the stats line, the composer placeholder, the quiet line, the
      list heading, the empty state. Phone: the cards/rows behave as the mockup's note describes.
- [ ] **Staging, real model:** set project instructions ("Only suggest trains, never flights."), then in a
      project chat ask about travel and confirm the answer obeys it; set personal instructions to contradict
      and confirm the project wins; ask a **short** question and confirm it still obeys; check an **incognito**
      chat in the project obeys it too.
- [ ] **Staging:** the Info popover shows the project token next to the You token for a reply in that project.
- [ ] Read the staging service journal for new warnings.

## Owner decisions (ratified 2026-09-24)

All three questions raised here were answered. `decisions.md` is the master record.

1. **The quiet line ships in two steps.** Slice D renders the instructions half, Slice E adds the files half.
   The mockup's full line is matched after E. Shipping a files button whose modal does not exist yet would be
   worse than an intermediate state no user sees in production.
2. **The incognito arm stays on the project page**, because Slice E guarantees an incognito chat in a project
   still sees the project's instructions and files — which only matters if one can be started there.
3. **The stats line keeps using the newest *chat* activity**, and it is nearly moot:
   `conversations.updatedAt` no longer moves on a folder move (commit `468668ee`), so it already tracks real
   activity, which is also why the home row and this line cannot disagree.
