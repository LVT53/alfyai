# Sidebar Pinning And Reorder Slices

This local issue breakdown turns the agreed Sidebar Pin spec into independently grabbable tracer-bullet slices. Do not create GitHub issues from this document unless explicitly asked.

Primary references:

- `CONTEXT.md` language: Sidebar Pin, Sidebar Order, Project Folder, Project Folder Awareness.
- `AGENTS.md` sidebar, localization, Svelte 5, and store/API boundary rules.
- `src/lib/components/AGENTS.md`: `ConversationList.svelte` owns sidebar drag/drop state; row components are event emitters.
- `src/lib/stores/AGENTS.md`: stores own optimistic state and use `src/lib/client/api/`.
- `src/lib/server/db/AGENTS.md`: sidebar pin/order state belongs directly on first-party sidebar resources for v1.

## V1 Workflow Bar

Sidebar Pin v1 is done when a user can:

- open the existing three-dots menu for a visible chat or Project Folder and choose `Pin to sidebar`;
- right-click a chat or Project Folder row and open the same details menu at the pointer position without selecting the chat or expanding/collapsing the Project Folder;
- see pinned chats once in a global `Pinned` section above Projects, with a subtle project label when a pinned chat belongs to a Project Folder;
- see pinned Project Folders remain in Projects and sort above unpinned Project Folders;
- choose `Unpin from sidebar` and see the item return to its ordinary visual location;
- refresh, sign out/in, or use another browser without losing Sidebar Pin state;
- trust that Sidebar Pin does not pin Context Sources, change Prompt Context, or raise memory authority.

Drag reorder is not required for v1, but the data model should not block it.

## User Stories

- **US1 - Pin a chat**: As a user, I can pin an important visible chat and find it quickly without changing its Project Folder assignment.
- **US2 - Pin a Project Folder**: As a user, I can keep important Project Folders at the top of Projects without moving their chats.
- **US3 - Use the same details menu everywhere**: As a desktop user, I can right-click a sidebar row to open the same menu I get from the three-dots control.
- **US4 - Keep sidebar organization durable**: As a user, my pinned sidebar organization follows my account across refreshes and devices.
- **US5 - Reorder priority work later**: As a user, I can later manually order pinned chats and Project Folders with the same sidebar reorder interaction.

## Slice 1: Sidebar-Pin Conversations End To End

**Type**: AFK  
**Blocked by**: None  
**User stories covered**: US1, US3, US4

### What to build

Add durable Sidebar Pin support for visible conversations. A user can pin or unpin a chat from the existing conversation details menu or by right-clicking the row to open the same menu. Pinned chats appear once in a global `Pinned` section above Projects, keep their Project Folder assignment, show a subtle project label when applicable, and keep the same conversation actions as unpinned chats. Unpinned chats return to their ordinary project or unorganized location by recent activity.

Pin/unpin should use the existing conversation resource update flow. Newly pinned chats enter at the top of the pinned group, and activity updates should not reorder pinned chats.

### Acceptance Criteria

- [ ] A visible conversation can be pinned from the three-dots menu.
- [ ] A visible conversation can be pinned from a row right-click menu that opens at the pointer position.
- [ ] Right-clicking a conversation row opens the details menu without navigating to that conversation.
- [ ] Pinned conversations appear once in a global `Pinned` section above Projects and are not duplicated inside their Project Folder.
- [ ] A pinned conversation that belongs to a Project Folder shows a subtle project label in the pinned area.
- [ ] A pinned conversation keeps rename, move-to-project, remove-from-project, and delete actions available.
- [ ] Unpinning a conversation returns it to its ordinary project or unorganized location by recent activity.
- [ ] Pinning and unpinning survive refresh and account reload through durable server state.
- [ ] Pinning and unpinning use immediate sidebar movement as success feedback, without success toasts.
- [ ] English and Hungarian strings cover `Pinned`, `Pin to sidebar`, `Unpin from sidebar`, and accessible menu labels.

### Verification

- Service and route tests for conversation pin/unpin ownership, returned list payload fields, and newly pinned top insertion.
- Store tests for optimistic conversation pin/unpin, rollback on failure, snapshot reconciliation, and activity updates not reordering pinned chats.
- Component tests for the Pinned section, project label display, no duplicate project row, menu ordering, and right-click behavior.
- Localization parity test for new English and Hungarian sidebar keys.

## Slice 2: Sidebar-Pin Project Folders End To End

**Type**: AFK  
**Blocked by**: Slice 1  
**User stories covered**: US2, US3, US4

### What to build

Add durable Sidebar Pin support for Project Folders using the same details-menu behavior and visual language as conversations. Pinned Project Folders stay in the Projects section, sort before unpinned Project Folders, show a subtle pin indicator, and do not move their conversations into the global Pinned section. Pin state is independent from Project Folder expansion state.

