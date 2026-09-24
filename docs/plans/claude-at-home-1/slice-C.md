# Slice C — Personal Instructions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first.

**Goal:** Give the account one free-text box of standing guidance that AlfyAI follows in every chat, editable
from Settings and from `/instruction`, applied in the **system message** on every path including shallow turns
and incognito, and reported in the per-message Info popover.

**Architecture:** `users.personal_instructions TEXT NULL` is the storage. One new shared component,
`InstructionsDialog.svelte`, is the only editing surface (the project scope in Slice D reuses it unchanged).
One new shared component, `ScopeToken.svelte`, renders a scope as a token everywhere. Prompt assembly receives
the resolved text as a **parameter** — `normal-chat-context.ts` gains the section but no DB reads. The
`## Your Instructions` section sits **after** `## Response Style`, which means the existing test that pins
Response Style as the last section is intentionally updated.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle on better-sqlite3, Vitest, Playwright, Tailwind tokens.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice C" (lines 161–207); mockups §M2, §M3, §M7,
§M8 (`…-workspaces-mockups.html`, sections 2, 3, 7, 8).

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **2,000 characters, counted as Unicode code points** (`[...text].length`), so an emoji counts as one. The
  browser counter and the server check must call the **same function**.
- **Never silently truncate.** Over the limit is a `400` from the API and a disabled Save in the dialog.
- **Empty means clear** — trimming to `""` stores `NULL`.
- Svelte 5 runes only: `$props`, callback props, `onclick`, `{@render}`; no new `<slot>`, no
  `createEventDispatcher`, no `afterUpdate`.
- Lucide icons via `@lucide/svelte` only; tokens from `src/app.css` only.
- Every string in EN and HU in the same commit.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/settings-profile-redesign.spec.ts tests/e2e/chat.spec.ts
```

## Review Focus

1. **Exactly 2,000 vs 2,001 characters, with an emoji and a Hungarian accent in the text.** The counter and the
   server must agree, and 2,001 must be a `400` — never a truncation (Task C1, Task C2).
2. **A user instruction containing `<preserve>`, `## Response Style` or the words "preserve tags".**
   `stripDeprecatedPromptSections` (`normal-chat-context.ts:521` → `prompts.ts:311-317`) deletes any paragraph
   containing those tokens; a user's own text must not vanish and section boundaries must not move (Task C4).
3. **Identical instructions across turns give an identical system-message prefix; an edit changes it.** The
   provider prefix cache depends on it, and the existing stability tests must be extended rather than relaxed
   (Task C4).
4. **The dialog opened with nothing saved, then cancelled** — no write, no `NULL`-vs-`""` ambiguity, no
   `--` placeholder text left in the box (Task C2).
5. **Personal instructions surviving both "Clear memory and knowledge" and "Clear workspace data".** They are
   not memory and not workspace content (Task C6).

---

## Contracts

### SQL DDL

`drizzle/1777140000106_users_personal_instructions.sql`:

```sql
ALTER TABLE `users` ADD `personal_instructions` text;
```

Plus the matching `drizzle/meta/_journal.json` entry (`idx` 118, `when` equal to the filename's epoch,
`tag` equal to the filename without `.sql`, `breakpoints: true`). Verify the exact number with
`npx drizzle-kit generate` rather than trusting this document.

### `src/lib/shared/instructions.ts` (create)

Client-safe, no server imports, so the dialog and the route validate identically.

```ts
/** Maximum instruction length, counted as Unicode code points. */
export const INSTRUCTIONS_MAX_CHARS = 2000;

export type InstructionScopeKind = "personal" | "project";

export interface InstructionScope {
	kind: InstructionScopeKind;
	/** Present only for kind === "project". */
	projectId?: string;
	/** Project name for the token; absent for kind === "personal". */
	name?: string;
}

/** Counts code points, so "👍" is 1 and "é" is 1. */
export function countInstructionChars(text: string): number;

/** "" after trim becomes null. */
export function normalizeInstructionText(text: string): string | null;

export type InstructionValidation =
	| { ok: true; value: string | null }
	| { ok: false; error: "not_a_string" | "too_long" };

/** `raw` is the untrusted JSON body value. */
export function validateInstructionInput(raw: unknown): InstructionValidation;
```

### API

`src/routes/api/settings/preferences/+server.ts` — `PATCH` gains one branch after the existing
`memoryEnabled` branch (around line 104), following the `preferredPersonalityId` string-or-null style at
`:87-92`:

```ts
	if (body.personalInstructions !== undefined) {
		const result = validateInstructionInput(body.personalInstructions);
		if (!result.ok) {
			return json(
				{ error: result.error === "too_long" ? "Instructions are too long" : "Invalid personalInstructions" },
				{ status: 400 },
			);
		}
		updates.personalInstructions = result.value;
	}
```

