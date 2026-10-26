# Sidebar Multi-select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person select several sidebar chats and delete, move, pin or unpin them in one action.

**Architecture:** One batch route, `POST /api/conversations/batch`, runs the existing per-chat service calls and returns a result per id. The browser sends chunks of 50, and the conversations store applies the results optimistically, rolling back per id. `ConversationList.svelte` owns the selection, with its rules in a pure `sidebar-selection.ts`; `ConversationItem.svelte` and the new `SidebarSelectionBar.svelte` only emit events.

**Tech Stack:** SvelteKit 2 with Svelte 5 runes, Drizzle on SQLite (better-sqlite3), Vitest with @testing-library/svelte, Playwright against the production build.

**Spec:** `docs/plans/sidebar-multi-select/design.md`: decisions D1 to D7 and the copy table. Read both.

## Global Constraints

- Runes-mode Svelte 5 only: `$props()`, callback props, `onclick`-style attributes, `{@render}`. No `on:`, `createEventDispatcher` or `<slot>`. A `bind:this` ref that a handler or effect reads is declared with `$state`.
- Icons from `@lucide/svelte` only; `SquareCheck`, `ListChecks`, `PinOff`, `FolderInput`, `Pin`, `Trash2`, `Check` and `X` exist in the installed version. Decorative icons get `aria-hidden="true"`.
- Every new label, tooltip, error, dialog and aria string in English and Hungarian, exactly as the spec's copy table says. Nothing clipped at the 240 px minimum sidebar width or on a 360 px phone. No keyboard-shortcut hints on touch screens.
- Placement (root `AGENTS.md`): routes are adapters; the store calls `src/lib/client/api/` and never `fetch`es; `ConversationItem` and `SidebarSelectionBar` are event emitters and `ConversationList` owns the state. No new top-level `src/lib/server/services/*.ts` file. No schema change.
- Single-chat behavior stays exactly as it is (row menu actions, PATCH and DELETE on `/api/conversations/[id]`, drag and drop, pinned reorder), with one exception: D5's stream stop inside `deleteConversationWithCleanup`.
- No new Svelte accessibility warning (they fail the zero-warning gate): no `onkeydown` or other handler on a static `div`, and no `role` computed at runtime. A row keeps `role="button"` and says its selected state with `aria-pressed`; keys that belong to the whole list go through `<svelte:window>`.
- Gates: `npm run check` with 0 errors and 0 warnings; `npm run build` with 0 warnings; `npx biome check src scripts tests` clean; Fallow with no new finding (the four known cycles, no fifth). Never run `npm run check` or `npm test` while a build runs.
- Before writing framework code, check the current docs for the APIs you use (Svelte and SvelteKit through the Svelte MCP or Context7 when the session has them, otherwise svelte.dev, vitest.dev, playwright.dev) and say in your report which docs you checked.
- Commit in small steps, one logical change each, with a message that says why. Never push.

## Review Focus

