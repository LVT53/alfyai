# Slice A — Remove "Manage context sources" and the dead Context Sources projection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the "Manage context sources" surface (the context-ring popover button and its `EvidenceManager`
side panel, with its per-source Auto/Pinned/Excluded steering) and the Context Sources projection, everywhere,
keeping the `/document` and `/source` linked-sources plumbing and the context ring's compaction indicator.

**Architecture:** This is a **net deletion**. Nothing replaces what goes away. Three independent dead-or-deadly
paths are removed: (1) the panel and its prop chains, (2) the task-steering write/read path plus the user pins
and exclusions already stored in `task_state_evidence_links`, and (3) the Context Sources projection, which the
stream path already computed and discarded. The `task_state_evidence_links` **table stays**; only user
`pinned`/`excluded` rows are deleted.

**Tech Stack:** SvelteKit, Svelte 5 runes, Drizzle on better-sqlite3, Vitest, Playwright, Biome, Fallow.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md` §"Slice A" (lines 68–113). The inventory in
"Verified removal map" below re-verifies that list against the current tree and adds what it missed; where the
two disagree, **this document wins**.

## Global Constraints

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- **Svelte 5 runes only** in touched files. Removing a prop is a Svelte-5 contract change: update
  `$props()` destructuring, not a legacy export.
- **Icons:** Lucide via `@lucide/svelte` only.
- **Tokens only** from `src/app.css`; no hard-coded hex.
- **Schema changes** need a Drizzle migration plus a `_journal.json` entry; `npm run check:migrations` must
  pass. Slice A adds **one data-only migration and no DDL**.
- **No broad Fallow ignores.** Deleting code must remove its findings, not silence them.
- **No revival of deleted files.** If a file named `EvidenceManager.svelte` reappears as an untracked leftover
  after a merge, verify git history before restoring anything.
- **Commits:** small, focused, explaining the *why*; stage by explicit path; never bare `git stash`. End every
  message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- **Never push, never deploy** without the owner's explicit go-ahead.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check                     # 0 errors, 0 warnings
npx biome check src scripts tests
npm test
npm run build                     # 0 warnings
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

## Review Focus

1. **Deleting a prop that a parent still passes.** Svelte 5 does not error on an unknown prop at runtime in
   every case, so `npm run check` is the only thing that catches this. Every removal below names both the
   component and its callers (Tasks A1–A3).
2. **The user's existing pins and exclusions surviving the migration.** After the DELETE, the read side must
   not keep filtering on rows that can never exist again — a silently always-empty filter is a defect even
   though it is invisible (Task A2).
3. **Over-deletion of the shared linked-sources plumbing.** `/document` and `/source` depend on it; deleting
   one import too many breaks a feature nobody in this slice touches (Task A1's Keep list, and the guard test
   in Task A4).
4. **A test that only asserted the old panel** must be deleted, not rewritten to assert nothing. A test that
   asserted *shared* behaviour (e.g. the compaction indicator) must survive with its shared assertions intact
   (Task A5).
5. **The compaction indicator disappearing.** The owner explicitly wants it kept. It reads
   `contextStatus.compactionMode`; the only thing to drop is the `contextSources?.compacted` fallback and the
   `contextDebug?.compactionMode` chain must be kept (Task A1).

---

## Verified removal map

Verified against the tree on 2026-09-24. Line numbers are starting anchors, not exact ranges.

### Delete — files

| File | Why | Referenced by |
|---|---|---|
| `src/lib/components/chat/EvidenceManager.svelte` | the panel | chat page `:71,2495-2501,2757,2819-2825` |
| `src/lib/components/chat/EvidenceManager.test.ts` | tests only the panel | — |
| `src/lib/components/chat/EvidencePreferenceControl.svelte` | used only by `EvidenceManager.svelte:2,219,278,310` | `MessageEvidenceDetails.test.ts:482` (stale comment only) |
| `src/routes/api/conversations/[id]/task-steering/+server.ts` | the steering endpoint | `src/routes/AGENTS.md:29,62`; `src/lib/client/api/conversations.ts` |
| `src/lib/server/services/chat-turn/context-sources.ts` | projection builder | `finalize.ts:35`, `conversation-detail/read-model.ts:4` |
| `src/lib/server/services/chat-turn/context-sources.test.ts` | tests only that builder | — |

### Delete — symbols

| Location | Symbol |
|---|---|
| `src/lib/client/api/conversations.ts:15,47-50,443-458` | `TaskSteeringPayload` import, `TaskSteeringResponse`, `applyTaskSteering` |
| `src/lib/server/services/task-state.ts:1447-1542` | `upsertEvidenceRole` |
| `src/lib/server/services/task-state.ts:1544-1636` | `applyTaskSteeringAction` |
| `src/lib/server/services/task-state/types.ts:23,74-82,84-89` | `EvidencePreference`, `TaskSteeringAction`, `TaskSteeringPayload` |
| `src/lib/server/services/knowledge/context-types.ts:54-103` | `ContextSourceGroupKind`, `ContextSourceItemState`, `ContextSourceItem`, `ContextSourceGroup`, `ContextSourcesState` |
| `src/lib/server/services/conversation-detail/types.ts:23,44` | `ConversationDetail.contextSources` |
| `src/lib/services/streaming.ts:86-88,311-313` | the `contextSources` type field and its stream parse |
| `src/lib/client/normal-chat-client-turn-runtime.ts:560` | `contextSources` in `isReceiptOnlyCompletionMetadata` |
| `src/routes/api/chat/send/+server.ts:287,303,391,613` | `contextSources` in the send response |

### Edit — component props and wiring

| Location | Change |
|---|---|
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | remove `onManageEvidence`/`evidenceManagerOpen` state and the panel block; remove the `contextSources` state, the response parse and the `contextDebug` pass-through to `ChatMessagePane` (`:2714`) |
| `src/routes/(app)/chat/[conversationId]/+page.ts:85` | drop `contextSources` from the load payload |
| `ChatComposerPanel.svelte` | remove the `onManageEvidence` / `contextSources` props |
| `src/lib/components/chat/MessageInput.svelte:151,267,3686` | remove the `ContextSourcesState` import, the `contextSources` prop and its pass-through; `:1120-1128 hasContextToShow` loses its three `contextSources?.` terms |
| `src/lib/components/chat/ContextUsageRing.svelte` | delete `formatSourceState()` (`:115-119`), the `contextSources?.x ?? contextDebug?.y` fallbacks (`:162-170`), the `contextSources` reads in `toneClass` (`:174,177`) and `isNearTrigger` (`:193-194`), the manage button and the Pinned/Excluded/"Source state" rows. **Keep** everything that reads `contextStatus.compactionMode`, and keep the `contextDebug` fallback chain |
| `ChatMessagePane.svelte:15,38,71,125,23,56,111` | remove the `onSteer` chain and `contextDebug` (dead after A1) |
| `MessageArea.svelte:31,55,97,771,42,80` | remove `onSteer`; remove `contextDebug` and the `pinnedArtifactIds`/`excludedArtifactIds` derivations at `:423-428`, `:758-759` |
| `MessageBubble.svelte:73,91,132,78-79,107-108` | remove `onSteer`; remove the never-read `pinnedArtifactIds`/`excludedArtifactIds` props |
| `src/lib/server/services/chat-turn/finalize.ts` | remove `:24` type import, `:190` result field, `:195-205` params type members, `:207-215 buildEmptyCompletionContextSources`, `:217-239 buildChatTurnCompletionContextSources`, `:588`, `:698-709`, `:714-731`, `:748`, `:831-834`, `:860`; remove the `getProjectReferenceContext` import at `:34` **only after confirming line 220 is its last user** |
| `src/lib/server/services/conversation-detail/read-model.ts` | remove `:106`, `:165-174`, `:182`, and the two fetches that exist only to feed the projection: `:140-142 listConversationLinkedContextSources` and `:155 getProjectReferenceContext`. **Keep** `listConversationArtifacts`, `getConversationWorkingSet`, `getContextDebugState`, `getConversationContextStatus` — they are returned in the payload |
| `src/lib/server/services/task-state.ts:1190-1199,1207-1210,1247-1249,1366-1367` | the pinned/excluded read side, which becomes permanently empty |
| `src/lib/server/services/chat-turn/context-selection.ts:1701-1702,1708,1985,2084` | the consumers of that read side |

### Added by this inventory (not in the spec's list)

1. `MessageArea.svelte`'s `contextDebug` prop and the `pinnedArtifactIds`/`excludedArtifactIds` derivations are
   a **second dead chain**: `MessageBubble` declares those two props and never reads them.
2. `ChatMessagePane.svelte`'s `contextDebug` prop, and its pass-through from the chat page.
3. `MessageInput.svelte`'s `contextSources` prop and its `hasContextToShow` terms.
4. `ContextUsageRing.svelte` has **four** more `contextSources` reads than the spec's "button and rows".
5. `src/lib/components/AGENTS.md:32,73` also documents `EvidenceManager`.
6. `AGENTS.md:516,529` mention "steering" in the client-API boundary lines.
7. `tests/cross-cutting/incognito-conversation-containment.test.ts:542-543` allow-lists
   `services/home-suggestions.ts` — **not** touched by Slice A, listed here only so Slice G's agent does not
   confuse the two.

### Keep — proven live

| Symbol | Evidence it must stay |
|---|---|
| `src/lib/server/services/linked-context-sources.ts` | 19 importers, incl. `chat-turn/preflight.ts:409`, `context-selection.ts`, `stream-completion.ts`, `routes/api/conversations/[id]/linked-sources/+server.ts` |
| `artifact_links` with `linkType:"linked_context_source"` | writer `linked-context-sources.ts:134`; reader `context-selection.ts:600`; `routes/api/chat/send/+server.ts:446` |
| `LinkedDocumentPicker.svelte`, `LinkedSourceManager.svelte` | imported by `MessageInput.svelte`; `linkedSources.*` i18n keys |
| `linkedSources.*` i18n (EN+HU) | those two components |
| `getContextDebugState` / `contextDebug` | `finalize-steps.ts:227`, `context-selection.ts:2132`, `stream-orchestrator.ts:1248`, `read-model.ts:184`, `chat/send/+server.ts:616`, chat page, `ContextUsageRing:314-331` |
| `contextStatus` / `ConversationContextStatus` | `routes/api/conversations/[id]/context-status/+server.ts`, `ContextUsageRing` compaction indicator, `MessageInput`, chat page |

### Migration

> **Shipped as `1777140000106_retire_user_evidence_preferences.sql`.** The plan guessed `…105`, but `…105` was
> already taken by `recency_backfill_last_message_time`. Taking the next free number shifted every later slice by
> one, and their documents were renumbered to match: **C `…107`, D `…108`, G `…109`, E `…110`.** All slices
> after A must take the next free journal number, not the number printed in their document, and say so in the
> commit if it differs.

New file `drizzle/1777140000106_retire_user_evidence_preferences.sql` (the journal's last entry was
`1777140000105`, `_journal.json` idx 118; take the number from `npx drizzle-kit generate` if it differs):

```sql
DELETE FROM task_state_evidence_links WHERE role IN ('pinned','excluded') AND origin='user';
```

Add the matching `_journal.json` entry. **The table itself stays.** It must remain listed in
`scripts/prepare-db.ts:48` and `src/lib/server/services/account-lifecycle/user-scoped-tables.ts:114`.

---

## File ownership

**Exclusive to Slice A.** No other slice touches any of these files. Slice A can run in parallel with Slice B
(the Parallel allowance) — the file sets are disjoint.

If Slice A runs concurrently with a later slice, the only shared file is `src/routes/(app)/chat/[conversationId]/+page.svelte`;
later slices must not be started while A is in flight.

---

## Tasks

### Task A1: Remove the panel surface and its prop chains (client)

**Files:**
- Delete: `src/lib/components/chat/EvidenceManager.svelte`, `EvidenceManager.test.ts`,
  `EvidencePreferenceControl.svelte`
- Modify: chat page `+page.svelte`, `+page.ts`, `ChatComposerPanel.svelte`, `MessageInput.svelte`,
  `ContextUsageRing.svelte`, `ChatMessagePane.svelte`, `MessageArea.svelte`, `MessageBubble.svelte`
- Modify: `src/lib/i18n/chat.ts` (remove `contextSources.*` EN `:557-586` / HU `:1732-1761`, and
  `contextUsageRing.manageEvidence` EN `:609` / HU `:1784`)
- Modify: `src/lib/components/chat/ContextUsageRing.cost.test.ts`
- Test: `src/lib/components/chat/ContextUsageRing.cost.test.ts`, plus a new guard test (Task A4)

**Interfaces:**
- Produces: `ContextUsageRing` with no `contextSources` prop; `MessageArea`/`MessageBubble`/`ChatMessagePane`
  with no `onSteer`; `MessageInput` with no `contextSources` prop.
- Consumes: nothing.

- [ ] **Step 1: Write the failing guard test**

Create `src/lib/components/chat/context-sources-removal.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REMOVED_SYMBOLS = [
	"EvidenceManager",
	"EvidencePreferenceControl",
	"applyTaskSteering",
	"TaskSteeringAction",
	"contextSources",
	"contextUsageRing.manageEvidence",
];

