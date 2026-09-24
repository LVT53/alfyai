# Slice F — `/instruction` and AI instruction suggestions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice C** (`InstructionsDialog`, `ScopeToken`,
> `instructions.ts` namespace) **and Slice D** (`projects.instructions`, project mode, the resolution of the
> project scope).

**Goal:** Add `/instruction <text>`, which opens the instructions dialog with the text appended at the end and
the right scope preselected, and add a model-facing `suggest_instruction` tool whose offers appear as a slim row
under the reply with Review and Dismiss.

**Architecture:** The command is one entry in the existing composer-command catalog plus one case in the
composer's execute switch; the dialog already exists. The suggestion is a tool in `normal-chat-tools/index.ts`
with its usage rules in its own description (ADR-0055), persisted on the assistant message as
`instructionSuggestions` following the `skillDrafts` precedent — **same status-transition discipline, separate
status union**. The row is a presentational component under the reply.

**Tech Stack:** SvelteKit + Svelte 5 runes, Vercel AI SDK tools with Zod schemas, Drizzle on better-sqlite3,
Vitest, Playwright.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice F" (lines 299–327); mockups §M3 and §M4
(`…-workspaces-mockups.html`, sections 3 and 4).

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **The token is English in both locales.** `/instruction`, like `/remember`. Its labels are localized.
- **Works in incognito.** `/instruction` is explicit and the user sees the dialog before anything is saved.
- **The suggestion tool is not registered at all in incognito** — absent from the catalogue, not merely refused.
- **At most one suggestion per turn.**
- **Nothing is saved without the user seeing the full text**, so every suggestion is a row with Review, never an
  automatic write.
- Svelte 5 runes only; Lucide icons only; tokens only; EN + HU in the same commit.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/composer-command-v1.spec.ts tests/e2e/chat.spec.ts \
  tests/e2e/conversation.spec.ts tests/e2e/incognito-indicator.spec.ts \
  tests/e2e/instruction-suggestions.spec.ts
```

## Review Focus

1. **`/instruction` typed with no argument, and typed in incognito.** The missing-argument guard must fire
   before the token is consumed (so the user's text is not swallowed), and incognito must behave identically
   except that no suggestion ever appears (Task F1, Task F4).
2. **The suggestion row across a refresh and across a reopen.** Status lives in message metadata and must
   survive a reload in whatever state it was left; a reviewed suggestion must not reappear as pending
   (Task F3).
3. **A second `suggest_instruction` call in one turn.** It must be refused with a payload that tells the model to
   stop, and the message metadata must still hold exactly one suggestion (Task F2).
4. **The suggestion's scope when the chat has no project.** It must land on Personal, and the dialog must render
   **no scope switch** (Task F1, Task F3).
5. **The tool catalogue staying stable across turns of one conversation.** Gating the tool per turn would change
   the cached prefix; the tool must be registered or absent for the whole conversation (Task F2).

---

## Contracts

### Composer command

`src/lib/composer-commands.ts` — add `"instruction"` to `ComposerCommandId` (`:1-17`) and, to
`STATIC_COMPOSER_COMMANDS` (`:44-164`), an entry in the same shape as `/remember` (`:146-156`):

```ts
	{
		id: "instruction",
		token: "/instruction",
		labelKey: "composerCommands.instruction.label",
		descriptionKey: "composerCommands.instruction.description",
		availability: "available",
		argument: {
			placeholderKey: "composerCommands.instruction.argumentPlaceholder",
			required: true,
		},
	},
```

**The existing tests must be updated deliberately, not deleted** (`src/lib/composer-commands.test.ts`):

- `:24-32` asserts the argument-bearing ids are exactly `["document","remember"]` with `/remember` required. It
  becomes `["document","instruction","remember"]`, and both `/instruction` and `/remember` are required.
- `:36-43` asserts `placeholderKey` matches `/^composerCommands\.[a-z]+\.argumentPlaceholder$/` — satisfied by
  the key above.
- `:46-70` asserts every label/description/placeholder resolves in the EN **and** HU chat dictionary — satisfied
  by the keys below.

### Composer wiring

`src/lib/components/chat/MessageInput.svelte`:

- `COMMAND_IDS_WITH_ARGUMENT` (`:2149-2151`) is derived from the catalog, so `/instruction` is picked up
  automatically by `findActiveComposerCommandTokenWithArgument` (`composer-command-parser.ts:105-132`).
- Add a `case "instruction":` to the execute switch (`:2588-2633`). It must run the same missing-argument guard
  as `/remember` (`:2578-2581`) **before** `consumeActiveCommandToken()` (`:2583-2586`), then call a new
  callback prop:

```ts
	onInstructionCommand?: (text: string) => void;
