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