const FILES = [
	"src/routes/(app)/chat/[conversationId]/+page.svelte",
	"src/lib/components/chat/MessageInput.svelte",
	"src/lib/components/chat/MessageArea.svelte",
	"src/lib/components/chat/MessageBubble.svelte",
	"src/lib/components/chat/ChatMessagePane.svelte",
	"src/lib/components/chat/ContextUsageRing.svelte",
];

describe("Manage context sources removal", () => {
	it.each(FILES)("keeps %s free of removed symbols", (file) => {
		const source = readFileSync(file, "utf8");
		for (const symbol of REMOVED_SYMBOLS) {
			expect(source, `${file} still mentions ${symbol}`).not.toContain(symbol);
		}
	});

	it("keeps the compaction indicator, which reads contextStatus", () => {
		const ring = readFileSync("src/lib/components/chat/ContextUsageRing.svelte", "utf8");
		expect(ring).toContain("contextStatus");
		expect(ring).toContain("compaction");
	});

	it("keeps the shared linked-source plumbing whole", () => {
		// The Keep table in this document, checked by existence and by one live consumer each.
		for (const file of [
			"src/lib/server/services/linked-context-sources.ts",
			"src/lib/components/chat/LinkedDocumentPicker.svelte",
			"src/lib/components/chat/LinkedSourceManager.svelte",
		]) {
			expect(() => readFileSync(file, "utf8"), `${file} was deleted`).not.toThrow();
		}
		const preflight = readFileSync("src/lib/server/services/chat-turn/preflight.ts", "utf8");
		expect(preflight).toContain("linked-context-sources");
		expect(readFileSync("src/lib/client/api/conversations.ts", "utf8")).not.toContain("applyTaskSteering");
	});
});
```

Adjust the kept-symbol substrings per file once written — the point is a test that fails now and stays green
afterwards.

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/components/chat/context-sources-removal.test.ts`
Expected: FAIL — the removed symbols are still present.