`src/routes/api/settings/+server.ts` — `GET` adds `personalInstructions: userRow.personalInstructions ?? null`
to the `preferences` object (beside `memoryEnabled`, around `:42`).

`src/routes/(app)/settings/+page.server.ts` — the `preferences` literal at `:37-48` gains the same field.

### Shared types

`src/lib/server/services/auth-types.ts:18-29` — `UserPreferences` gains `personalInstructions: string | null;`.
This flows to the browser through `fetchUserSettings` unchanged.

`src/lib/client/api/settings.ts:225-244` — `updateUserPreferences`'s param object gains
`personalInstructions?: string | null;` (it is spread into `JSON.stringify(params)`).

### New service: `src/lib/server/services/instructions.ts` (create)

This is a **new boundary on purpose**, not a convenience: two scopes of standing guidance read from two
different tables, resolved once per turn, consumed by prompt assembly, the audit metadata and the data archive.
It is not "one file getting large". Record it in `AGENTS.md` under "Config And Environment" in the same commit
(Task C6).

```ts
import type { InstructionScope } from "$lib/shared/instructions";

export interface ResolvedTurnInstructions {
	/** Trimmed personal text, or null when unset. */
	personal: string | null;
	/** Present only when the conversation has a project with instructions. */
	project: { id: string; name: string; text: string } | null;
}

/** One read of the user row plus (Slice D) one read of the conversation's project. */
export async function resolveTurnInstructions(params: {
	userId: string;
	conversationId: string;
}): Promise<ResolvedTurnInstructions>;

/** For Settings, the project page and the data archive. */
export async function getInstructionText(userId: string, scope: InstructionScope): Promise<string | null>;
```

In Slice C, `resolveTurnInstructions` returns `project: null` always; Slice D fills that half in. Write the
signature complete now so Slice D does not change it.

### Prompt section

`src/lib/server/services/normal-chat-context.ts`:

- `PrepareOutboundChatContextParams` (`:1756-1799`) gains
  `instructions?: ResolvedTurnInstructions | null;` — **optional**, so the control-model path
  (`normal-chat-control-model.ts:351`, which passes `skipDefaultRuntimeGuidance: true`) and every existing
  caller keep compiling and keep rendering nothing.
- `buildOutboundSystemPrompt` (`:419-522`) currently builds the `sections` array (`:501-521`), joins it with
  `"\n\n"`, and returns `stripDeprecatedPromptSections(joined)` at `:521`. **The instruction sections must be
  appended after that call, not pushed into the array**, because `stripDeprecatedPromptSections`
  (`prompts.ts:311-317`) deletes any paragraph containing `<preserve>`, "preserve tags" or
  "translation-preserved" — and it would delete a paragraph **the user typed**, whatever its indentation.
  Indentation protects the section *shape*; only ordering protects the user's *text*.

```ts
	// existing: build `sections`, join, strip
	const stripped = stripDeprecatedPromptSections(sections.join("\n\n"));

	// new: instruction sections are appended AFTER stripping so user text is never scanned for
	// deprecated-section tokens. Slice D appends its project section in the same place.
	const instructionSections: string[] = [];
	if (params.instructions?.personal) {
		instructionSections.push(buildInstructionSection("Your Instructions", params.instructions.personal));
	}
	return instructionSections.length > 0
		? `${stripped}\n\n${instructionSections.join("\n\n")}`
		: stripped;
```

  (Write it as a small helper if the function's shape makes the early return awkward — but the ordering is
  not negotiable.)

- Section text, exactly:

```
## Your Instructions

AlfyAI follows these in every chat. Follow Project Instructions over Your Instructions, and both over the Response Style and any remembered preference; the user's current message overrides all of them.

<the user's text, indented by four spaces, one paragraph per line>
```

- `buildInstructionSection(heading, text)` is a local helper (not exported): it indents every line of the
  user's text by four spaces so a line the user typed (`## Project Instructions`, `- a bullet`) renders as
  literal text inside the section rather than as a heading or a list. It must not introduce any of the tokens
  `stripDeprecatedPromptSections` looks for **in its own boilerplate** — but the user's text is protected by
  the ordering above, not by sanitising it. **Never rewrite or escape what the user typed.**

- **Response Style framing** (`:515`) must be reworded so it yields. Replace the clause
  `"Only deviate if it directly conflicts with safety, tool, source-citation requirements, or an explicit user instruction in the current message."`
  with
  `"Deviate whenever it conflicts with safety, tool or source-citation requirements, with the user's instructions (project instructions first, then personal instructions), or with the current message."`
  Keep the first three sentences' meaning; the difficulty is that the owner's precedence puts *personal
  instructions* above style even when the style was chosen deliberately, which the old wording did not.

### Message metadata

`src/lib/server/services/messages.ts` — `PersistedMessageMetadata` (`:43-86`) gains:

```ts
	instructionsApplied?: InstructionScopeApplication;
```

with the type declared in the new shared module so the browser can read it, and re-exported onto `ChatMessage`
the way `skillDrafts` is (`messages-types.ts:328-329`):

```ts
export interface InstructionScopeApplication {
	personal: boolean;
	/** Set only when the project instruction block applied. */
	projectId?: string;
}
```

Add the read projection beside the `skillDrafts` line at `messages.ts:273-275`:

```ts
	instructionsApplied:
		metadata?.instructionsApplied && typeof metadata.instructionsApplied === "object"
			? metadata.instructionsApplied
			: undefined,
```

The value is written at turn completion by the same bag the other metadata fields use:
`chat-turn/stream-completion.ts:552-596` (stream) and `routes/api/chat/send/+server.ts:565-578` (send). The
turn knows which blocks applied because `resolveTurnInstructions` returned them — pass the resolved value into
the completion step, do not re-read the database there.

### i18n — new namespace `src/lib/i18n/instructions.ts`

Wire it into `src/lib/i18n/index.ts:42-61` (both locale spreads) and add `"instructions."` and
`"audit.instructions"` coverage by adding `instructions` to the module list in
`src/lib/i18n.test-helpers.ts:7-13` and `"instructions."` to `AUDITED_PREFIXES` (`:14-75`).

| Key | EN | HU |
|---|---|---|
| `instructions.title` | `Instructions` | `Utasítások` |
| `instructions.descriptionPersonal` | `These apply in every chat.` | `Minden csevegésben érvényesek.` |
| `instructions.descriptionProject` | `AlfyAI follows these in every chat in this project. They take priority over your memory and style.` | `Az AlfyAI minden csevegésben követi ezeket a projektben. Elsőbbséget élveznek a memóriáddal és a stílussal szemben.` |
| `instructions.appendedLine` | `Added to the end. Edit the whole text if something no longer fits.` | `A végéhez fűztük. Ha valami már nem illik, nyugodtan írd át az egészet.` |
| `instructions.counter` | `{count} / {max}` | `{count} / {max}` |
| `instructions.tooLong` | `Instructions can be at most {max} characters.` | `Az utasítás legfeljebb {max} karakter lehet.` |
| `instructions.save` | `Save` | `Mentés` |
| `instructions.cancel` | `Cancel` | `Mégsem` |
| `instructions.scopePersonal` | `Personal` | `Személyes` |
| `instructions.scopeYou` | `You` | `Te` |
| `instructions.scopeA11y` | `Instructions for {scope}` | `Utasítások ehhez: {scope}` |
| `instructions.tokenA11y` | `Project {name}` | `{name} projekt` |
| `instructions.saveFailed` | `Could not save the instructions.` | `Nem sikerült menteni az utasításokat.` |

Additions to `src/lib/i18n/settings.ts`:

| Key | EN | HU |
|---|---|---|
| `profileTab.personalInstructions` | `Personal instructions` | `Személyes utasítások` |
| `profileTab.personalInstructionsHelp` | `Followed in every chat. Project instructions take priority inside a project.` | `Minden csevegésben érvényes. Egy projekten belül a projekt utasításai élveznek elsőbbséget.` |
| `profileTab.personalInstructionsAdd` | `Add instructions` | `Utasítások hozzáadása` |
| `profileTab.personalInstructionsEdit` | `Edit` | `Szerkesztés` |
| `profileTab.personalInstructionsEmpty` | `Not set` | `Nincs beállítva` |

Addition to `src/lib/i18n/chat.ts`:

| Key | EN | HU |
|---|---|---|
| `audit.instructions` | `Instructions` | `Utasítások` |

**Copy change, both locales:** `settings_clearMemoryDescription` (`settings.ts:808-809` EN, `:2728-2735` HU)
must now say that personal instructions are kept. EN becomes
`Deletes everything AlfyAI has learned about you and every document you have uploaded or that AlfyAI created. Your personal instructions, your chats and your account stay.`
HU: `Törli mindazt, amit az AlfyAI megtanult rólad, és minden feltöltött vagy általa létrehozott dokumentumot. A személyes utasításaid, a csevegéseid és a fiókod megmaradnak.`

---

## File ownership

