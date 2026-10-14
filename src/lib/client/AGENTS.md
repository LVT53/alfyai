# Client API Layer

## OVERVIEW

Browser-side API clients and session state management. Thin wrappers around `fetch` that centralize auth, error handling, and response parsing.

## STRUCTURE

```
api/
  _utils.ts        - Shared internal helpers (e.g., _unwrapList for list responses)
  admin.ts         - Admin user management CRUD (list/create/update/delete/revoke-sessions)
  auth.ts          - Login/logout calls
  http.ts          - Base fetch wrapper, error handling
  conversations.ts - Conversation detail, evidence, titles, drafts
  knowledge.ts     - Uploads, library, memory
  workspace-search.ts - Global shell Workspace Search
  models.ts        - Model list fetching
  projects.ts      - Project CRUD
  settings.ts      - Settings, account, avatar, admin calls (re-exports from admin.ts)
conversation-session.ts - Landing draft IDs, pending message replay
```

## WHERE TO LOOK

| Domain | File |
|--------|------|
| Auth flows | `api/auth.ts` |
| HTTP errors, base fetch | `api/http.ts` |
| Admin user management | `api/admin.ts` |
| Conversation detail, drafts | `api/conversations.ts` |
| Knowledge uploads, library, memory | `api/knowledge.ts` |
| Global shell Workspace Search | `api/workspace-search.ts` |
| Model list | `api/models.ts` |
| Projects | `api/projects.ts` |
| Settings, account, avatar | `api/settings.ts` |
| Landing/chat handoff | `conversation-session.ts` |

## CONVENTIONS

- **Always use `api/http.ts` base wrapper** for consistent error handling and auth header injection
- **Return typed responses** - parse JSON and validate shape before returning
- **Throw on non-OK** - let callers handle with try/catch or propagate to UI error boundaries
- **Auth is automatic** - base wrapper reads session cookie; don't manually add headers
- **Draft cleanup** - `conversation-session.ts` owns prepared-conversation deletion transport

## ANTI-PATTERNS

- **Don't scatter raw `fetch` calls** in components or pages - use the API modules
- **Don't put HTTP logic in stores** - stores own state transitions, not network calls
- **Don't invent new `sessionStorage` keys** outside `conversation-session.ts`
- **Don't duplicate error handling** - let the base wrapper normalize HTTP errors
- **Don't bypass auth** - always route through the shared HTTP wrapper
- **Don't reimplement admin CRUD** in `settings.ts` - import from `api/admin.ts` and re-export for backward compat

## Client Boundaries

- `src/lib/client/conversation-session.ts` owns landing-to-chat handoff state. Do not scatter raw `sessionStorage` keys across pages or components.
- `src/lib/client/api/` owns reusable browser `fetch` logic. Stores should not become ad hoc HTTP clients.

## Browser API, Stores, And Session Handoff

- Shared browser API:
  - [`src/lib/client/api/_utils.ts`](./src/lib/client/api/_utils.ts) — shared list-unwrapping helper for API responses
  - [`src/lib/client/api/admin.ts`](./src/lib/client/api/admin.ts) — reusable admin-side user management browser calls
  - [`src/lib/client/api/auth.ts`](./src/lib/client/api/auth.ts)
  - [`src/lib/client/api/http.ts`](./src/lib/client/api/http.ts)
  - [`src/lib/client/api/conversations.ts`](./src/lib/client/api/conversations.ts)
  - [`src/lib/client/api/knowledge.ts`](./src/lib/client/api/knowledge.ts)
  - [`src/lib/client/api/workspace-search.ts`](./src/lib/client/api/workspace-search.ts)
  - [`src/lib/client/api/models.ts`](./src/lib/client/api/models.ts)
  - [`src/lib/client/api/projects.ts`](./src/lib/client/api/projects.ts)
  - [`src/lib/client/api/settings.ts`](./src/lib/client/api/settings.ts)
- Session handoff:
  - [`src/lib/client/conversation-session.ts`](./src/lib/client/conversation-session.ts)


Rules:

- `client/api/` owns reusable request/response parsing and shared HTTP behavior.
- `src/lib/client/api/auth.ts` owns reusable browser auth calls such as login and logout.
- `src/lib/client/api/conversations.ts` owns reusable browser conversation-detail, evidence, and title calls.
- `src/lib/client/api/conversations.ts` also owns browser-side draft persistence and prepared-conversation deletion transport used by `conversation-session.ts`.
- `src/lib/client/api/knowledge.ts` owns reusable knowledge upload, library, and memory browser calls.
- `src/lib/client/api/workspace-search.ts` owns reusable browser calls for server-backed Workspace Search.
- `src/lib/client/api/models.ts` owns reusable model-list browser calls.
- `src/lib/client/api/settings.ts` owns reusable settings/account/avatar/admin/analytics browser calls.
- `src/lib/client/api/settings.ts` re-exports admin functions from `api/admin.ts` for backward compat; admin calls live in `api/admin.ts`
- `conversation-session.ts` owns landing draft IDs, pending first-message replay, previous-conversation markers, and draft cleanup rules.


Do not:

- put raw `fetch` + `res.ok` + JSON parsing boilerplate into stores
- open-code reusable browser auth, model, conversation-detail, evidence, title, or knowledge fetches in pages/components when they can live in `src/lib/client/api/`
- open-code settings/admin/analytics browser fetches in `settings/+page.svelte` when they can live in `src/lib/client/api/settings.ts`
- invent new `sessionStorage` keys in components or pages when the conversation-session helper should own them
- move reusable HTTP error handling into page files