```

  The component must **not** open the dialog itself: it emits, and the page that owns the composer owns the
  dialog. That keeps `MessageInput` free of cross-page orchestration, as AGENTS.md requires.

Callers to update: `src/lib/components/home/HomeSurface.svelte` (Slice D extracted the composer there) and the
chat route's `ChatComposerPanel.svelte`.

### Suggestion metadata

Declare in `src/lib/shared/instructions.ts` (already client-safe):

```ts
export type InstructionSuggestionStatus = "pending" | "reviewed" | "dismissed";

export interface InstructionSuggestion {
	id: string;
	status: InstructionSuggestionStatus;
	/** The offered text, exactly as the model wrote it. */
	text: string;
	/** The scope the offer targets. */
	scope: InstructionScope;
	createdAt: number;
}
```

`src/lib/server/services/messages.ts`:

- `PersistedMessageMetadata` (`:43-86`) gains `instructionSuggestions?: InstructionSuggestion[];`, re-exported
  onto `ChatMessage` the way `skillDrafts` is (`messages-types.ts:328-329`).
- The read projection gains the field beside `skillDrafts` (`messages.ts:273-275`) with an `Array.isArray` guard.
- A status-transition helper modelled on `updateAssistantMessageSkillDraftStatus` (`:794-884`):
  `updateAssistantMessageInstructionSuggestionStatus({ userId, conversationId, messageId, suggestionId, status })`.
  Same shape: SELECT `metadataJson` → `parseMetadata` → index-preserving `nextSuggestions` → `UPDATE` with
  `JSON.stringify`. Idempotent re-`reviewed` returns early; `dismissed` after `reviewed` is allowed;
  `reviewed` after `dismissed` throws a dedicated transition error mapped to `409`.
- **The write route mirrors the skill-draft route exactly.** Find it with
  `rg -n "updateAssistantMessageSkillDraftStatus" src/routes` and copy its auth, ownership and error mapping;
  the new route lives beside it with the same shape.

### The tool

`src/lib/server/services/normal-chat-tools/suggest-instruction.ts` (new module; the tool object itself is
registered in `index.ts` like every other tool):

```ts
export const suggestInstructionInputSchema = z.object({
	text: z.string().min(1).max(INSTRUCTIONS_MAX_CHARS),
	scope: z.enum(["personal", "project"]).optional(),
});
```

Registration in `index.ts` (`createNormalChatTools`, `:531`; tool object opens at `:624`) with a `TOOL_I18N`
entry (`:259-350` EN, `:351+` HU), a `TOOL_TIMEOUTS_MS` entry (`shared.ts:196-232`), and the shared envelope
`executeToolWithEnvelope` (`shared.ts:314-394`).

Server-enforced rules, in this order:

1. **Asked scope is clamped.** `scope === "project"` is only honoured when the conversation has a project;
   otherwise the suggestion's scope is Personal. The model never sees a project id.
2. **At most one suggestion per turn.** A closure counter beside the existing produce_file counters
   (`index.ts:539-548`); a second call returns a refusal payload that tells the model not to offer another one,
   following the `refuse(...)` shape at `:1357-1370`.
3. **The text is validated** with the shared limit before it is stored (`validateInstructionInput`).

Tool description (guidance lives here, ADR-0055 — quote this shape, then localize it):

> "Offer to add a standing instruction the user just stated — only when they said it as a rule for the future
> ('from now on…', 'always…', 'never…', or the Hungarian equivalents). Not for one-off requests. Call it once
> with the rule in the user's own words: {"text": "Only suggest trains, no flights.", "scope": "project"}. The
> user sees a row with Review and Dismiss; nothing is saved until they review it. Do not repeat the offer in
> prose."

**Where the "only when they said it as a rule" rule is enforced:** it is in the description, not in a gate.
The gate is registration in the catalogue, and the catalogue must not vary by turn — a turn-varying tool set
breaks the cached prompt prefix, which is why `shouldExposeFileProductionTools()` returns `true`
unconditionally (`normal-chat-tool-gating.ts:5-14`). This is Slice F's one deviation from a literal reading of
the spec; it is recorded in the open questions.

### Incognito gating

`src/lib/server/services/chat-turn/normal-chat-tool-gating.ts` — `selectNormalChatToolsForRequest` (`:17-46`)
gains an explicit `incognito: boolean` parameter and, when true, `delete selected.suggest_instruction`. Add a
comment stating why: an AI suggestion is a learning-shaped surface, and incognito's promise is that nothing is
learned.

The caller (`shared-normal-chat-model-run-helpers.ts:436-451`) resolves it with `isConversationIncognito`
(`memory-controls.ts:34-44`). **Do not fold it into `memoryActive`** — instructions apply in incognito, so the
two flags are different questions. The existing test "exposes the memory-recall tool regardless of incognito
(read side is not gated)" (`normal-chat-tool-gating.test.ts:29`) must stay green.

Because incognito is one-way for a conversation's whole life, this gate never changes mid-conversation, so the
prefix stays stable.

### New read for the dialog's other scope

`GET /api/projects/[id]` (new export beside the existing `PATCH`/`DELETE`): returns
`{ project: { id, name, instructions } }` after the ownership check. The dialog needs the project's current text
when the user switches scope; the shell payload deliberately does not carry it.

Client call goes in `src/lib/client/api/projects.ts` as `fetchProject(projectId)`.

### Suggestion row (§M4)

`src/lib/components/chat/InstructionSuggestionRow.svelte` (new):

```ts
interface Props {
	suggestion: InstructionSuggestion;
	onReview: (suggestion: InstructionSuggestion) => void;
	onDismiss: (suggestion: InstructionSuggestion) => void;
	/** True while the dismiss request is in flight. */
	dismissing?: boolean;
}
```

Markup: a slim bordered row — a pencil icon in the accent token, then
`{$t('instructions.suggestionPrefix')}` + `ScopeToken` + a middot + the quoted suggestion text, then a primary
`Review` and a text `Dismiss`. Rendered by `MessageArea.svelte` under the assistant reply, one row per pending
suggestion; `reviewed` and `dismissed` suggestions render nothing (the state is kept in metadata, the row is
not).

Review opens `InstructionsDialog` with `scope` = the suggestion's scope, `initialText` from the current saved
text of both scopes, `appendedLine` = the suggestion text, and `onSave` that saves the text **and then** marks
the suggestion reviewed (save first; if the save fails, the row stays pending).

### i18n

Composer keys in `src/lib/i18n/chat.ts` (the prefix and the shape are enforced by
`composer-commands.test.ts`), EN near `:486-494`, HU near `:1655-1663`:

| Key | EN | HU |
|---|---|---|
| `composerCommands.instruction.label` | `Instruction` | `Utasítás` |
| `composerCommands.instruction.description` | `Write a standing instruction` | `Állandó utasítás írása` |
| `composerCommands.instruction.argumentPlaceholder` | `What should always apply?` | `Mi érvényes mindig?` |
| `composerCommands.instruction.missingArgument` | `Write the instruction after /instruction.` | `Írd le az utasítást az /instruction után.` |

Suggestion-row keys in `src/lib/i18n/instructions.ts`:

| Key | EN | HU |
|---|---|---|
| `instructions.suggestionPrefix` | `Add to instructions for` | `Hozzáadás az utasításokhoz:` |
| `instructions.suggestionReview` | `Review` | `Áttekintés` |
| `instructions.suggestionDismiss` | `Dismiss` | `Elvetés` |
| `instructions.suggestionA11y` | `Add to instructions for {scope}: {text}` | `Hozzáadás az utasításokhoz ({scope}): {text}` |
| `instructions.suggestionDismissFailed` | `Could not dismiss the suggestion.` | `Nem sikerült elvetni a javaslatot.` |
| `instructions.suggestionReviewFailed` | `Could not save the instructions.` | `Nem sikerült menteni az utasításokat.` |

(`instructions.commandLabel` etc. are **not** used: the catalog requires `composerCommands.<id>.*` keys.)

---

## File ownership

| File | Change |
|---|---|
| `src/lib/shared/instructions.ts` | the suggestion types |
| `src/lib/composer-commands.ts` + test | the command, and the two updated assertions |
| `src/lib/components/chat/MessageInput.svelte` | the execute case and the callback prop |
| `src/lib/components/chat/ChatComposerPanel.svelte` | pass the callback through |
| `src/lib/components/home/HomeSurface.svelte` | own the dialog for the landing composer |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | own the dialog, resolve the scope, wire the row |
| `src/lib/components/chat/MessageArea.svelte` | render the row |
| `src/lib/components/chat/InstructionSuggestionRow.svelte` + test | create |
| `src/lib/server/services/normal-chat-tools/suggest-instruction.ts`, `index.ts` + tests | the tool |
| `src/lib/server/services/chat-turn/normal-chat-tool-gating.ts` + test | the incognito gate |
| `src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts` | resolve `incognito` |
| `src/lib/server/services/messages.ts`, `messages-types.ts` + test | the metadata field and the transition helper |
| `src/routes/api/conversations/[id]/instruction-suggestions/+server.ts` | the status route |
| `src/routes/api/projects/[id]/+server.ts` | `GET` |
| `src/lib/client/api/projects.ts` | `fetchProject` |
| `src/lib/i18n/chat.ts`, `src/lib/i18n/instructions.ts` | keys |
| `tests/e2e/instruction-suggestions.spec.ts`, `tests/e2e/composer-command-v1.spec.ts` | create / extend |

**Serialisation:** `src/lib/i18n/chat.ts` is shared with Slice G — land G's deletions first. `MessageArea.svelte`
was edited by Slice A; A must be merged before this slice starts.

---

## Tasks

### Task F1: The `/instruction` command

**Files:** `composer-commands.ts` + test, `MessageInput.svelte`, `ChatComposerPanel.svelte`,
`HomeSurface.svelte`, chat page, `src/lib/i18n/chat.ts`, `tests/e2e/composer-command-v1.spec.ts`
**Test:** the catalog test, the composer E2E, and a new dialog-opening test

**Interfaces:**
- Consumes: `InstructionsDialog`, `fetchProject`, `GET /api/settings` for the personal text.
- Produces: `onInstructionCommand(text: string)` out of `MessageInput`.

- [ ] **Step 1: Write the failing tests**

`composer-commands.test.ts` (update the two assertions as described in Contracts, then add):

```ts
it("registers /instruction as an argument-bearing command available everywhere", () => {
	const command = STATIC_COMPOSER_COMMANDS.find((entry) => entry.id === "instruction");
	expect(command?.token).toBe("/instruction");
	expect(command?.argument?.required).toBe(true);
	expect(command?.availability).toBe("available");
});
```

E2E (`tests/e2e/composer-command-v1.spec.ts` extended, or a new
`tests/e2e/instruction-command.spec.ts`):

```
it("opens the instructions dialog with the argument appended at the end", ...);
it("defaults to Personal with no scope switch outside a project", ...);
it("defaults to the project with a switch inside a project", ...);
it("keeps the typed text in the composer when the argument is missing", ...);
it("works in an incognito conversation", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/composer-commands.test.ts
npx playwright test tests/e2e/composer-command-v1.spec.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the catalog entry, the execute case with the guard before `consumeActiveCommandToken()`, the callback prop
and its wiring in both composer hosts, the four EN/HU keys, and the page-side dialog opening: resolve the scope
from `data.conversation?.projectId`, load the current text for the scopes the dialog will show, and pass
`appendedLine` with `appendedScope` set to the default scope.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/composer-commands.ts src/lib/composer-commands.test.ts \
  src/lib/components/chat/MessageInput.svelte src/lib/components/chat/ChatComposerPanel.svelte \
  src/lib/components/home/HomeSurface.svelte "src/routes/(app)/chat/[conversationId]/+page.svelte" \
  src/lib/i18n/chat.ts tests/e2e
git commit -m "Add /instruction, which opens the one dialog with the text appended

The token is English in both locales like /remember, and the command only
emits: the page owns the dialog, so MessageInput stays free of cross-page
orchestration. The argument guard runs before the token is consumed, so a bare
/instruction does not eat what the user typed next."
```

### Task F2: The `suggest_instruction` tool

**Files:** `normal-chat-tools/suggest-instruction.ts`, `index.ts` + `index.test.ts`,
`normal-chat-tool-gating.ts` + test, `shared-normal-chat-model-run-helpers.ts`, `messages.ts` + test,
`shared/instructions.ts`
**Test:** `index.test.ts` (tool behaviours + registration), `normal-chat-tool-gating.test.ts`,
`messages.test.ts`

**Interfaces:**
- Consumes: `INSTRUCTIONS_MAX_CHARS`, `validateInstructionInput`.
- Produces: `InstructionSuggestion[]` on the assistant message metadata; refusal payloads.

- [ ] **Step 1: Write the failing tests**

Follow the existing per-tool pattern (`index.test.ts:385-410`): build the tool set with
`createNormalChatTools({...})`, call `execute` with a hand-made options object, assert the `modelPayload` and the
recorded entries from `getToolCalls()`.

```ts
it("offers a suggestion and records it as pending", ...);
it("clamps a project scope to personal when the chat has no project", ...);
it("refuses a second suggestion in the same turn", ...);
it("rejects text over the instruction limit without storing it", ...);
it("is present in the catalogue for an ordinary turn", () => {
	expect(tools).toHaveProperty("suggest_instruction");
});
it("is absent from the catalogue in an incognito conversation", () => {
	expect(selectNormalChatToolsForRequest(tools, { ..., incognito: true })).not.toHaveProperty("suggest_instruction");
});
it("still exposes memory_context in incognito", ...);   // the existing guarantee
it("adds both the en and hu description", ...);          // src/lib/i18n.test.ts:82-83 shape
it("keeps the whole catalogue inside its prompt token budget", ...);  // index.test.ts:4662
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/normal-chat-tools src/lib/server/services/chat-turn/normal-chat-tool-gating.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the module, register the tool and the `TOOL_I18N` entries, add the closure counter, add the `incognito`
parameter to the gating function and resolve it at the call site, and add the metadata field, projection and
transition helper in `messages.ts`. Keep `TOOL_TIMEOUTS_MS` in the same place as its neighbours.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then
`npx vitest run src/lib/server/services/normal-chat-tools src/lib/server/services/chat-turn src/lib/server/services/normal-chat-model`.
Expected: PASS, including the catalogue token-ceiling test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/instructions.ts src/lib/server/services/normal-chat-tools \
  src/lib/server/services/chat-turn src/lib/server/services/messages.ts \
  src/lib/server/services/messages-types.ts
git commit -m "Offer to remember a standing instruction the user just stated

The tool is registered for the whole conversation rather than gated per turn:
the catalogue renders inside the cached prompt prefix, and a turn-varying tool
set is exactly what shouldExposeFileProductionTools() exists to prevent. What
the tool does offer is gated instead — absent in incognito, once per turn, and
with the project scope only when there is a project."
```

### Task F3: The suggestion row, Review and Dismiss

**Files:** `InstructionSuggestionRow.svelte` + test, `MessageArea.svelte`, chat page,
`routes/api/conversations/[id]/instruction-suggestions/+server.ts`, `src/lib/i18n/instructions.ts`,
`tests/e2e/instruction-suggestions.spec.ts` (create)
**Test:** the component test, the route test, the E2E

**Interfaces:**
- Consumes: `updateAssistantMessageInstructionSuggestionStatus`, `InstructionsDialog`.
- Produces: a persisted, refresh-surviving row state.

- [ ] **Step 1: Write the failing tests**

```ts
// component
it("renders the scope token and the quoted text", ...);
it("calls onReview when Review is pressed", ...);
it("calls onDismiss when Dismiss is pressed", ...);
it("disables Dismiss while the request is in flight", ...);

// route
it("marks a pending suggestion reviewed", ...);
it("is idempotent when the same status is written twice", ...);
it("409s a reviewed suggestion being set back to dismissed", ...);
it("404s a message in another user's conversation", ...);

// e2e
it("keeps a dismissed suggestion dismissed after a reload", ...);
it("keeps a reviewed suggestion reviewed after a reload", ...);
it("shows no suggestion row in an incognito conversation", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/components/chat/InstructionSuggestionRow.test.ts src/routes/api/conversations`
Expected: FAIL.

- [ ] **Step 3: Implement**

Build the component per Contracts, render it from `MessageArea.svelte` under the reply, add the status route by
copying the skill-draft route's auth/ownership/error shape, and wire the chat page's Review handler: open the
dialog prefilled, save, then mark reviewed (and leave the row pending if the save fails).

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then
`npx playwright test tests/e2e/instruction-suggestions.spec.ts tests/e2e/chat.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/chat src/routes/api/conversations src/lib/i18n/instructions.ts \
  tests/e2e/instruction-suggestions.spec.ts
git commit -m "Show instruction offers under the reply, with Review and Dismiss

Review opens the same dialog as /instruction rather than saving anything, which
is the whole point: a suggestion the user never read is a suggestion nobody
agreed to. The state lives on the message, so a refresh keeps it."
```

### Task F4: Incognito and archive coverage

**Files:** `tests/cross-cutting/incognito-conversation-containment.test.ts`,
`src/lib/server/services/account-data-archive/index.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

```ts
it("never registers the instruction-suggestion tool in an incognito conversation", ...);
it("never writes an instruction suggestion into an incognito conversation", ...);
it("carries suggestion rows into the archive with the messages they belong to", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run tests/cross-cutting src/lib/server/services/account-data-archive`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

The incognito guarantee should already hold from Task F2; if the test fails, the gate is wrong — fix the gate,
not the test. For the archive, the suggestions ride on message metadata, so the assertion is that they arrive;
if the archive's message rendering drops metadata, extend it.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/cross-cutting src/lib/server/services/account-data-archive
git commit -m "Pin the incognito guarantee for instruction suggestions

An offer to remember something is a learning surface, and incognito's promise is
that nothing is learned. The tool is absent from the catalogue there, so the
model cannot offer one at all."
```

---

## Non-goals

- **No automatic saving of a suggestion.** Review is the only path, always.
- **No suggestions outside Normal Chat** (no Atlas, no skills, no memory judge).
- **No per-suggestion editing** beyond what the dialog already allows.
- **No changes to `/remember`** or to the skill-draft metadata.
- **No new tool-gating vocabulary** beyond the one `incognito` parameter.
- **No reordering of the composer tray**, beyond the new command appearing where the catalog puts it
  (`COMPOSER_COMMAND_VISIBLE_RESULT_LIMIT = 7` still applies).

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The bare `/instruction` swallows the user's next text | The token is consumed before the guard, and the text is gone | The guard runs before `consumeActiveCommandToken()`; an E2E test pins it |
| A turn-varying tool set breaks the cached prefix | Cost and latency silently rise on every turn, and the stability tests fail | The tool is registered per conversation, not per turn; the catalogue ceiling test must stay green |
| The status write races the metadata's other writers | `messages.ts` updates are read-modify-write and unsynchronized | Reuse the skill-draft helper's exact shape, which already handles this; write the suggestion at insert time in the metadata bag, never as a second UPDATE in the same turn |
| A reviewed suggestion comes back as pending | The user is asked twice for the same thing | Status is persisted, and the E2E test reloads |
| The Review save half-fails | The instruction is not saved but the row says reviewed | Save first, mark second; a failed save leaves the row pending |
| The project scope is named by the model without a project | The token points at nothing, or worse, at another project | The server clamps: the scope is Personal unless the conversation's own project matches |
| Reusing `SkillDraftStatus` | The two features' status machines drift together | A separate union, declared beside the other instruction types |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including `src/lib/i18n.test.ts` and the tool catalogue token ceiling.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/composer-command-v1.spec.ts tests/e2e/instruction-suggestions.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/incognito-indicator.spec.ts`
      — green.
- [ ] **Real-app visual check** against mockups §M3 and §M4 at **1440×900 and 390×844, light and dark**: the
      dialog with the appended line highlighted, the scope switch only in a project, the suggestion row's
      pencil accent, tokens, quote, Review and Dismiss; the row wraps rather than overflowing on the phone.
- [ ] **Staging, real model:** type "From now on, only suggest trains. We don't fly." → exactly **one** suggestion
      row appears; press **Dismiss**; reload → still dismissed. Say the same thing again in a **new** turn →
      Review → confirm the dialog is prefilled with the line highlighted, save, then reload → the row reads
      reviewed and the next answer obeys the rule.
- [ ] **Staging:** the same sentence in an **incognito** chat produces no row at all.
- [ ] Read the staging service journal for new warnings.

## Owner decisions (ratified 2026-09-24)

All three questions raised here were answered. `decisions.md` is the master record.

1. **The tool stays registered for the whole conversation, not gated per turn.** A per-turn gate would vary the
   tool catalogue inside the cached prompt prefix — the exact failure
   `shouldExposeFileProductionTools()` exists to prevent — and a language-dependent accept gate would
   reintroduce what ADR-0055 deleted. The rule lives in the tool description; the server enforces absence in
   incognito, one offer per turn, and a clamped scope. The catalogue cost is one small schema, paid per turn
   because the Flash-Next prefix cache gives zero hits.
   **Named fallback:** if staging shows offers on ordinary turns, add an accept filter inside the tool's
   `execute` body — that leaves the catalogue untouched. Any fix that varies the catalogue per turn is out of
   bounds and comes back to the owner.
2. **`Dismiss` stays permanent, with no suppression.** A later explicit "from now on" is new evidence and
   deserves a new offer.
3. **The row shows only the scope token and the quote.** It sits under its own reply, so position is the
   reference.