1. **Input while a bulk action runs** (a second click on Delete, a row click, Esc, close). All of it is ignored until the action ends, and the action's result never revives a selection the person ended. Test: Task 5, "toggles, Esc and close are ignored while a bulk action runs".
2. **A stale or foreign id** (a chat deleted in another tab, another user's chat). The server answers `not_found` and never touches another user's row; the store treats `not_found` as gone (removed locally, not a failure). Tests: Task 1, "deletes several conversations and reports each" (the other user's chat survives); Task 3, "not_found leaves the list and is not a failure".
3. **Deleting the open chat, one whose reply is streaming included.** The server aborts the stream before deleting, the page goes home, no error toast. Tests: Task 1, "stops the conversation's streaming reply before deleting it"; Task 5, "deleting the open chat goes home".
4. **More than 50 selected.** Chunks of 50, sent in order; a failed chunk marks only its own ids `unknown`; after a delete the store reloads the list, and rows the server did delete disappear. Tests: Task 3, "sends a large batch in chunks of 50, in order" and "a delete with an unknown result reloads the list".
5. **Gestures that collide.** Ctrl-click on macOS fires `contextmenu`: it opens the row menu and never selects. Shift-click selects no page text. No drag starts while selecting. Enter in the rename input still only saves. Tests: Task 5, the ConversationItem gesture tests.

---

### Task 1: Batch contract, bulk services and the stream stop

**Files:**
- Create: `src/lib/shared/conversation-batch.ts`
- Modify: `src/lib/server/services/conversations.ts` (beside `setConversationSidebarPinned` and `moveConversationToProject`)
- Modify: `src/lib/server/services/cleanup/conversation-cleanup.ts`, `src/lib/server/services/cleanup.ts` (re-export)
- Test: `src/lib/server/services/conversations.test.ts`, `src/lib/server/services/cleanup/conversation-cleanup.test.ts`

**Interfaces:**
- Produces, in `src/lib/shared/conversation-batch.ts`:
  ```ts
  export const CONVERSATION_BATCH_MAX_IDS = 50;
  export type ConversationBatchRequest =
  	| { action: "delete"; ids: string[] }
  	| { action: "move"; ids: string[]; projectId: string | null }
  	| { action: "pin"; ids: string[]; pinned: boolean };
  /** The server sends `not_found` or `failed`; the browser marks every id of a chunk whose request failed `unknown`. */
  export type ConversationBatchFailure = "not_found" | "failed" | "unknown";
  export type ConversationBatchResult<TConversation = never> =
  	| { id: string; ok: true; conversation?: TConversation }
  	| { id: string; ok: false; error: ConversationBatchFailure };
  ```
- Produces, services (results in the given id order, one per id):
  - `deleteConversationsWithCleanup(userId: string, conversationIds: string[]): Promise<ConversationBatchResult[]>`, re-exported from `$lib/server/services/cleanup`.
  - `moveConversationsToProject(userId: string, conversationIds: string[], projectId: string | null): Promise<ConversationBatchResult<Conversation>[] | null>`: `null` when `projectId` is not one of the user's projects, and then no row changes.
  - `setConversationsSidebarPinned(userId: string, conversationIds: string[], sidebarPinned: boolean): Promise<ConversationBatchResult<Conversation>[]>`

- [ ] **Step 1: Write the failing tests** (in each file's existing style)
  - cleanup, `"stops the conversation's streaming reply before deleting it"`: `registerActiveChatStream({ streamId: "s1", userId, conversationId, controller })`, then `deleteConversationWithCleanup(userId, conversationId)` → `controller.signal.aborted === true` and the row is gone. A stream registered for another conversation of the same user is not aborted. Unregister the streams afterwards. This file calls `vi.resetModules()` in `beforeEach` and imports the code under test dynamically, so get `registerActiveChatStream` with `await import("../chat-turn/active-streams")` inside the test: a top-level import is a different module instance and nothing would abort. Assert only `aborted`; the stop is not awaited, and the aborted stream may log a line or two when its write meets the deleted chat (it swallows that failure, see `chat-turn/finalize.ts`).
  - cleanup, `"deletes several conversations and reports each"`: owned A and B, another user's C, a missing `"nope"` → `[{ id: A, ok: true }, { id: B, ok: true }, { id: C, ok: false, error: "not_found" }, { id: "nope", ok: false, error: "not_found" }]`, and C still exists.
  - cleanup, `"keeps going when one delete throws"`: make the delete throw for one id → that id is `failed`, the others are `ok`.
  - conversations, `"moves several conversations into a project without touching updatedAt"`: two owned ids and a foreign one → ok, ok, `not_found`; the two rows carry the project id and their `updatedAt` is unchanged. `projectId: null` takes them out again. Another user's project → `null`, and no row changed.
  - conversations, `"pins several conversations on top in the order given"`: P already pinned; pin `[A, B]` → pinned order A, B, P (`sidebarSortOrder` A < B < P), and each result's `conversation.sidebarPinned` is true. Unpin `[A, B]` → `sidebarPinned` false and `sidebarSortOrder` null. A foreign id → `not_found`.
- [ ] **Step 2: Run them and see them fail**
  Run: `npx vitest run src/lib/server/services/cleanup/conversation-cleanup.test.ts src/lib/server/services/conversations.test.ts`
  Expected: FAIL, the new functions are not defined and the stream is not aborted.
- [ ] **Step 3: Implement**
  - In `deleteConversationWithCleanup`, right after the ownership check: `getOrphanedStream({ userId, conversationId })`, and when it returns a stream id, `requestActiveChatStreamStop({ streamId, userId })` (both from `../chat-turn/active-streams`, which imports nothing that reaches `cleanup`).
  - `deleteConversationsWithCleanup` runs the single delete for one id after another (SQLite and the artifact cleanup do not want parallel deletes) and catches per id: log `[CONVERSATION_BATCH_DELETE]` with the id, report `failed`.
  - `moveConversationsToProject` checks the project once, then runs `moveConversationToProject`'s row update per id. Extract that update into a private helper so it exists once.
  - `setConversationsSidebarPinned`: to unpin, `setConversationSidebarPinned(userId, id, false)` per id. To pin, call it for the ids in reverse, so the first id ends on top. Report in the given order.
- [ ] **Step 4: Run them and see them pass** (same command). Expected: PASS.
- [ ] **Step 5: Commit**

### Task 2: The batch route

**Files:**
- Create: `src/routes/api/conversations/batch/+server.ts`
- Test: `src/routes/api/conversations/batch/batch.test.ts`
- Modify: `src/routes/AGENTS.md` (one row in its API route table)

**Interfaces:**
- Consumes: Task 1's contract and services.
- Produces: `POST /api/conversations/batch`:
  - 200 `{ results: ConversationBatchResult<Conversation>[] }`
  - 400 `{ error }` for an invalid body
  - 404 `{ error: "Project not found" }` for a move into a project that is not the user's
  - 401 without a session (`requireAuth`)
  - 500 `{ error: "Failed to apply batch action" }` when a service throws

- [ ] **Step 1: Write the failing tests** (call the handler the way `src/routes/api/conversations/conversations.test.ts` does)
  - 400 for each of: no body; `action: "archive"`; `ids` missing, empty, not an array, holding `""` or a number; 51 ids; a move without `projectId` or with a number; a pin with `pinned: "yes"`.
  - `ids: ["a", "b", "a"]` → the service gets `["a", "b"]` (duplicates dropped, first-seen order kept; ids trimmed).
  - delete → `deleteConversationsWithCleanup(user.id, ids)`, and its results come back as `results`. `invalidateHomeSummary(user.id)` is called once when any result is ok, and not at all when none is.
  - a move into an unknown project → 404; a move with `projectId: null` → 200.
  - pin → `setConversationsSidebarPinned(user.id, ids, true)`.
- [ ] **Step 2: Run them and see them fail**
  Run: `npx vitest run src/routes/api/conversations/batch/batch.test.ts`
  Expected: FAIL, the route does not exist.
- [ ] **Step 3: Implement** `parseConversationBatchRequest(body: unknown): ConversationBatchRequest | null` in the route file (the local convention: `parseOrderedIds` in `sidebar-order/+server.ts`), then dispatch by `action`.
- [ ] **Step 4: Run them and see them pass** (same command). Expected: PASS.
- [ ] **Step 5: Commit**

### Task 3: The browser's chunks and the store's bulk actions

**Files:**
- Modify: `src/lib/client/api/conversations.ts`; test `src/lib/client/api/conversations.test.ts`
- Modify: `src/lib/stores/conversations.ts`; test `src/lib/stores/conversations.test.ts`
- Modify: `src/lib/stores/AGENTS.md` (the `conversations.ts` row names the bulk actions)

**Interfaces:**
- Consumes: Task 1's contract; Task 2's route.
- Produces:
  - `runConversationBatch(request: ConversationBatchRequest): Promise<ConversationBatchResult<Conversation>[]>` in the client API. It splits `request.ids` into chunks of `CONVERSATION_BATCH_MAX_IDS`, sends them one after another and concatenates the `results`. When a chunk's request throws, every id in that chunk is `{ ok: false, error: "unknown" }`, and the next chunk is still sent. An id that a successful answer leaves out is `unknown` too.
  - In the store, none of which throws for a per-id failure, and each resolves `{ failedIds: [] }` without a request for an empty `ids`:
    - `deleteConversationsByIds(ids: string[]): Promise<{ failedIds: string[] }>`
    - `moveConversationsToProject(ids: string[], projectId: string | null): Promise<{ failedIds: string[] }>`
    - `setConversationsSidebarPinned(ids: string[], sidebarPinned: boolean): Promise<{ failedIds: string[] }>`

- [ ] **Step 1: Write the failing tests**
  - API, `"sends a large batch in chunks of 50, in order"`: 120 ids → three POSTs to `/api/conversations/batch` carrying 50, 50 and 20 ids and the same action fields; the results come back concatenated in id order.
  - API, `"marks a failed chunk unknown and still sends the rest"`: the second request rejects → ids 51 to 100 are `unknown`; 1 to 50 and 101 to 120 are what the server said.
  - store delete, `"not_found leaves the list and is not a failure"`: results ok (A), `not_found` (B), `failed` (C) → A and B leave `$conversations` and C stays; the workspace-deleted event fires for A and B only; it returns `{ failedIds: ["C"] }`. The existing `deleteConversationById` tests stay green.
  - store delete, `"a delete with an unknown result reloads the list"`: one forced `loadConversations` follows the batch (a GET `/api/conversations` happens). An `unknown` chat the reloaded list no longer holds counts as deleted (its workspace event fires, it is not in `failedIds`); one it still holds is in `failedIds`.
  - store move: every row carries the new project before the response; a `failed` id goes back to its previous project; a later snapshot does not undo the ones that succeeded; an `unknown` id is decided by the reload (it succeeded when the reloaded row is in the target project).
  - store pin: with B's `updatedAt` newer than A's (so a fallback to recency would show B first), pinning `[A, B]` while P is pinned gives the Pinned order A, B, P before the response; a failed id goes back to its previous pin state; unpin sets `sidebarPinned` false and `sidebarSortOrder` null; an `unknown` id is decided by the reload.
- [ ] **Step 2: Run them and see them fail**
  Run: `npx vitest run src/lib/client/api/conversations.test.ts src/lib/stores/conversations.test.ts`
  Expected: FAIL, the functions are not defined.
- [ ] **Step 3: Implement.**
  - `deleteConversationById` and the bulk delete share one private helper for the local cleanup (drop the row, the persisted workspace state, the workspace event).
  - The optimistic apply and rollback for one chat live today in inline closures (`toggleConversationSidebarPin`, `moveConversationToProject`). Extract per-chat helpers from them and use those helpers in both the single and the bulk functions, so the machinery (`localConversationProjectIds`, `localConversationSidebarStates`, `applyConversationSidebarState`, `sortConversationsForSidebar`) exists once. The single functions' behavior and tests do not change.
  - Pin order: `nextTopPinnedConversationOrder` reads one snapshot, so calling it per id gives every id the same order. Compute `base` once; the k-th of n ids gets `base - (n - 1 - k)`.
  - A `not_found` from a move or a pin drops the row locally (the chat is gone) and is not a failure.
  - When any result is `unknown`: drop the optimistic local state of the `unknown` ids (so the snapshot is not overridden), run `loadConversations({ force: true })`, and decide those ids from the reloaded list as the tests say. Report `failedIds` only after that.
- [ ] **Step 4: Run them and see them pass** (same command). Expected: PASS.
- [ ] **Step 5: Commit**

### Task 4: Selection rules, the bar and the copy

**Files:**
- Create: `src/lib/components/sidebar/sidebar-selection.ts`; test `sidebar-selection.test.ts`
- Create: `src/lib/components/sidebar/SidebarSelectionBar.svelte`; test `SidebarSelectionBar.test.ts`
- Modify: `src/lib/i18n/common.ts` (both languages: the spec's copy table)
- Modify: `src/lib/components/AGENTS.md` (the hierarchy gets the bar; "ConversationList owns the selection")

**Interfaces:**
- Produces, in `sidebar-selection.ts` (pure; no Svelte, no stores):
  ```ts
  export type ShownSections = {
  	pinned: { expanded: boolean; ids: readonly string[] };
  	projects: {
  		expanded: boolean;
  		folders: readonly { expanded: boolean; ids: readonly string[] }[];
  	};
  	chats: { expanded: boolean; ids: readonly string[] };
  };
  export function shownConversationOrder(sections: ShownSections): string[];
  export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string>;
  export function selectRange(
  	selected: ReadonlySet<string>,
  	order: readonly string[],
  	anchorId: string | null,
  	targetId: string,
  ): Set<string>;
  export function pruneSelected(selected: ReadonlySet<string>, presentIds: ReadonlySet<string>): Set<string>;
  export function bulkPinAction(selected: readonly { sidebarPinned?: boolean }[]): "pin" | "unpin";
  ```
  `shownConversationOrder` lists the Pinned ids (when Pinned is expanded), then each expanded folder's ids in folder order (when Projects is expanded), then the Chats ids (when Chats is expanded). `selectRange` adds every id between the anchor and the target, both included and in either direction, and keeps what was already selected; with a null anchor, or an anchor or target not in `order`, it adds only the target. `bulkPinAction` is `"unpin"` only when the list is not empty and every chat in it is pinned.
- Produces, `SidebarSelectionBar.svelte` props:
  ```ts
  {
  	count: number;
  	canSelectAll: boolean;
  	pinAction: "pin" | "unpin";
  	projects: Project[];
  	canRemoveFromProject: boolean;
  	busy?: boolean;
  	onClose?: () => void;
  	onSelectAll?: () => void;
  	onPin?: () => void;
  	onMove?: (payload: { projectId: string | null }) => void;
  	onDelete?: () => void;
  }
  ```
  Test ids: `sidebar-selection-bar` (`role="toolbar"`, named by `sidebar.selectionToolbar`), `selection-count` (`aria-live="polite"`), `selection-close`, `selection-select-all`, `selection-pin`, `selection-move`, `selection-move-option` (one per project, with `data-project-id`), `selection-remove-from-project`, `selection-delete`.

- [ ] **Step 1: Write the failing tests**
  - rules: toggle adds, then removes; a range forward and a range backward from the anchor; a range keeps the earlier picks; a null or unknown anchor selects only the target; prune drops missing ids and keeps the rest; `bulkPinAction` gives `"pin"` for `[]`, `"unpin"` for all pinned, `"pin"` for a mix; `shownConversationOrder` skips a collapsed Pinned, a collapsed Projects section, a collapsed folder and a collapsed Chats.
  - bar: count 3 shows "3 selected"; Select all is disabled when `canSelectAll` is false; the pin button's accessible name is "Pin to sidebar" for `"pin"` and "Unpin from sidebar" for `"unpin"`; Move opens a menu of the projects, with "Remove from project" only when `canRemoveFromProject`; Move is absent with no projects and `canRemoveFromProject` false; each callback fires with the right payload; `busy` disables every button, Close included (D3: while a bulk action runs, close is ignored); with the UI language set to Hungarian the count reads "3 kijelölve".
  - copy: every new key from the spec's table exists in both languages with the spec's text.
- [ ] **Step 2: Run them and see them fail**
  Run: `npx vitest run src/lib/components/sidebar/sidebar-selection.test.ts src/lib/components/sidebar/SidebarSelectionBar.test.ts`
  Expected: FAIL, the modules do not exist.
- [ ] **Step 3: Implement.** Icons: close `X`, Select all `ListChecks`, Pin `Pin` or Unpin `PinOff`, Move `FolderInput`, Delete `Trash2`. Buttons are 28 px, with 44 px touch targets below 768 px; each has a `title` tooltip and an `aria-label`. The usable width at the 240 px minimum is about 223 px, so: the count is `min-w-0 flex-1 truncate`, every control is `shrink-0`, and gaps are 2 px at most. The Move menu opens above the bar through `portal` from `$lib/utils/popup-menu` and closes on an outside click and after a choice. It looks like the row menu (`.conversation-menu`, `.conversation-option` in `ConversationItem.svelte`); if more than a few of those rules would repeat, lift them into one shared global class that both use rather than keeping two copies.
- [ ] **Step 4: Run them and see them pass** (same command). Expected: PASS.
- [ ] **Step 5: Commit**

### Task 5: Rows and list: selecting, the bar, the bulk calls

**Files:**
- Modify: `src/lib/components/sidebar/ConversationItem.svelte`; test `ConversationItem.test.ts` (and `ConversationItemWrapper.test.svelte` if the tests need it)
- Modify: `src/lib/components/sidebar/ConversationList.svelte`; test `ConversationList.test.ts`
- Modify: `src/lib/components/layout/Sidebar.svelte` (only `data-testid="sidebar-scroll"` on the list's scroll container, about line 416, for Task 6)

**Interfaces:**
- Consumes: Task 3's store functions; Task 4's rules and bar; `hasOpenDialog()` from `src/lib/components/ui/DialogShell.svelte`.
- Produces, new `ConversationItem` props:
  ```ts
  selecting?: boolean; // a selection is open in the sidebar
  selected?: boolean;
  onSelectionToggle?: (payload: { id: string; range: boolean }) => void;
  ```
  Test ids: `select-option` (the row menu item), `conversation-select-checkbox` (the drawn box, `aria-hidden`), and `data-selected="true"` or `"false"` on `conversation-item` while selecting.

- [ ] **Step 1: Write the failing tests**
  - Row, no selection open: a click with `metaKey` → `onSelectionToggle({ id, range: false })` and no `onSelect`; the same with `ctrlKey`; with `shiftKey` → `range: true`; a plain click → `onSelect`; a `contextmenu` with `ctrlKey` opens the row menu and calls no selection callback; a `mousedown` with `shiftKey` is default-prevented; the menu holds "Select" (`select-option`), and clicking it calls `onSelectionToggle({ id, range: false })` and closes the menu; Enter in the rename input saves the title and calls neither `onSelect` nor `onSelectionToggle`.
  - Row, selection open: the row stays a `button` and carries `aria-pressed` from `selected` (no `aria-pressed` while no selection is open); a plain click → `onSelectionToggle` with `range: false`, never `onSelect`; Space and Enter toggle (Space's default prevented); the ⋮ trigger is not rendered; a `contextmenu` opens nothing; `draggable` is false; the fork and incognito marks still render.
  - List: Cmd-click two rows → the bar shows "2 selected"; Esc ends the selection and the bar goes, also when focus is on the page body (as after "Select" from the portaled menu), but not while a dialog is open and not when typed into a text field; a plain click while selecting does not call `goto`; Shift-click with the open chat shown selects from it to the clicked row in shown order; Select all takes the shown rows only (with Chats collapsed, its rows stay out); `"collapsing a section takes its chats out of the selection"`; project folders still open and close while selecting; `"closing the drawer ends the selection"` (`sidebarOpen` set to false); `"toggles, Esc and close are ignored while a bulk action runs"` (hold the batch request open, try each, then resolve it: the result applies to the selection as it was); bulk delete → the dialog → confirm → a POST to `/api/conversations/batch` with `action: "delete"` → the rows and the bar are gone; a `failed` id stays selected, the bar stays, and the toast store holds "Couldn't delete 1 chat. Try again."; `"deleting the open chat goes home"` (`currentConversationId` becomes null and `goto("/")` is called); a selected chat that leaves the store leaves the selection; unticking the last row ends the selection; Pin on a mixed selection sends only the unpinned ids, in shown order; Move skips chats already in the target project; a failed move and a failed pin each show their own toast ("Couldn't move 1 chat. Try again.", "Couldn't update the pin on 1 chat. Try again."); while selecting, `SidebarReorderRow` gets `disabled` and no row is `draggable`.
- [ ] **Step 2: Run them and see them fail**
  Run: `npx vitest run src/lib/components/sidebar/`
  Expected: FAIL on the new tests; the old ones still pass.
- [ ] **Step 3: Implement**
  - `ConversationItem`: the row's click handler takes the event and decides as the tests say; while selecting, keydown toggles on Space and Enter; `oncontextmenu` returns early while selecting; `onmousedown` prevents the default when Shift is held. The box sits before the fork, Atlas and incognito marks. `role` stays `"button"`; `aria-pressed={selecting ? selected : undefined}`. Menu order: Pin, Rename, Move to project, Select, Delete; icon `SquareCheck`. The Select item uses the same classes as its neighbours, `max-md:min-h-[44px]` included: `tests/e2e/phone-polish.spec.ts` (about lines 599 to 618) requires every menu option on one line and at least 43.5 px tall on a phone.
  - `ConversationList`: state `selectedIds` (a `Set` replaced on every change, or a `SvelteSet`: check the Svelte docs), `selectionAnchorId`, `bulkBusy`, `bulkDeleteConfirmOpen`. Derived: `selecting`, `shownOrder` (from `shownConversationOrder` over the existing derived lists and expand states), `selectedConversations`, `pinAction`, `canSelectAll`, `canRemoveFromProject`. The range anchor is `selectionAnchorId`, or, while the selection is empty, the open chat when it is in `shownOrder`. Prune to the shown rows (`pruneSelected(selectedIds, new Set(shownOrder))`) with an `$effect` that writes only when something was pruned (no effect loop): that one rule covers chats deleted elsewhere and collapsed sections and folders. End the selection when `$sidebarOpen` turns false; collapsing the whole sidebar unmounts the list, which ends it anyway. Esc goes through `<svelte:window onkeydown>`, acting only while selecting and skipping an event that is `defaultPrevented`, a moment when `hasOpenDialog()` is true, and a target that is an `input`, `textarea`, `select` or contenteditable element. Starting a selection closes any open menu and clears the drag state. While `bulkBusy`, row toggles, Esc and close do nothing. After a bulk call: `bulkBusy = false`; when everything succeeded, clear the selection; otherwise keep the failed ids that are still shown selected and `showToast({ type: "error", message })`. For Pin and Move, send the selected chats in shown order.
  - The bar is the last child of the list's root, inside `Sidebar.svelte`'s scroll container. Measured in Chromium against that container: make the root `min-h-full` (not `h-full`) and the bar `sticky mt-auto`, offset by the container's `py-sm` padding (`-bottom-sm -mb-sm`), with an opaque `bg-surface-overlay` and `border-t`. Then it sits flush at the bottom with a long list and a short one, and covers no row at the end of the list.
- [ ] **Step 4: Run them and see them pass**
  Run: `npx vitest run src/lib/components/sidebar/` then `npm run check`
  Expected: PASS, and 0 errors and 0 warnings.
- [ ] **Step 5: Commit**

### Task 6: The browser spec

**Files:**
- Create: `tests/e2e/sidebar-multi-select.spec.ts`
- Modify: `tests/AGENTS.md` ("Where to Look" gets a sidebar selection row)

- [ ] **Step 1: Write the spec.** A chat with no messages is not listed, so seed listed chats the way `seedChat` in `tests/e2e/artifact-canvas-edit-helpers.ts` does (`createEmptyConversation`, then one `messages` row through `db`), then reload. Tests:
  - `"selects chats with a modifier click and deletes them after confirming"`: 3 chats; `ControlOrMeta`-click two → `selection-count` reads "2 selected" → `selection-delete` → the dialog title reads "Delete 2 chats?" → `confirm-delete` → both rows are gone and the third stays; still gone after a reload.
  - `"selects a range with Shift-click in sidebar order"`: 4 chats; `ControlOrMeta`-click the first shown, Shift-click the third → those 3 are selected.
  - `"starts a selection from the row menu on a phone"`: viewport 390 by 844; open the drawer; a row's ⋮ → `select-option` → tap another row → "2 selected" → `selection-close` → the bar is gone, and tapping a row opens the chat.
  - `"moves a selection into a project and back"`: make a project through the API the sidebar uses; select 2 → `selection-move` → the project → both sit under its expanded folder; select them again → Remove from project → both are back under Chats.
  - `"pins and unpins a selection"`: select 2 unpinned → Pin → Pinned shows them in the order they had; select both → the pin button reads Unpin → the Pinned section is gone.
  - `"keeps the bar in view and on one line"`: 30 chats, the sidebar at its 240 px minimum, the UI in Hungarian (put both back in the spec's cleanup); select one, then Select all, so the count reads "30 kijelölve"; scroll `sidebar-scroll` to the top and to the bottom → each time the bar lies inside the scroller's visible box; the bar's `scrollWidth <= clientWidth`, and so does the count's. Repeat the width checks on a 360 by 800 phone with the drawer open.
  - `"deleting the open chat in a selection goes home"`.
  Use test ids and `getByRole`, no fixed waits, and undo whatever the spec changes (language, width, projects).
- [ ] **Step 2: Run it on the build**
  Run: `npm run build`, then `E2E_PORT=<your port> E2E_WORKERS=2 npx playwright test tests/e2e/sidebar-multi-select.spec.ts tests/e2e/conversation.spec.ts tests/e2e/phone-polish.spec.ts`
  Expected: all pass, with `conversation.spec.ts` and `phone-polish.spec.ts` unchanged.
- [ ] **Step 3: Commit**

## Execution

- Wave 1, in parallel: one agent takes Tasks 1 to 3 (the data path), another takes Task 4 (the rules, the bar, the copy). Their files do not overlap.
- Both branches merge into `feat/sidebar-multi-select`.
- Wave 2: Tasks 5 and 6 on the merged branch.
- Then an independent review-and-fix pass over the whole branch (a failing test before each fix), and the agent gate: `scripts/gates.sh agent <out-dir> --port <base> tests/e2e/sidebar-multi-select.spec.ts tests/e2e/conversation.spec.ts tests/e2e/phone-polish.spec.ts` (`phone-polish.spec.ts` has no `@smoke` test, so it must be named).
