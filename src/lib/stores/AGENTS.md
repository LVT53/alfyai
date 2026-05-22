# Stores

Client state management using Svelte writable stores. Owns browser state, optimistic updates, and UI transitions.

## Structure

| File | Purpose |
|------|---------|
| `conversations.ts` | Conversation list with optimistic create/delete/rename/move. Reconciles server snapshots with local pending state. |
| `projects.ts` | Project folders for conversation organization. Simple CRUD updates. |
| `settings.ts` | Model selection, title language, and UI language. Syncs to localStorage and server preferences. |
| `ui.ts` | Sidebar open/collapsed state, responsive breakpoint handling, current conversation tracking. |
| `avatar.ts` | Profile picture state with cache-busting timestamp for fresh fetches after upload. |
| `theme.ts` | Light/dark/system theme with OS preference detection and localStorage persistence. |
| `_local-storage.ts` | Shared localStorage read/write utility (not a store). Used by `theme.ts` and `settings.ts`. |
## Where to Look

| Domain | Store | Components |
|--------|-------|------------|
| Conversation list | `conversations` | `ConversationList.svelte`, `Sidebar.svelte` |
| Project folders | `projects` | `ConversationList.svelte` (drag/drop) |
| Model selector | `settings.selectedModel` | `ModelSelector.svelte`, `ComposerToolsMenu.svelte` |
| Sidebar state | `ui.sidebarOpen`, `ui.sidebarCollapsed` | `Sidebar.svelte`, `Header.svelte` |
| Theme | `theme`, `isDark` | Root layout |
| Avatar | `avatarState` | `Sidebar.svelte` |

| Markdown dark mode | `theme` | `MessageBubble.svelte` |
| Draft/scroll state | `ui` | `MessageInput.svelte` |
| Global search | `conversations`, `projects`, `ui` | `SearchModal.svelte` |
## Conventions

- **Legacy writable pattern**: All stores use `writable()` from `svelte/store`. Not yet migrated to Svelte 5 runes.
- **Optimistic updates**: Mutate store immediately, then confirm with server. Track pending IDs in module-level Sets (see `conversations.ts`).
- **Persistence**: localStorage for theme, model, title language, and UI language. Server sync for account-level preferences.
- **Sidebar pinning**: Treat conversation and project-folder pin/unpin as durable resource updates through the existing client API/store boundaries. Bulk sidebar reorder can use a dedicated ordered-ID save path in the later drag-reorder slice.
- **API delegation**: Stores import from `$lib/client/api/`. Never inline fetch logic.
- **SSR guards**: Check `typeof window !== 'undefined'` or `browser` from `$app/environment` before accessing DOM APIs.
- **Derived stores**: Use `derived()` for computed state (theme dark mode, avatar cache-busting).

## Anti-Patterns

- **No fetch boilerplate**: Stores must not contain raw `fetch` + `res.ok` + JSON parsing. Use `client/api/` modules.
- **No cross-domain mutations**: A store should not directly mutate another store's state. Route through actions or page logic.
- **No HTTP client bloat**: Stores are not API clients. Keep HTTP logic in `client/api/`.
- **No server-side storage access**: Never access `localStorage` during SSR. Guard with environment checks.
