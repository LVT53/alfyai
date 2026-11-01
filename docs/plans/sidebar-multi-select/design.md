# Sidebar multi-select

Item 1 of the owner's ranked feature backlog (2026-10-25). The owner's words: "Multi-select in the sidebar and related actions to make it complete." The owner dropped archive the same day. Written 2026-10-26. The owner asked for the build directly, so the open decisions below were taken without a brainstorm; any of them can be overturned.

## What a person can do

Select several chats in the sidebar, then in one action delete them, move them into a project or out of one, or pin or unpin them.

## Decisions

### D1. Starting a selection

- Desktop: Cmd-click (macOS) or Ctrl-click (Windows, Linux) on a chat adds it to the selection or takes it out. Shift-click selects every chat from the anchor to the clicked one, in the order the sidebar shows them. The anchor is the chat last clicked into or out of the selection. When a selection starts with Shift-click, the anchor is the open chat if its row is shown; otherwise only the clicked chat is selected.
- Every device: "Select" in a chat's ⋮ menu (and its right-click menu) starts a selection with that chat. This is how a touch screen gets in. No long-press: the browser has its own, and catching it needs non-passive touch listeners.
- Ctrl-click on macOS stays a right-click: it opens the menu and selects nothing.

### D2. While a selection is open

- Every chat row shows a checkbox at its start. A click or tap adds or removes the row instead of opening the chat; Shift-click extends from the anchor; Enter or Space toggles the focused row. Assistive tech meets the row as a toggle button: it stays a `button` and gets `aria-pressed` (a role that changes at runtime fails the build's accessibility check).
- Row menus, rename and pinned reorder are off. Dragging a chat row stays on (added later, Task 10 of plan 2b): a selected row drags the whole selection onto a folder, Chats, Pinned or the bin; an unselected row drags itself. Project folders still open and close, so the chats inside can be reached.
- The fork, Atlas and incognito marks stay where they are. None of them changes a bulk action: a selection may mix pinned, project, fork and incognito chats.

### D3. Ending a selection

Esc (anywhere except in a text field or while a dialog is open), the bar's close button, a bulk action that fully succeeds, unticking the last chat, or closing the sidebar (the phone drawer closing, or the sidebar being collapsed or hidden). While a bulk action runs, row clicks, Esc and close are ignored, so its result cannot revive a selection the person already ended.

Everything selected is on screen. A selected chat that leaves the list (deleted in another tab) leaves the selection, and so do the chats of a section or folder that is collapsed: a bulk delete never takes a chat the person cannot see. The bar's count is always the size of the selection, and the delete dialog repeats it.

### D4. The bar

Sticky at the bottom of the chat list while a selection is open. In order: close, the count ("3 selected" / "3 kijelölve"), then icon buttons, each with a tooltip and an accessible name:

- Select all: selects every chat row shown. Disabled when every shown row is already selected.
- Pin / Unpin: "Unpin" when every selected chat is pinned; otherwise "Pin", which pins the unpinned ones and leaves the pinned ones where they are. Newly pinned chats go to the top of Pinned, in the order the sidebar showed them.
- Move to project: a menu of the person's projects, then "Remove from project" when a selected chat is in one. Hidden when there are no projects and no selected chat is in one (the row menu's own rule).
- Delete.

The action buttons are disabled while a bulk action runs. The bar fits on one line at the sidebar's 240 px minimum width and on a 360 px phone, in Hungarian, with "30 kijelölve" unclipped; below 768 px its buttons have 44 px touch targets.

### D5. Bulk delete

Always confirmed: "Delete 3 chats?" and "Their messages, files, reports and the Documents made in them are deleted too. This can't be undone." Each chat is deleted exactly as deleting it alone does (`deleteConversationWithCleanup`). If the open chat is among them, the app goes to the home page.

A chat whose reply is still streaming has that reply stopped on the server first. Single delete gets the same stop, so the two paths stay one: today a delete leaves the server generating into a chat that no longer exists. Atlas jobs are cancelled, as today. File-production and extraction job rows go with the chat by cascade, as today.

### D6. Partial failure

