# Components — Hierarchy and Contracts

Parent: [AGENTS.md](../../../AGENTS.md) defines component categories and boundary rules. This file maps the **component hierarchy, store dependencies, and page-to-component usage** — what the parent doesn't document.

## Component Hierarchy

```
layout/
  Sidebar.svelte                    ← navigation shell, profile, new-chat button
    ├── search/SearchModal.svelte   ← global Workspace Search (Ctrl+K)
    └── sidebar/ConversationList.svelte  ← list with drag/drop, project folders
          ├── sidebar/ProjectItem.svelte      ← folder row (event emitter only)
          └── sidebar/ConversationItem.svelte  ← conversation row (event emitter only)
  Header.svelte                     ← mobile header, sidebar toggle, user menu

chat/
  MessageInput.svelte               ← composer UI, attachments, local draft, onUploadReady callback
    ├── chat/ContextUsageRing.svelte     ← context usage % ring
    ├── chat/ComposerToolsMenu.svelte    ← model selector, personality style picker, attach action
    ├── chat/FileAttachment.svelte       ← attachment chip (viewable prop, onView callback)
    └── chat/DropZoneOverlay.svelte      ← full-page drag-and-drop overlay for file uploads
  MessageArea.svelte                ← message list scroll container (OWNS scroll)
    ├── chat/FileProductionCard.svelte  ← generated-file preview, retry/cancel, and download actions
    ├── chat/DocumentWorkspace.svelte   ← route-driven working-document pane using shared preview
    └── chat/MessageBubble.svelte       ← individual message (attachment open handoff)
          ├── chat/MarkdownRenderer.svelte    ← markdown + Shiki highlighting
          ├── chat/CodeBlock.svelte           ← fenced code block
          ├── chat/ThinkingBlock.svelte       ← <thinking> content
          ├── chat/FileAttachment.svelte      ← inline attachment display
          └── chat/MessageEvidenceDetails.svelte  ← evidence summary panel
  ModelSelector.svelte              ← model dropdown
  EvidenceManager.svelte            ← evidence management sidebar
  ErrorMessage.svelte               ← error display
  LogoMark.svelte                   ← animated brand logo (used by MessageBubble)

ui/
  AvatarCircle.svelte               ← user avatar display
  ProfilePictureEditor.svelte       ← avatar upload/crop
  ConfirmDialog.svelte              ← confirmation modal
  DialogShell.svelte                ← reusable dialog shell wrapper
  FileTypeIcon.svelte               ← file type icon display
  TypewriterText.svelte             ← animated text display
```

## Store Dependencies by Component

| Component | Store | Imports Used |
|-----------|-------|-------------|
| `Sidebar.svelte` | `ui` | `sidebarOpen`, `sidebarCollapsed`, `currentConversationId` |
| `Sidebar.svelte` | `avatar` | `avatarState` |
| `AvatarCircle.svelte` | props | `src` prop passed from parent; no store dependency |
| `Header.svelte` | `ui` | `sidebarOpen`, `sidebarCollapsed`, `currentConversationId` |
| `ConversationList.svelte` | `conversations` | `conversations`, CRUD actions |
| `ConversationList.svelte` | `projects` | `projects`, CRUD actions |
| `ConversationList.svelte` | `ui` | `currentConversationId`, `sidebarOpen` |
| `MessageInput.svelte` | `ui` | `currentConversationId` (draft clear on switch), `onUploadReady` callback |
| `MessageBubble.svelte` | `theme` | `isDark` (markdown dark mode), attachment open handoff to the route-owned workspace |
| `ModelSelector.svelte` | `settings` | `selectedModel`, `setSelectedModel` |
| `ComposerToolsMenu.svelte` | props + child components | `ModelSelector`, personality-profile props, attach callback |
| `SearchModal.svelte` | `workspace-search` API | server-backed workspace results through `client/api/workspace-search.ts` |
| `SearchModal.svelte` | `ui` | `currentConversationId`, `sidebarOpen` |

## Page-to-Component Usage

### Landing (`src/routes/(app)/+page.svelte`)
- `chat/MessageInput.svelte` — composer for first message

### Chat (`src/routes/(app)/chat/[conversationId]/+page.svelte`)
- `chat/MessageArea.svelte` — message list
- `document-workspace/DocumentWorkspace.svelte` — route-driven working-document workspace shell
- `chat/MessageInput.svelte` — composer with queued follow-up
- `chat/ModelSelector.svelte` — model picker
- `chat/EvidenceManager.svelte` — evidence panel
- `chat/ContextUsageRing.svelte` — context indicator
- `chat/DropZoneOverlay.svelte` — drag-and-drop file upload overlay
- Route-local `_components/` — `ChatComposerPanel`, `ChatMessagePane` (page scaffolding)

### Knowledge (`src/routes/(app)/knowledge/+page.svelte`)
- `ui/ConfirmDialog.svelte` — delete confirmations
- Route-local `_components/` — `DocumentsList`, `KnowledgeLibraryModal`, `KnowledgeMemoryModal`, `KnowledgeMemoryView`, `KnowledgeWorkspaceCoordinator`

### Settings (`src/routes/(app)/settings/+page.svelte`)
- `ui/ProfilePictureEditor.svelte` — avatar management
- `ui/ConfirmDialog.svelte` — account deletion
- Route-local `_components/` — `SettingsProfileTab`, `SettingsAdministrationTab`, `SettingsAdminSystemPane`, `SettingsAdminUsersPane`, `SettingsAnalyticsTab`, and account/user modals

### Shell (`src/routes/(app)/+layout.svelte`)
- `layout/Sidebar.svelte` — navigation
- `layout/Header.svelte` — mobile header