Pin/unpin should use the existing project resource update flow. Newly pinned Project Folders enter at the top of the pinned Project Folder group.

### Acceptance Criteria

- [ ] A Project Folder can be pinned from the three-dots menu.
- [ ] A Project Folder can be pinned from a row right-click menu that opens at the pointer position.
- [ ] Right-clicking a Project Folder row opens the details menu without expanding or collapsing the folder.
- [ ] Pinned Project Folders remain in Projects and sort above unpinned Project Folders.
- [ ] Pinning a Project Folder does not pin or visually move its conversations.
- [ ] Deleting a pinned Project Folder removes that folder's Sidebar Pin with the folder.
- [ ] Deleting a Project Folder does not unpin conversations that were inside it; those conversations become unorganized while keeping their own Sidebar Pin if they had one.
- [ ] Project Folder pinning survives refresh and account reload through durable server state.
- [ ] Project Folder expansion state remains browser-local and independent from durable pin state.

### Verification

- Service and route tests for project pin/unpin ownership, returned list payload fields, and newly pinned top insertion.
- Store tests for optimistic project pin/unpin, rollback on failure, snapshot reconciliation, and independence from local expansion state.
- Component tests for pinned Project Folder sorting, subtle pin indicator, menu ordering, and right-click behavior.
- Regression test proving Project Folder pinning does not alter Project Folder Awareness, Prompt Context, or conversation project assignment.

## Slice 3: Shared Sidebar Reorder Primitive For Pinned Conversations

**Type**: AFK  
**Blocked by**: Slice 1  
**User stories covered**: US5

### What to build

Introduce a sidebar-specific reorder primitive and use it first for the global pinned conversation group. The primitive should support pointer drag reorder and keyboard-accessible reorder controls or equivalent accessible behavior. `ConversationList.svelte` remains the persistence and cross-group rule owner; row components remain event emitters.

Pinned conversation reorder persists durable Sidebar Order. Reordering is limited to the pinned conversation group and does not affect unpinned activity sorting.

### Acceptance Criteria

- [ ] Pinned conversations can be manually reordered within the global Pinned section.
- [ ] The reorder interaction uses a shared sidebar-specific primitive rather than one-off conversation-only drag code.
- [ ] Reordered pinned chat order survives refresh and account reload.
- [ ] Activity updates do not change the manual order of pinned conversations.
- [ ] Unpinned conversations remain ordered by recent activity.
- [ ] Reorder does not move conversations into or out of Project Folders.
- [ ] Keyboard or accessible reorder behavior is available and localized.

### Verification

- Component tests for pointer reorder and accessible reorder behavior in the pinned conversation group.
- Store/API tests for bulk or ordered-ID persistence and rollback on failure.
- Regression tests proving unpinned activity ordering and Project Folder membership remain unchanged.
- Visual or Playwright smoke test for desktop and narrow sidebar widths if the interaction affects layout.

## Slice 4: Reuse Sidebar Reorder Primitive For Project Folders

**Type**: AFK  
**Blocked by**: Slice 2, Slice 3  
**User stories covered**: US5

### What to build

Reuse the sidebar-specific reorder primitive for Project Folders. Pinned Project Folders remain above unpinned Project Folders. Manual reorder applies within the pinned Project Folder group and within the unpinned Project Folder group; changing pin state still happens through the menu action, not by dragging across groups.

Project Folder reorder persists durable Sidebar Order and continues to coexist with browser-local expansion state and conversation drag-to-project behavior.

### Acceptance Criteria

- [ ] Pinned Project Folders can be manually reordered within the pinned Project Folder group.
- [ ] Unpinned Project Folders can be manually reordered within the unpinned Project Folder group.
- [ ] Dragging to reorder a Project Folder does not pin or unpin it.
- [ ] Reordered Project Folder order survives refresh and account reload.
- [ ] Existing drag-to-project behavior for conversations still works.
- [ ] Project Folder expansion state remains browser-local and is not reset by reorder.
- [ ] The same sidebar reorder primitive is used for Project Folders and pinned conversations.

### Verification

- Component tests for Project Folder reorder in pinned and unpinned groups.
- Regression tests for conversation drag-to-project after Project Folder reorder support lands.
- Store/API tests for Project Folder order persistence and rollback on failure.
- Accessibility tests or focused component tests for keyboard reorder labels in English and Hungarian.

## Out Of Scope

- Pinning hidden empty/bootstrap conversations before they become visible sidebar conversations.
- Treating Sidebar Pin as a Context Source pin, memory priority, or Prompt Context signal.
- Success toasts for pinning or unpinning.
- Row right-click replacing three-dots click, tap, or keyboard access.
- Generic app-wide sortable-list infrastructure.
- Dragging Project Folders across pinned/unpinned boundaries to change pin state.
- Reordering unpinned conversations by hand.