- [ ] **Step 3: Delete the files and edit the prop chains**

Delete the three component files. Then, in dependency order (children first so `npm run check` stays as clean
as possible between edits): `MessageBubble` → `MessageArea` → `ChatMessagePane` → `ContextUsageRing` →
`MessageInput` → `ChatComposerPanel` → chat page → `+page.ts`.

**Do not** remove `contextDebug` from `ContextUsageRing`'s compaction path, and **do not** remove
`getContextDebugState` from any server caller. Only the `contextSources` half goes.

- [ ] **Step 4: Run the guard test and the typecheck**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/chat/context-sources-removal.test.ts
npm run check
```
Expected: guard PASS; `npm run check` reports **only** the diagnostics caused by the not-yet-removed
`contextSources` server payload (Task A3) — record the exact count in the report. If it reports unknown props
on a component, a caller was missed: fix it before committing.

- [ ] **Step 5: Fix `ContextUsageRing.cost.test.ts`**

Delete the whole test `"opens context source management…"` (`:55-67`), the `onManageEvidence` render default
(`:21,52`), the test `"uses contextSources for source counts…"` (`:126-178`), and the sources stat row
assertion (`:380-383`). Keep every test that asserts the compaction indicator and the cost display.

- [ ] **Step 6: Run the affected component suites**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/components/chat`
Expected: PASS. If `MessageArea.test.ts` fails on its ~25 `contextDebug: null` fixtures, remove the now-unknown
prop from those fixtures.