The rest of the action stands. The chats that failed stay selected, and an error toast says how many. A chat the server no longer has counts as done, not failed: it is gone either way. Nothing is rolled back on the server.

### D7. One batch endpoint

`POST /api/conversations/batch` takes `{ action: "delete" | "move" | "pin", ids, projectId?, pinned? }` with at most 50 ids, and answers with one result per id: ok, `not_found` or `failed`. Every id is checked against the signed-in user; another user's id reads as `not_found`. The browser sends a larger selection in chunks of 50, one after another. A chunk whose request fails marks its ids `unknown`, and so does an id missing from a successful answer. When any id is `unknown`, the sidebar reloads its list and lets it decide: a deleted chat that is no longer listed went, and a moved or pinned chat whose listed state matches the action succeeded. Only the rest count as failed.

### Not in this build

Archive (dropped by the owner). Running and unread dots: their own item, which backlog item 6 needs. Bulk rename, export or fork. Selecting project folders. Undo. Cmd+A or a Delete-key shortcut. Keeping a selection across reloads.

## Copy

New keys, all in `src/lib/i18n/common.ts`:

| Key | English | Hungarian |
|---|---|---|
| `sidebar.select` (row menu) | Select | Kijelölés |
| `sidebar.selectionToolbar` (the bar's accessible name) | Selected chats | Kijelölt beszélgetések |
| `sidebar.selectionCount` | {count} selected | {count} kijelölve |
| `sidebar.selectionClose` | Cancel selection | Kijelölés megszüntetése |
| `sidebar.selectAll` | Select all | Összes kijelölése |
| `sidebar.deleteConversationsTitle` | Delete {count} {count, plural, one {chat} other {chats}}? | Törölsz {count} beszélgetést? |
| `sidebar.deleteConversationsMessage` | Their messages, files, reports and the Documents made in them are deleted too. This can't be undone. | Az üzeneteik, fájljaik, jelentéseik és a bennük készült dokumentumok is törlődnek. Ez nem vonható vissza. |
| `sidebar.bulkDeleteFailed` | Couldn't delete {count} {count, plural, one {chat} other {chats}}. Try again. | {count} beszélgetést nem sikerült törölni. Próbáld újra. |
| `sidebar.bulkMoveFailed` | Couldn't move {count} {count, plural, one {chat} other {chats}}. Try again. | {count} beszélgetést nem sikerült áthelyezni. Próbáld újra. |
| `sidebar.bulkPinFailed` | Couldn't update the pin on {count} {count, plural, one {chat} other {chats}}. Try again. | {count} beszélgetés rögzítését nem sikerült frissíteni. Próbáld újra. |

Reused as they are: `sidebar.pinToSidebar`, `sidebar.unpinFromSidebar`, `sidebar.moveToProject`, `sidebar.removeFromProject`, `sidebar.delete`, `common.delete`, `common.cancel`.

## Where

- `src/lib/shared/conversation-batch.ts`: the request and result contract and the 50-id limit, shared by the route and the browser.
- `src/routes/api/conversations/batch/+server.ts`: the adapter.
- `src/lib/server/services/conversations.ts`: `moveConversationsToProject`, `setConversationsSidebarPinned`.
- `src/lib/server/services/cleanup/conversation-cleanup.ts` (re-exported by `cleanup.ts`): `deleteConversationsWithCleanup`, and the stream stop inside `deleteConversationWithCleanup`.
- `src/lib/client/api/conversations.ts`: `runConversationBatch`, which chunks.
- `src/lib/stores/conversations.ts`: `deleteConversationsByIds`, `moveConversationsToProject`, `setConversationsSidebarPinned`.
- `src/lib/components/sidebar/sidebar-selection.ts`: the pure selection rules.
- `src/lib/components/sidebar/SidebarSelectionBar.svelte`: the bar, an event emitter.
- `ConversationItem.svelte` (an event emitter: the checkbox, "Select", modifier clicks) and `ConversationList.svelte` (owns the selection, the bulk calls and the delete dialog).
- `tests/e2e/sidebar-multi-select.spec.ts`.

No schema change and no migration.