## Key Component Boundaries (not in parent)

- `ConversationList.svelte` owns drag/drop state — `ConversationItem` and `ProjectItem` are **event emitters**, not persistence actors
- Sidebar drag reordering should stay sidebar-specific for now. Reuse a shared whole-row sidebar reorder primitive for sidebar-pinned conversations and project folders, but keep persistence and cross-group rules in `ConversationList.svelte`.
- `MessageArea.svelte` is the **sole scroll owner** for conversation content — do not add `overflow-y: auto` elsewhere
- `MessageArea.svelte` must also keep newly appended file-production cards visible when the user remained near the bottom of the chat
- `MessageArea.svelte` also owns the quiet empty-conversation ready state for chat detail routes; do not reintroduce the landing-page hero copy inside the message pane
- `MessageInput.svelte` emits drafts and `onQueue` events — the **chat page** decides auto-send and restore behavior
- `MessageInput.svelte` must mirror a cleared `conversationId` prop back into its local `resolvedConversationId`; do not keep stale landing-page conversation ids alive inside the component after the parent resets them
- The chat page must treat route teardown/unmount as a local stream detach, not the same thing as the user pressing Stop. Only explicit stop UI should request `/api/chat/stream/stop`.
- The landing page may force a full document navigation after the first send so the browser cannot remain on the home-screen visual state while the new chat route is already executing on the server
- `MessageInput.svelte` accepts `onUploadReady` callback for external upload handling
- `FileAttachment.svelte` accepts `viewable` boolean and `onView` callback for document opening
- `SearchModal.svelte` queries server-backed Workspace Search through `client/api/workspace-search.ts` and hands document opens off to the knowledge-page workspace instead of owning a parallel preview modal
- `DropZoneOverlay.svelte` provides visual feedback during OS file manager drag operations
- `FileProductionCard.svelte` owns the generated-file job card layout, grouped output rows, preview/download UI, retry/cancel controls, and queued/running/failed/succeeded states
- `FileProductionCard.svelte` may delegate preview opening upward to the chat route so the route owns active-document selection for the working-document workspace
- Generated-file preview should open through `document-workspace/DocumentWorkspace.svelte` and `DocumentPreviewRenderer.svelte` instead of maintaining a second lightweight preview modal.
- `DocumentWorkspace.svelte` is the shared shell for working documents. It should stay route-driven, default closed in Chat, expanded by default in Knowledge, and lazy-load `DocumentPreviewRenderer.svelte` rather than creating a second viewer
- `DocumentWorkspace.svelte` should also lazy-load the embedded preview component and markdown highlighter so opening chat or knowledge pages does not eagerly pull the full rich-preview stack
- `DocumentPreviewRenderer.svelte` is the embedded preview coordinator. Keep file-type loading/rendering internals in `document-workspace/preview-runtime/` adapters instead of adding PDF.js, Office, text/HTML, CSV, markdown, or image interaction logic back into the coordinator
- `DocumentWorkspace.svelte` now owns version-history tabs/strips, source-message jump affordances, text-document compare mode, and the shared historical-status badge for dormant generated-document families. Keep those behaviors inside the shared workspace instead of rebuilding them in chat rows, search, or knowledge-page components
- Workspace-open behavior tracking should stay in the route-owned open/select handlers, not inside `DocumentWorkspace.svelte` or row components. The shared workspace UI remains a pure callback consumer while document-open events flow through the existing browser API + `memory_events` rail.
- Historical document badges are informational, not disabling state. Components should still allow explicit open/jump/version navigation for historical families even though server-side ranking now soft-deprioritizes them on weak generic turns.
- Knowledge-memory UI should render server-derived persona classes and historical temporal phrasing as-is. Do not re-derive deadline freshness or topic lifecycle rules in Svelte components.
- `MarkdownRenderer.svelte` uses Shiki with 25+ language grammars — init is async; check `initHighlighter()`
- `ContextUsageRing.svelte` (656 lines) is large because it contains SVG rendering logic, not business logic

## Route-Local Components Convention

Pages may have `_components/` directories for page-scoped UI:
- `src/routes/(app)/chat/[conversationId]/_components/` — `ChatComposerPanel`, `ChatMessagePane`
- `src/routes/(app)/knowledge/_components/` — `DocumentsList`, `KnowledgeLibraryModal`, `KnowledgeMemoryModal`, `KnowledgeMemoryView`, `KnowledgeWorkspaceCoordinator`
- `src/routes/(app)/settings/_components/` — settings tabs, admin panes, password field, and account/user modals

These are **page-internal** — do not import them from other pages. If logic becomes shared, move to `src/lib/components/` or `src/lib/client/api/`.

## Icon Policy

- **All UI icons must be sourced from Lucide** ([lucide.dev](https://lucide.dev)) via `@lucide/svelte`. Never write inline `<svg>` elements for icons.
- Import icons with PascalCase names: `import { FileText, Search, X } from "@lucide/svelte";`
- Always set `size`, `strokeWidth`, and `class` props to match the design system. Add `aria-hidden="true"` to decorative icons.
- **Exceptions**: `LogoMark.svelte` (brand logo), `ContextUsageRing.svelte` (data visualization), and icons with no verified Lucide equivalent.
- When replacing an inline icon, consult the migration mapping in the commit history for the exhaustive table.

Chat-route presentation rule:
- `ChatComposerPanel` and `ChatMessagePane` are part of the chat-detail layout, not the landing-page hero. Keep the composer bottom-docked on the chat route and keep the message surface visible even when a brand-new conversation has no persisted messages yet.
- The app shell must not infer "current conversation was deleted" purely from the sidebar list. Empty bootstrap chats may be real before they become list-visible.