- [ ] **Step 7: Commit**

```bash
git add -A src/lib/components/chat src/routes/\(app\)/chat src/lib/i18n/chat.ts
git commit -m "Remove the Manage context sources surface

The owner has never opened it, and its per-source Auto/Pinned/Excluded
steering never fed the answer: the pinned/excluded ids reached MessageBubble
as props nothing read. Deleting it also deletes 58 i18n key-lines and two
dead prop chains (onSteer and contextDebug) that existed only to carry it.

The context ring keeps its compaction indicator, which the owner wants and
which reads contextStatus, not the removed panel."
```

### Task A2: Remove the steering path and delete the stored user preferences

**Files:**
- Delete: `src/routes/api/conversations/[id]/task-steering/+server.ts`
- Modify: `src/lib/client/api/conversations.ts`, `src/lib/server/services/task-state.ts`,
  `src/lib/server/services/task-state/types.ts`,
  `src/lib/server/services/chat-turn/context-selection.ts`
- Create: `drizzle/1777140000105_retire_user_evidence_preferences.sql`,
  `drizzle/meta/_journal.json` entry
- Test: `src/lib/server/services/task-state.test.ts`, `src/lib/server/services/task-state-learning.test.ts`,
  and a new migration assertion

**Interfaces:**
- Consumes: Task A1's removal of the client caller.
- Produces: no steering endpoint; `task_state_evidence_links` with no user `pinned`/`excluded` rows.