**Exclusive to Slice C** (plus the shared files listed at the end of `plan.md`'s hot-file table).

| File | Change |
|---|---|
| `src/lib/shared/instructions.ts` | create |
| `src/lib/server/services/instructions.ts` | create |
| `src/lib/server/services/instructions.test.ts` | create |
| `src/lib/components/instructions/InstructionsDialog.svelte` | create — **Slice D and F reuse it unchanged** |
| `src/lib/components/instructions/InstructionsDialog.test.ts` | create |
| `src/lib/components/instructions/ScopeToken.svelte` | create — Slice D, F, G reuse it |
| `src/lib/components/instructions/ScopeToken.test.ts` | create |
| `src/lib/i18n/instructions.ts` | create |
| `drizzle/1777140000106_users_personal_instructions.sql` + journal | create |
| `src/lib/server/db/schema.ts` | one column on `users` |
| `src/routes/api/settings/preferences/+server.ts`, `src/routes/api/settings/+server.ts` | accept + return the field |
| `src/routes/(app)/settings/+page.server.ts` | shell payload field |
| `src/lib/server/services/auth-types.ts` | `UserPreferences` |
| `src/lib/client/api/settings.ts` | param |
| `src/routes/(app)/settings/_components/SettingsProfileTab.svelte` | the new first row |
| `src/routes/(app)/settings/+page.svelte` | load + save wiring |
| `src/lib/server/services/normal-chat-context.ts` | the section, the reword, the param |
| `src/lib/server/services/normal-chat-context.test.ts` | extend stability tests |
| `src/lib/server/services/messages.ts` | the metadata field + projection |
| `src/lib/components/chat/ResponseAuditDetails.svelte` | the Info row |
| `src/lib/i18n/settings.ts`, `src/lib/i18n/chat.ts`, `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts` | keys + registration |
| `src/lib/server/services/account-data-archive/**` | archive the text |
| `AGENTS.md` | record the `instructions.ts` boundary |

**Not this slice:** `projects.instructions` (Slice D), `ResponseAuditDetails`'s project token (Slice D),
`project_knowledge_links` (Slice E), `/instruction` and suggestions (Slice F).

---

## Tasks

### Task C1: Storage, shared limit, and the settings API

**Files:** schema + migration, `src/lib/shared/instructions.ts`, both settings routes,
`auth-types.ts`, `src/lib/client/api/settings.ts`
**Test:** `src/lib/shared/instructions.test.ts`, `src/routes/api/settings/settings.test.ts`

**Interfaces:**
- Produces: `INSTRUCTIONS_MAX_CHARS`, `validateInstructionInput`, `countInstructionChars`,
  `normalizeInstructionText`, `InstructionScope`, and a `personalInstructions` field on `GET /api/settings`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

`src/lib/shared/instructions.test.ts`:

```ts
import {
	INSTRUCTIONS_MAX_CHARS, countInstructionChars, normalizeInstructionText, validateInstructionInput,
} from "./instructions";

describe("countInstructionChars", () => {
	it("counts an accented Hungarian character as one", () => {
		expect(countInstructionChars("árvíztűrő")).toBe(9);
	});
	it("counts an emoji as one, not two", () => {
		expect(countInstructionChars("👍")).toBe(1);
		expect(countInstructionChars("a👍b")).toBe(3);
	});
	it("counts a 2,000-character string as exactly 2,000", () => {
		expect(countInstructionChars("a".repeat(INSTRUCTIONS_MAX_CHARS))).toBe(INSTRUCTIONS_MAX_CHARS);
	});
});

describe("validateInstructionInput", () => {
	it("accepts text at exactly the limit", () => {
		expect(validateInstructionInput("a".repeat(INSTRUCTIONS_MAX_CHARS))).toEqual({
			ok: true, value: "a".repeat(INSTRUCTIONS_MAX_CHARS),
		});
	});
	it("rejects text one character over the limit", () => {
		expect(validateInstructionInput("a".repeat(INSTRUCTIONS_MAX_CHARS + 1))).toEqual({
			ok: false, error: "too_long",
		});
	});
	it("rejects an over-limit string of emoji by code points, not UTF-16 units", () => {
		// 1,001 emoji is 2,002 UTF-16 units but only 1,001 code points: must be accepted.
		expect(validateInstructionInput("👍".repeat(1001)).ok).toBe(true);
	});
	it("rejects a non-string", () => {
		expect(validateInstructionInput(42)).toEqual({ ok: false, error: "not_a_string" });
	});
	it("turns empty and whitespace-only text into an explicit clear", () => {
		expect(validateInstructionInput("   \n ")).toEqual({ ok: true, value: null });
	});
	it("accepts null as a clear", () => {
		expect(validateInstructionInput(null)).toEqual({ ok: true, value: null });
	});
	it("trims the stored text", () => {
		expect(validateInstructionInput("  keep it short  ")).toEqual({ ok: true, value: "keep it short" });
	});
});

describe("normalizeInstructionText", () => {
	it("returns null for whitespace only", () => {
		expect(normalizeInstructionText("\n\t ")).toBeNull();
	});
});
```

Route tests in `src/routes/api/settings/settings.test.ts`: a `PATCH` with 2,000 characters returns 200 and
persists; 2,001 returns `400 { error: "Instructions are too long" }` **and writes nothing**; `""` clears;
`GET` returns the value.

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/shared/instructions.test.ts src/routes/api/settings`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Add the column + migration + journal entry, create the shared module, add the route branch, the `GET` field,
`UserPreferences.personalInstructions`, and the client API param. Run
`npm run check:migrations && npm run db:prepare` and confirm both pass.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/instructions.ts src/lib/shared/instructions.test.ts \
  src/lib/server/db/schema.ts drizzle src/routes/api/settings src/lib/server/services/auth-types.ts \
  src/lib/client/api/settings.ts
git commit -m "Store personal instructions on the user row

The limit is enforced in one shared function so the dialog's live counter and
the API cannot disagree. Character means Unicode code point: counting UTF-16
units would reject a Hungarian or emoji text the counter said was fine.

Over the limit is a 400 and nothing is written. Skills truncate silently today;
that is the bug this avoids copying."
```

### Task C2: The dialog and the scope token

**Files:** `src/lib/components/instructions/InstructionsDialog.svelte`, `ScopeToken.svelte`, their tests,
`src/lib/i18n/instructions.ts`
**Test:** both component tests, plus `tests/e2e/instructions-dialog.spec.ts` (create)

**Interfaces:**
- Consumes: `INSTRUCTIONS_MAX_CHARS`, `countInstructionChars` (Task C1).
- Produces: `InstructionsDialog` and `ScopeToken` with the exact props below — Slice D and Slice F call them.

```ts
// ScopeToken.svelte
interface Props {
	scope: InstructionScope;          // kind "personal" renders the user icon + scopeYou
	size?: "sm" | "md";
}
```

```ts
// InstructionsDialog.svelte
interface Props {
	open: boolean;
	/** Scope shown on open. */
	scope: InstructionScope;
	/** Every scope the user may switch to. One entry means no switch is rendered. */
	scopes: InstructionScope[];
	/** Current saved text per scope, keyed "personal" or `project:<id>`. */
	initialText: Record<string, string>;
	/** A new line to append and highlight. */
	appendedLine?: string | null;
	/** Where the appended line starts; switching moves it with the user. */
	appendedScope?: InstructionScope;
	/** Resolves to the saved text, or to a failure the dialog shows without closing. */
	onSave: (payload: { scope: InstructionScope; text: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
	onClose: () => void;
}
```

- [ ] **Step 1: Write the failing component tests**

`InstructionsDialog.test.ts` behaviours (Vitest + the component test setup already used under
`src/lib/components/**`):

```ts
it("renders one textarea and the live counter for the opened scope", ...);
it("appends the pending line to the buffer and grows the counter to include it", ...);
it("disables Save and shows tooLong when the buffer passes the limit", ...);
it("does not render the scope switch when only one scope is passed", ...);
it("moves the pending line to the other scope's text when the switch is used", ...);
it("keeps the buffer when Save fails and shows the error", ...);
it("calls onClose without onSave when Cancel is pressed", ...);
it("sends an empty string when the user deletes the whole text", ...);
```

`ScopeToken.test.ts`: personal renders the "You"/"Te" label with the user icon and no folder icon; project
renders the project name with the folder icon and an accessible name from `instructions.tokenA11y`.

`tests/e2e/instructions-dialog.spec.ts`: open the dialog from the Settings row and assert the title, the token,
the counter text, Save/Cancel labels, the appended-line description, and that Save persists across a reload.

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/components/instructions`
Expected: FAIL — the components do not exist.

- [ ] **Step 3: Implement**

Build on `DialogShell` (`src/lib/components/ui/DialogShell.svelte`), props at `:119-130`: `title`,
`description`, `onClose`, `maxWidthClass="max-w-[560px]"`, `phonePresentation="sheet"`, and the `footer`
snippet for Cancel/Save. Use `btn-secondary` for Cancel and `btn-primary` for Save, matching
ConfirmDialog (`src/lib/components/ui/ConfirmDialog.svelte:41-56`). Use `User` and `Folder` from
`@lucide/svelte` at the design system's `size`/`strokeWidth`, both `aria-hidden="true"`.

The textarea is about 8 rows and grows to a `max-height: 40vh`. The appended line is highlighted **inside** the
textarea with a mirror layer: a `<div class="instructions-mirror" aria-hidden="true">` behind a textarea whose
own background is transparent and whose `font`, `line-height`, `padding` and `border-width` are identical; the
mirror repeats the full buffer with the appended suffix wrapped in `<mark>`, and its `scrollTop` is written
from the textarea's `scroll` and `input` handlers. If the mirror and the textarea cannot be kept in alignment
at 390×844, the fallback is to render the appended line as a `<mark>` row directly above the textarea and to
append it to the buffer on save — record which of the two you shipped in the task report, because the reviewer
will check the mockup against it.

Count with `countInstructionChars`, never `text.length`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command, then
`npx playwright test tests/e2e/instructions-dialog.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/instructions src/lib/i18n/instructions.ts src/lib/i18n/index.ts \
  src/lib/i18n.test-helpers.ts tests/e2e/instructions-dialog.spec.ts
git commit -m "Add the one instructions dialog every entry point will use

Every way of changing instructions opens this same frame, so nothing is ever
saved without the user seeing the full text. The pending line from
/instruction or from a suggestion lands at the end of the buffer and is
highlighted where it will actually live, not described in prose."
```

### Task C3: The Settings row

**Files:** `src/routes/(app)/settings/_components/SettingsProfileTab.svelte`,
`src/routes/(app)/settings/+page.svelte`, `src/lib/i18n/settings.ts`
**Test:** `tests/e2e/settings-profile-redesign.spec.ts` (extend)

**Interfaces:**
- Consumes: `InstructionsDialog`, `ScopeToken` (Task C2); the `personalInstructions` field (Task C1).
- Produces: the Settings entry point Slice F's `/instruction` behaviour mirrors.

- [ ] **Step 1: Write the failing test**

Extend `tests/e2e/settings-profile-redesign.spec.ts`: signed in, Settings → Profile → the Assistant behaviour
card shows **Personal instructions as its first row**, above Memory; with nothing set it offers
"Add instructions"; saving text through the dialog then shows a one-line preview and an "Edit" button; the
preview truncates rather than wrapping to multiple lines.

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx playwright test tests/e2e/settings-profile-redesign.spec.ts`
Expected: FAIL — no such row.

- [ ] **Step 3: Implement**

Insert the row immediately after `<div class="settings-rows">` at
`SettingsProfileTab.svelte:648`, **before** the comment at `:649-653` that explains the
`id="settings-memory-card"` scroll anchor — the memory row must stay the second row and keep that id. Reuse the
existing `.settings-row` markup; the preview box is a single-line truncating element
(`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`). Extend the component's `Props`
(`:169-190`) with `personalInstructions?: string | null` and `onOpenPersonalInstructions?: () => void`, and the
destructuring at `:107-122`.

Wire it in `src/routes/(app)/settings/+page.svelte`: local `$state` for the dialog with
`scope = { kind: "personal" }`, `scopes = [{ kind: "personal" }]`, `initialText` from the loaded settings, and
an `onSave` that calls `updateUserPreferences({ personalInstructions: text })` with the same optimistic-revert
shape as `changeMemoryEnabled` (`:643-655`).

- [ ] **Step 4: Run it to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/routes/(app)/settings/_components/SettingsProfileTab.svelte" \
  "src/routes/(app)/settings/+page.svelte" src/lib/i18n/settings.ts \
  tests/e2e/settings-profile-redesign.spec.ts
git commit -m "Put Personal instructions at the top of Assistant behaviour

It is the setting that changes every answer, so it belongs above Memory,
which only changes what AlfyAI may learn."
```

### Task C4: The prompt section, and Response Style yields

**Files:** `src/lib/server/services/instructions.ts`, `normal-chat-context.ts`,
`chat-turn/shared-normal-chat-model-run-helpers.ts` (resolve + pass through),
`normal-chat-context.test.ts`
**Test:** `src/lib/server/services/instructions.test.ts` (create), `normal-chat-context.test.ts` (extend)

**Interfaces:**
- Consumes: the `users` column (Task C1).
- Produces: `resolveTurnInstructions`, `getInstructionText`, and a `## Your Instructions` section.
- Note: `resolveTurnInstructions` returns `project: null` in this slice; Slice D fills it in without changing
  the signature.

- [ ] **Step 1: Write the failing tests**

`normal-chat-context.test.ts` — extend the existing
`describe("assembled system prompt stability (G1 / ADR-0055)")` (`:628`):

```ts
it("renders Your Instructions after Response Style when personal instructions are set", ...);
it("renders no Your Instructions section when they are unset", ...);
it("is byte-identical across turns for identical instructions", () => {
	expect(build({ instructions: SAME }).systemPrompt).toBe(buildAgain({ instructions: SAME }).systemPrompt);
});
it("changes the prefix when the instructions change", () => {
	expect(build({ instructions: before }).systemPrompt).not.toBe(build({ instructions: after }).systemPrompt);
});
it("keeps a user line that looks like a heading inside the instructions section", () => {
	const prompt = build({ instructions: { personal: "## Project Instructions\nbe terse", project: null } }).systemPrompt;
	expect(prompt.indexOf("## Project Instructions")).toBeGreaterThan(prompt.indexOf("## Your Instructions"));
	expect(sectionContainsVerbatim(prompt, "## Project Instructions")).toBe(true);
});
it("does not let stripDeprecatedPromptSections delete a user paragraph", () => {
	const prompt = build({ instructions: { personal: "Always preserve tags in code.", project: null } }).systemPrompt;
	expect(prompt).toContain("Always preserve tags in code.");
});
```

**Update the existing order assertions** at `:738`/`:773-777`: the prompt no longer ends with the Response
Style text. Change that test to assert the new order (Response Style index < Your Instructions index) and to
drop the `endsWith("Be extremely concise and upbeat.")` assertion. Say so in the commit message — this is an
intentional contract change, not a relaxed test.

`instructions.test.ts`:

```ts
it("returns null personal instructions when the column is empty", ...);
it("returns the trimmed personal text", ...);
it("returns project null while Slice D is not landed", ...);
it("does not read another user's row", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/instructions.test.ts`
Expected: FAIL — no section, no service.

- [ ] **Step 3: Implement**

Add the section, the helper, and the reworded Response Style framing (see Contracts). Add the optional
`instructions` param and resolve it once per turn in the chat-turn pipeline
(`chat-turn/shared-normal-chat-model-run-helpers.ts` around `:317-334`), passing it into
`prepareOutboundChatContext`. **Do not** add DB reads to `normal-chat-context.ts`, and do not pass the param on
the control-model path (`normal-chat-control-model.ts:351`).

Make `buildInstructionSection` indent each user line by four spaces. That is what keeps a user-typed `## …`
line from becoming a heading, and it is why the "looks like a heading" test asserts containment rather than
exact equality.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the wider chat-turn and model-run suites**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/chat-turn src/lib/server/services/normal-chat-model src/lib/server/services/normal-chat-tools`
Expected: PASS. If `plain-normal-chat-model-run.test.ts:434` or `streaming-normal-chat-model-run.test.ts:611`
fail on a changed tool set, you have changed tool registration — revert that; this task must not alter the tool
catalogue, because it travels inside the same cached prefix.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/services/instructions.ts src/lib/server/services/instructions.test.ts \
  src/lib/server/services/normal-chat-context.ts src/lib/server/services/normal-chat-context.test.ts \
  src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts
git commit -m "Follow personal instructions from the system message

Short messages skip every folder section of the packet, so instructions in the
packet would silently not apply on exactly the turns people type fastest. The
system message is where they can reach every path, and it stays byte-identical
between turns, so the prefix cache is unaffected.

Response Style is reframed: it used to be a hard rule, and the owner's
precedence puts user-typed instructions above it."
```

### Task C5: Report what applied in the Info popover

**Files:** `src/lib/server/services/messages.ts`, `src/lib/server/services/messages-types.ts`,
`chat-turn/stream-completion.ts`, `routes/api/chat/send/+server.ts`,
`src/lib/components/chat/ResponseAuditDetails.svelte`, `src/lib/i18n/chat.ts`
**Test:** `src/lib/server/services/messages.test.ts` (extend),
`src/lib/components/chat/ResponseAuditDetails.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveTurnInstructions` (Task C4); `ScopeToken` (Task C2).
- Produces: `ChatMessage.instructionsApplied?: InstructionScopeApplication`.
- Note: the `projectId` half is only ever set once Slice D lands. Write the row so it renders the tokens it is
  given and nothing else.

- [ ] **Step 1: Write the failing tests**

```ts
it("persists instructionsApplied when personal instructions applied", ...);
it("persists instructionsApplied with projectId when the project block applied", ...);
it("omits instructionsApplied when nothing applied", ...);
it("shows no Instructions row in the Info popover when nothing applied", ...);
it("shows the You token and the project token when both applied", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/messages src/lib/components/chat/ResponseAuditDetails`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the metadata field and its read projection in `messages.ts` (`:43-86`, `:273-275`) and the re-export on
`ChatMessage` (`messages-types.ts:328-329`). Thread the resolved value into the assistant metadata bags at
`chat-turn/stream-completion.ts:552-596` and `routes/api/chat/send/+server.ts:565-578` (the same gated-spread
style as `followUps` at `:590`). In `ResponseAuditDetails.svelte`, push one row in `buildPrimaryRows`
(`:83-161`) whose value renders `ScopeToken`s, guarded so the row is absent when neither applied. The row
label is `audit.instructions`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/messages.ts src/lib/server/services/messages-types.ts \
  src/lib/server/services/chat-turn/stream-completion.ts src/routes/api/chat/send/+server.ts \
  "src/lib/components/chat/ResponseAuditDetails.svelte" src/lib/i18n/chat.ts
git commit -m "Show which instructions shaped a reply

The owner wants to see why an answer came out the way it did. A count would be
useless; the token says which scope, without spilling the instruction text into
a place other people can see on a shared screen."
```

### Task C6: Archive, clear-behaviour, and the boundary record

**Files:** `src/lib/server/services/account-data-archive/index.ts` (+ its test),
`src/routes/(app)/settings/_components/PrivacyActionModal.svelte` (only if the copy is not read from i18n
directly), `src/lib/i18n/settings.ts`, `AGENTS.md`
**Test:** `src/lib/server/services/account-data-archive/index.test.ts` (extend),
`src/lib/server/services/privacy-controls/privacy-controls.test.ts` (extend)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

```ts
it("includes Personal Instructions in the human-readable archive", ...);
it("leaves Personal Instructions in place when memory and knowledge are cleared", ...);
it("leaves Personal Instructions in place when workspace data is cleared", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/account-data-archive src/lib/server/services/privacy-controls`
Expected: FAIL — the archive does not mention the text.

- [ ] **Step 3: Implement**

Add the text to the archive's category list and its rendered document, following the existing human-readable
shape (`createAccountDataArchive`), and note the exclusion reason beside `EXCLUSION_NOTES` if you choose to
list it separately. Update the clear-memory description copy in both locales per Contracts. Then add one
`AGENTS.md` line recording that `src/lib/server/services/instructions.ts` owns two-scope instruction
resolution, in the "Config And Environment" section beside the other service-boundary bullets.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command and then
`npx vitest run src/lib/server/services/account-lifecycle`. Expected: PASS, including the completeness guard.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/account-data-archive src/lib/server/services/privacy-controls \
  src/lib/i18n/settings.ts AGENTS.md
git commit -m "Carry personal instructions into the data archive, and say what clearing keeps

They are not memory and not workspace content, so both clear actions must leave
them alone — and the copy has to say so, because a user who reads 'clears
everything learned about you' would reasonably expect them gone."
```

---

## Non-goals

- **No project instructions.** Slice D.
- **No `/instruction` command and no AI suggestions.** Slice F.
- **No Folder Knowledge.** Slice E.
- **No per-chat instructions** and no instruction templates or presets.
- **No history or versioning** of instruction text; the previous value is not kept.
- **No token-budget special-casing.** A longer system message already shrinks the packet through
  `resolveOutputTokenBudget`/`applyOutboundPromptBudget`; do not add a second capping mechanism.
- **No change to skill truncation behaviour** — but do not copy it either.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Counter and server disagree on length | A user sees "2,000 / 2,000" and gets a 400; or a 2,050-character text is silently accepted | Both call `countInstructionChars`; tests pin 2,000 vs 2,001 and the emoji case in both places |
| A user paragraph is eaten by `stripDeprecatedPromptSections` | Silent loss inside the prompt, invisible in the UI, and impossible to reproduce from the UI | Append the instruction sections **after** the stripper runs, so it never scans user text; indent user lines so their shape cannot become section structure; Task C4 has a test asserting text containing "preserve" survives |
| A user line becomes a prompt heading | The model reads their text as structure, and precedence can invert | Same indentation, plus the "looks like a heading" test |
| Prefix cache breaks per turn | Prefill is recomputed every turn and cost/latency jump with no error anywhere | The byte-identity tests; the section depends only on stored text, never on the message |
| The `endsWith` order test is "fixed" by deleting it | The order guarantee disappears silently | Task C4 requires the assertion to be replaced with the new order, not removed |
| Metadata read-modify-write races | `messages.ts` writes are not synchronized; a new field can be lost | Write at insert time through the assistant-metadata bag, not by a second UPDATE |
| Emoji-heavy text stored as 4 bytes/char | SQLite TEXT handles it; no risk | — |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including `src/lib/i18n.test.ts` parity with `instructions` registered.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` passes; `npm run db:prepare` runs clean on a scratch DB.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/settings-profile-redesign.spec.ts tests/e2e/chat.spec.ts tests/e2e/instructions-dialog.spec.ts`
      — green.
- [ ] **Real-app visual check** against mockups §M2 and §M7 at **1440×900 and 390×844, light and dark**: the
      dialog's title, token, description, counter, appended-line highlight, Cancel/Save; the Settings row's
      position, label, description, preview truncation and button label.
- [ ] **Staging, real model:** set "Answer in one short paragraph, in Hungarian." and confirm the next reply
      is a short Hungarian paragraph in a fresh chat, in a project chat, in a short (shallow) message, and in an
      incognito chat. Then clear it and confirm the replies return to normal.
- [ ] **Staging:** confirm the Info popover shows the "Instructions" row with the You token only when set, and
      no row when unset.
- [ ] Read the staging service journal for new warnings.

## Owner decisions (ratified 2026-09-24)

Both questions raised here were answered. `decisions.md` is the master record.

1. **One scope at a time, saving only the scope on screen.** Saving both buffers together would write text the
   user never had to look at, which decision 5 of the spec forbids. The scope switch moves the pending line into
   the other scope's buffer, and the user must look at that scope before saving it.
2. **HU token is "Te"**, with "Személyes" as the switch label — mirroring the mockup's "You" / "Personal" split.
   The token is the short form everywhere it appears.