- [ ] **Step 1: Write the failing test**

Add to the task-state suite a behaviour test:

```ts
it("no longer resolves user-pinned or user-excluded evidence", async () => {
	// a pre-existing row of role 'pinned', origin 'user' must not survive the migration,
	// and the selection result must not read one even if it is inserted directly.
	await seedEvidenceLink({ role: "pinned", origin: "user", artifactId });
	const selection = await selectTaskEvidenceForTurn({ userId, conversationId });
	expect(selection.pinnedArtifactIds ?? []).toEqual([]);
});
```

And a migration test asserting the migration's content, following whatever pattern the existing
migration-script tests use in this repo:

```ts
it("deletes only user-origin pinned and excluded links", async () => {
	await seedEvidenceLink({ role: "pinned", origin: "user" });
	await seedEvidenceLink({ role: "pinned", origin: "system" });
	await seedEvidenceLink({ role: "selected", origin: "system" });
	await runMigration("1777140000105_retire_user_evidence_preferences");
	expect(await rolesFor(origin("user"))).toEqual([]);
	expect(await countEvidenceLinks()).toBe(2);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/lib/server/services/task-state`
Expected: FAIL — the pinned row is still read, and the migration does not exist.

- [ ] **Step 3: Implement — migration, write side and read side in one patch**

Write the migration and its `_journal.json` entry. Delete the route, `applyTaskSteering` and its types from the
client API, then `upsertEvidenceRole` and `applyTaskSteeringAction` and the three types from `task-state`.
Then remove the read side at `task-state.ts:1190-1199,1207-1210,1247-1249,1366-1367` and its consumers at
`context-selection.ts:1701-1702,1708,1985,2084`. Keep `getContextDebugState`. Keep `EvidenceSourceType` in
`context-types.ts:13` (still used at `:109,:117`).

**Do not** drop the table, and **do not** remove it from `prepare-db.ts:48` or `user-scoped-tables.ts:114`.

- [ ] **Step 4: Run the tests and the migration check**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/server/services/task-state
npm run check:migrations && npm run db:prepare
```
Expected: PASS; migrations up to date.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/conversations src/lib/client/api/conversations.ts \
  src/lib/server/services/task-state.ts src/lib/server/services/task-state/types.ts \
  src/lib/server/services/chat-turn/context-selection.ts \
  drizzle/1777140000105_retire_user_evidence_preferences.sql drizzle/meta/_journal.json \
  src/lib/server/services/task-state.test.ts src/lib/server/services/task-state-learning.test.ts
git commit -m "Retire the stored user pins and exclusions with the surface that set them

Deleting the writer first and leaving its rows would keep a read-side filter
that can never match again — invisible, but wrong. Migration, writer and
reader go in one patch so no intermediate state reads rows nothing can create.

The table stays: system-side selected links still live in it."
```

### Task A3: Remove the Context Sources projection

**Files:**
- Delete: `src/lib/server/services/chat-turn/context-sources.ts`, `context-sources.test.ts`
- Modify: `chat-turn/finalize.ts`, `conversation-detail/read-model.ts`, `conversation-detail/types.ts`,
  `knowledge/context-types.ts`, `src/lib/services/streaming.ts`,
  `src/lib/client/normal-chat-client-turn-runtime.ts`, chat page, `routes/api/chat/send/+server.ts`

**Interfaces:**
- Consumes: Task A1 removed the client consumers of the ring's `contextSources` prop.
- Produces: no `contextSources` anywhere in the response, the detail payload or the stream metadata.

- [ ] **Step 1: Write the failing test**

Add to the send/stream metadata suites:

```ts
it("does not ship a contextSources projection in the send response", async () => {
	const response = await sendTurn(...);
	expect(response).not.toHaveProperty("contextSources");
});

it("does not expose contextSources on the conversation detail payload", async () => {
	const detail = await getConversationDetail({ userId, conversationId });
	expect(detail).not.toHaveProperty("contextSources");
});

it("does not fetch linked context sources or project reference context for the detail payload", async () => {
	// pins that the two now-unused read-model fetches are gone.
	expect(listConversationLinkedContextSourcesSpy).not.toHaveBeenCalled();
	expect(getProjectReferenceContextSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && npx vitest run src/routes/api/chat src/lib/server/services/conversation-detail`
Expected: FAIL — `contextSources` is present.

- [ ] **Step 3: Delete the server side, then the client side**

Server: delete `context-sources.ts` and its test; strip every listed site in `finalize.ts`; remove
`ConversationDetail.contextSources` and the read-model assembly plus the two fetches that feed it; delete the
five `ContextSource*` types from `context-types.ts:54-103`. **Keep** `ContextPromptTokensSource` /
`ConversationContextStatus` (`:22-52`) and the `ContextDebug*` types (`:105-133`).

Client: drop the `contextSources` field and its stream parse in `streaming.ts`, the
`isReceiptOnlyCompletionMetadata` entry, the chat page's state/parse/pass-through and `+page.ts:85`, and the
send response field.

Then decide, per assertion, on the six `stream-completion.test.ts` assertions at `:1325,1367,1470,1507,1534,1556`
that assert the *absence* of `contextSources` in receipts: they become tautologies. **Delete the
`not.toHaveProperty("contextSources")` clauses** and keep the surrounding receipt assertions.

- [ ] **Step 4: Run the tests and the typecheck**

Run:
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/routes/api/chat src/lib/server/services/chat-turn src/lib/server/services/conversation-detail src/lib/services
npm run check
```
Expected: PASS, and `npm run check` back to **0 errors / 0 warnings** (Task A1 left residual diagnostics that
this task closes).

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/server/services/chat-turn src/lib/server/services/conversation-detail \
  src/lib/server/services/knowledge/context-types.ts src/lib/services/streaming.ts \
  src/lib/client/normal-chat-client-turn-runtime.ts src/routes/api/chat/send \
  "src/routes/(app)/chat/[conversationId]"
git commit -m "Delete the Context Sources projection

The stream path built it and threw it away, and nothing read the field the
send response carried. Its two read-model fetches existed only to feed it, so
the chat page now does two fewer queries on load."
```

### Task A4: Docs, ADR notes, and the final sweep

**Files:**
- Modify: `CONTEXT.md`, `AGENTS.md`, `src/lib/components/AGENTS.md`, `src/routes/AGENTS.md`,
  `src/lib/server/services/chat-turn/AGENTS.md`, `docs/adr/0004-*.md`, `docs/adr/0006-*.md`,
  `docs/adr/0043-*.md`

**Interfaces:** none.

- [ ] **Step 1: Verify the ADR-0043 claim before rewriting it**

Run: `rg -n "pinn|exclud" docs/adr/0043-*.md CONTEXT.md | head -40`

ADR-0043 lines ~9 and ~49 and `CONTEXT.md:1380-1381,1393` claim that pinning and excluding "lives in the
Knowledge library / working-document workspace". **Confirm whether that is true today.** If it is not, say so
in the commit message and describe what actually holds the preference rather than repeating the claim.

- [ ] **Step 2: Edit the docs**

- `CONTEXT.md` — fix the "evidence manager" entries at the lines the inventory lists (`266, 279, 294, 645-647,
  1134, 1140, 1380-1381, 1415, 2302`), removing language that implies per-source user steering exists.
- `AGENTS.md:144` — remove the "Context Sources projection" mention from the conversation-detail bullet;
  `AGENTS.md:516,529` — remove "steering" from the client-API boundary lines.
- `src/lib/components/AGENTS.md:32,73` — drop the `EvidenceManager` entries.
- `src/routes/AGENTS.md:29,62,100` and `src/lib/server/services/chat-turn/AGENTS.md:54` — drop the removed
  route/builder mentions.
- `docs/adr/0004-*.md` and `docs/adr/0006-*.md` — add a **one-line** superseded note. Do not rewrite either
  ADR.
- `docs/adr/0043-*.md` — correct the pinning claim per step 1.

- [ ] **Step 3: Run the docs-focused checks**

Run: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH && rg -n "EvidenceManager|contextSources|task-steering|applyTaskSteering|upsertEvidenceRole" --glob '!docs/plans/**' --glob '!docs/superpowers/**' .`
Expected: no hits outside the plan documents themselves. Any hit is a missed removal — fix it.

- [ ] **Step 4: Full gate run**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/settings-admin.spec.ts
```
Expected: all green, 0 warnings, Fallow shows **no new findings and no new ignores** (this slice should
*reduce* the report).

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md CONTEXT.md src/lib/components/AGENTS.md src/routes/AGENTS.md \
  src/lib/server/services/chat-turn/AGENTS.md docs/adr
git commit -m "Update the docs the context-sources removal invalidated

The removed surface was still described as a live capability in three places
and asserted as living 'in Knowledge' in two more. A one-line superseded note
on 0004 and 0006 records the reversal without rewriting their reasoning."
```

---

## Non-goals

- **No replacement steering mechanism.** Nothing takes over per-source Auto/Pinned/Excluded.
- **No `task_state_evidence_links` table drop.** System-side `selected` links still live there.
- **No change to `/document`, `/source`, `LinkedDocumentPicker`, `LinkedSourceManager`,
  `linked-context-sources.ts` or `linkedSources.*`.** They are reused by Slice E.
- **No change to the compaction indicator's behaviour** — only its dead `contextSources` fallback.
- **No change to `artifact_links`,** including its `linked_context_source` rows.
- **No restructuring of `ContextUsageRing.svelte`** beyond deleting the removed reads.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| A caller still passes a deleted prop | Svelte 5 does not always fail loudly; the stale value can persist into a render | `npm run check` after each task; Task A1 step 4 records the residual count and Task A3 step 4 must show 0 |
| Over-deletion of the shared linked-sources path | `/document` and `/source` break in a slice that claims not to touch them | The Keep table above, plus Task A4's `rg` sweep and the existing linked-source tests |
| Under-deletion leaves two dead prop chains | `contextDebug`/`pinnedArtifactIds` look harmless but keep dead state flowing through three components | The inventory's added items 1–4 are in the map on purpose; Task A1's guard test names them |
| The migration runs against production rows nobody can restore | A `DELETE` with no undo | Content is scoped to `origin='user'` and two roles; the rows are preferences, not documents. Dry-run against a scratch DB copy first, and report the row count in the task report |
| Tautological assertions keep passing after the field is gone | `not.toHaveProperty("contextSources")` passes trivially once the field never exists | Task A3 step 3 deletes those clauses explicitly |
| Docs keep advertising a feature that is gone | CONTEXT.md is read by every future agent | Task A4 step 3's `rg` sweep is the gate |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — **0 errors, 0 warnings** at slice end.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green.
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run check:migrations` — passes; `npm run db:prepare` runs clean.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, and no new ignores added.
- [ ] `npx playwright test tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts tests/e2e/settings-admin.spec.ts`
      — green.
- [ ] **Manual walk of the real app** (local dev server, scratch DB) at **1440×900 and 390×844, light and dark**:
      - open a chat, hover/click the context ring → no manage button, no panel, no Pinned/Excluded rows
      - the compaction indicator still shows when the conversation is near the threshold
      - `/document` and `/source` still link and list sources, and the linked-source chips still render
      - the Info popover still opens and shows its remaining rows
- [ ] `rg` sweep (Task A4 step 3) returns no hits outside plan docs.

## Owner decisions (ratified 2026-09-24)

Both questions raised here were answered. `decisions.md` is the master record.

1. **No standalone write-up of when the feature went inert.** One line in the commit message and one line in
   `review-<batch>.md`; a future `git log -S` lands there.
   **— The premise is retracted: the surface had not gone inert.** Only its display chain was dead; its effect
   chain was live (the panel's writes filtered and boosted artifacts in `task-state.ts` → `context-selection.ts`).
   The removal stands on the owner's "I never used it", not on the feature being dead. See the correction note
   under decision 6 in `decisions.md` for the file:line evidence.
2. **Correct ADR-0043 in place, with the correction dated**, rather than adding a superseded note — AGENTS.md
   points future agents at that ADR, so a false claim about where a capability lives keeps misleading them. If
   the verification in Task A4 step 1 shows the claim was true, leave it alone and say so in the report.
